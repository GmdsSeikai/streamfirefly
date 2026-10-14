<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { HlsSelectionSnapshot } from "../download-plan";
import { buildHlsPlan, planSelectionFor } from "../download-plan";
import { deriveMediaPlaylist, parseHls, segmentRangeForTime, type HlsManifest } from "../media";
import { createSelectionPreviewSession, type SelectionPreviewSession } from "../hls-selection-preview";
import { humanError } from "../store";
import { sendMessage } from "../api";
import { formatDuration } from "../format";
import SfIcon from "../ui/SfIcon.vue";

type PreviewState = "idle" | "preparing" | "playing" | "paused" | "ended" | "failed";
type HlsConstructor = typeof import("hls.js").default;

const STALE = "preview_stale";
const PREPARE_TIMEOUT_MS = 15000;
const REPLAY_HEADERS = ["referer", "origin", "authorization", "cookie", "user-agent"];

let hlsModulePromise: Promise<HlsConstructor> | null = null;
function loadHls(): Promise<HlsConstructor> {
  if (!hlsModulePromise) {
    hlsModulePromise = import("hls.js").then(module => module.default).catch(error => { hlsModulePromise = null; throw error; });
  }
  return hlsModulePromise;
}

const props = defineProps<{ snapshot: HlsSelectionSnapshot | null }>();

interface PreviewRun {
  snapshot: HlsSelectionSnapshot;
  sessionId: string;
  previewSessionId: string;
  requestId: string;
  session: SelectionPreviewSession | null;
  hls: InstanceType<HlsConstructor> | null;
  deadlineTimer: number;
  endTimer: number;
  wait: { settle: (ok: boolean, error?: Error) => void } | null;
  headersClear: "none" | "pending" | "ok" | "failed";
  terminated: boolean;
  loadStopped: boolean;
  origin: number;
  networkRecoveries: number;
  mediaRecoveries: number;
}

const state = ref<PreviewState>("idle");
const error = ref("");
const notice = ref("");
const mediaElement = ref<HTMLVideoElement | null>(null);
const localTime = ref(0);
const duration = ref(0);
const muted = ref(false);
const volume = ref(1);
const audioTail = ref(false);
const bounds = ref<{ actualStart: number; actualEnd: number; first: number; last: number } | null>(null);

let current: PreviewRun | null = null;
let unmounted = false;

const canSeek = computed(() => duration.value > 0 && (state.value === "playing" || state.value === "paused" || state.value === "ended"));
const canReplay = computed(() => Boolean(current?.snapshot || props.snapshot));

function live(run: PreviewRun | null): run is PreviewRun {
  return Boolean(run && !run.terminated && !unmounted && current === run);
}

watch(() => props.snapshot, (next, previous) => {
  if (next === previous) return;
  if (!next) { terminate(current); return; }
  startSession(next);
}, { immediate: true });
onBeforeUnmount(() => { unmounted = true; terminate(current); });

function needsHeaderReplay(snapshot: HlsSelectionSnapshot): boolean {
  return Object.entries(snapshot.source.requestHeaders || {}).some(([key, value]) => REPLAY_HEADERS.includes(key.toLowerCase()) && Boolean(value));
}

async function fetchSnapshotText(run: PreviewRun, url: string): Promise<{ text: string; url: string }> {
  run.requestId = `preview-req-${crypto.randomUUID()}`;
  try {
    const result: any = await sendMessage({ type: "media.fetchText", tabId: run.snapshot.source.sourceTabId, id: run.snapshot.source.candidateId, url, requestId: run.requestId, sourceContextId: run.snapshot.source.sourceContextId });
    if (!result?.ok) throw new Error(result?.error || "media_fetch_failed");
    return { text: result.text, url: result.url || url };
  } finally {
    if (run.requestId) run.requestId = "";
  }
}

async function cancelFetch(run: PreviewRun) {
  if (!run.requestId) return;
  const pending = run.requestId;
  run.requestId = "";
  await sendMessage({ type: "media.fetchText.cancel", requestId: pending, sourceContextId: run.snapshot.source.sourceContextId }).catch(() => {});
}

async function clearHeadersBounded(run: PreviewRun) {
  if (!run.previewSessionId || run.headersClear === "pending") return;
  run.headersClear = "pending";
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const result: any = await sendMessage({ type: "preview.headers.clear", previewSessionId: run.previewSessionId });
      if (result?.ok) { run.headersClear = "ok"; return; }
    } catch {}
  }
  run.headersClear = "failed";
}

function compensateHeadersClear(run: PreviewRun) {
  run.headersClear = "none";
  void clearHeadersBounded(run);
}

async function applyPreviewHeaders(run: PreviewRun) {
  const needs = needsHeaderReplay(run.snapshot);
  let result: any = null;
  try {
    result = await sendMessage({ type: "preview.headers.apply", payload: { previewSessionId: run.previewSessionId, candidateId: run.snapshot.source.candidateId, url: run.snapshot.source.candidateUrl, headers: run.snapshot.source.requestHeaders } });
  } catch { result = null; }
  if (!live(run)) {
    if (result?.ok && needs) compensateHeadersClear(run);
    throw new Error(STALE);
  }
  if (needs && !result?.ok) throw new Error("预览鉴权规则安装失败，无法安全播放此资源。");
}

function armDeadline(run: PreviewRun) {
  clearTimeout(run.deadlineTimer);
  run.deadlineTimer = window.setTimeout(() => {
    if (!live(run) || state.value !== "preparing") return;
    terminate(run, "预览准备超时，请重试或改用下载。");
  }, PREPARE_TIMEOUT_MS);
}

function clearDeadline(run: PreviewRun) {
  clearTimeout(run.deadlineTimer);
  run.deadlineTimer = 0;
}

function terminate(run: PreviewRun | null, failMessage?: string) {
  if (!run || run.terminated) return;
  run.terminated = true;
  if (current === run) current = null;
  const media = mediaElement.value;
  media?.pause();
  run.session?.abortPending();
  if (run.hls) {
    try { run.hls.stopLoad(); } catch {}
    try { run.hls.destroy(); } catch {}
    run.hls = null;
  }
  clearDeadline(run);
  clearInterval(run.endTimer);
  run.endTimer = 0;
  if (media) {
    media.removeEventListener("timeupdate", onTimeUpdate);
    media.removeEventListener("seeking", onSeeking);
    media.removeEventListener("play", onPlay);
    media.removeEventListener("pause", onPause);
    media.removeEventListener("ended", onEnded);
    media.removeAttribute("src");
    media.load();
  }
  run.wait?.settle(false, new Error(STALE));
  run.session?.dispose();
  run.session = null;
  void cancelFetch(run);
  void clearHeadersBounded(run);
  if (failMessage) {
    state.value = "failed";
    error.value = failMessage;
  } else if (state.value !== "failed") {
    state.value = "idle";
    error.value = "";
    notice.value = "";
    localTime.value = 0;
    duration.value = 0;
    bounds.value = null;
  }
}

function isPlayPolicyRejection(reason: unknown): boolean {
  const name = (reason as { name?: string } | null)?.name;
  const message = (reason as { message?: string } | null)?.message || "";
  return name === "NotAllowedError" || name === "AbortError" || message === "NotAllowedError";
}

function localProgress(): number {
  const media = mediaElement.value;
  if (!media) return 0;
  return Math.min(duration.value, Math.max(0, media.currentTime - (current?.origin ?? 0)));
}

function enforceEnd() {
  if (state.value !== "playing" && state.value !== "paused") return;
  if (duration.value > 0 && localProgress() >= duration.value - 0.001) reachEnd();
}

function reachEnd() {
  const run = current;
  if (!run || run.terminated) return;
  const media = mediaElement.value;
  media?.pause();
  run.hls?.stopLoad();
  run.loadStopped = true;
  localTime.value = duration.value;
  state.value = "ended";
  clearInterval(run.endTimer);
  run.endTimer = 0;
}

function resumeLoading(run: PreviewRun) {
  if (!run.loadStopped || !run.hls) return;
  run.loadStopped = false;
  run.hls.startLoad(-1);
}

function armEndChecks(run: PreviewRun) {
  clearInterval(run.endTimer);
  run.endTimer = window.setInterval(() => {
    if (!live(run) || state.value !== "playing") return;
    localTime.value = localProgress();
    enforceEnd();
  }, 100);
}

function onTimeUpdate() {
  const run = current;
  if (!run || run.terminated) return;
  if (state.value === "playing") localTime.value = localProgress();
  enforceEnd();
}

function onSeeking() {
  const run = current;
  const media = mediaElement.value;
  if (!run || run.terminated || !media || duration.value <= 0) return;
  const clamped = Math.min(duration.value, Math.max(0, media.currentTime - run.origin));
  const target = run.origin + clamped;
  if (Math.abs(media.currentTime - target) > 0.01) media.currentTime = target;
  localTime.value = clamped;
  enforceEnd();
}

function onPlay() {
  const run = current;
  if (!run || run.terminated) return;
  if (state.value === "playing" || state.value === "paused") { state.value = "playing"; armEndChecks(run); }
}

function onPause() {
  const run = current;
  if (!run || run.terminated) return;
  if (state.value === "ended" || state.value === "failed" || state.value === "preparing") return;
  state.value = "paused";
  clearInterval(run.endTimer);
  run.endTimer = 0;
  localTime.value = localProgress();
}

function onEnded() { reachEnd(); }

function handleHlsError(run: PreviewRun, Hls: HlsConstructor, data: any) {
  if (!live(run) || !data?.fatal) return;
  const status = data?.response?.code;
  if (status === 401 || status === 403) { terminate(run, `媒体请求被拒绝（${status}），无法预览此资源。`); return; }
  if (data.details === Hls.ErrorDetails.KEY_LOAD_ERROR) { terminate(run, "无法获取或解析 AES 密钥，预览已停止。"); return; }
  if (data.details === Hls.ErrorDetails.INTERNAL_EXCEPTION) { terminate(run, "预览解码失败，此浏览器可能不支持该媒体格式。"); return; }
  if (data.type === Hls.ErrorTypes.NETWORK_ERROR && run.networkRecoveries < 1) { run.networkRecoveries += 1; run.hls?.startLoad(); return; }
  if (data.type === Hls.ErrorTypes.MEDIA_ERROR && run.mediaRecoveries < 1) { run.mediaRecoveries += 1; run.hls?.recoverMediaError(); return; }
  terminate(run, "预览加载失败，可尝试重新播放或改用下载。");
}

function waitForManifest(run: PreviewRun, Hls: HlsConstructor): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const settle = (ok: boolean, error?: Error) => {
      if (!run.wait) return;
      run.wait = null;
      run.hls?.off(Hls.Events.MANIFEST_PARSED, done);
      run.hls?.off(Hls.Events.ERROR, failWait);
      if (ok) resolve(); else reject(error ?? new Error(STALE));
    };
    const done = () => settle(true);
    const failWait = (_event: unknown, data: any) => { if (data?.fatal) settle(false, new Error("预览加载失败，可尝试重新播放或改用下载。")); };
    run.wait = { settle };
    run.hls!.on(Hls.Events.MANIFEST_PARSED, done);
    run.hls!.on(Hls.Events.ERROR, failWait);
  });
}

function startSession(snapshot: HlsSelectionSnapshot) {
  const run: PreviewRun = {
    snapshot,
    sessionId: crypto.randomUUID(),
    previewSessionId: "",
    requestId: "",
    session: null,
    hls: null,
    deadlineTimer: 0,
    endTimer: 0,
    wait: null,
    headersClear: "none",
    terminated: false,
    loadStopped: false,
    origin: 0,
    networkRecoveries: 0,
    mediaRecoveries: 0
  };
  run.previewSessionId = `preview-${run.sessionId}`;
  terminate(current);
  current = run;
  localTime.value = 0;
  error.value = "";
  notice.value = "";
  audioTail.value = false;
  duration.value = Math.max(0, snapshot.selection.actualEnd - snapshot.selection.actualStart);
  bounds.value = { ...snapshot.selection };
  state.value = "preparing";
  armDeadline(run);
  queueMicrotask(() => { if (live(run)) void prepareRun(run); });
}

async function prepareRun(run: PreviewRun) {
  try {
    const track = run.snapshot.audioTrack;
    let audioManifest: HlsManifest | null = null;
    if (track) {
      if (!track.uri) throw new Error("轨道没有清单地址");
      const response = await fetchSnapshotText(run, track.uri);
      if (!live(run)) throw new Error(STALE);
      audioManifest = parseHls(response.text, response.url);
    }
    const plan = await buildHlsPlan(planSelectionFor(run.snapshot, { audioManifest, container: run.snapshot.output.container }));
    if (!live(run)) throw new Error(STALE);
    duration.value = Math.max(0, plan.duration);
    bounds.value = { actualStart: plan.range.actualStart, actualEnd: plan.range.actualEnd, first: plan.range.firstSegment, last: plan.range.lastSegment };
    if (audioManifest && run.snapshot.audioTrack) {
      try {
        const audioWindow = deriveMediaPlaylist(audioManifest, ...segmentRangeForTime(audioManifest, plan.range.actualStart, plan.range.actualEnd));
        audioTail.value = audioWindow.actualEnd > plan.range.actualEnd + 0.01;
      } catch { audioTail.value = false; }
    }
    await applyPreviewHeaders(run);
    if (!live(run)) throw new Error(STALE);
    run.session = createSelectionPreviewSession({
      sessionId: run.sessionId,
      video: plan.videoManifest,
      audio: plan.audioManifest,
      variant: {
        bandwidth: run.snapshot.variant?.bandwidth ?? null,
        averageBandwidth: run.snapshot.variant?.averageBandwidth ?? null,
        width: run.snapshot.variant?.width ?? null,
        height: run.snapshot.variant?.height ?? null,
        codecs: run.snapshot.variant?.codecs ?? null,
        audioGroup: run.snapshot.variant?.audioGroup ?? null
      },
      keyOverride: run.snapshot.keyOverride
    });
    const Hls = await loadHls();
    if (!live(run)) throw new Error(STALE);
    if (!Hls.isSupported()) throw new Error("当前浏览器不支持此 HLS 预览，可改用下载。");
    const media = mediaElement.value;
    if (!media) throw new Error("预览媒体元素不可用");
    media.muted = muted.value;
    media.volume = volume.value;
    run.hls = new Hls({ ...run.session.configFor(Hls.DefaultConfig.loader as never), enableWorker: true, lowLatencyMode: false, autoStartLoad: true, startPosition: 0, maxBufferLength: 4, maxMaxBufferLength: 8, backBufferLength: 0, maxBufferSize: 10 * 1024 * 1024 });
    run.hls.on(Hls.Events.ERROR, (_, data) => handleHlsError(run, Hls, data));
    run.hls.on(Hls.Events.LEVEL_LOADED, (_, data: any) => {
      if (!live(run)) return;
      run.origin = data?.details?.fragments?.[0]?.start || 0;
    });
    run.hls.attachMedia(media);
    media.addEventListener("timeupdate", onTimeUpdate);
    media.addEventListener("seeking", onSeeking);
    media.addEventListener("play", onPlay);
    media.addEventListener("pause", onPause);
    media.addEventListener("ended", onEnded);
    run.hls.loadSource(run.session.masterUrl);
    await waitForManifest(run, Hls);
    if (!live(run)) throw new Error(STALE);
    try {
      await media.play();
      if (!live(run)) { if (!current) media.pause(); return; }
      clearDeadline(run);
      state.value = "playing";
      armEndChecks(run);
    } catch (reason: unknown) {
      if (!live(run)) return;
      clearDeadline(run);
      if (isPlayPolicyRejection(reason)) {
        state.value = "paused";
        notice.value = "浏览器阻止了自动播放，请点击播放按钮继续。";
        return;
      }
      terminate(run, "预览播放失败，可尝试重新播放或改用下载。");
    }
  } catch (reason: unknown) {
    if (!live(run)) return;
    if (reason instanceof Error && reason.message === STALE) return;
    terminate(run, humanError(reason instanceof Error ? reason.message : "") || "预览准备失败");
  }
}

async function togglePlay() {
  const run = current;
  const media = mediaElement.value;
  if (!media || !run) return;
  if (state.value === "playing") { media.pause(); return; }
  if (state.value === "ended") { replay(); return; }
  if (state.value === "failed" || state.value === "preparing" || state.value === "idle") return;
  try {
    resumeLoading(run);
    await media.play();
    if (!live(run)) { if (!current) media.pause(); return; }
    clearDeadline(run);
    state.value = "playing";
    notice.value = "";
    armEndChecks(run);
  } catch (reason: unknown) {
    if (!live(run)) return;
    if (isPlayPolicyRejection(reason)) {
      notice.value = "浏览器阻止了播放，请再次点击播放按钮。";
      state.value = "paused";
      return;
    }
    terminate(run, "预览播放失败，可尝试重新播放或改用下载。");
  }
}

function replay() {
  const snapshot = current?.snapshot || props.snapshot;
  if (!snapshot) return;
  startSession(snapshot);
}

function seekTo(event: Event) {
  const run = current;
  const media = mediaElement.value;
  const target = Number((event.target as HTMLInputElement).value);
  if (!run || run.terminated || !media || !Number.isFinite(target)) return;
  if (state.value === "ended") { state.value = "paused"; }
  const clamped = Math.min(duration.value, Math.max(0, target));
  media.currentTime = run.origin + clamped;
  localTime.value = clamped;
  resumeLoading(run);
  enforceEnd();
}

function toggleMute() {
  const media = mediaElement.value;
  muted.value = !muted.value;
  if (media) media.muted = muted.value;
}

function setVolume(event: Event) {
  const media = mediaElement.value;
  const value = Math.min(1, Math.max(0, Number((event.target as HTMLInputElement).value)));
  volume.value = Number.isFinite(value) ? value : 1;
  if (media) media.volume = volume.value;
}
</script>

<template>
  <section class="panel selection-preview" aria-label="所选范围预览">
    <div class="panel-title"><div><h3>播放所选范围</h3><p>预览在主视频终点停止，不创建下载任务</p></div><span class="tag">{{ state === 'preparing' ? '准备中' : state === 'playing' ? '播放中' : state === 'paused' ? '已暂停' : state === 'ended' ? '已到终点' : state === 'failed' ? '预览失败' : '未开始' }}</span></div>
    <video ref="mediaElement" class="preview-media" playsinline preload="auto"></video>
    <div v-if="state === 'preparing'" class="status-banner" role="status">正在准备预览媒体…</div>
    <div v-if="error" class="status-banner error" role="alert">{{ error }}</div>
    <div v-else-if="notice" class="status-banner warning" role="status">{{ notice }}</div>
    <div v-if="audioTail" class="status-banner warning" role="note">预览在主视频终点停止；下载文件可能包含更长的音轨尾部。</div>
    <div class="preview-controls">
      <button class="icon-button" type="button" :aria-label="state === 'playing' ? '暂停' : state === 'ended' ? '重播' : '播放'" :disabled="state === 'preparing' || state === 'failed' || state === 'idle'" @click="togglePlay">
        <SfIcon :name="state === 'playing' ? 'player-pause' : 'player-play'" />
      </button>
      <button class="icon-button" type="button" aria-label="重新播放" :disabled="state === 'preparing' || !canReplay" @click="replay"><SfIcon name="refresh" /></button>
      <label class="preview-seek"><span class="sr-only">播放进度</span><input class="control" type="range" min="0" :max="Math.max(duration, 0.1)" step="0.1" :value="localTime" :disabled="!canSeek" @input="seekTo"></label>
      <span class="preview-time">{{ formatDuration(localTime) }} / {{ formatDuration(duration) }}</span>
      <button class="button" type="button" :aria-pressed="muted" @click="toggleMute">{{ muted ? '取消静音' : '静音' }}</button>
      <label class="preview-volume"><span class="sr-only">音量</span><input class="control" type="range" min="0" max="1" step="0.05" :value="volume" @input="setVolume"></label>
    </div>
    <dl v-if="bounds" class="range-summary">
      <div><dt>原资源范围</dt><dd>{{ formatDuration(bounds.actualStart) }} — {{ formatDuration(bounds.actualEnd) }}</dd></div>
      <div><dt>实际切片</dt><dd>#{{ bounds.first }} — #{{ bounds.last }}</dd></div>
      <div><dt>预计时长</dt><dd>{{ formatDuration(duration) }}</dd></div>
    </dl>
  </section>
</template>

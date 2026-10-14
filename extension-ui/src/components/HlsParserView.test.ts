import { flushPromises, mount } from "@vue/test-utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import HlsParserView from "./HlsParserView.vue";

const { send, create } = vi.hoisted(() => ({ send: vi.fn(), create: vi.fn() }));
vi.mock("../api", () => ({ sendMessage: send, extensionApi: () => ({ runtime: { sendMessage: true } }) }));
vi.mock("../download-client", () => ({ createDownload: create }));
vi.mock("./HlsSelectionPreview.vue", () => ({ default: { name: "HlsSelectionPreview", props: ["snapshot"], render: () => null } }));

const masterText = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="中文",LANGUAGE="zh-CN",DEFAULT=YES,URI="audio.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=1280x720,CODECS="avc1.64001f,mp4a.40.2",AUDIO="audio"
720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080,CODECS="avc1.640028,mp4a.40.2",AUDIO="audio"
1080.m3u8`;
const videoText = "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttps://media.example/v1.ts\n#EXTINF:5,\nhttps://media.example/v2.ts\n#EXTINF:5,\nhttps://media.example/v3.ts\n#EXT-X-ENDLIST";
const audioText = "#EXTM3U\n#EXT-X-TARGETDURATION:5\n#EXTINF:5,\nhttps://media.example/a1.aac\n#EXTINF:5,\nhttps://media.example/a2.aac\n#EXT-X-ENDLIST";

const props = () => ({
  candidate: { id: "hls", type: "hls", url: "https://media.example/master.m3u8", title: "测试 HLS", inlineManifest: { format: "hls", baseUrl: "https://media.example/master.m3u8", text: masterText } },
  context: { sourceContextId: "page", sourceTabId: 1, supported: true } as any,
  capabilities: ["hls-selection-v1", "hls-key-override-v1"],
  saveDir: "",
  downloadThreads: 2,
  connected: true
});

let audioGate: ((value: any) => void) | null = null;

beforeEach(() => {
  send.mockReset();
  create.mockReset();
  create.mockResolvedValue({ id: "task", title: "任务" });
  audioGate = null;
  send.mockImplementation(async (message: any) => {
    if (message.type === "media.fetchText") {
      if (String(message.url).includes("audio")) return new Promise(done => { audioGate = done; });
      return { ok: true, text: videoText, url: message.url };
    }
    if (message.type === "task.prepare") return { ok: true, payload: { fileName: "默认文件名" } };
    return { ok: true };
  });
});

describe("HLS parser selection preview entry", () => {
  it("starts the preview from the entry and invalidates it on media-affecting edits only", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    const entry = () => wrapper.findAll("button").find(button => button.text() === "播放所选范围")!;
    expect(entry().attributes("disabled")).toBeUndefined();
    await entry().trigger("click");
    await flushPromises();
    const preview = wrapper.findComponent({ name: "HlsSelectionPreview" });
    expect(preview.exists()).toBe(true);
    const snapshot = preview.props("snapshot");
    expect(snapshot.source.candidateId).toBe("hls");
    expect(snapshot.selection).toEqual({ first: 0, last: 2, actualStart: 0, actualEnd: 15 });

    await wrapper.get(".filename input").setValue("新文件名");
    await flushPromises();
    expect(wrapper.findComponent({ name: "HlsSelectionPreview" }).props("snapshot")).toBeTruthy();

    await wrapper.findAll(".range-tabs button").find(button => button.text() === "按切片")!.trigger("click");
    await flushPromises();
    expect(wrapper.findComponent({ name: "HlsSelectionPreview" }).exists()).toBe(false);
    wrapper.unmount();
  });

  it("builds the download task from the click-time snapshot even if inputs change mid-flight", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    await wrapper.findAll("button").find(button => button.text() === "开始可靠下载")!.trigger("click");
    await flushPromises();
    expect(audioGate).not.toBeNull();
    await wrapper.findAll(".range-tabs button").find(button => button.text() === "按切片")!.trigger("click");
    await flushPromises();
    await wrapper.findAll(".range-inputs input")[0].setValue("1");
    await wrapper.findAll(".range-inputs input")[1].setValue("1");
    await flushPromises();
    audioGate!({ ok: true, text: audioText, url: "https://media.example/audio.m3u8" });
    await flushPromises();
    expect(create).toHaveBeenCalledOnce();
    const payload = create.mock.calls[0][0];
    expect(payload.hlsPlan.range.firstSegment).toBe(0);
    expect(payload.hlsPlan.range.lastSegment).toBe(2);
    expect(payload.fileName).toBe("默认文件名");
    wrapper.unmount();
  });

  it("blocks the preview entry while the range inputs are invalid", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    await flushPromises();
    await wrapper.findAll(".range-tabs button").find(button => button.text() === "按时间")!.trigger("click");
    await flushPromises();
    await wrapper.findAll(".range-inputs input")[0].setValue("");
    await flushPromises();
    expect(wrapper.text()).toContain("有效的时间");
    const entry = wrapper.findAll("button").find(button => button.text() === "播放所选范围")!;
    expect(entry.attributes("disabled")).toBeDefined();
    expect(wrapper.findComponent({ name: "HlsSelectionPreview" }).exists()).toBe(false);
    wrapper.unmount();
  });

  it("a fractional segment field is a validated state, not a watcher crash", async () => {
    const wrapper = mount(HlsParserView, { props: props() });
    try {
      await flushPromises();
      await wrapper.findAll(".range-tabs button").find(button => button.text() === "按切片")!.trigger("click");
      await flushPromises();
      await wrapper.findAll(".range-inputs input")[0].setValue("0.5");
      await flushPromises();
      expect(wrapper.text()).toContain("整数");
      const entry = wrapper.findAll("button").find(button => button.text() === "播放所选范围")!;
      expect(entry.attributes("disabled")).toBeDefined();
      await wrapper.findAll(".range-inputs input")[0].setValue("1");
      await flushPromises();
      expect(wrapper.text()).not.toContain("整数");
    } finally { wrapper.unmount(); }
  });
});

# Decision: HLS 所选范围播放预览（Issue #14）

Status: proposed

## Problem

HLS 解析页只能在创建下载任务后才能确认所选画质、音轨和范围是否正确。用户需要在下载前手动播放所选主流范围及对应音轨，且不能扩大现有鉴权边界、不改变下载合并方式。维护者要求：一致性口径收窄为"预览所选主视频范围及对应音轨"，ByteRange 与 #13 的归一化衔接，预览失败局部提示、不阻断下载。

## Proposal

- 解析页范围摘要旁提供"播放所选范围"入口，全部/按切片/按时间共用。点击才准备媒体与密钥；进入页面、修改选择不自动播放。字幕、文件名、保存目录改动不重建媒体。
- 点击时同步捕获不可变选择快照（候选与来源身份、请求头副本、画质/清单、音轨描述、范围与实际边界、keyOverride；下载另含字幕与输出设置），预览与下载经同一快照调用 `buildHlsPlan`，其 `videoManifest`/`audioManifest`/`range.actualStart/actualEnd`/`duration` 为预览权威。
- `media.ts` 在完整清单解析期把合法隐式 ByteRange 偏移归一化为显式 `length@offset` 字符串（媒体分片要求紧邻前片同资源子范围，否则明确失败；MAP 按 §4.3.2.5 仅继承 n[@o] 格式，缺省偏移为 0，与 hls.js `setInitSegment` 一致）。加密 MAP 无显式 IV 明确失败，与 native `hls_map_iv_required` 对齐。截取后 `deriveMediaPlaylist` 直接输出归一化结果，下载与预览共用。
- 新增 `hls-selection-preview.ts`：每会话独立虚拟清单映射（master 仅一所选画质与一条外置音轨），pLoader 白名单应答、未知虚拟地址失败不发 HTTP；真实分片/MAP/自动 AES key 委托默认 loader 保留 Range/abort。手动 Hex/Base64 key 内存解码，URL key 经受控可取消 loader 获取并强制 16 字节；key 改写只作用会话副本且不改 METHOD=NONE；IV 优先级=手动→清单显式→原 sequence 推导，保留原 sequence/MAP/discontinuity。
- 新增 `HlsSelectionPreview.vue`：状态机 idle→preparing→playing↔paused→ended/failed；局部进度 `0..plan.duration`（不用含尾音的 media.duration），seek 限制在局部范围；终点由 100ms 主动检查加 timeupdate/seeking/ended 兜底，到点 pause+stopLoad，实测停止误差 ≤0.25 秒；外置音轨更长时提示下载可能保留尾音。15 秒准备期限不被重试重置；fatal 网络/媒体恢复各至多一次；401/403、无效密钥、不支持格式不进恢复循环。不回退 `video.src=candidate.url`。
- `media.fetchText` 增可选 `requestId`/`sourceContextId` 与 `media.fetchText.cancel`：后台 AbortController 按发送者 tab+来源上下文+请求身份归属登记，覆盖取消先于登记的竞争，fetch 与读体均受 signal，导航/关 tab/失效时实际 abort；既有不带预览字段的调用语义不变，不涉及 Native 协议。preview.headers.apply/clear 按会话串行，旧会话 clear 不删新会话规则，关 tab 前排干会话队列防孤儿规则。
- 预览清单请求经 `prepareOwnedFetch` 新增的 opt-in origin 限制：候选 Authorization/Cookie 与 Referer/Origin 只随同源请求，跨域仅按浏览器既有权限访问公开/签名资源；不改全局下载鉴权、不加代理或权限。

## Alternatives considered

- 原生播放器直连完整 m3u8：无法限制所选轨道与范围，也不支持手动密钥适配，弃用。
- Native 先下载合并再播放：引入文件与等待时间，与下载前确认的目标不符，弃用。
- 修改 FFmpeg 按主视频截断音轨：改变现有下载产物，超出维护者边界，弃用。
- 扩大凭据注入或加代理：改变鉴权边界，弃用。
- ByteRange 隐式偏移默认 0（hls.js/PR #13 分支）：会静默取错字节；媒体分片改为明确失败。

## Risks

- 跨轨时间对齐依赖容器时间戳，已用真实双音轨播放验证；discontinuity 跨段已用独立编码拼接夹具验证解码，长时间直播录制不在本轮范围。
- 浏览器编解码与 Range 服务差异：已覆盖 Chromium/Edge 与 Playwright 配套 Firefox 156 真实解码；用户安装版 Firefox 158 未接入（Playwright 需配套补丁构建，不自动改有界面/接管桌面）。
- AES-CBC 错误 IV 仅损坏每片首块，媒体仍可能解出（Native 同样不校验 IV 正确性）；错误 KEY 会局部失败。IV 一致性由会话归一化（0x 前缀）与下载语义对齐保证。
- 真实扩展鉴权已取得 Chromium 无头真实 DNR 证据；Firefox 真实扩展网络栈与真实网站矩阵（具体站点）仍未做，不把 Chromium 结果外推 Firefox。

## Verification

- `npm run typecheck`、`npm run validate:extension` 通过；全量 `npx vitest run` 270 项通过（目标 6 文件 77 项，含 R1–R8 转正回归与 R2-1/R2-2 新回归）。
- `node tools/test-extension-logic.mjs`（并入 `npm run test:unit`）：取消归属/竞争/回收、跨会话规则不丢更新、安装中清理拦截、导航 abort 通过。
- `npm run test:hls:preview`（headless Playwright + 构建后生产组件 + ffmpeg 真实媒体）：Chromium **35 项执行通过、0 失败、0 跳过**（完整覆盖）；Firefox 156 **34 项执行通过、0 失败、1 跳过**（跳过项为 Chromium 专属的真实扩展鉴权，不计通过，覆盖率不完整）——即 Firefox 媒体矩阵全部执行通过。内容：真实 TS/fMP4 解码、双音轨频谱、终点停止、暂停/拖动/重播、AES 全矩阵（隐式/显式/无前缀手动 IV、轮换、METHOD=NONE、15/17 字节）、ByteRange 中间隐式片真实 Range/206、fMP4 MAP ByteRange、discontinuity、请求白名单、收起/关闭在途请求中止（ERR_ABORTED/NS_BINDING_ABORTED）、**长片段终点后拖回回收缓冲区重取片续播**、**无 AUDIO 分组仍播放所选外置音轨**、失败隔离、无 pageerror。
- **真实扩展鉴权（Chromium 无头、真实 DNR/网络栈）**：chromium channel + `--load-extension` 载入构建扩展（隔离 profile），双 origin 实测——同源两路请求携带候选 Authorization 与 DNR 注入 Referer；跨域与跨源重定向零凭据；DNR 规则 apply=1/clear=0/关 tab=0。
- 测试 runtime 统一经 `PLAYWRIGHT_MODULE`/`PLAYWRIGHT_BROWSERS_PATH` 显式配置（项目声明 playwright-core 为默认），无个人路径依赖；缺失时有界失败无残留。
- `npm run test:unit`、`git diff --check` 通过。审查复现脚本 4 条（Chromium/Firefox 各 2）由失败转为通过。
- 未验收：用户安装版 Firefox 158 的播放/插件；Firefox 真实扩展网络栈；真实网站矩阵；观看者可感知的画质/内容正确性。

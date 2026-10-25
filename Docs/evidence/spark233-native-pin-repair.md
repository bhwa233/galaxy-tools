# Windows 置顶默认层级的修复

日期：2026-10-25。承接[原始置顶诊断](spark233-native-pin-followup.md)。此前记录的“具体根因未定”是当时边界，本轮取得了更直接的公开 API 与源码对照；原失败包和失败报告保持原结论。

## 已确认的原因范围

独立 Electron 45 app 不加载 spark233 宿主、插件、剪贴板或 fullscreen watcher。在正常可见启动下，普通有边框窗口和产品透明无边框窗口都已实际报告 `visible=true`，默认 `setAlwaysOnTop(true)` 之后立即、250 ms、1000 ms 均读回 false。报告：`local-build/spark233/pin-runtime-probe/normal-cf8f9b5a-9b31-439a-8b06-7ef27e6142cf/report.json`。这次排除了上一轮 Hidden 启动造成普通窗口不可见的歧义。

读取 Electron 固定 `v45.0.0` 的公开源码确认：

- `shell/browser/api/electron_api_base_window.cc:646` 将 `top=true` 转为 floating Z-order，默认层级名为 `floating`。
- `shell/browser/native_window_views.cc:1196` 在设置 Z-order 后，对 `floating` 等层级额外调用任务栏后排逻辑。
- 同文件 `MoveBehindTaskBarIfNeeded():2119` 使用全局 `FindWindow(Shell_TrayWnd)`，再将当前窗口 `SetWindowPos` 到该任务栏之后；没有按窗口所在显示器选任务栏。

这与“另一屏的置顶也被立即降为普通窗口”的现场现象相符。没有直接读取系统任务栏的原生 style，因此不把任务栏被其他程序降低的具体原因写成已知。

独立窗口仅将公开层级改为 `pop-up-menu`，两种窗口都能立即并持续读到 true，取消置顶后为 false，报告为 `local-build/spark233/pin-runtime-probe/popup-dc7a44bb-bbbc-4e14-af47-a02ef77a2373/report.json`。Electron 文档明确该层级在 Windows 不再排到任务栏后面；没有新增原生依赖或修改 OS 设置。

## 最小产品适配

`electron/main.ts` 的现有 `applyNoteTopmost()` 和 `electron/capsules.ts` 的现有 `applyZOrder()` 在 Windows 上明确使用公开的 `pop-up-menu` 层级；其他平台仍使用默认对应的 `floating`。逻辑 pin 偏好、正文和布局存储不变，没有新增 helper、依赖或原生实现。

原 fullscreen 判定继续先计算最终布尔值，要求避让时只设置 false；已有 show 和移动/缩放后按当前几何重算的补齐保留。C# fullscreen observer 没有更改。该 Windows 层级允许窗口高于任务栏，这是公开 API 的已知语义；置顶或胶囊窗口仍受宿主的 fullscreen 避让控制，取消置顶仍降回普通窗口。

曾评估保留默认层级、仅在读回失败时换层级的条件策略。直接换层级的 host smoke 仍失败（`smoke-1792922265856`）；独立窗口先 false 再重试的对照虽成功（`pin-runtime-probe/retry-c149aeeb-f9ef-43ae-8218-e380726cec72/report.json`），相同条件策略的 host smoke 仍失败（`smoke-1792922370872`）。这说明条件重试不足以在实际宿主生命周期保持状态，已从最终代码移除。最终使用已取得实际成功的明确层级，不保留失效重试、额外日志或放宽断言。

## 验证与产物边界

最终明确层级的行为已通过原完整源码 smoke：`local-build/spark233/pin-diagnostic/smoke-1792922173373/report.json`，`ok=true`，包括原生 pin、双向同步、保存与未保存输入保护。失败的条件重试报告原样保留，不用于证明最终版本。

新 Windows 候选 `pin-keyboard-followup` 已完成独立构建、NSIS、七包/14native/ASAR 审计及自己的 fresh packaged smoke；`smoke-1792922587099/report.json` 为 `ok=true`、`runtime.packaged=true`、`nativePinOnOpen=true`、renderer errors 为空。该轮 `fullscreenAvoidanceObserved=false`，因此不宣称物理全屏条件已验收。精确产物及 gate 见[新包记录](spark233-pin-keyboard-packaging.md)；模式键盘另有 13 项 Windows 实际检查通过，见[键盘记录](spark233-launcher-mode-keyboard.md)。

所有 probe/smoke 数据均在 `local-build/`，没有读取真实笔记/剪贴板、操作 UAC/SYSTEM 服务、关闭用户其他应用或修改系统任务栏。正常启动对照的首次 bootstrap 因误传空 `ELECTRON_RUN_AS_NODE` 而只运行了 Node 并退出，保留在 `normal-b2d18f2d-bab8-4e7b-a460-338d2e882902/stderr.log`；它没有创建窗口，不作为置顶 API 结果。

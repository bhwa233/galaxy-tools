# spark233 P1 Windows 升级验证

记录日期：2026-10-24（Asia/Hong_Kong）。此处验证技术栈升级后的既有便签程序；产品身份仍为花笺，正式 spark233 名称、插件宿主和启动器不在本次完成范围。

## 构建来源

主线程在新依赖 `npm ci`、Electron 安装和新 build 通过后通知执行本验证。Windows 打包显式选择项目便携 Node.js `26.12.1` / npm `12.2.1`，使用升级后的 Electron Builder `26.18.0`，不重装依赖。

```powershell
. ./scripts/use-toolchain.ps1
node node_modules/electron-builder/out/cli/cli.js --win --x64 --dir --publish never --config.directories.output=local-build/spark233/p1/pack --config.electronDist=node_modules/electron/dist
```

打包完成，见 [pack.log](../../local-build/spark233/p1/pack.log)。首轮目录包为 `local-build/spark233/p1/pack/win-unpacked/花笺 Electron.exe`，79 个文件合计约 `378.94 MiB`。依赖、运行时和 ASAR SHA-256 见 [build-manifest.json](../../local-build/spark233/p1/build-manifest.json)。没有构建或安装 NSIS。

第三方许可证清单补全后，另外生成未加诊断代码的最终候选包 `local-build/spark233/p1/final-pack/win-unpacked/花笺 Electron.exe`，见 [final-pack.log](../../local-build/spark233/p1/final-pack.log)。[final-package-manifest.json](../../local-build/spark233/p1/final-package-manifest.json) 记录：79 个文件、`397364772` 字节，ASAR SHA-256 为 `c8534847ebf5e74a0a5c4440d52903fa947ce2b5736ad5fdffa706bfa0da72a6`；ASAR 中选出的 37 个前后端代码/样式/HTML/JSON 文件与首轮 P1 包逐字节相同，许可证清单与当前工作区一致，没有打入 `*.test.*` 文件。

## 固定业务数据升级对照

从 [P0 冻结样本](../../local-build/spark233/p0/fixed-fixture/frozen) 复制到全新的 `local-build/spark233/p1/fixed-fixture/profile`，仅将配置中的 `dataDir` 改为该隔离副本，使用新目录包真实启动 GUI 后经 CLI `--exit` 正常退出（退出码 0）。然后通过新目录包中的真实 NoteStore / Reminders API 读回，结合文件 SHA-256 比较。

[fixed-fixture/report.json](../../local-build/spark233/p1/fixed-fixture/report.json) 的全部检查通过：

- Markdown 原文、图片附件和其他业务数据文件逐字节不变。
- 便签 ID、标题、非空分类、文件名、时间、字数和编辑模式不变。
- 未来任务提醒的 ID、noteId、fireAt、createdAt 和 taskText 不变。
- 便签与主窗口布局完整不变。
- 配置除明确要求的隔离 `dataDir` 路径变化外保持不变。

该结果是旧业务数据在新技术栈下的启动和退出对照；不承诺未来产品更名后的旧安装身份迁移。

## 最短 CLI/MCP 链路

复用 P0 的一次性探针，目标改为新目录包，独立数据位于 `local-build/spark233/p1/cli-mcp`。启动前确认共享 MCP 管道没有既有服务。本次 [cli-mcp/report.json](../../local-build/spark233/p1/cli-mcp/report.json) 为 `ok: true`。

已完成 packaged `--mcp` stdio 初始化、append 权限工具列表、创建并读回中文便签，以及拒绝越权删除。`--hide`、`--show`、`--toggle`、`--new`、`--list` 经单实例交接后子进程正常退出且主进程存活，最后 `--exit` 让主进程退出 0。没有扩展测试矩阵或新增仓库测试。

## 既有完整 Windows smoke

首轮真实目录包 smoke 未通过，原始现场完整保留在 [smoke-failed/report.json](../../local-build/spark233/p1/smoke-failed/report.json)。顶部胶囊、文本与 Markdown/图片模式、提醒路径已通过，但在便签列表打开已置顶便签后失败：

```text
Opening a pinned preference did not apply the expected native window level
```

失败现场的布局文件记录目标便签 `topmost: true`，原报告没有记录失败时 `isAlwaysOnTop()`、fullscreenRects 和窗口 bounds，不能根据事后代码阅读认定失败是升级回归或系统全屏干扰。

使用 `local-build/` 中的完整目录包诊断副本，仅在既有置顶断言前后追加实际状态记录，保持原等待时间与断言不变。这轮 [diagnostic-smoke/report.json](../../local-build/spark233/p1/diagnostic-smoke/report.json) 完整通过，且第一次采样就满足原断言：[pin-diagnostics.json](../../local-build/spark233/p1/diagnostic-smoke/pin-diagnostics.json) 记录 `nativeTopmost: true`、`layoutTopmost: true`、`fullscreenRects: []`、`fullscreenSuppressed: false`，窗口为 `(1674,972,360,420)`。该故障未在诊断包重现，不能据此断定首次失败原因，也没有为此改变业务置顶逻辑。

完整 smoke 的图片、公式、主窗口分栏和提醒截图已人工查看，没有观察到本轮技术栈升级造成的布局或图片渲染异常。

随后对未修改业务代码、包含最新许可证清单的最终候选包执行一次确认，既有完整 smoke 通过，见 [final-smoke/report.json](../../local-build/spark233/p1/final-smoke/report.json) 和 [final-pack-smoke.log](../../local-build/spark233/p1/final-pack-smoke.log)。最终报告为 `packaged: true`、`ok: true`，包含 12 张截图；`nativePinOnOpen` 和便签/图片/公式/胶囊/提醒/保存失败保护等既有检查通过。GPU 崩溃计数为 0，硬件合成及栅格化启用，沙箱开关未禁用。运行后核对没有遗留测试 Electron 进程。

首次置顶失败在诊断副本和最终原样包均未再现，根因仍不确定；原始失败没有删除或改写，没有延长等待时间、移除断言或修改业务置顶逻辑。此处记录的是一次失败及随后两次不同目的的通过，而非宣称间歇问题已修复。`fullscreenAvoidanceObserved` 为 false，真实全屏避让和中文 IME 组合输入仍不属于本次已经证明的行为。

一次直接运行提取后的 app 的诊断尝试在更早的图片 decode 检查超时，未到达置顶断言；该结果保存在 `local-build/spark233/p1/pin-diagnostics`，没有用于证明原目录包行为。后续诊断改为完整已打包程序的独立副本，以保持 packaged 上下文。

## 开发启动链与一次进程快照

在隔离的 `local-build/spark233/p1/dev-launcher/config` 和 `data` 下使用项目 Node 26.12.1 启动当前 `scripts/dev-electron.mjs --list`。开发脚本解析 TypeScript 公共 CLI、完成 Electron 编译后，成功拉起 Vite `8.3.5`（日志 ready 1651ms）及 Electron 主进程、GPU、网络服务、两个渲染进程和全屏 watcher。见 [stdout.log](../../local-build/spark233/p1/dev-launcher/stdout.log)、[stderr.log](../../local-build/spark233/p1/dev-launcher/stderr.log) 和 [report.json](../../local-build/spark233/p1/dev-launcher/report.json)。

最短退出尝试在布局出现后只等待 2 秒，渲染初始化/保存确认尚未全部完成，既有保护返回 `saveFailed`，没有强行退出或丢弃内容。初次一次性外部脚本因此等待超时；它不等于开发脚本未能启动。保留同一个活动实例，初始化完成后再发送 `--exit` 成功，随后主进程、开发脚本、Vite 和 watcher 均退出，1420 端口释放。没有为了得到通过结果重新启动多个开发实例。

[process-snapshot.json](../../local-build/spark233/p1/dev-launcher/process-snapshot.json) 记录该实例的完整后代与一次工作集、private bytes 和累计 CPU：包含开发脚本和 Vite 的全树为 10 个进程，工作集 `1026.25 MiB`、private bytes `831.39 MiB`；Electron 主进程及后代（含 watcher 和 console host）为 7 个进程，工作集 `620.27 MiB`、private bytes `385.68 MiB`。这是一份开发启动时的单次快照，不构成空闲、峰值、冷启动时间或最终性能预算。

定位并修正的开发环境问题：Vite 对 `local-build/` 中隔离 Chromium profile 的 `Cookies` 与 `Cookies-journal` 发出 `EBUSY` watch 错误，当时 watch 只排除 `dist-electron`。主线程随后在 `vite.config.ts` 补充排除 `**/local-build/**` 和 `**/release-electron/**`，并针对真实 `createServer` watcher 核查：[dev-watcher.json](../../local-build/spark233/p1/dev-watcher.json) 记录仍观察 337 个目录（含 39 个源码目录），其中 `local-build` 目录为 0，`watcherErrors` 为空，服务正常关闭；对应 typecheck/lint 通过。这项修正采用针对性 watcher 证据，没有重复运行一套 GUI 用例。

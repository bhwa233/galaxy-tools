# spark233 重构前 Windows 基线

记录时间：2026-10-24（Asia/Hong_Kong）。本记录针对重构前工作区和既有便签实现，不代表 spark233 插件宿主或新技术栈已经交付。

## 快照与运行环境

- 分支为 `codex/spark233-refactor`，起点提交为 `0e8c2637558ee1c6640daf59a192cf53a35e8e89`；原有未提交工作保留。
- 原始快照：`C:/tmp/spark233-refactor/p0-2026-10-24T09-57-20-895Z`。工作区文件清单和 SHA-256 见 [snapshot.json](../../local-build/spark233/p0/snapshot.json)。
- 开发运行时为 Node.js `24.14.0`；P0 使用已有安装依赖，没有通过安装依赖来修复基线。
- Electron 二进制实测为 `45.0.0`，内嵌 Node.js `24.22.0`，Chromium `156.0.8078.48`，ABI `150`，Windows x64。见 [electron-runtime.json](../../local-build/spark233/p0/electron-runtime.json)。开发 Node 与内嵌 Node 分开记录。
- Windows `10.0.26300`；CPU 为 AMD Ryzen 7 PRO 8845HS（8 核 16 线程），显示适配器为 AMD Radeon 780M Graphics，驱动 `32.0.32015.7029`。见 [cpu.json](../../local-build/spark233/p0/cpu.json) 和 [display-adapters.json](../../local-build/spark233/p0/display-adapters.json)。

## 现有工程检查

四个现有 gate 已通过，日志由主执行线程保存：

| 命令                | 结果                      | 证据                                                         |
| ------------------- | ------------------------- | ------------------------------------------------------------ |
| `npm run typecheck` | 通过                      | [typecheck.log](../../local-build/spark233/p0/typecheck.log) |
| `npm run lint`      | 通过                      | [lint.log](../../local-build/spark233/p0/lint.log)           |
| `npm test`          | 62 个文件，307 个测试通过 | [tests.log](../../local-build/spark233/p0/tests.log)         |
| `npm run build`     | 通过                      | [build.log](../../local-build/spark233/p0/build.log)         |

没有新增或扩展仓库测试用例。后续 MVP 优先复用已有 gate 和最短真实集成链路。

## Windows 既有 smoke

执行 `pwsh -File scripts/smoke-windows.ps1`。源码模式及目录包模式各通过一次，目录包再复用同一隔离 profile 检查冷恢复。所有配置、便签、图片、布局和 Chromium profile 都在 `local-build/` 下。

| 运行方式                 | 结果                                                       | 报告                                                                                   |
| ------------------------ | ---------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 已构建源码 + Electron    | `ok: true`，`packaged: false`                              | [source-smoke/report.json](../../local-build/spark233/p0/source-smoke/report.json)     |
| Windows 目录包           | `ok: true`，`packaged: true`                               | [packaged-smoke/report.json](../../local-build/spark233/p0/packaged-smoke/report.json) |
| 目录包复用隔离数据冷启动 | `ok: true`，`coldRestoreObserved: true`，恢复 2 项置顶偏好 | [cold-restore/report.json](../../local-build/spark233/p0/cold-restore/report.json)     |

确认的既有行为：便签列表与桌面窗口状态同步，文本与 Markdown 模式保留原文，任务勾选只改变对应标记，图片使用相对路径且宽度保留，正文/图片/公式能渲染，折叠和关闭前保存，重新打开恢复内容，保存失败保留未保存文本及窗口，胶囊队列拖拽和预览，提醒预设及跨窗口同步。

真实渲染结果已查看：

- [便签文本、Markdown 图片和公式](../../local-build/spark233/p0/source-smoke/note-pad-md.png)
- [主窗口分栏及原文](../../local-build/spark233/p0/source-smoke/note-main-split.png)
- [便签列表与桌面状态](../../local-build/spark233/p0/source-smoke/note-states.png)
- [顶部胶囊](../../local-build/spark233/p0/source-smoke/capsules-top.png)
- [无焦点胶囊预览](../../local-build/spark233/p0/source-smoke/capsules-top-preview.png)
- [便签提醒](../../local-build/spark233/p0/source-smoke/reminder-pad.png)
- [磁贴提醒](../../local-build/spark233/p0/source-smoke/reminder-tile.png)

每次完整 smoke 保存 12 张 PNG。首次运行的 `coldRestoreObserved` 为 false 是新 profile 的自然结果；复用 profile 后该项为 true。`coldVisibleQueue` 仍为 false，因此这份基线不将“冷启动时已有可见胶囊队列”认定为已观察通过。`fullscreenAvoidanceObserved` 也为 false，未据此声称真实全屏避让已通过。中文正文输入使用 Electron `insertText`，不等价于 Windows 中文 IME 的完整组合输入验证。

现有 smoke 中名称为 `clipboardOnNewNote` 的报告字段只反映新便签可接受图像粘贴的既有检查，不能据此声称读取了系统剪贴板。执行前已检查源码：图片通过内存 canvas、File、DataTransfer 和合成 ClipboardEvent 提供，本次未读取或写入用户真实剪贴板。

## GPU、沙箱与进程证据

源码和目录包 smoke 均报告：GPU 进程崩溃计数 `0`，`gpu_compositing: enabled`、`rasterization: enabled`，未带 `no-sandbox` 或 `disable-gpu-sandbox`。渲染页面的 `typeof require` 为 `undefined`，允许的 IPC 可读隔离便签，未授权外部文件读取被拒绝，资源协议访问隔离配置文件返回 `403`。这些是应用层和 Chromium 功能状态证据，不等价于操作系统令牌级沙箱审计。

源码 smoke 期间以约 1 秒间隔采集限定于该测试主进程及后代的进程树。213 条进程样本覆盖 29 个时间段，累计观察 23 个 PID；单个时间段最多 10 个进程，观察到的进程树工作集最高约 `1558.93 MiB`，private bytes 最高约 `865.87 MiB`，各 PID 首末样本之间 CPU 时间累计 `52.66 秒`。见 [原始进程样本](../../local-build/spark233/p0/smoke-process-samples.json) 和 [汇总](../../local-build/spark233/p0/smoke-memory-summary.json)。

以上是在主动创建、销毁多个渲染窗口的自动 smoke 中取样，并非托盘空闲占用、冷启动延迟或最终性能预算；跨 PID 样本有时间偏差，也可能漏掉进程起止时的分配。不能据此认定新启动器的性能门槛已完成。

## 目录包与 CLI/MCP

P0 目录包采用 Electron Builder `26.15.3`：

```powershell
node node_modules/electron-builder/out/cli/cli.js --win --x64 --dir --publish never --config.directories.output=local-build/spark233/p0/pack-local --config.electronDist=node_modules/electron/dist
```

结果为 `local-build/spark233/p0/pack-local/win-unpacked/花笺 Electron.exe`；79 个文件合计 `397284182` 字节（`378.88 MiB`），见 [构建日志](../../local-build/spark233/p0/pack-local.log) 和 [体积记录](../../local-build/spark233/p0/package-size.json)。没有构建或安装 NSIS，本记录也不作为 NSIS 安装、升级或卸载通过的证据。

首次未指定 `electronDist` 的构建在 Electron 解压目录切换时失败：`EPERM: operation not permitted, rename ...win-unpacked.tmp -> ...win-unpacked`，见 [首次构建日志](../../local-build/spark233/p0/pack.log)。复用已安装的同版本 Electron 分发后目录包成功；没有为此变更 package.json、lockfile 或 node_modules。

使用成功目录包运行最短隔离 CLI/MCP 链路；一次性探针和数据仅保存在 `local-build/spark233/p0/`，没有加入 Vitest 套件：

- 启动前探测既有 MCP 管道；若存在预先运行的服务则直接退出，避免触及用户服务。本次没有既有服务。
- 隔离 profile 开启 append 权限，经已打包的 `--mcp` stdio 入口完成 initialize、tools/list、新建中文便签、读回并核对持久化正文。
- append 权限下删除工具不出现在 tools/list，强行调用删除被拒绝（`-32602`）。
- 向已运行的隔离主实例发送 `--hide`、`--show`、两次 `--toggle`、`--new`、`--list`；子命令均退出 `0`，主实例保持运行。这里只证明单实例交接和进程存活，未另行断言每一步的视觉状态。
- `--exit` 后主实例退出 `0`；核查时没有遗留测试 Electron 进程。退出保存的内容保障同时由既有 smoke 的关闭/折叠/保存失败路径佐证。

完整响应见 [cli-mcp/report.json](../../local-build/spark233/p0/cli-mcp/report.json)。报告不含握手 token。

已知非阻断现象：并行 `--mcp` 入口的 application.log 有 Chromium `Unable to move the cache` / `Gpu Cache Creation failed: -2`，而上述协议请求全部完成。后续应检查 MCP 启动入口是否不必要地与 GUI 使用同一个 Chromium cache/profile；目前不将此问题描述为已经修复。见 [application.log](../../local-build/spark233/p0/cli-mcp/application.log)。

## 升级对照与剩余边界

已冻结源码和目录包 smoke 的完整隔离样本，包括 Markdown 文件、图像附件、metadata、布局和提醒文件；CLI/MCP 样本另含显式配置与中文持久化数据。升级复测必须从这些路径复制到新隔离目录，不能修改已保存的基线副本，也不能使用真实用户目录。

现有 smoke 最后会清理临时提醒，因此另外建立一份最小固定样本，补齐 P0.6 的非空分类和活动提醒。样本直接使用 P0 已打包旧程序中的真实 `NoteStore` / `Reminders` API 创建，然后启动旧 GUI、恢复便签窗口、经 `--exit` 保存退出（退出码 0），最后冻结数据与配置；没有修改原始 smoke 报告或增加仓库用例。

- 冻结目录：[fixed-fixture/frozen](../../local-build/spark233/p0/fixed-fixture/frozen)。后续只读取原件，复制到新的升级隔离目录运行。
- [manifest.json](../../local-build/spark233/p0/fixed-fixture/manifest.json) 记录生产者、完整原文与元数据、配置、布局、提醒和 6 个冻结文件的 SHA-256。
- 便签 ID 为 `ff73f860-0c00-4d9c-9cd0-eab04d918a33`，非空分类为 `升级验证`；Markdown 包含中英文、强调、公式、未完成任务和带 `{width=75%}` 的本地 PNG 引用，编辑模式为 Markdown。
- 图片使用既有 smoke 生成的附件，由真实 `saveImage` 写入；附件路径位于 `images/<noteId>/`。
- 活动提醒 ID 为 `3e275e1a-967a-4d04-9996-d7c35c389857`，关联任务为 `保留活动提醒`，计划时间为 `2027-04-22T10:14:05.662Z`（香港时间 2027-04-22 18:14），避免升级验证期间触发真实通知。
- 配置显式保存深色主题、`zh-CN`、16px 字体、关闭自启、关闭 MCP 及全局快捷键；GUI 退出后保留了关联该便签的 `420×480` 桌面窗口布局和主窗口布局。

升级前后比较应至少核对：Markdown 文件逐字节与附件 SHA-256；元数据中的 ID、标题、分类、文件名、创建时间、更新时间、字数与编辑模式；提醒 ID、noteId、fireAt、createdAt 和 taskText；布局的窗口身份、noteId、模式、可见/折叠/置顶状态与可用屏幕内几何；主题、语言、字体和行为配置。复制样本时允许把 `config.dataDir` 改为新的隔离目录，并在报告中单独列出该预期路径变化；不能把该变化当成用户内容变化。运行时 Chromium cache/profile 不进入这份冻结业务样本。

该样本生成与冻结已经完成；P1 用新栈打开副本后的实际对照结果仍待执行，不能以本样本存在替代升级验证通过。

P0 的结果仅证明既有便签实现的当前状态。OCR、ScreenCapture、Pulse、七个插件生命周期、启动器、离线首装、插件信任和更新事务均未由本记录验证。P1 必须在新运行时和新依赖构建完成后生成自己的目录包及报告，不能沿用本目录包冒充升级结果。

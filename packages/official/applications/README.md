# spark233 应用搜索

独立 npm 产物，通过宿主 utilityProcess 后台运行。无需 npm 生命周期脚本或运行依赖。

- 读取当前用户和全局开始菜单中的 `.lnk` / `.url`，保留原快捷方式，由宿主通过 Windows Shell 打开，从而保留其参数、工作目录及 Shell 语义。
- 使用系统 `Get-StartApps` 获取本地化的注册应用（含 AppX）及其 AppUserModelId，不对 renderer 提供任意可执行路径入口。
- 宿主设置中的“自定义应用入口”允许选择 `.exe`、`.lnk` 或 `.url`，设置搜索名称并添加、修改、移除入口。`.exe` 可设置逐项参数与工作目录；参数以 JSON 字符串数组编辑，明确保留每一项的空格、引号、中文和空字符串，不解析 shell 命令。快捷方式保留其自身的参数与工作目录。
- 查询参数为 `{ action: "search", query, limit }`，返回稳定的内部索引 ID 与 `commandId: "launch"`；宿主把结果参数保存在查询会话中。执行只能使用索引 ID，后台返回宿主专用启动描述，由主进程适配器再次验证。
- 缓存有效期 60 秒；同一轮发现由查询共享，取消的查询不接收迟到结果，停用会中止发现并等待系统查询进程结束。自定义入口保存在插件独立 `dataDir/custom-entries.json`，使用 fsync 与同目录 rename 原子提交；数据格式版本为 1，总大小不超过 2 MiB、最多 200 个入口。修改入口后立即撤销旧查询，移除入口会使旧启动 ID 失效。无启动历史写入。
- 支持 Unicode 应用原名、英文缩写、中文全拼、拼音首字母、中英混排与多音字，返回 `pinyinSupported: true`。匹配直接复用固定 Pulse 的 `filename_pinyin` 实现和完整 ib-matcher 派生数据；单个拉丁字母仍按 Pulse 的规则只做字面匹配。查询可以带 `locale: "zh-CN" | "en-US"`，不传时使用简体中文提示。
- 拼音助手按查询启动，输入仅包含会话、应用名与查询词，没有应用启动路径；结果校验会话和实际 PID。新查询取消旧查询，停用会等待助手正常退出；父 utilityProcess 崩溃后，助手通过父进程句柄检测退出，不留下常驻进程。

普通输入与 `apps` 模式可以复用同一个搜索调用；本插件不因查询启动应用或请求网络。

`settings` 内部命令只供宿主管理界面使用，参数为 `{ action: "get" }` 或 `{ action: "save", entries }`，返回 `{ entries }`。实际启动仍只消费后台已索引的 ID；主进程对自定义目标再次校验绝对路径、文件类型、参数大小和工作目录，`.exe` 通过 `spawn` 的 argv/cwd 与 `shell: false` 启动，快捷方式通过 Shell 打开原文件。

## 当前实现证据

2026-10-24，在真实 Windows x64 / Electron 45 utilityProcess 中执行包清单校验、发现、查询、内部 ID 解析及停用。发现 171 个开始菜单快捷方式、180 个注册项（其中 25 个 AppX），合计 351 项；该次首次发现 1378.83 ms，缓存原名查询 0.91 ms。这是单机单次观测，未清空系统缓存，不代表跨机器性能保证。

另在 `local-build/` 下覆盖探针进程的 APPDATA/ProgramData 指向隔离开始菜单，生成一个调用隐藏 PowerShell 标记程序的 `.lnk`，经过相同后台查询及宿主 `launchIndexedApplication` 实际 `shell.openPath` 启动，确认快捷方式参数与含空格工作目录均保留。未修改真实开始菜单，也未启动用户的真实应用。未知索引 ID 即使附带 renderer path 仍被拒绝；两次后台停用后资源数为 0，stderr 为空。

报告：`local-build/spark233/applications/runs/2026-10-24T12-59-14-584Z/report.json`。宿主适配器的注册应用分支会重新核对 `Get-StartApps` 再打开 `shell:AppsFolder`；此次没有实际启动真实 AppX 或注册应用，因此不扩大这部分的执行验收结论。聚焦 lint 与不含正在并行改动的 main.ts 的隔离 TypeScript 编译通过。没有新增依赖、Vitest 套件、截图或 UI 验证。

后续拼音接入证据：`local-build/spark233/applications-pinyin/runs/cd66ab01-cec1-417e-b888-980d8a4e0d97/report.json`。真实 Electron 45 / Node 24.22 utilityProcess 查询隔离的 `spark233微信工具`、`spark233重庆音乐` 和 `spark233文档Code2026`，验证全拼、首字母、多音字、中英混排及分词；单次助手进程含启动耗时首次约 153 ms，后续约 46–49 ms。原生取消会话 PID 30760 返回 `cancelled` 并以 0 退出；停用后资源为 0，进程盘点没有本次 driver 或助手残留。此次不启动任何真实应用，不操作 UI。

2026-10-25 的自定义入口代表验证为 `local-build/spark233/applications/custom-report.json`（实际运行目录 `custom-runs/7a6fbb11-562f-40c9-a11b-d079a319a15f`）：配置原子提交、后台重启恢复、全拼召回、实际受控 Node 目标的 argv/cwd、移除后的旧 ID 拒绝与资源释放均通过。所有数据与目标脚本均在 `local-build/`；未启动用户真实应用。此验证不包含最终界面验收。

## 构建与来源

```powershell
pwsh -NoProfile -File scripts/native-applications/build.ps1
node packages/official/applications/build.mjs --native-build-dir local-build/spark233/native-applications/build/bin
```

默认复用 `local-build/spark233/native-search/pulse-source`，不存在时在应用专用 BuildRoot 下准备固定源码。程序约 492 KiB，使用静态 MSVC 运行时，不引入 Rust 或 npm 运行依赖。源码固定为 Pulse `c4fe01ed82fe091f495f531972a854aa32caac2b`（Apache-2.0）以及其中的 ib-matcher `70673969ca837e6eb6caf4e2d22d494a707a5846` 派生拼音数据（MIT）。原许可证、上游声明和输入文件 SHA-256 随 `licenses/` 提供；包内 `native/win32-x64/resources.json` 记录原生产物和本仓构建入口散列。

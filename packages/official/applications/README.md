# spark233 应用搜索

独立 npm 产物，通过宿主 utilityProcess 后台运行。无需 npm 生命周期脚本或运行依赖。

- 读取当前用户和全局开始菜单中的 `.lnk` / `.url`，保留原快捷方式，由宿主通过 Windows Shell 打开，从而保留其参数、工作目录及 Shell 语义。
- 使用系统 `Get-StartApps` 获取本地化的注册应用（含 AppX）及其 AppUserModelId，不对 renderer 提供任意可执行路径入口。
- 1.1.0 后台支持宿主登记程序、快捷方式、普通文档与目录四类入口，设置搜索名称并添加、修改、移除入口。新路径授权和系统打开由宿主负责。`.exe` 可设置逐项参数与工作目录；参数以 JSON 字符串数组编辑，明确保留每一项的空格、引号、中文和空字符串，不解析 shell 命令。快捷方式保留其自身的参数与工作目录。
- 查询参数为 `{ action: "search", query, limit }`，返回稳定的内部索引 ID 与 `commandId: "launch"`；宿主把结果参数保存在查询会话中。执行必须携带该结果的索引 ID 与 selectionVersion，后台返回宿主专用启动描述，由主进程适配器再次验证。
- 缓存有效期 60 秒；同一轮发现由查询共享，取消的查询不接收迟到结果，停用会中止发现并等待系统查询进程结束。自定义入口保存在插件独立 `dataDir/custom-entries.json`，使用 fsync 与同目录 rename 原子提交；数据格式版本为 2（插件 dataVersion 为 1），总大小不超过 2 MiB、最多 200 个入口。修改入口后立即撤销旧查询，移除入口会使旧启动 ID 失效。无启动历史写入。
- 支持 Unicode 应用原名、英文缩写、中文全拼、拼音首字母、中英混排与多音字，返回 `pinyinSupported: true`。匹配直接复用固定 Pulse 的 `filename_pinyin` 实现和完整 ib-matcher 派生数据；单个拉丁字母仍按 Pulse 的规则只做字面匹配。查询可以带 `locale: "zh-CN" | "en-US"`，不传时使用简体中文提示。
- 拼音助手按查询启动，输入仅包含会话、应用名与查询词，没有应用启动路径；结果校验会话和实际 PID。同一 caller 的新查询取消旧查询，不同 caller 相互隔离；停用会等待助手正常退出；父 utilityProcess 崩溃后，助手通过父进程句柄检测退出，不留下常驻进程。

普通输入与 `apps` 模式可以复用同一个搜索调用；本插件不因查询启动应用或请求网络。

1.1.1 在普通查询中先保留自然精确标题匹配，再按 `includeIds` 顺序合并当前可用目标，其余自然结果保持原排序；所有结果仍按稳定 ID 去重。即使 100 个偏好 ID 占满请求，精确标题也不会在合并时被挤出。`onlyIds: true` 保持指定 ID 的原顺序，不运行拼音助手；没有新增第二次查询或执行权限，dataVersion 仍为 1。宿主在满页时不能将未返回的某个偏好 ID 直接判为缺失。

`settings` 内部命令只供宿主管理界面使用，参数为 `{ action: "get" }` 或 `{ action: "save", entries }`，返回 `{ entries, supportedKinds: ["program", "shortcut", "document", "directory"] }`。实际启动仍只消费后台已索引的 ID；主进程对自定义目标再次校验绝对路径、文件类型、参数大小和工作目录，`.exe` 通过 `spawn` 的 argv/cwd 与 `shell: false` 启动，快捷方式通过 Shell 打开原文件。

## 自定义入口与迁移合同

`entries` 每项为 `{ id, kind, title, path, args, cwd }`。UUID 与内部 `idFor("custom", UUID)` 不因改名或明确编辑同一入口而改变；移除后不再解析该 ID，不按标题或同名路径自动寻找替代项。`includeIds` / `onlyIds` 仍按当前私有索引的精确 ID 解析，纯 ID 查询不启动拼音助手。

- `program` 仅接受 `.exe`，保留原 argv 数组和 cwd，交给宿主的目标仍为 `{ kind: "custom", path, args, cwd }`。
- `shortcut` 仅接受 `.lnk` / `.url`，必须 `args: []`、`cwd: ""`，保持原 `custom` 启动目标和 Shell 语义。
- `document` 与 `directory` 同样要求空 argv/cwd；返回 `{ kind: "document" | "directory", path }`。目录只登记本身，不枚举或索引其子项。
- 文档分支拒绝程序、快捷方式及常见脚本/安装包后缀；配置与执行时都检查类型，实时解析后的扩展名也须仍符合该类型。未知执行 ID 附带 renderer 路径不会得到授权。

`custom-entries.mjs` 共享数据验证、普通文档分类和原子写入，避免 backend 与 migration 各维护一份格式。独立 `migration.mjs` 通过已有宿主迁移 worker 的 `migrate` 入口执行 dataVersion **0→1**：只读取/改写本插件的 `custom-entries.json`，将文件 v1 转为 v2；缺失 kind 的旧 `.exe` 归为 program，旧 `.lnk/.url` 归为 shortcut，保留原 UUID、路径和 argv/cwd 语义。迁移不打开、stat 或复制配置引用的外部目标；无配置文件合法，已为 v2 时重放不改写，错误数据不覆盖。配置总大小仍不超过 2 MiB、最多 200 项。

settings 保存兼容旧 program/shortcut 的缺 kind 输入，新文档/目录必须显式声明 kind。缺失或类型变化的目标保留在配置中，但不会作为可用查询结果发布；已拒绝 ID 不会从失败扫描的快照复活。后续完整刷新只有真实 metadata 校验通过才恢复仍配置的精确目标。每次 launch/reveal/copy 都再次检查文件/目录类型、解析后的扩展名和程序 cwd；新文档/目录还要求 realpath 与配置中的 canonical point 相同（Windows 不分大小写），拒绝祖先 junction 或末尾链接后来跳到另一位置；旧 program/shortcut 不新增该 canonical-point 限制。不读取文档内容。metadata 检查只作用于受控配置/将发布候选，不递归扫描目标目录。

新查询的 launch/reveal/copy 参数带 `selectionVersion`，它绑定当前目标类型、路径、argv/cwd 和注册应用身份，不含显示名称。缺失或不匹配时拒绝执行；同 UUID 重选目标或修改参数后，旧查询参数不能指向新配置，改名不改变版本。宿主仍须撤销旧查询会话，不能将版本戳当成新的执行权限。

明确提交的 Save 在首次配置读取前即登记；prepareStop 等待这些已接受写入及串行保存完成，再确认可停止。stop 仍等待真实发现/拼音进程关闭。该合同不表示未点击 Save 的 UI 草稿会自动保存。

宿主负责新建或改变路径/kind/cwd 时的选择器/真实拖入授权，并独立复核执行目标；本插件只消费私有内部 ID，不提供 renderer 任意路径执行接口。备份只保存配置引用，不扩大为备份外部文档或目录内容。普通文档不会通过本合同扩展脚本/安装包执行能力。

## 历史实现证据（1.0.0 输入）

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

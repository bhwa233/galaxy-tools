# 便签引擎收口、数据域与 Windows 候选

日期：2026-10-26。接续 [utility/main 接线](spark233-notes-utility-integration.md)，范围仍为一期原任务。本轮实现、Linux/Windows 门禁、最终候选静态审计和完整 packaged smoke 均已通过，固定旧样本保持通过；P3.1 按原范围完成，当前 47/98，完整一期及人工验收尚未完成。旧报告继续绑定原输入。

## 实现收口

### 通用备份与恢复

`PluginBackupService` 接收宿主登记的 `externalDataRoots`，按插件身份保存外置数据，包含已卸载但仍保留的域。它不再解释便签身份、`dataDir` 或业务文件；配置位置的读取和恢复重绑由宿主回调完成。

新快照和中断 journal 使用 schema 2。schema 1 通过宿主显式提供的 mount alias 读取，原 manifest 不改写，完整预览指纹仍在保存、停机和写入前核对。恢复目标只来自当前授权位置；journal 和默认根不能覆盖已持久化的宿主位置。重启前从受控命名的 previous/target/stage 配置候选核实各数据域，再恢复事务。

可重复入口为 `scripts/verify-plugin-backup.mjs`。它使用正式服务和事务管理器、真实磁盘及子进程突退出；旧快照由固定提交 `37bc1c55d9b544baec2b3ce902a8c0ce6d9ec3e7` 的真实 schema 1 writer 生成，不在 probe 内复制第二份旧 schema。

### 私有数据目录与搜索

`private-data-roots.json` 是宿主只追加的搜索排除账本，位于配置根、可恢复的 `host/` 之外。它仅增加搜索排除，不授予读写、迁移或恢复权限。当前与历史数据根、配置根及恢复保护根均被保留；恢复较旧宿主配置不会撤销这些排除。

便签引擎先规划迁移目标，通过当前 owner/request/storage grant 绑定的 `storage.protectRoot` 请求宿主批准；宿主只接受本次迁移已授权父目录中的目标，并拒绝与源、宿主或恢复范围重叠。登记落盘且在途搜索完成取消后才复制；授权后目标变化会被再次拒绝。导出快照及恢复 target/stage/previous/failed 也在写入前登记，失败残留不会回到普通文件搜索。

搜索在请求、返回结果与执行旧选择时读取最新排除；登记会撤销旧 generation、selection 和 cursor，并等待 native 取消。登记或取消失败则停止新复制，保留已登记根供重试。没有通过扫描真实用户目录来发现私有数据。

### 崩溃恢复与最终保存

真实 `utility.kill()` 暴露旧流程的死锁：已死后台无法再确认最终布局，旧 owner 留在待恢复状态，重新启用反复 `pluginSaveRefused`。现在释放已死资源时保留活编辑器、未保存文字和内存布局；新 owner 重用活窗口，通过 manager 保存，已死 renderer 才按布局重建。待恢复时，停用、卸载、覆盖安装及备份维护均拒绝跨过尚未归属新 owner 的活窗口。管理页错误态提供“重试”，而不是再次发送停用。未重新启用时，脏窗口仍会拒绝退出保存，不将丢弃内容视为成功恢复。真实 renderer 点击该按钮并保存的检查已经通过。

### 设置只提交字段变化

`config_patch` 使用严格白名单，合并宿主最新配置；命令快捷键按命令身份合并。SettingsPanel 和两个宿主入口只提交本次改动，写入排队，关闭准备等待未完成设置写入。背景授权、数据根显式迁移与原生失败回滚保留。

旧全量 `config_save` 返回 `obsoleteClient`。旧独立便签 renderer 需要更新归档，不能把该协议变化说成旧页面完全兼容；当前新归档已经包含补丁调用。该变化不把宿主配置权限开放给第三方插件。无关字段补丁不再重复注册全局快捷键，避免已存在热键冲突阻断字体等设置；快捷键修改本身仍执行校验及失败回滚。

### 提醒状态事件

原完整 Windows smoke 暴露提醒已落盘、界面列表仍为空。后台现在在变更事件中传递完整提醒数组，main 保留该 payload；原 hook 能立即更新提醒角标和列表。现有 utility verifier 加入该事件契约检查，保留真实 timer 校验，没有用空通知替代。

### 原生内容索引配置归属与早期探针隔离失误

Instant 配置直接读取 `LOCALAPPDATA`，原 Search helper 仅设置搜索 profile，导致配置 sidecar 脱离插件数据域。现在仅在已验证的 search/service-status 分支，将该子进程的 `LOCALAPPDATA` 绑定到宿主给定 profile；不改变系统环境或 SCM。新 Search SHA-256 为 `2bd0e8e517576bf337358f0ba28bd7bbacd4912442f2199bf25ca55f98126571`。真实旧字节在合成父目录创建 sidecar，新字节将其留在请求 profile，父目录保持为空；原 12 项私有根检查及两项新归属检查全部通过。

早期两次失败探索 `run-20261026T044646Z`、`run-20261026T044646Z-admit-fixture` 未隔离 `LOCALAPPDATA`，可能读写 `C:/Users/40417/AppData/Local/spark233/ContentIndex/content-v1.sqlite.config`。真实 helper 日志分别为 UTC 04:47:34.759–04:47:34.794、04:48:01.651–04:48:01.686；不能将 run 名当实际开始时间。只读 metadata 核对该目录当前有一个 1746 字节配置文件、创建及修改时间均为 UTC 04:48:01.6114785，未见 SQLite 文件。未读取共享配置正文、未猜测回滚；这些 metadata 不证明此前完全无触及。纠正后的所有回归均用合成父目录和独立请求 profile，报告明确保留此失误及限制。

## 当前验证

| 范围               | 当前结果与边界                                                                                                                                                                |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux 门禁         | 完整 typecheck、lint、33 文件/163 项、renderer 和 notes 单包构建通过                                                                                                          |
| Windows 门禁       | Node 26.12.1/npm 12.2.1，完整 typecheck/build/NSIS 通过；lint 零警告/零错误，33 文件/163 项通过                                                                               |
| 真实 utility       | `notes-backend-probe/run-2qGuBL/report.json` 五组通过，含完整提醒列表事件、真实提醒 timer、拒绝删除、drain、第二次 prepare 和重启保持                                         |
| 通用备份           | `plugin-backup-probe/run-L1korv/report.json` 七组通过，包含 schema 1/2、真实突退出、授权拒绝和保护副本；导出目录在首次创建前已经登记                                          |
| 真实 main/renderer | `notes-main-probe/run-Kglnct/report.json` 七组通过，含管理页实际点击“重试”后的脏窗口恢复、定制目录的 schema 2 创建/预览/恢复及正文附件保持                                    |
| 主进程私有根绑定   | `notes-main-probe/run-x5YwV5/private-roots-binding.json` 核对旧根、当前根、失败迁移根、导出快照与恢复 siblings 均持久排除                                                     |
| 设置与最终保存     | `notes-main-probe/final-save-smoke-FJ1uaD/report.json` 通过真实两窗独立 patch、目录与旧协议拒绝，以及原最终保存检查                                                           |
| Windows 原生私有根 | `private-roots-native-probe/windows-profile-regression-green-2026-10-26.json` 14 项通过：旧选择撤销、实际 native 取消后复制、重启排除和 profile 配置归属；旧字节 red 报告保留 |
| 部分复制失败       | `private-roots-engine-check/run-FUKPMv/report.json` 通过真实 backend 引擎的先登记、拒绝不复制、部分复制失败及重启保留；不冒充 utility 或 OS 验收                              |
| 当前 Windows 候选  | `notes-engine-2026-10-26`，目录包/NSIS、30 项静态审计、11 项固定旧样本及完整 fresh packaged smoke 通过；输入绑定见下文                                                        |

表内 Linux 报告均相对于 `local-build/spark233/`，使用合成数据和独立 profile。Windows staging 为 `C:/Users/40417/AppData/Local/spark233/build-staging/00C2B9AB54BF`，其证据目录为 `local-build/spark233/notes-engine-2026-10-26/`。

## 构建身份与可重放条件

便携 Node/npm、PowerShell 7.5.4、CMake 4.4.4、Ninja 1.13.2、MSVC 14.51、SDK 28000 及 ATL 已在独立工具链根准备。只提取和编译构建资源，没有安装应用或 SYSTEM 服务。五个原生插件共 14 个 payload，39,668,560 字节，来源与资源清单已重新核对。

当前 ECDICT 仍来自锁定提交 `ab22ad36302cafc6349a050e2b60894855208055`，770,611 词条，102,096,896 字节。本机 Windows SQLite 构建产生的 SHA-256 为 `d7c046f2ba43d2630cf276fb5b790f85c8f3d3f26ca12c1b7ef29d5db995a489`。数据库与本次生成的 provenance 成对校验，不沿用源码内另一构建产物的摘要。

源码按清单逐文件复制和散列核对，保留 Windows `node_modules`、原生 payload 及构建缓存，没有用 `/MIR` 删除生成资源。构建日志保留第一次词典 provenance 不匹配的失败及按原 builder 重建后的成功；没有跳过该校验。跟踪的生成 `backend.mjs` 和词典 provenance 作为派生输出另行核对，不能宣称构建后所有源码文件字节都没有变化。

## 尚未完成的范围

新候选的自动回归与固定样本证据已经独立绑定，完整一期仍未结束。真实安装/卸载、SYSTEM/UAC、物理断网首装、IME/多屏/热插拔、原生截图标注、真实回贴、完整资源预算与公开 npm 发布仍按原条目保留。没有降低原一期范围，也没有用单条 green 声称整个项目完成。

## 最终候选绑定

正式 `dist:win` 已退出 0，静态审计 30 项全部通过：237 个冻结生产源文件、68 个编译文件、72 个 renderer 资源、7 个插件归档和 14 个 native payload 一致。审计明确核对管理页错误态“重试”逻辑、主进程待恢复保护及新 Search 源/manifest/二进制绑定；静态存在性不代替实际 UI 与 native 回归。

| 文件                                               |    字节数 | SHA-256                                                            |
| -------------------------------------------------- | --------: | ------------------------------------------------------------------ |
| `release-electron/spark233-1.2.0-x64.exe`          | 210272811 | `f96c64af68b176f4538fb2e05e5c4f591ba062a1c1597ddffbab21fb94e0b3b6` |
| `release-electron/win-unpacked/resources/app.asar` |  36649117 | `604645f9ceeb5fa7a561c594c6c652e3ecd055388dc9a2104e20a740b7ac0ab8` |
| `release-electron/win-unpacked/spark233.exe`       | 249797632 | `d08a254db2573b5b4a6bb371dea81f78525704f33984808fe4e33693ad1fc4a1` |

`electron-smoke/41cdc1c4-794d-434a-9eed-236d81aab4bf` 最终报告 `ok:true`、renderer errors 为空，包含模式、提醒、共享列表、胶囊、资源拒绝、GPU/沙箱、维护恢复、独立设置补丁及最终保存。原 wrapper 的 120 秒截止早于约三分多钟的完整运行，先返回 timeout；报告随后生成且 PID 已退出，但未捕获该次退出码，因此不以它单独宣称 wrapper 通过。正式脚本保留全部断言，将总时限设为 300 秒，新增 `process.json` 明确记录 UTC 起止、耗时、超时状态和实际退出码；后续顺序执行的固定旧样本与 fresh 完整链均已通过。

notes 归档 `notes-0.1.1.tgz` 为 1,367,898 字节，SHA-256 `4e0df90f54f9396e53fbb1398a0ab66401350e66d0fe9bef76aeb3fd4d7ed97b`；fresh 与 seeded 实际安装的 79 个文件均逐成员匹配。

安装器未执行，未签名，也未安装 SYSTEM 服务。

最终完整链为 `electron-smoke/c94c7be6-ea9b-4abe-a711-da40a9378cf0`：UTC 05:32:12.2553546 启动、05:35:44.5227069 退出，212.288 秒，应用实际 `exitCode:0`，wrapper 也退出 0，`timedOut:false`。报告 `ok:true`、`errors:[]`，GPU compositing enabled 且 sandboxEnabled true。当前环境 `Alt+Space` 注册冲突作为可见业务错误保留；无关设置补丁正常保存，不将该环境状态宣称为热键实机验收通过。多屏迁移、冷启动可见队列与全屏避让本次未观察到对应条件，仍按其他条目保留。

固定旧样本为 `seeded-smoke-pQcL2D`，11 项通过，应用及 runner 均退出 0。固定 ID/分类/模式/创建修改时间与 Markdown 原文保持，PNG 和提醒文件摘要保持，隐藏置顶布局及冻结源副本未改；七插件启用且无安装错误，剪贴板启动前后均暂停、零条。提醒时刻仅为避免真实通知而设置在次日，所有业务数据均是合成 fixture。该检查使用独立 AppData/LocalAppData/ProgramData/TEMP；未宣称全文件系统沙箱。

仓库内可审阅入口为 `local-build/spark233/notes-engine-2026-10-26/` 的 `artifact-audit.json`、`fresh-packaged-smoke/{report,process}.json`、`seeded-smoke/{report,process,seed}.json` 及 `final-candidate-binding.json`，原 staging 报告和失败现场保留。最终 binding 重新计算安装器、ASAR、exe 和 notes 归档散列，并逐成员核对 fresh/seeded 两份实际安装的 notes 包，确保相同候选覆盖全部证据。安装器和 notes 归档另复制至同一证据目录供检查；复制后按摘要核对。

按 P3.1 原文所需的插件业务归属、界面接入及固定数据/保存恢复已闭环，重新勾选该项，清单由 46/52 更新为 47 完整完成、51 部分完成或待验收/发布。其余条目的物理操作、目标机安装、资源预算和公开发布没有随此项一起勾选。本轮未提交或推送。

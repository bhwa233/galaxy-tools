# 启动器固定、个人别名与命令隐藏

日期：2026-10-26。对应实施清单 P3.13、P3.14、P3.15，接续 P3.12 分批查询。**P3.13、P3.14、P3.15 已按原条目完成并勾选。** 独立查询/owner、真实命令 UI、正常重启、七包性能对照及最终 Windows 候选均已有实际结果；本文继续区分各份报告输入与人工验收边界。

## 当前实现

复用 `launcher.json`、宿主 atomicWrite、现有查询会话/action map 与共享 UI 组件。`electron/launcher-preferences.ts` 统一保存首次引导、使用统计、固定顺序、别名及隐藏状态；每次修改只提交一个入口的一项操作，避免旧窗口或使用统计保存覆盖其他偏好。

公开命令按 packageName/pluginId/commandId 绑定，应用按官方 provider 的 npm 身份及已有稳定 application ID 绑定。存储不包含 renderer 提交的启动路径、执行参数、query 文本、上下文句柄或一次查询 token。标题与说明仅供同名区分和缺失时展示，不能用来选择替代执行目标。

首次操作应用来自当前 caller 的宿主私有 action；现有偏好与公开命令目录使用宿主已知 key。未知 key、跨 caller 的 selection、额外路径或参数不产生执行授权。偏好改变撤销所有旧查询/action，并通知窗口按新 revision 重查。公开命令、provider、owner 及实时目标的原执行校验保留。

空查询页按用户顺序显示独立固定区，近期使用不重排该区。固定应用通过一次有界 `onlyIds` 查询从当前 inventory 重新解析；普通搜索将个人别名命中的稳定 ID 合入同一次应用查询，避免同 caller 两次 provider 请求互相取消。缺失目标保留原位置并显示不可用，管理中可移除；每次实际查询重新生成 token。

个人别名仅影响匹配，最多八条、每条 80 字符，做 NFKC、首尾空白和重复校验；不会解释成 shell 命令，也不会自动执行 AI。原命令关键词、清单别名及原名称拼音继续参与原查询。

隐藏是公开命令的启动器展示偏好：默认查询、模式入口、别名及固定命令使用同一过滤。管理目录保留隐藏项并允许恢复；不改变 manager 的权限或全局快捷键/内部调用语义。隐藏与停用插件分别管理。

界面复用 Dialog、Button、Input、Textarea、Badge 与已有字体/主题，提供结果操作菜单和固定可见的“入口管理”。管理支持固定/取消、上下移动、逐行编辑别名、隐藏/恢复，以及缺失应用移除；没有新增依赖或另一套执行引擎。

## 已有独立证据

- `electron/launcher-preferences.test.ts` 四项已通过：旧两字段存储升级后的交错保存及重开、固定顺序独立于 usage、同名/不同 kind/不同 npm owner 身份隔离、别名规范化/重复拒绝及实际写入失败不改变内存或文件。
- `local-build/spark233/applications-stable-id-probe/summary.json`：旧 backend `cc4d14…` 的真实 red 证明 `onlyIds` 被忽略且前 100 外目标丢失；新 backend `43bcfcd1dac6358ac65b3531fec533949259053716fba31eea06c493e2a1c9c1` 在独立 Windows utility 的七组验证通过，含 125 个自定义目标中的精确有序解析、跳过拼音、include 去重、完整删除/同名不替代、caller/取消及真实子进程退出。没有执行应用或读真实应用列表。
- 当前 Linux typecheck、lint、前端及 Electron 编译通过，34 文件/167 tests 通过。它们不能代替真实 UI、Windows 打包或旧选择的执行边界证明。

- `launcher-stable-prefs-probe/summary.json` 的 run-d52Lnw 六组真实 Windows Controller/Manager/应用 utility 验证通过：从 opaque 选择提取 stable ID、跨 caller 与路径注入拒绝、混合固定顺序/重开、单次 onlyIds/includeIds、缺失/恢复和停用/升级/卸载，以及双 caller 在途信号撤销。该报告 controller 为 `a9ab083b…`，不改绑后续修补；应用启动仅记录实际 backend target，不代表 OS 打开。
- `launcher-preference-regressions/summary.json`：旧 a9ab… 三组均实际失败，新 `181c6abc8090bceba66f1b829461cbf47b01787249a219cd385714ff6c731341` 全部通过。修复 13 个应用共用别名时 limit=12 导致误判第 13 个缺失；修复 npm A 卸载后 npm B 同 pluginId/commandId 被旧固定项错误替代；统一过滤 provider 主行与次级动作返回的隐藏公开命令。内部动作和 manager 原授权保持。
- `launcher-preferences-main/final-summary.json` 的 run-EFcfuE 使用真实 Linux main/renderer/IPC/utility，首轮八组、同 profile 重启两组通过，含键盘操作菜单、固定/排序、别名增改删、隐藏的默认/Tab/mode/modeOptions/固定区过滤、其他业务/内部授权、停用/恢复、英文暗色 200% 实际保存。16 次 UI 单字段修改成功、一条跨 caller 拒绝；两次实际托盘“保存后退出”均退出 0，所有 utility 退出 0、持久 state 无 lastError、所属进程空。输入为 main `c8b471ea…`、controller `181c6abc…`、preferences `d8e2b46a…` 与 renderer `index-bbAro3M3.js`。该项只证明公开命令目标，未扩写成实际应用/原生快捷键验收。
- `applications-save-main/summary.json`：旧 main 实际复现保存后同输入不刷新；新 c8b471… 的成功保存、失败后恢复及保存 gate 期间换代四项通过，均使用正常托盘退出，所属进程空。真实 main/renderer/manager/official adapter/utility 链中 backend 是自写 Alpha/Beta fixture，仅证明刷新和 token 边界；实际 Windows inventory 另由前述独立验证证明。

## 七包性能收口

39 项静态包审计与 Windows 167 tests 已通过的 b42f5622… 候选，在独立 `--smoke-launcher-maintenance` 快速入口超过 90 秒 watchdog，没有生成产品报告；实际超时终止和输入保留，不记作通过。

`catalog-performance-2026-10-26/summary.json` 对同一 Windows NTFS 七个已安装包、17 个公开命令做纯 Node 单次阶段计时，未启动 utility/原生 helper：当前 `state()` 7.037 秒（19 次 commands、154 次 metadata），空查询 11.454 秒（35 次 commands、252 次 metadata）；旧 P3.12 对应 0.989 秒和 6.179 秒。`realpath` 占约 89%，零延时 timer 漂移与同步时长一致，证实存在同步重复校验。它不是 RPC 卡死的必要条件，也未单独定位先前 watchdog 的具体阶段。

主线已将 manager 校验后的公开目录复用于同一同步处理栈，状态、初始查询、分组/分页映射和 snapshot 各自建立视图；返回 Promise 时立即清除，不跨 await 或请求保存。owner 检查只在同一同步栈内按完整 owner/command 去重，异步查询返回及执行入口保留独立现场复核。匹配补充新 token 另绑定查询开始时的安装身份，避免迟到拼音结果对新实例铸权。同目录 `green/summary.json` 对完全相同七包目录/状态/manager 做红绿对照：state 7233.68→969.18 ms，空查询 11568.86→652.60 ms，中文查询 3153.96→635.40 ms；每阶段 commands 均降为一次，四组稳定输出字段一致，原 state SHA 不变。controller 为 `a557b3a6127502f8a225ad278da68710323e4adcbfbb827c25d77c0b469a5e41`。`launcher-catalog-cache-probe/summary.json` 再复用前三项回归并增加真实 utility 在 owner preparing 时实际返回旧页的场景，四项通过，证明缓存没有跨 await 复活旧结果/选择；所有实际 utility/native 子进程退出。

各报告保留各自冻结 runtime，不把 a9ab、181c 或旧包报告改绑性能修复输入。新候选使用 `launcher-preferences-2026-10-26` 证据目录；前一候选的维护状态失败见[分批查询补证](spark233-incremental-query-followup.md)，不会重写成成功。旧 UI 观察器过早读列表、错误字段断言及 app.exit 污染的历史 fixture 单列，最终正常重启验证使用全新 profile，没有手改错误状态。

## 最终 Windows 候选

证据目录为 `local-build/spark233/launcher-preferences-2026-10-26/`，最终 `final-candidate-binding.json` 实际 `ok:true`。source-sync 为 488 份输入，SHA-256 `9c9974efe2305c1a357df6393d822c41e0a33be54116a380d438315b0519b320`；静态审计 SHA-256 `2e9d63a3015df8a9b75fc9c3d7dc7c81ca1a813b4aa91e23a0e06b6ce86bf5e8`。构建前的 clipboard 生成清单仅末尾换行不同，单独核对原文件散列、完整 JSON 语义、三个构建源和真实 backend 输出；没有用语义比较放宽其他源或包字节。

| 产物                          |      字节 | SHA-256                                                            |
| ----------------------------- | --------: | ------------------------------------------------------------------ |
| NSIS `spark233-1.2.0-x64.exe` | 210296287 | `9c1f5d4cd6ca66f9d93b80f1db7e72b104126649daa00af8fc3574ec57138c0b` |
| `app.asar`                    |  36707632 | `47e1f8216964a54ed9fc7af766df628008965fdcb6b33f3219f74710f57684a1` |
| 目录包 `spark233.exe`         | 249797632 | `3718d7a22ad4d8bf06bd940017dce276750271073aad9f13a49b54fafc8a53af` |
| `notes-0.1.1.tgz`             |   1370822 | `bf742be7f105a01e318bd64b9604e47760ff1040e8dcf0e34a4ca3fb38f668a7` |
| `applications-1.0.0.tgz`      |    246629 | `913b1fd42d767cd91041fd35a66f722aa235092d3f9320fd8aa7754529a19acc` |

Windows `dist:win`、typecheck、lint 和 34 文件/167 tests 均实际退出 0。39 项静态审计通过，包含七个官方包、69 个编译模块、全部 renderer 与 14 个 native payload（39668560 字节），Search 为适配 8 的正式资源；应用 backend 为 `43bcfcd1…`，最终 compiled controller 为 `a557b3a6…`。原 181c 命令 UI 报告使用相同 c8 main、d8 preferences、bbAro3M3 renderer，但没有改绑为 a557；同步目录修复另有上述功能/迟到回包回归和最终正式包验证。

最终维护快速入口 `maintenance-green-probe/run-EtqWyI`：33.630 秒、实际退出 0、未超时。读状态、查询拒绝提示、恢复命令、清除临时查询错误、动作拒绝以及动作错误在后台成功重查后保留均通过。

固定旧样本 `seeded-smoke-oZX0tl`：11 项通过，53.602 秒、实际退出 0；原 ID/原文/分类/模式/时间、附件与提醒散列、隐藏置顶布局、七插件状态、独立字段保存及暂停且空的剪贴板历史保持。

完整 fresh run 为 `00adf327-a45b-4dd3-98df-9ff7c2035998`：**199.859 秒、进程/外层 wrapper 实际退出 0、300 秒期限内、report.ok=true，checks.errors=[]**。维护恢复、独立字段补丁和最终插件保存均通过；stderr 有已有 Alt+Space 注册冲突及受控拒绝输出，不称为完全无 stderr，但 `tray-notes` RPC timeout 为零。最终 UTC 2026-10-26 13:05:34.2497897 只读进程核对为所属进程空。

seeded/fresh 两次首启解包后的七插件 version/integrity 全部核对；notes 79 个、applications 11 个安装成员与当前 tgz 逐文件大小/散列一致。归档、安装器和 ASAR 已留在 checkout 的 `candidate/`；完整 release、488 份源码快照及绑定记录另冻结于 `C:/Users/40417/AppData/Local/spark233/verification-runs/launcher-preferences-47e1/`，后续打包不会覆盖本候选。`attempt-before-review-fixes`、`attempt-before-catalog-cache`、旧 1613/c1 与失败 probe 保持原身份。

这些结果支持 P3.12–P3.15 的文档范围，不把它们扩写成真实用户应用启动、完整 Settings 各类型、OS 剪贴板/热键、IME/多屏、干净机物理断网、SYSTEM 服务或安装器实际执行。NSIS 未执行、未签名、未公开发布；原相关任务框和最后人工验收要求继续保留。当前主清单为 **57/108 完整完成、51 项部分完成或待验收/发布**。

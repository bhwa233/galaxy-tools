# 便签启停、剪贴板与插件授权、词典更新补证

日期：2026-10-26。范围为 [实施清单](../launcher-todo.md) 的 P2.4、P3.3、P6.5、P6.9、P6.10；不扩展为真实剪贴板监听、回贴或完整物理界面验收。本页记录已执行的代表流程，不修改清单计数。

本轮报告绑定下文的冻结输入。随后 `SettingsPanel` 缩放、关闭、标签及两条语言文案已有源码修复，新的 Windows 候选仍待构建和审计；**本页成功报告不能直接改绑到这些新字节**。前一候选的完整 Windows 检查见 [便签引擎收口](spark233-notes-finalization.md)。

本页的 `local-build/` 路径均相对于仓库，属于忽略的本机证据，不保证随源码分发。

## P3.3：独立便签包、停用撤下与宿主可用

原条目要求便签作为独立 npm 产物加载，停用后保存并撤下窗口、提醒和搜索，宿主仍可使用。

报告：`local-build/spark233/notes-lifecycle-probe/run-qTiKMk/report.json`，`ok:true`、`rendererErrors:[]`。入口为同目录父级的 `prepare.mjs`、`probe.mjs`；冻结运行目录为 `runtime-Vl3vXN`，`bindings.json` 保存产物比对。

实际使用正式 main、renderer、插件管理器和真实 utility。仅将 notes 清单的平台改为 Linux；便签引擎和 renderer 未改写。目录选择通过受控返回连接仓库 Hello Web 示例，系统通知和托盘气泡替换为计数器，不弹出真实 OS 通知。

| 原要求                 | 实际流程及结果                                                                                                                                                                              |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 独立 npm 产物加载      | 从冻结官方 `notes-0.1.1.tgz` 建立独立安装目录，由正式宿主加载 renderer 和 utility backend；不是以 action stub 代替业务引擎。                                                                |
| 停用前保存             | 同时打开真实便签、磁贴和已折叠胶囊；便签关闭自动保存，确认磁盘仍为旧正文后写入未保存中文。通过真实管理页的“停用”按钮执行，随后重新启用读回该次最后正文。                                    |
| 撤下窗口和后台         | 停用后原便签、磁贴、胶囊窗口均销毁；全部剩余窗口精确为启动器和 Hello Web。旧 utility 的 exit 事件已取得，退出码为 0。                                                                       |
| 撤下提醒               | 停用前设置约 1.2 秒后到期的活动提醒。旧 utility 退出后保持停用 **17.265 秒**，超过生产 15 秒 timer 周期；提醒文件字节不变，旧 owner 没有 `notes-reminder-due` 事件，通知/气泡调用计数为 0。 |
| 撤下搜索及旧动作       | 停用前三个便签均可搜索；停用后同模式查询结果为空、便签命令撤下，停用前取得的 opaque action 和公共便签读取均被拒绝。                                                                         |
| 宿主及其他插件可用     | 停用便签时真实宿主设置仍可打开；Hello Web 保持相同 owner，可重新激活，其页面保存内容实际落入自己的私有存储。                                                                                |
| 重新启用保持身份和布局 | 管理页“启用”创建新 utility owner；原便签 ID、最后正文、磁贴与胶囊状态、位置尺寸和队列布局恢复一致，原提醒 ID/时间保留，三条便签搜索结果恢复。随后正常停用清理，新旧两个 utility 均退出 0。  |

报告记录的冻结绑定：

| 输入                   | SHA-256                                                            |
| ---------------------- | ------------------------------------------------------------------ |
| 官方 notes 归档        | `4e0df90f54f9396e53fbb1398a0ab66401350e66d0fe9bef76aeb3fd4d7ed97b` |
| 前一 Windows 候选 ASAR | `604645f9ceeb5fa7a561c594c6c652e3ecd055388dc9a2104e20a740b7ac0ab8` |
| 冻结 main              | `93a379540b2f743e6b2c0312852cc8691285020a25bdd4debd2fbc6efb4dfc89` |
| notes backend          | `34be0eae15d7c85caeb80b45e60140c646e0862f95501edd7721d226c6bc8474` |

`prepare.mjs` 实际比较归档与前一候选绑定、main 与 ASAR 内字节，三项 binding 均为 true。平台清单改写后的 Linux fixture 归档有自己的 SRI，不冒称其 tarball 散列仍等于原 Windows 归档。

这些结果覆盖 P3.3 的原范围。它们不证明 Windows 物理焦点、托盘鼠标、通知外观、IME、多屏或完整升级过程；不把这些其他条目的范围追加为本条完成条件。

## P6.9、P6.10：真实组件与数据后台

报告：`local-build/spark233/clipboard-ui-probe/run-u5g43w/report.json`，`ok:true`，`uiAssertions.checks` 的 **16 项均为 true**。`filesystem-check.json` 为独立物理文件复核。入口为 `clipboard-ui-probe/probe.mjs` 和 `drive.js`，`driver.log` 保存代表流程结果。

从前一 Windows 候选的正式 clipboard tgz 校验 SRI 后，解包到本次独立目录，运行其中真实 renderer、`ClipboardPanel`/`ClipboardWorkspace` 和 utility backend。Linux Electron 45 使用独立 CDP 会话、1200×900 viewport 操作真实组件及表单事件。桥接仅提供本次所需的数据请求；没有构造 native clipboard adapter，始终暂停记录，并拒绝 copy、paste、emoji.copy 和恢复记录等 OS 操作。没有读取、修改真实系统剪贴板或用户历史，也没有覆盖正式 main/native adapter 的整条调用路径。

合成样本为四条文字和一条图库图片。A、B 经真实组件收藏；C 为占用约 0.2 MiB 的待清理文字；D 随后经 UI 置顶，用于证明确认时仍保留受保护内容。图库样本在独立数据域预置，**不作为图库原生文件选择/导入 UI 已验收的证据**。

### 条目与实际流程

| 条目及原要求                   | 取得的证据                                                                                                                                                                                                 |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6.9 历史与独立收藏            | 实际执行两次 favorite 请求并切换历史/收藏视图；最终仍有两条收藏，清理不会移除这些独立引用。                                                                                                                |
| P6.9 分别排序                  | 在历史中将 B 移至顶部，再在收藏中将 A 移至顶部；`order` 与 `favoriteOrder` 分别改变各自结果，另一视图顺序保持。对应 `historySort`、`favoriteOrderIndependent`。                                            |
| P6.9 分别置顶                  | 收藏中置顶 B 不改变其历史 pinned；历史中置顶 A 不改变其 favoritePinned，收藏仍由 B 居首。对应 `favoritePinIndependent`、`historyPinIndependent`。                                                          |
| P6.9 多标签、备注、编辑与恢复  | UI 保存“已编辑的合成文字 A”、备注及两个标签，真实后台读回一致；再点击“恢复原文并放弃草稿”，原文恢复且备注和标签保留。恢复后的原始 snapshot SHA 与种子一致。                                                |
| P6.9 清理引用保护              | 预览排除收藏/图库引用，最终确认只删除无引用的 C；A、B 收藏和图库条目仍在，图库分组引用保持。utility 导出原始 snapshot 后逐个比较 A、B、图库的 SHA，均与清理前一致。                                        |
| P6.10 默认不限、启动不自动清理 | 种子设置中 retentionDays/visibleCount 均为 null，暂停为 true；新 utility 启动后五条样本均保留。生产构造流程没有自动清理调用，删除资源只经明确 cleanup.confirm；既有范围/过期保护证据继续见下文。           |
| P6.10 占用统计                 | 真实组件 footer 展示后台资源和数据库统计。清理前五条、两收藏、160232 资源字节；确认后四条、两收藏、198 资源字节，UI 随之更新。物理 SCB 文件另行求和为 198，与后台一致。                                    |
| P6.10 保留范围及可逆性         | UI 将可见条数设为 1 后，仅改变历史可见集合，全部保留数据仍为五条；清空限制后 C 和四条历史重新出现。对应 `rangeHidesWithoutDeleting`、`expandedRangeRestoresItems`。                                        |
| P6.10 待清理、取消与确认       | 首次预览包含 C、D，点击取消后条数及 160232 资源字节不变。随后置顶 D、重新缩小范围，当前 DOM/后台仅将 C 列为候选；最后一次 cleanup.confirm 删除 C，收藏、图库和置顶内容保留。请求日志中只有这一次 confirm。 |

当前新增 UI 证据与此前的数据层证据相互补充：[功能集成记录](spark233-functional-integration.md)保存 `history-1792900022609` 的 24 条数据检查及独立后台的收藏/清理/原始字节报告，包括过期置顶、范围过滤和放宽范围恢复。旧报告未在本轮重新执行，也不改绑为本次归档已运行的结果。

### 产物绑定与统计口径

| 输入                                 | SHA-256                                                            |
| ------------------------------------ | ------------------------------------------------------------------ |
| 正式 `clipboard-0.1.0.tgz`           | `97251e13aa9a519f7fd4d6e6382dbcbca6d859e2c1a19d589893d9be55f8afa0` |
| 解包 backend                         | `5605c6e49d487e48ae71f5879d19a1970cebcd89ace1dcdd8520b7c9b56b0963` |
| 解包 renderer index                  | `88ab769e9f3e6f18175a2f32fc8f2618b657156e498e190079c3a9993a110ff1` |
| 运行时对照的 ClipboardWorkspace 源码 | `11f7675dc32540845bb2db55e7ab569ed73e4a8f8f2c39c621724d85cf1dbdbb` |

UI 资源显示按一位小数换算 MiB，因此 198 字节显示为 0.0 MiB，不表示资源为零。数据库统计包含运行时 DB、WAL、SHM；utility 正常停机 checkpoint 后文件大小会变化，不能用退出后的单个 DB 大小反推当时 footer 错误，也不承诺清理后数据库文件立即缩小。

### 截图与未覆盖范围

同一 run 保存四张 1200×900 截图：`sort-edit-statistics.png`、`cleanup-cancel-preview.png`、`cleanup-confirm-preview.png`、`cleanup-complete.png`。捕获没有等待动画和绘制结束；视觉复核发现 **cleanup-confirm-preview.png 仍显示上一次取消前的两条预览**。它只能作为控件/布局的辅助记录，不能证明最终候选数量。最终仅 C 的判断以 `secondPreviewOnlyC` 当前 DOM 断言、实际请求序列、后台确认后状态和物理文件复核为依据，不能用延迟截图替代这些结果。

这些代表流程覆盖 P6.9/P6.10 的原要求，可据此更新条目状态；本页不自行改清单。没有执行真实监听、复制回贴、UIPI、原应用焦点、图库原生选择器或 Windows 物理交互，它们继续由各自原条目承接。前期 1×1 headless viewport、CLI 清空 number 输入未触发事件及 fixture watchdog 均为未完成的验证输入，最终通过结果仅使用 `run-u5g43w`，不将早期 fixture 失败改写为通过。

## P2.4、P6.5：第三方授权与词典版本更新

### 输入、隔离与交互方式

报告位于 `local-build/spark233/plugin-authority-dictionary-ui/authority-dictionary-Q0wT6K/`：汇总 `report.json` 的 `uiChecks` 12 项及 `restartChecks` 6 项均通过。原始 `observer-report.json` 仍保留首次观察器超时失败，汇总报告没有将该进程改写为退出成功。逐步证据在 `observations/`、`ui-checks.json`、`picker-log.jsonl`；实际进程终态分别见 `process.json` 和 `restart-process.json`。

实际运行 Windows 正式目录包，`app.isPackaged:true`、版本 1.2.0、Electron 45.0.0。测试绑定**旧候选**，不是随后修复 SettingsPanel/Launcher 的源码或新候选。原 ASAR 已复制为报告目录内 `input-app.asar`，可用于保持输入绑定。

| 输入                                | SHA-256                                                            |
| ----------------------------------- | ------------------------------------------------------------------ |
| 正式 ASAR，36,649,117 字节          | `604645f9ceeb5fa7a561c594c6c652e3ecd055388dc9a2104e20a740b7ac0ab8` |
| 正式 spark233.exe，249,797,632 字节 | `d08a254db2573b5b4a6bb371dea81f78525704f33984808fe4e33693ad1fc4a1` |
| 原正式 translation-0.1.0.tgz        | `cd5905f9e64a9d9e0f8f823c85b5b25f1c8f2b7d29564c21165ed75f0630c8a3` |
| 本地 translation-0.1.1.tgz          | `083b3d24b09fe246c44c27b259b5c69c7b652a82aba3e8c86ba7a81fb2b576b8` |
| 本地故意失败 translation-0.1.2.tgz  | `975b7e08a1c4ad5c2ea2fdf7d85837e55936926243cb74923bf5ba9889b172d9` |

归档、完整 SRI、第三方两个版本与词典成员逐个绑定见同目录 `fixtures.json`；fixture 生成和运行入口也已复制。归档保存在 `local-build/spark233/plugin-authority-dictionary-fixtures/prepare-EMXjBf/archives/`，其中 `baseline-translation-0.1.0.tgz` 为原正式包的保留副本。未修改冻结候选、安装系统服务或发布 npm。

使用全新合成 profile，config/data、AppData/LocalAppData/ProgramData 和 TEMP 均指向独立测试目录；剪贴板保持 paused，前后 entries 均为 0。第三方 backend 为本任务编写的可信 fixture，只写所属 dataDir 的 `authority.json`，没有网络、剪贴板或通知动作；第二版只声明新增 `notifications`，不调用实际通知。用于证明保留的 provider 配置为合成值，未调用 AI，也不表示真实用户 provider 配置 UI 已验收。

真实生产 React 管理页通过 DOM click 触发组件事件、生产 IPC、安装器、管理器和真实 utility，不直接写授权或调用安装 IPC 绕过页面。Node inspector 仅将原生文件选择器结果限制为四个固定 tgz 路径；没有替换 utilityProcess、worker 或消息原型。**OS 文件选择器和物理指针操作未验收**。初期预览截图视口未显示完整对话框，预览复选框/按钮的证据为对应 DOM/AX 与安装状态，不能把那些截图当作控件均已可见的证明。后续保存的更新查询、失败详情及已装版本截图只能佐证各自时刻。

### P2.4 原要求与证据

| 原要求                                                | 证据及结果                                                                                                                                                                                                                                                                                                    |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 受限 SDK、来源校验、能力路由，隔离 Web 与可信原生后台 | 沿用[完成审计](spark233-completion-audit.md) W/M/I：真实隐藏 Web 沙箱、来源及未授权能力拒绝；[管理器记录](spark233-plugin-manager.md)中未批准 native 信任时拒绝创建、scope 资源数仍为 0；[包安装记录](spark233-plugin-packages.md)的来源、强 SRI、精确版本与仅确认后授权。此处不把旧 SDK 报告改绑为本轮重跑。 |
| 官方原生插件预置信任                                  | 既有正式包 fresh smoke `c94c7be6-ea9b-4abe-a711-da40a9378cf0/config/plugins/state.json` 只读复核：七个官方条目均 enabled、`grant.native:true`，能力与各自正式清单对应。该 state 位于 Windows staging 的 `local-build/electron-smoke/`；完整 fresh 报告沿用[便签引擎收口](spark233-notes-finalization.md)。    |
| 第三方执行前展示来源、版本、能力并显式授权            | `@spark233-fixtures/native-authority` 0.1.0 实际预览展示文件来源、版本、`node.backend`/`storage` 及可信 Node 拥有当前用户权限的警告。未勾选时确认禁用，无安装记录和 backend 输出；取消后仍不执行。勾选后点击确认才提交精确版本授权、安装并运行，随后页面 Open 激活记录为 true。                               |
| 新增能力重新确认                                      | 导入 0.2.0 增加 `notifications`，真实预览重新要求确认。首次取消保留 0.1.0、原能力及文件；再次仅勾选仍不改变原授权，点击确认后才提交 0.2.0 和三项准确能力。正常重启后版本和 grant 保持。                                                                                                                       |

这些结果补齐 P2.4 先前“授权对话框及新增能力确认待交互验收”的缺口，结合既有 SDK/数据证据，按原功能范围可勾选。可信 Node 后台仍拥有当前用户的系统权限，不据此宣称 OS 权限沙箱；本地包的内容散列也不等于第三方发布者身份认证。公网发布属于 P7.1，不能作为 P2.4 本地可信授权链的新增前置条件。

### P6.5 原要求与证据

| 原要求                                  | 证据及结果                                                                                                                                                                                                                                                    |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| ECDICT 基础约 76 万词条、词形索引与短语 | 沿用[完成审计](spark233-completion-audit.md) T、[词典构建说明](../../packages/official/translation/README.md)和固定 source-lock：770,611 词条、136,400 词形映射、366,599 短语，MIT 来源与许可证随包保留。                                                     |
| 单词即时展示、覆盖与实际体积            | 既有真实 utility 报告 `translation/runs/2026-10-24T13-29-54-823Z/report.json` 验证 hello 精确词条、went → go、take off 短语、详情及 lookup 网络调用为 0；SQLite 实际 102,096,896 字节（约 97.37 MiB）。覆盖依据为全量构建统计与代表查询，不声称逐词人工验收。 |
| 可版本化、独立更新                      | 保留完整正式词典资源，将包版本改为 0.1.1，经真实管理页预览/确认更新后显示新版本，重新打开查询 hello，中文释义实际出现。此版本 DB、provenance、renderer 字节不变，证明固定完整语料的版本包替换，不表示已经更新为另一份语料或执行 DB schema 迁移。              |
| 更新失败仍可用                          | 0.1.2 使用相同词库与 renderer，但 backend factory 故意抛错。真实管理页展开错误；管理器回滚至 0.1.1，保留原 grant、DB/provenance 和合成私有配置 SHA；失败预览可取消，pending 清空，再次查词成功。正常重启后 0.1.1、配置及查询仍保持。                          |

本轮 Windows 词库 DB SHA 为 `d7c046f2ba43d2630cf276fb5b790f85c8f3d3f26ca12c1b7ef29d5db995a489`，provenance SHA 为 `03fe4bc0169bf3ae5b1ca3e38a82a6113f39deff9441c1d05e98b1deff83429e`，在原包、0.1.1 和回滚结果间一致；它们与历史构建说明中的 DB SHA 属于不同构建输入，不互相改绑。合成 `provider.json` 在更新/回滚后 SHA 仍为 `5f66a70d1bccbd9fe3e4d1485b3bf4169361c12b54ccd2b1c1e62a6b1ef2a838`。

这些结果补齐 P6.5 先前“词库独立更新交互待验收”的缺口，结合既有规模、离线查询和资源绑定，按原功能范围可勾选。“完整版后续可选”仍为可选，不新增必须构建完整版、发布 npm 或更换实际语料才能完成当前条目的条件。

### 首次观察器失败、正常退出与未归因错误

| UTC 时刻            | 原始事实                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 06:03:39.682        | 首次正式主进程 PID 3212 启动。                                                                                                                                            |
| 06:17:21.077449     | 首次 stderr 的最终写入时刻；其中共有四条 `tray-notes Error: Plugin backend activate timed out`。单条日志没有 UTC、requestId 或 owner ID，不能据文件时间生成四条发生时间。 |
| 06:18:15 / 06:20:59 | 新能力 0.2.0 / 词典 0.1.1 的 picker 记录；四条 timeout 均早于这两步，不能归因于词典更新或回滚。                                                                           |
| 06:33:40.335        | 观察器达到 30 分钟 deadline，以 taskkill 结束首次进程，实际 exit 1，`timedOut:true`。                                                                                     |
| 06:34:23.277        | `shutdown.json` 才被写入，比进程被结束晚约 43 秒；首次 deadline 前尚未请求产品退出，不能据此判定 quit 挂起，也不能把首次观察器记作 exit 0。                               |
| 06:42:31.853        | 同一合成 profile 无 Node inspector 短重启，PID 37044。                                                                                                                    |
| 06:43:34.755        | 通过产品真实单实例 CLI `--exit` 请求退出，CLI PID 43776 最终 exit 0。                                                                                                     |
| 06:43:37.359        | 主进程实际 exit 0；距退出请求约 2.604 秒，总运行 65.506 秒，无超时或强杀。                                                                                                |

四条旧日志的栈指向 main 全局菜单调用 notes list 所经的 activate RPC 超时，不是 init/prepare 的错误。当前仍无根因结论；无 inspector 的 65.5 秒重启未出现同类错误，只能证明该次短运行没有重现，不能据此归因于 inspector。原 stderr、失败 observer 和正常重启记录均保留，最后的本次程序及其 native 子进程范围检查为空。后续最小重放或新版候选验证应独立记录，不改写本次历史结果。

另行最小重放保存在 Windows 独立目录 `C:/Users/40417/AppData/Local/spark233/verification-runs/notes-rpc-replay-20261026T065629Z/`，同样冻结旧 ASAR `604645…`，不参与上述 12 项授权/词典通过计数。安全证据已复制至 `local-build/spark233/notes-rpc-replay/` 的 `inspector-off-report.json`、`inspector-on-report.json`、`diagnosis.json` 和 stderr。两个 run 各用 fresh profile 执行便签停用/启用、OCR 停用/启用三次及 21 次显式 notes_list：关闭 inspector 时没有 tray timeout、显式读取最长 350 ms，实际退出 0；开启时出现两次 tray timeout、21 次显式读取仍通过且最长 505 ms，报告 `ok:false`。协议日志仅记录安全元数据，不记录便签正文。

重放开启 inspector 时的 `57286f3f…`、`3e4a0225…` 两个 note.list 请求，从发送到宿主收到 `ok:true` 分别约 13.161 秒和 13.051 秒，发送、取消和回包的 owner 完全一致；回包分别晚于 timeout/cancel 11 ms 和 1 ms。10 秒 timeout 本身也延迟约 3 秒触发，这支持宿主主线程调度延迟的解释，不支持将该重放直接认定为 stale owner 或 backend 初始化失败。仅开启组附加了内存 Date.now/array.push 的协议插桩，虽不在主线程读写或 hash 文件，仍不能排除调试/观察器负载；一对 run 不能证明 inspector 是唯一根因，也不能把两个新错误与原四条日志逐条绑定。该重放退出时另有 `Waiting for the debugger to disconnect...`，断开调试连接后进程消失，但没有捕获真实 ExitCode，**不宣称其退出 0**，与上表实际退出 0 的独立短重启分开记录。重放程序及其 native 子进程已在 UTC 07:25:54.9288350 确认无残留。

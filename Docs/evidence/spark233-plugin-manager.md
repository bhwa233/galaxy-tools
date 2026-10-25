# spark233 插件后台与更新恢复证据

日期：2026-10-24（Asia/Hong_Kong）。本记录覆盖 P2 的一个真实后台生命周期和一条更新失败数据恢复链，不将它扩展为完整插件产品、插件 UI 或全部安装/升级场景已经交付。

## 运行资源与可信后台

实现位于 [resources.ts](../../electron/plugins/resources.ts)、[backend.ts](../../electron/plugins/backend.ts) 和 [backend-worker.ts](../../electron/plugins/backend-worker.ts)。共享身份与激活类型来自 [SDK](../../packages/sdk/src/index.ts)。

- 资源按 `{pluginId, version, instanceId}` 归属，统一跟踪任务、事件、快捷键、窗口和进程的清理回调。
- `prepareStop` 只询问保存结果；拒绝时不取消任务、不中断信号、不释放现实例。保存通过后 `release` 先拒绝旧实例结果，再按资源种类清理；失败的清理保持可达，后续 `stop` 可直接重试释放而不重复保存询问。
- 完整 Node 后台通过 Electron `utilityProcess` 使用内嵌 Node，后台模块必须提供 `prepareStop`。正常停止先取得保存确认，再执行 stop 回调，最后请求子进程退出；不会把 Windows 强制终止当作保存成功。
- 后台控制消息与异步事件携带完整 owner 和 requestId，已取消请求及已释放实例的迟到结果不进入当前调用。
- 后台与原生执行都要求宿主显式信任审核；路径在实际执行前再次 realpath 检查，限定于已验证的插件包目录。原生进程只使用清单 descriptor 的路径和固定参数，`shell: false`；运行中的原生程序必须由可信适配器确认保存并请求优雅退出，否则拒停并保留进程跟踪。

这些进程提供故障隔离。可信 Node 后台拥有当前用户的系统权限，不是权限沙箱；宿主必须把信任审核绑定到已验证的精确插件版本和授权记录。

[plugins-lifecycle/report.json](../../local-build/evidence/plugins-lifecycle/report.json) 由隔离 Electron app 使用真实生产控制器和 utilityProcess 生成：

1. 未批准信任时拒绝创建，scope 资源数仍为 0。
2. 启动实际 Node 24.22.0 后台并执行命令。
3. 后台拒绝保存停止后，同一 PID 和已有异步任务继续运行，AbortSignal 未中断。
4. 允许保存后停止 scope，取消待处理任务、拒绝迟到事件，子进程真实退出、资源清零。

报告中的 `saved.aborted: false` 与 `stopped.aborted: true` 直接记录了保存早于中断。[cleanup-retry.json](../../local-build/evidence/plugins-lifecycle/cleanup-retry.json) 则只证明一个清理瞬态失败可以通过再次 stop 完成：保存询问 1 次，释放尝试 2 次，最终资源为 0。原生适配器实际工具链由独立的原生接入证据说明，这份后台代表链不声称覆盖了所有 native adapter。

## 真实 .tgz 更新失败与数据保护

入口为隔离 [manager evidence app](../../local-build/evidence/plugins-manager/app/main.cjs)。它使用已安装的 tar 库生成标准 `package/` 结构的两个本地 `.tgz`，由真实 `stageLocalPluginPackage` 完成受限解包、清单检查、完整性记录和精确版本落盘，再使用真实 PluginManager、manifest resolver 和 createTrustedBackend。

主报告：[plugins-manager/report.json](../../local-build/evidence/plugins-manager/report.json)。该次运行的完整文件保存在 `local-build/evidence/plugins-manager/runs/dc7b9625-ad7c-4906-a394-88c6a2b95916`，没有访问真实用户配置、便签或剪贴板。

| 步骤      | 实际行为                                                                                    | 结果                                             |
| --------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| 安装 v1   | `@spark233/fixture-manager@1.0.0`，on-command，授予 storage/node.backend 和显式 native 信任 | 创建真实后台，插件 enabled                       |
| 写原数据  | 通过 manager.activate 调用 v1                                                               | `content.txt = v1 original content`              |
| 更新 v2   | `2.0.0` 为 on-startup，真实 activate 覆盖正文、创建新文件，然后主动抛错                     | 返回 `Intentional v2 startup activation failure` |
| 更新回滚  | 保存并停止 v2，再保护未提交数据、恢复 v1 备份及代码身份                                     | v1 enabled 状态保留，事务清除                    |
| 再激活 v1 | 创建新的 v1 运行实例并读取正文                                                              | 读到 `v1 original content`                       |

v2 写出的 `content.txt = v2 uncommitted content` 和 `new-only.txt = v2 new user data` 保存在 `data/.recovery/fixture.manager/<transaction>/<recovery-instance>/`，而不是被旧备份覆盖丢弃。报告记录了具体目录和恢复后的安装状态。

## 一次 switched journal 重启恢复

同一条小流程还保留了真实 manager 持久化的 `phase: switched` 事务快照（`captured-switched-state.json`）。第一次回滚及 shutdown 完成后，用这份准确 journal 和前述真实 v2 数据重新构造这一未提交边界，再创建新的 PluginManager 并调用 initialize。

这是实际执行重启恢复入口的一次单边界验证，没有真实断电，也没有随机杀进程或构造多阶段故障矩阵。结果：

- initialize 将这份未提交 v2 数据保存在另一份 `.recovery` 目录，已有恢复副本没有覆盖。
- 恢复 v1 数据和版本，`enabled: true` 保持不变，事务清除。
- 再次激活 v1 后读取原正文。
- 最后 shutdown，四个曾启动的 utilityProcess PID 均已退出，`alivePids: []`。

主报告的六项检查均为 true。真实包、SHA-512 integrity、持久状态、备份、两份新增数据恢复副本、owner/instance ID 及 PID 都保留在该运行目录，可复核，不依赖 mock transport 或内存状态代替磁盘结果。

## Review 与验证边界

只读 review 发现：on-startup activate 失败时，initialize / setEnabled 的旧路径只记录失败或抛错，可能保留后台却仍显示 disabled。已交由主线程修正为尝试保存并停止，拒停时保留可达故障实例并记录错误；本记录没有再为这一修改扩展用例矩阵，也没有声称该分支由上述更新回滚代表链覆盖。

另外确认长任务的 dispatch 队列只等待运行实例取得，不等待 activate Promise 的完整持续时间，使后续停用可以进入保存确认与任务取消。保存拒绝、清理失败和进程退出的更底层行为由前述生命周期代表链及清理重试取证支持。

后台与资源模块的四份 typecheck、lint 以及 Electron 编译已通过。manager 真实取证完成后的全局检查遇到并行新增代码问题：共享 `manifest.ts:119` 使用 `Object.hasOwn`，在前端 ES2020 lib 下报 TS2550；另有 web-host 的两处 no-useless-spread 警告。已交给主线程修正归属文件，不能把这一次全局检查写成通过。

临时取证程序、数据和日志均位于 `local-build/evidence/`；没有新增 Vitest 文件、测试框架或格式/平台/状态矩阵。最终整体验收仍需由宿主将管理器、界面、权限、安装更新与业务插件接通后完成相应真实路径。

## 2026-10-25：故障实例回收与 AI 任务期限

本节为后续功能补证，不改写前述历史报告的验证范围。使用项目 Node 26.12.1 / npm 12.2.1、Electron 45 和真实本地 `.tgz`，通过 production DesktopPluginHost、PluginManager、utilityProcess 与独立 Web 页面执行；数据和 profile 均位于 `local-build/spark233/plugin-crash-functional/`。

`backend.ts` 暴露实际 `running` 状态并上报进程异常退出，`desktop-host.ts` 将异常绑定到准确 owner；`manager.ts` 只撤下同一 `{pluginId, version, instanceId}` 的命令并保留失败清理的可达实例。已知死实例的后续停用、更新、卸载及退出使用 crash 停止路径；存活资源仍须取得真实保存确认。`web-host.ts` 同样将独立页面渲染进程崩溃送入管理器回收。剪贴板的 durable recovery 另见[功能集成记录](spark233-functional-integration.md)，此处不将普通后台报告扩展为剪贴板数据恢复证据。

翻译的 `translate` 激活期限单独设为 120 秒，以容纳 provider 的 90 秒期限；初始化、保存、停止及其他命令仍保留 10 秒 RPC 期限。

[crash report](../../local-build/spark233/plugin-crash-functional/runs/0544203e-2174-4fc0-8629-05b25ea869d4/report.json) 的 12 条检查记录通过，其中同一崩溃回收检查分别发生在停用、更新和卸载前，不代表新增 12 个测试文件。真实后台退出后撤下命令并释放实例；显式启用产生新 PID；崩溃后更新可切到新版本，卸载保留业务正文。真实独立 Web renderer 崩溃后释放隐藏窗口。翻译激活耗时 11,016.7 ms 仍完成，普通激活在 10,020.6 ms 超时，随后宿主退出成功。

## 隐藏 Web 查询与执行通道分离

启动器候选查询改用 `PluginManager.query`。通用混合插件直接查询后台，不调用 Web 激活；纯 Web 插件通过隐藏页面的 `query` / `query.result` 返回结果。SDK 新增 `registerQuery(id, handler)`，handler 接收 activation 和 AbortSignal，返回 `PluginLauncherPage`；官方已有适配器继续复用其现有查询实现。

查询 IPC 复用原发送者、主框架、精确入口 URL 与实例边界；请求总量限制为 256 KiB，候选最多 100 条、每项最多 8 个动作，并校验返回命令全部属于当前插件清单。查询不会更新激活上下文或触发激活监听器。超时发送取消信号，成功停用或 renderer 崩溃拒绝未完成任务；保存被拒绝时保留当前查询。结果在保存确认后或实例已释放时不可回流。

[query report](../../local-build/spark233/plugin-crash-functional/query-runs/72cb01a0-441e-4468-94cf-a0e27e2fb7dd/report.json) 的 10 条记录通过。使用真实沙箱 preload、浏览器 SDK 和 utilityProcess，覆盖纯 Web 返回候选/动作、未声明返回命令被拒绝、超时中断 SDK handler、拒绝保存后继续完成、成功停用取消、renderer 崩溃回收，以及混合插件后台返回。整个运行窗口 `show` 事件为 0，最后无残余窗口；未进行人工或可见界面验收。

## 预置包的独立更新源

预置包保持真实 `source.kind = file` 和归档来源，新增独立 `updateSource = {registry, channel}`。官方打包索引默认使用 npm 公共 registry / `latest`，构建可通过 `--update-registry` / `--update-channel` 或对应 `SPARK233_PLUGIN_UPDATE_*` 环境变量覆盖。更新源要求 HTTPS 且无凭据、查询参数和 fragment；映射必须同时匹配插件 ID 与 npm 包名。宿主在已消费预置安装标记的跳过逻辑之前加载映射，registry 安装仍优先使用其真实来源。

[update-source report](../../local-build/spark233/plugin-crash-functional/update-source-runs/90820994-578b-41c4-8925-99b93abc0eac/report.json) 的 8 条记录通过：自动检查和用户确认前的更新准备实际访问公共 npm，随机未发布 fixture 得到真实 404；检查仅报告更新警告，已安装离线插件仍可执行 ping，安装来源没有改写。重启后已消费预置包仍加载更新映射，同 ID 不同包名无法误绑定。默认及 `next` channel 的单包构建索引分别保存在 `build-default/index.json` 和 `build-next/index.json`。没有执行 npm 登录或发布，此报告不证明线上已存在可安装的新版本。

## 启动器代表行为与宿主返回边界

[launcher report](../../local-build/spark233/plugin-crash-functional/launcher-runs/ddfbf36a-b7ac-43f0-9525-9a9b6892c3a2/report.json) 的 10 条记录通过，复用真实 PluginManager、标准本地 `.tgz`、磁盘偏好和 LauncherController，运行时回调提供受控结果；没有使用 Electron 界面或真实用户数据。

记录证明控制器重建后恢复最近命令排序、进入模式记录公开命令、中文句子不会触发 `match: word` 或词典自动 provider、英文输入通过 `manager.query` 获取候选及次级动作、opaque 次级令牌只执行宿主保存的内部参数，替换查询使旧令牌失效。停用后命令及候选消失；偏好仅包含公开命令身份和计数，不含查询、结果私有参数或内部命令 ID。

新增的两条宿主保留结构检查实际注入坏 JSON：第三方无法直接返回伪造 `launcherResults`，也无法注入 `searchPreview` 或非字符串 `workspace`。实现仅允许 `spark233.search` 返回经过 Zod 校验的文件预览；本报告直接证明第三方拒绝边界，不将其扩展为官方预览的人工界面验收。

上述补充仅新增忽略目录中的短取证程序，未新增仓库测试、依赖或测试框架。修改时前端、Electron、SDK 类型检查及目标文件 lint/格式检查通过；最终全局 gate、打包和人工界面验收由主线程统一记录，不能由这些局部报告代替。

## 受控 registry 确认安装与更新

[registry HTTPS report](../../local-build/spark233/plugin-crash-functional/registry-https-runs/2c800235-257d-447c-8416-e8e459bc3560/report.json) 补齐真实 registry tarball 成功下载与版本更新的自动验证。复用 Hello Web 的 v1/v2、本地 HTTPS registry 和生产 DesktopPluginHost/PluginManager：首次 prepare 只产生预览，confirm 才安装 v1；重启时自动 metadata 检查提示 v2，但不下载或切换。错误 SRI 的更新下载被拒，v1、业务数据和空 staging 保持；正确 SRI 的 v2 prepare 仍只生成预览，confirm 后版本切换，新 renderer 通过真实存储 IPC 读回 v1 正文。

子进程 9 条业务记录通过，父进程另记录默认信任拒绝与两版 TLS tarball 请求。临时证书来自已安装 Git OpenSSL，仅子进程 `NODE_EXTRA_CA_CERTS` 添加信任；没有系统证书修改、关闭 TLS 校验、npm 发布或真实 registry 写入。所有窗口一直隐藏，退出后释放；未进行管理界面或人工验收。完整传输边界与报告范围见[插件包记录](spark233-plugin-packages.md)。本次没有修改产品源码、增加仓库测试或框架。

## 开发目录与预装失败诊断补齐

管理页新增预构建开发目录导入，经宿主 picker 和受限归档快照进入相同 preview/confirm/信任流程。管理器、预览持久化和前端 source 合同均支持 `directory` 来源，实际运行仍来自不可变精确版本副本；不运行目录中的安装脚本。目录与 junction 拒绝的真实宿主报告为 [desktop-host report](../../local-build/spark233/desktop-host/runs/2026-10-25T04-52-23-527Z/report.json)，具体边界见[插件包说明](spark233-plugin-packages.md)。

预装包安装失败除内存提示外，现在向插件宿主根 `bundled-failures.json` 保留最多 16 条记录，包含 timestamp、插件/版本、错误 message/stack，以及可取得的 code、errno、syscall、path、dest；stderr 同步输出，成功重启不清空历史，不增加重试。已有损坏或超限诊断文件保留并报告，避免静默覆盖。上述 probe 用缺失归档实际产生 `ENOENT`，证明错误路径与 stack 落盘、成功重启保留。该记录不能追溯先前未持久化的六插件缺失错误，也不推断其 errno 或原因；先前现象仍以主线程原始诊断报告为准。

## 显式数据迁移、已提交版本与匹配恢复

精确核对 P2.9 后发现此前只有数据备份与失败恢复，没有迁移合同；本节是补齐后的新证据。清单新增 `migration.entry`，要求 `node.backend` 与显式 native 信任，路径与普通后台同样在包内校验。SDK 定义 `PluginDataMigration`、`PluginMigrationContext` 和 `PluginMigrationResult`。独立 utility worker 只调用该模块的命名 `migrate`，传入源/目标数据与代码版本、dataDir 和 signal；不构造普通后台或迁移模块的 default factory。必须返回目标 dataVersion，并成功退出进程后才进入普通初始化检查。

宿主 `state.json` 新增 `dataVersions[pluginId] = {packageName, dataVersion, pluginVersion}`，保留数据卸载时保留，明确删除数据才清除；不同 npm 包不能借同一插件 ID 接管旧数据。旧的已安装记录仅在身份与 manifestDigest 校验通过后建立初始版本；只有非空数据而没有记录/版本元数据时拒绝猜测。相同 schema 不迁移，提升 schema 必须有迁移入口，默认拒绝降级。事务持久化 `migrating` 及 before/after 数据版本，失败和重启均先保护新版数据，再恢复旧代码、数据和版本。停用更新照样迁移并通过显式 `startupCheckOnly` 初始化检查，随后释放，启停状态不变且不执行业务 startup。该 boolean 同时传入 ordinary Node factory 的 context，默认 false；仅检查时插件可跳过业务订阅，官方适配器另在创建业务资源前短路。

沿用既有真实 manager/utilityProcess 探针，最新 [manager report](../../local-build/evidence/plugins-manager/runs/3f7a0ef5-5dde-4b36-bd05-f016d7ce1dd1/report.json) 的 13 项检查均通过：原启动失败回滚仍成立；schema1 → schema2 的停用更新保留正文、未运行业务 startup、没有实例残留。普通新版 factory 强制验证 `startupCheckOnly: true`、schema2 且迁移 PID 已退出；迁移模块 default factory 故意抛错但没有被调用。schema3 迁移写入新正文和用户文件后主动失败，旧 code2/schema2/版本记录恢复，新增数据受保护；重建真实持久的 `migrating` 日志后再次恢复同一边界，保护副本不覆盖。保留数据卸载并重启后，纯 Web 的其他 npm 包用相同 ID/schema2 安装返回 `pluginIdentityMismatch`，原包重装 schema1 返回 `pluginDataDowngrade`。九个真实 PID 最后均已退出。

一致备份的 manifest、磁盘插件 state、恢复 journal 和最终替换状态同时携带 npm 身份与数据版本。沿用既有 [backup report](../../local-build/spark233/backup-functional/runs/8063c683-d8a1-4fcb-9112-b02cedc5c9c1/report.json) 的 8 项通过记录，实际创建和恢复包含版本的便签/SQLite/资源快照；数据版本与代码、启停状态一同恢复。该 probe 预置的便签域显式 seed 版本元数据，没有绕过未知版本保护。此前首次运行在 `state.json.<uuid>.tmp → state.json` 出现 Windows EPERM，一次重跑通过；没有改写原子文件工具或泛化同步重试。针对这次错误暴露的首个 prepared 日志写入位于恢复 try 外的问题，现已移入恢复范围；同一 manager probe 单次注入该写入的 EIO，证明旧数据/版本恢复、事务清空、后续一致快照及操作仍可继续。该注入不冒充真实 OS EPERM，也不宣称消除了系统瞬态锁。

新源码通过五个类型边界的 `npm run typecheck`、聚焦 lint 和独立 Electron 编译。只强化忽略目录中的现有 manager/backup 探针，没有新增仓库测试套件、依赖或故障矩阵，也没有将这些自动检查写成人工界面验收。

随后正式首启暴露空框架目录被误判为未知数据：宿主可在插件安装前创建 `notes/` 等空目录，不能用根目录条目数判定已有正文。管理器现以异步、有界、短路的目录检查识别实际 payload：纯空目录树可 fresh 初始化；任意文件（含零字节 metadata/SQLite）、链接、特殊项、不可读取或超过 512 项/16 层范围均保守拒绝，不跟随链接、不扫描无界目录。既有 manager probe 的 `--fresh-data-only` [报告](../../local-build/evidence/plugins-manager/runs/a4e3a969-752f-4ffa-b597-a238adf83644/report.json) 证明未 seed 版本的嵌套空 notes/images 目录成功安装并提交 schema1，而含零字节 metadata.json 的另一数据域返回 `pluginDataVersionUnknown`、factory 未执行；最后 PID 已退出。没有通过额外 seed notes 版本规避产品首启。

本次完整旧 probe 重跑还在重建 switched 恢复边界时遇到原数据目录 rename 的 Windows EPERM，现场保留于 `local-build/evidence/plugins-manager/runs/9ad1b99b-6028-436c-b258-0d82dfd66844/state.json`，没有修改该恢复逻辑或增加重试；上面的 13 项成功报告与本次两项聚焦记录分别描述各自运行，不把失败运行标为通过。

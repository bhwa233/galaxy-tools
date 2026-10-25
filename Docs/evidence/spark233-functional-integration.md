# spark233 本轮功能集成记录

当前最终输入为 `87818-final-offline-catalog`，已接入官方离线目录选择及真实卸载重装链。此前候选包的成功不能替代后续逐项审计：本轮另补齐显式数据迁移、可回收 OCR 引擎复用和读取时文件身份/版本，完成了空数据首启集成修复并重新打包。最新结论见本文末节及[98 项完成审计](spark233-completion-audit.md)，历史报告保留原有范围。

日期：2026-10-25。分支：`codex/spark233-refactor`。按用户要求先实现功能，最后验证界面；本记录汇总已有隔离调用，不新增测试套件、不重复运行旧底层检查。所有样本、配置、缓存和索引均位于 `local-build/`，没有使用真实便签或剪贴板历史。

## 当前门禁与证据范围

当前冻结输入覆盖开发目录快照安装、第三方原生协议、便签搜索独立打开/桌面动作、显式目标与保存拒绝守卫、窗口归属修复，以及 registry 有界重试、Windows 安装目录切换重试和预装失败持久日志。它在原完整构建 64274 基础上继续收口；原构建已包含七插件、外部插件隐藏查询、后台崩溃恢复、预装更新源、受控结果动作、搜索服务管理与个人正文策略、应用/便签设置分组、翻译及剪贴板数据保护。现有源测试仍为 32 个文件、162 项，本轮没有新增测试套件。当前 type/lint/test 日志为 `local-build/spark233/functional-integration/final-*.log`，完整构建和 Windows 产物以[分发记录](spark233-packaging.md)的最终输入为准。历史 64274 和 smoke 分类断言修正的报告保留，不作为后续新代码已验证的替代。

用户再次明确先全部实现，最后人工验收。本轮后续没有请求手动框选、真实回贴或 UAC；尚未人工操作的条目保留待验收，不用自动报告替代。

最后自动回归中，源码 Windows smoke `local-build/electron-smoke/c8936810-dcb8-4a4e-a8a4-3953f77d429e/report.json` 通过。打包版使用 P0 冻结样本的副本，成功报告为 `local-build/spark233/functional-integration/packaged-1792902424729/report.json`，`runtime.packaged=true`、renderer 错误为空；同目录 `fixed-data-preservation.json` 逐字节核对原 Markdown 与附件，保留原 ID、标题和分类，`clipboard-isolation.json` 确认记录暂停且历史为 0。原冻结目录未被产品或 runner 改写。

首次带分类样本的打包回归发现旧 runner 断言错误：它声称检查分类内置顶，却读取全列表首项，非空分类排在未分类之前时会误报。仅修正已有 `smoke-note-list.ts` 为同分类范围内的排序断言，并等待该范围排序完成；没有修改产品排序、删除断言或新增套件。修正后的同一打包链已通过。首次失败报告仍保留在 `packaged-1792899360299/` 供追溯，其样本正文与附件散列也均未改变。

## 正式宿主与界面代表检查

`local-build/electron-smoke/73b06ae6-3f84-4139-b449-dabf8fe77849/report.json` 是 Electron 45 正式源码宿主的成功报告：首次自动便签数为 0，便签正文模式、图片、提醒、胶囊、关闭保存、保存失败保留窗口、协议边界和沙箱/GPU 通过，renderer 错误列表为空。旧 smoke 曾依赖产品自动生成空便签，现由 runner 显式建立受控文档；没有恢复产品的自动新建行为。runner 会在启动前把隔离剪贴板策略设为暂停，避免记录桌面剪贴板。

该链路实际发现并修复了重开已有便签的加载竞态：异步正文尚未到达时，初始文本模式误被当作就绪；提前切换 Markdown 会被返回数据覆盖。现在既有便签加载完成前禁用会覆盖数据的操作，现有 smoke 等到真实模式就绪后继续，并已经通过，不以延长等待掩盖问题。全局 `Alt+Space` 在本机被占用的情况也会显示在启动器警告中，允许从设置更改。

`local-build/spark233/functional-integration/host-report.json` 汇总 9 项成功结果。正式宿主从七个独立安装包加载启动器、剪贴板、词典和 OCR 工作区，已有简体中文浅色、英文深色及三个工作区的代表截图。离线 `hello` 查词得到实际词条；剪贴板只使用两条合成文字及一张固定 OCR 图片，始终暂停记录，随后停用。OCR 经过实际宿主链完成识别，文字选区反向高亮原图、图上选择对应中文、连续第二个 session 清掉上一编辑状态均通过；来源剪贴板插件停用后，OCR 自有图片仍返回 HTTP 200。

另一次默认冷启动暴露布局被空内存状态覆盖的风险：显示器和插件回调在初始布局读入前已可调用保存。主进程现统一拒绝在 `layoutsRestored` 前写回布局。修复后同一隔离 profile 正常退出再默认启动，仅恢复受控便签，不出现启动器；正文完整，见 `restored-pages-fixed.json` 和 `restored-note-fixed.json`。本次未获得原始异常的回调栈，显示器事件是代码审查确认的可触发路径，不宣称已锁定唯一触发者。

桌面 computer-use 无法激活目标窗口，返回截图实际包含前台其他程序，相关图片已拒绝作为证据。上述界面检查使用应用自身的本地 CDP 渲染、DOM 事件及截图，不等同物理键盘/真实 IME、截图遮罩框选或回贴焦点验收。截图原生标注/DPI、真实剪贴板监听与回贴、UAC/SYSTEM 服务生命周期、干净 Windows 断网安装仍未验收；没有借真实用户数据或系统服务补测。

检查条数只描述对应报告中的断言或检查记录，不是新建 Vitest 用例数量。以下报告不能代替首装、用户交互、SYSTEM 服务或跨插件整体验收；实施 TODO 不据此整体勾选。

## 启动器中文命令拼音

`electron/launcher-command-matcher.ts` 复用应用搜索已有的 `pinyin.mjs` 和固定 Pulse/ib-matcher 原生助手，不添加 npm 依赖。宿主资源合同为开发 `dist-host/command-matcher/`、打包 `resources/command-matcher/`，保留 wrapper 的相对原生目录和许可证；无需安装或启用应用搜索插件。主线程负责 matcher 创建、Launcher 注入和退出等待。

`electron/launcher.ts` 为全拼/首字母结果分别赋 55/35 分，与原有字面匹配 100/75/40 分取较大值；上下文优先和文本输入行为保留。搜索词同时含本地化标题、原始中文标题、关键词和别名，因此英文界面也可按中文原名的拼音搜索。替换查询和 `clear()` 取消旧匹配，generation 检查拒绝迟到结果。

报告：`local-build/spark233/command-pinyin/7a5fc933-8949-4510-af80-6474b6f4befa/report.json`，8 项通过。使用项目 Node 26.12.1、隔离编译的 Launcher 和真实原生助手，manager 仅提供截图插件，资源为独立宿主副本：

- `jietu` 命中“截图”，不含 `jt` 别名的原生词项也通过首字母匹配；`gztsz` 命中“工作台设置”，证明匹配不依赖截图专用硬编码。
- Launcher 的 `jietu`/`jt` 返回截图和 OCR；精确 `jt` 别名优先于拼音结果，英文 `screenshot` 仍可检索。
- 英文界面下刻意移除截图命令的中文关键词后，`jietu` 仍通过原始标题找到 `Take screenshot`。
- 查询替换不发布旧结果，退出后原生会话缓存为空。

原生助手为 503,808 字节，SHA-256 `03dfdf95cf917d8b7aca398503ed26cbcf572dcfe879479439c6fe4668102cf4`。此报告没有使用 Electron 主宿主界面，也不证明最终打包资源和 main 接线已实际运行。

## 搜索范围与文件名分页

范围设置报告：`local-build/spark233/search-scope-functional/runs/12eaa8cb-3490-44e3-b491-a6727443bcce/report.json`，21 项为 true。已证明用户默认排除项为空、相对路径和外部 `privateRoots` 注入被拒绝、设置规范化去重并持久化；变更取消旧查询并撤销旧选择令牌；排除后正文无结果，重启保留设置，清空用户排除后恢复结果而宿主私有域仍被排除。

该 21 项报告使用修复前 native，不能单独证明原生文件名分页过滤。后续独立报告 `local-build/evidence/search-production/f909f8b8-0f56-4325-b1e3-7effc4f419d7/report.json` 的 12 项通过，使用已补齐排除过滤的正式 native：第一页是两条可见结果和分页令牌，第二页仅剩一条可见结果且无多余下一页。排除规则先于可见分页计数，多批读取遇索引 revision 变化要求重试。详见 [搜索插件记录](spark233-search-plugin.md)。

目录筛选/范围设置代码及目录筛选版构建已接入，但原生目录选择器实际操作、主宿主范围编辑和查询交互尚未验收。没有执行 UAC、SYSTEM 服务安装/升级/卸载、全卷 MFT/USN 或真实目录撤权检查。

## OCR 结果与图片归属修复

后端修复将识别结果的 PNG 和 JSON 保存到 OCR 自有域后才注册资源和发布结果；源插件关闭不再使 OCR 图片失效。只保留当前和上一输出，第三次发布淘汰最旧资源；新实例清理前一工作区孤儿输出。存储失败、取消和 busy 拒绝均清理本次导入输入，保留已经发布的当前结果。清理规则已覆盖原生使用的 32 位十六进制 session 文件名。

最新报告：`local-build/spark233/ocr-result-functional/runs/a6c895ae-612a-437c-88c7-9239c795d499/report.json`，`ok: true`，16 条检查记录。调用实际 production OCR adapter、真实离线 ImageReader 和隔离资源域，使用人工样例原图及首行 crop，两图产生不同文本、session 和 source：

- 三次成功结果先落盘再发布；关闭输入来源域后，OCR 自有图片仍可按原字节读取。
- 当前和上一图片仍有效，第三次结果只淘汰最旧输出；保留数量有界，新实例清理孤儿输出。
- 结果存储失败、busy 和取消不发布新结果，导入输入及映射被清理；失败保留当前 source。
- 五个原生进程均退出码 0；取消会话得到取消确认，最终 `aliveNativePids` 为 `[]`，隔离资源域全部释放。

前端已按 session 重建编辑器状态；文本选区映射到行高亮，文本编辑更新 anchors，点击图片/Shift 选行设置文本选区。**这些前端交互只有实现和类型/lint 检查，尚未真实 UI 验收**；两张图片的原生识别不能替代前端状态重置、部分选字或映射检查。main 的资源注册/释放接线及最新完整构建也需最终统一核对。

历史 `2cd2dc8f-44bb-4335-b176-531ced4ab0ea` 报告在新实例孤儿清理处失败，不能引用为通过；最新报告包含修复后的该项及 busy 输入清理。P1V 手动框选和先前 P4 runtime 证据继续保留，不能覆盖截图标注、复制、DPI 和最终宿主交互。

## 自定义应用入口

报告：`local-build/spark233/applications/custom-report.json`，对应 `custom-runs/7a6fbb11-562f-40c9-a11b-d079a319a15f`，7 项为 true。应用后台新增自定义入口持久化与启动描述，宿主按已索引的内部 ID 校验执行；仍拒绝 renderer 任意路径和已移除入口。

实际证明隔离设置初始为空、原子保存、后台重启恢复、全拼检索，以及受控 Node 程序的真实启动。参数 `arg with spaces`、`quote"value`、`中文参数` 和空字符串均保持原 argv，含空格 cwd 保持一致；移除后旧 ID 不可执行，停机后资源为 0。没有启动用户真实应用。自定义入口设置 UI、真实用户应用和最终独立包尚待完整构建及界面验收。

## 剪贴板与分发的保留边界

`local-build/spark233/native-clipboard-p6/backend-1792896204028/report.json` 为独立 backend 在 Electron 45 / Node 24.22 utilityProcess 的 11 项通过证据，覆盖受控快照原始字节、私有 spool 路径、有界预览、收藏/清理、停机保存确认与 SQLite/草稿重启恢复；两个进程正常退出。它使用人工数据和私有文件，不代表新原生服务已在真实系统剪贴板监听或回贴成功。

新原生服务的私有窗口站创建失败报告为 `local-build/spark233/native-clipboard-p6/named-station-b3e58cf8797649c386a7bfd91dd73618/report.json`：`CreateWindowStation isolation: 5`，`clipboardOpened: false`，未使用新 logon。没有转用用户桌面剪贴板或历史作验证。原应用焦点、UIPI、实时多格式回贴和当前新服务监听仍待验收，旧 P1V 原型证据不代替这些项。

七包候选审计为 `local-build/spark233/packaging/distribution-A169Js/report.json`，目录包日志为 `directory-build-final.log`；其输入不覆盖随后自定义应用、宿主匹配器和最新 OCR 修复，文件名中的 `final` 不代表本轮最终交付。OCR app-local 四 DLL 加载证据仍为 `packaging/runtime-load-report.json`。UAC、真实服务生命周期、全新 Windows/断网首装、最新 NSIS、完整进程树及最终体积和界面均待收口，见 [分发记录](spark233-packaging.md)。

## P6 功能缺口复查与补齐

后续只读复查发现并修复了四项实际业务缺口：词典/AI 结果现已使用既有 `writeText` 和 `text_action` 提供复制与保存便签；复用翻译窗口收到新文本或新词条时撤销旧请求身份并清理旧译文，迟到流片段、错误和结束状态不能覆盖新输入。剪贴板用同一 SQL 可见集合先计算保留范围，再应用正文/类型/分组搜索；置顶免于天数与条数范围淘汰且不占普通条数，清理预览和删除都保护置顶。

沿用既有历史 probe，在 `local-build/spark233/native-clipboard-p6/history-1792900022609/report.json` 的 24 条记录中新增五条数据保护检查，实际证明过期置顶仍可见、搜索/类型不绕过待清理范围、放宽条数可恢复内容，以及确认清理后置顶原始字节不丢失。没有新增 Vitest 套件，也没有执行真实桌面复制。翻译按钮和窗口状态切换只有实现、类型与 lint 检查，人工交互统一留到功能完成后。

另修复剪贴板后台崩溃时要求死进程保存确认而无法停止的问题。宿主控制器按 backend 的真实 `running` 状态处理：死后台分支先暂停 native，工作区草稿持久化到私有 spool 后才确认交接；仍尊重存活后台或工作区的真实保存拒绝。未提交快照连同来源元数据、未提交草稿保留在旧会话目录，正常停止 native 后不删除；下次启用在开始录制前通过新后台恢复，只有已成功提交的数据才删除。恢复写入失败继续保留原文件。

沿用既有真实 Electron utilityProcess probe，`local-build/spark233/native-clipboard-p6/backend-1792900380490/report.json` 的 13 条记录通过，其中两条补证恢复拒绝保留原始字节/草稿、新后台恢复来源和草稿后清理旧 spool。它没有调用新 native 监听或回贴；私有窗口站权限错误 5 与当前 native 实机限制继续保留。宿主 AI 长任务超时另由后台生命周期集成处理，不能用这些局部报告代替其证明。

随后修正一致备份边界：durable recovery 已移入插件 `dataDir/recovery/<session>/`，而非被备份排除的 cache。崩溃停机成功前将 pending raw/来源迁入业务域，草稿交接直接持久化到业务域；恢复时单项暂存当前受限 cache 再 RPC，后台 `privateFile` 权限未放宽。最新报告 `local-build/spark233/native-clipboard-p6/backend-1792901092150/report.json` 的 15 条记录通过，实证业务域字节和草稿存在、整个原 cache 删除后仍成功恢复，以及当前来源排除返回 `captured:false` 时正常消费并丢弃，不绕过隐私策略。本报告使用真实 utilityProcess 和人工文件，未运行真实剪贴板，也不替代完整备份 UI 或真实断电验收。

启动器前端已接宿主提供的 PNG 图标和 opaque `actions`，复用既有 Dialog/Button 列出动作，支持按钮键盘访问及 `Alt+Enter` / `Shift+F10`。执行只发送宿主 token、插件 ID 和命令 ID；`searchPreview` 结果交给专用纯文本预览组件，保留原有最近使用和模式记录。此前端接线尚未进行界面验收，最新完整构建与整体验收仍由主线程统一收口。

## 插件故障、查询与预置更新源补证

管理器已按精确实例身份接入可信后台和独立 Web renderer 的崩溃上报，故障后撤下命令并回收对应资源；存活资源继续遵守保存拒绝。翻译 `translate` 的任务期限为 120 秒，其他激活与控制 RPC 保持 10 秒。`local-build/spark233/plugin-crash-functional/runs/0544203e-2174-4fc0-8629-05b25ea869d4/report.json` 的 12 条记录通过：真实进程崩溃后的停用、重新启用、更新、卸载保留数据，独立页面崩溃回收，以及 11 秒翻译成功/普通命令 10 秒超时和最后停机。重复崩溃回收记录按报告原样计数，不代表新增测试文件。

启动器候选改用 `PluginManager.query`：混合插件仅查询后台，纯 Web 插件通过隐藏页面与 SDK `registerQuery` 返回受限 `PluginLauncherPage`，执行仍走激活通道。`local-build/spark233/plugin-crash-functional/query-runs/72cb01a0-441e-4468-94cf-a0e27e2fb7dd/report.json` 的 10 条记录通过，实证窗口 show 事件为 0、查询不触发激活、未声明动作被拒、超时中断 handler、拒绝保存保持查询、停用取消和崩溃回收，最后无残余窗口。这是隐藏进程功能验证，未进行可见或人工界面验收。

预置包保留本地归档来源，同时由构建索引提供同时绑定插件 ID/npm 包名的独立 registry/channel。`local-build/spark233/plugin-crash-functional/update-source-runs/90820994-578b-41c4-8925-99b93abc0eac/report.json` 的 8 条记录通过：实际公共 npm 的未发布包 404 只成为更新警告，离线 ping 仍可用，自动检查与准备更新不改写安装来源，重启加载映射，不同包名不能误绑定。没有 npm 登录或发布，也未以 404 证明真实升级已完成。详细实现与边界见[插件管理器记录](spark233-plugin-manager.md)。

## 启动器状态与保留返回结构

`local-build/spark233/plugin-crash-functional/launcher-runs/ddfbf36a-b7ac-43f0-9525-9a9b6892c3a2/report.json` 的 10 条记录通过。使用真实管理器、磁盘和本地包，运行时回调提供人工候选：控制器重建后最近命令排序恢复，进入模式写入使用历史，中文句子不触发仅英文词的命令/provider，英文查询提供次级操作。次级动作通过 opaque 令牌执行宿主保存的参数，替换查询后旧令牌拒绝执行；停用后命令/候选撤下，使用偏好不包含查询文本、私有参数或内部命令。

同一 probe 补了两条保留结构拒绝记录：第三方坏 JSON 无法伪造宿主 `launcherResults`、`searchPreview` 或非字符串 `workspace`。宿主仅允许官方搜索返回通过 Zod 验证的预览；第三方的候选必须先经过候选 schema，再由宿主生成令牌和 renderer 返回结构。此报告不验证前端动作菜单、文件预览的人工操作或官方预览的界面表现。本节未新增仓库测试或测试框架，最终整体 gate 与界面验收范围仍以主线程记录为准。

## 末次实现审计与扩展入口补齐

按一期架构重新核对主链后，补齐开发目录导入和外部 native-only 插件。开发目录以不可变快照进入现有预览/确认安装链；目录在审阅后继续修改不影响已审阅产物，真实 junction 拒绝和重启来源保留均已证明，报告为 `local-build/spark233/desktop-host/runs/2026-10-25T04-52-23-527Z/report.json`。源码与运行边界见[插件包记录](spark233-plugin-packages.md)。

外部原生程序通过显式定义的 UTF-8 JSON-lines 协议运行，仅执行清单内入口和固定参数，信任、资源、取消与保存停机均由宿主绑定。直接生命周期报告 `local-build/spark233/native-plugin-runtime/runs/2a455f14-36c7-491d-8f86-b414ef67f8d1/report.json` 的 10 条记录通过；完整工厂报告 `local-build/spark233/native-plugin-runtime/host-runs/deef804e-4341-455d-9a7c-b30db054b94e/report.json` 的 10 条记录经过实际 `.tgz` 预览、信任拒绝/确认、初始化、查询/激活、保存拒绝及停用卸载，另通过真实隐藏 Web renderer 调用声明的 native 入口，任意 path/args 和未声明入口被拒。详情见[原生插件协议](../native-plugin-protocol.md)。这些报告不等于任意普通 EXE 都会自动符合该协议。

便签搜索新增独立的“在便签管理器打开”和“贴到桌面”动作，默认打开管理器中的目标便签。主进程等 renderer ready 后才投递目标，首次默认便签加载遵循已有 epoch；打开目标前等待当前编辑器保存，保存失败或保存期间仍有新编辑则保持原内容。该路径的最新打包版行为证据随下节最终代表链记录，不以类型检查替代。

打包代表链还暴露了窗口归属缺口：旧 `notes_create` 桥接会给任意非管理器窗口绑定便签 ID，`openNote` 又把同 ID 的任意非管理器布局视为桌面便签。通过启动器桥接建立受控样本后，“贴到桌面”因此错误复用启动器。两处现均严格限定为 `notepad` 或 `tile`；不再让宿主或其他工作区占用便签窗口身份。历史失败 `measurement-1792905115384` 保留，最终成功报告另列。

## 首启预装失败与 Windows 目录切换

旧报告 `measurement-1792903053624` 首次仅有六个插件，未保存完整管理状态。原隔离 profile 重启后七个均正常，诊断 `clipboard-diagnosis-1792903400442/report.json` 保留原状态和空版本父目录；原错误无法恢复，不能仅凭目录推定原因。随后 `measurement-1792904413026/report.json` 在新打包版复现六个插件，这次持久诊断明确记录应用插件从已校验 staging 到精确版本目录的 `EPERM rename`。两次不宣称已锁定为同一原因。

预装失败现写入有界 `bundled-failures.json`（最多 16 条，含时间、插件、版本、errno/path/stack），同时输出 stderr，成功重启保留历史。安装器仅对 Windows 的 `EPERM` / `EACCES` / `EBUSY` 作八次有界重试，累计计划等待 2.75 秒；每次重新检查精确目标不存在并尊重取消。非暂态错误仍直接失败，不能复制半成品或覆盖已安装版本。

沿用既有包安装 probe，`local-build/spark233/plugin-packages/runs/2026-10-25T05-02-55-385Z/report.json` 与 `windows-rename-lock.json` 通过真实文件锁复现：PowerShell 持有源 `package.json` 的无 Delete 共享句柄，Windows 前四次返回 `EPERM/-4048`，锁释放后第五次原生 rename 成功，首末约 801 ms。没有伪造异常。既有路径穿越拒绝、安装脚本不执行、无隐式依赖安装及 staging 清理继续通过。

registry 元数据和归档请求另补明确的重试因子、最小/最大等待，修复 npm-registry-fetch 透传未定义值导致 `TimeoutNaNWarning` 和 1 ms 重试的问题；它与目录 rename 是两个独立问题。此前失败打包测量已确认不再出现该警告；最终成功离线代表链继续检查此项。

## 前一候选打包代表链与资源快照（历史）

最终报告为 `local-build/spark233/functional-integration/measurement-1792905486885/report.json`：`packaged: true`、`ok: true`、15 条检查均为 true，拥有的主进程正常退出。使用 `46269+note-window-ownership` 的稳定目录包、新隔离配置与人工数据；真实剪贴板始终暂停。该次通过七个预装插件、无自动空便签、词典三次查询、固定中英文/代码 PNG 的两次真实 OCR、打包 reduced-motion 样式、便签两个独立动作、首次目标不被默认加载覆盖、真实写入失败拒绝导航、恢复写入后先保存再切换，以及独立桌面便签窗口。

写入失败只在受控便签文件上注入：临时把原文件移到同目录备份，并在其路径创建目录；操作结束在 `finally` 中恢复。验证当前未保存内容没有被目标便签覆盖，恢复后原编辑内容确实落盘。没有模拟成功保存或接触用户便签。此前 runner 漏写 `notes/` 路径的失败已保留，不属于产品保存故障；媒体查询的计算样式检查等待实际 `matchMedia` 与样式生效，不再仅以发出 CDP 设置命令即认为已生效。

网络范围是子进程专用的不可连接 proxy，Node registry 更新请求实际得到 `ECONNREFUSED 127.0.0.1:9`；Chromium 同样设置该 proxy。七包、模型和词库使用本地资源，基础词典/OCR 仍通过，且 stderr 无 `TimeoutNaNWarning`。这证明该进程范围的不可用网络代表链，**不等同拔网线、干净 Windows 首装或完整截图遮罩的离线操作验收**。

以下为原始少量时延样本。同机 OS 缓存未清空，同时还有隔离 smoke/NSIS 工作，不作为空闲设备基准、物理呼出延迟、冷暖模型复用或 P95：

| 指标                                      | 实测                 |
| ----------------------------------------- | -------------------- |
| 新 profile 首次安装七包至启动器输入框出现 | 9,112 ms             |
| 默认 `hello` 综合 provider 查询           | 3,281 / 590 / 498 ms |
| 固定 PNG 的 OCR 新进程调用                | 1,386 / 1,658 ms     |

综合 provider 包含应用发现，不能把其耗时写成 ECDICT 单独查询速度；第一次查询仍有明显等待。两次 OCR 时延均在 P1V 同样例 2 秒警戒线内，本次未采集其运行中峰值，不能据事后快照断言 350 MiB 峰值预算通过。

完整后代进程树的时点快照如下。`privateBytes` 为各进程私有内存指标之和，工作集求和会重复计算共享页；这些值不是常驻/峰值或物理内存承诺，也没有包含尚未授权安装的 SYSTEM 搜索服务及全卷索引：

| 时点               | 进程数 | private bytes 合计 | working set 合计 |
| ------------------ | -----: | -----------------: | ---------------: |
| 首装后启动器空闲   |     12 |         649.99 MiB |       998.83 MiB |
| 本地综合查询后     |     12 |         640.45 MiB |       971.84 MiB |
| 停用 OCR、剪贴板后 |      9 |         583.92 MiB |       862.01 MiB |

最终固定数据打包 smoke 为 `local-build/spark233/functional-integration/packaged-1792905353320/report.json`，`ok: true`、`runtime.packaged: true`、renderer 错误为空；同目录的正文/附件 SHA、ID 保留、剪贴板暂停/零记录、七插件安装/启用且预装失败为零均通过。最终安装器、目录和首启展开体积见[分发记录](spark233-packaging.md)。[界面指南代码检查](spark233-interface-review.md)与这些代表运行均不替代最后人工验收。

## 完整审计后的前一候选：40596+fresh-data-payload（历史）

逐项核对原 98 个任务后，确认旧候选仍有三项实际代码缺口。本轮未把它们改写成“待人工”：

- **P2.9 数据版本迁移**：独立 `migration.entry` 在普通 factory 之前执行，目标版本确认且迁移进程退出后才检查新版。宿主记录 `{packageName,dataVersion,pluginVersion}`，保留数据卸载仍约束包身份；未知格式、降级和异包接管拒绝。停用更新通过显式 `startupCheckOnly` 检查并保持停用，官方适配器不启动便签窗口或剪贴板记录。真实迁移/失败保护/持久 journal 重启/身份与降级/首次事务写入失败恢复的 13 项报告为 `local-build/evidence/plugins-manager/runs/3f7a0ef5-5dde-4b36-bd05-f016d7ce1dd1/report.json`；新版本一致备份 8 项为 `local-build/spark233/backup-functional/runs/8063c683-d8a1-4fcb-9112-b02cedc5c9c1/report.json`。接口见 SDK README 和管理器记录。
- **P4.11 OCR 引擎复用**：无窗口 worker 在请求循环外初始化 TinyOcr，默认空闲 30 秒回收，取消/停用协作退出。`local-build/spark233/ocr-result-functional/runs/107ca14b-2df8-4589-96d6-47e8eafc7a8f/report.json` 21 项证明不同图片同进程/单次初始化、同图约 783/315 ms 的新引擎/复用对照，原数据保护及 idle/退出继续通过；它不是推理峰值或 P95。固定源码重放与正式资源散列见[OCR worker](spark233-ocr-worker.md)。
- **P5.10 读取时身份与版本**：Pulse adaptation 7 传回实际读句柄的 file ID/volume/size/mtime/ChangeTime，宿主发布和动作前复核，预览同句柄读前/读后复核。当前生产 `local-build/evidence/search-production/a9a8a308-2c90-473a-9e8f-f117e8433e96/report.json` 20 项包括读取后发布前修改、同大小/mtime 但不同 file ID 替换的拒绝；`current-native-binding.json` 绑定当前四个生产文件。详见[搜索十项审计](spark233-search-completion-audit.md)。

新版本保护集成还暴露并修复了真正 fresh 首启缺陷：旧 `readdir(data).length` 把宿主已创建的空 `notes/` 视为未知业务数据。管理器现有界短路判断 payload，纯空树可以初始化；任何文件（包括零字节）、链接/特殊项/不可读取或超出预算的树仍保守拒绝，不能靠预填 notes marker 绕过。根宿主在便签插件启用前禁用胶囊刷新，避免启动过程自行写入空元数据。聚焦真实证明为 `local-build/evidence/plugins-manager/runs/a4e3a969-752f-4ffa-b597-a238adf83644/report.json`；历史失败 `measurement-1792907563522` 保留。

Windows 瞬态锁仍可能导致持久状态或恢复目录的原子 rename 失败。既有失败在 `backup-functional/runs/7fb83184…` 和 `plugins-manager/runs/9ad1b99b…` 保留；后者仍有 switched journal，不能称该轮恢复成功。首个 prepared 状态写失败现进入既有恢复分支，真实单边界已验证；没有改写通用同步原子写工具、静默吞错或宣称消除了系统锁。数据/日志保留为可诊断恢复状态，与“任意系统 I/O 故障下均自动成功”不同。

全仓 typecheck、lint、现有 32 文件/162 项测试通过；完整构建为 40596，之后仅编译末次宿主和管理器修复，并重新生成目录包和 NSIS。生产输入为 `40596+fresh-data-payload`，新固定数据 smoke `local-build/spark233/functional-integration/packaged-1792908033222/report.json` 通过，renderer 错误为空；原 Markdown/PNG 与副本散列和 ID 保持，剪贴板暂停/零记录，七包全启用及版本台账一致。该固定样例确有业务内容，准备阶段显式声明其格式；它与下面无 notes marker 的真正 fresh 链分别验证。

该候选代表报告：`local-build/spark233/functional-integration/measurement-1792908279968/report.json`，`packaged: true`、`ok: true`、16 项全部通过、`mainExited: true`。只有剪贴板人工 fixture 预置其已知格式，notes 完全不 seed 版本，仍完成七包首启；词典三次、真实 OCR 两次、reduced-motion、便签两动作、指定目标、真实写入失败拒绝导航/恢复后先保存、独立桌面窗口和不可用网络更新错误均通过。

此次真实打包 OCR 的两份 `sessions/*.json` 都记录 PID **11272**、workerSessionId **c556951a2eab4a3d9c16b45d747d9d83**、`engineInitializations:1`，`processed` 为 1/2；同 profile 的 `workers/*.json` 记录正常退出码 0。进程核对无残留。不是仅从耗时变短猜测复用。

runner 在直接发查询前等待首次自动更新结束及页面自身可用性刷新完成，并保留三次完整结果页。此前 `measurement-1792908077704` 首次直接查询未保留完整响应，不能确定是否被页面查询替换；没有为该未确定失败修改产品或宣称已修复。当前成功是具备明确同步条件和真实结果的证据。

| 该候选打包样本时延             | 实测                               |
| ------------------------------ | ---------------------------------- |
| fresh 七包安装至启动器就绪     | 7,793 ms                           |
| 就绪后首次自动更新检查剩余等待 | 6,783 ms，单列，不计入本地查询延迟 |
| 综合 `hello` provider 查询     | 2,676 / 283 / 248 ms               |
| 两次连续 OCR（首次/复用）      | 1,111 / 688 ms                     |

| 该候选进程树时点     | 进程数 | private bytes 合计 | working set 合计 |
| -------------------- | -----: | -----------------: | ---------------: |
| 更新完成后启动器空闲 |     12 |         555.45 MiB |       899.02 MiB |
| 综合查询后           |     12 |         565.82 MiB |       888.57 MiB |
| 两次 OCR 后、停用前  |     14 |         755.48 MiB |     1,135.56 MiB |
| 停用 OCR/剪贴板后    |      9 |         600.96 MiB |       826.35 MiB |

时延与内存是有 OS 缓存和并行构建负载的少量时点，工作集包含共享页重复，不能替代 P95、真实热键呼出、初始化/推理峰值、SYSTEM/全卷负载或物理断网首装。该候选安装包约 200.33 MiB，应用目录约 469.05 MiB，加七包展开的代码文件约 614.78 MiB；当前产物的精确 SHA/字节和统计边界见[分发记录](spark233-packaging.md)。

全部 98 个编号已在[完成审计](spark233-completion-audit.md)对应源码、报告范围和剩余工作。用户安排稍后进行的原生截图标注/选字/DPI、真实监听回贴/UIPI/焦点、IME/辅助技术、UAC/SYSTEM 与全卷、干净 Windows/物理断网首装，以及公开 npm 归属与授权发布仍未完成；本轮未把完整目标标记完成。

## 当前最终交付：87818-final-offline-catalog

完整构建 87818 重新生成宿主、插件 renderer、七个 archive 和带中英文显示名称的官方离线目录。最终 NSIS 为 210,065,819 字节（200.33 MiB），SHA-256 `3caccc9619b2c2d717fd8e37d033c857c9f7541be1539a44806c271aec748d55`；应用目录 491,844,852 字节（469.06 MiB），加首启展开七插件的代码文件共 644,657,093 字节（614.79 MiB）。这些是文件字节之和，用户数据、缓存、索引、服务副本及回滚版本另计。安装器未签名、未执行。产物逐字节和依赖绑定以 `local-build/spark233/packaging/windows-package-final.json` 为准。

最新固定样本 smoke 为 `local-build/spark233/functional-integration/packaged-1792909699509/report.json`，打包运行通过且 renderer 错误为空；冻结原件与副本的 Markdown、PNG 散列及便签 ID 一致，七插件全启用，隔离剪贴板暂停且历史为 0。原冻结目录没有改动。

最终代表报告 `local-build/spark233/functional-integration/measurement-1792909805347/report.json` 的 21 项全部为 true，`packaged: true`、`ok: true`、`mainExited: true`。它继续验证前一候选的 16 项，并增加实际官方剪贴板插件的五项离线目录链：七条目可发现、保留数据卸载后仍可选择、prepare 仅生成待确认项、拒绝未显式信任的 native 安装、确认信任后从 bundled archive 重装且保留合成 PNG 记录 ID/资源、暂停设置和更新来源。该链没有使用真实剪贴板历史，结束再次停用 clipboard。

本次 notes 没有预置版本 marker，是真正 fresh 空树首启；仅为隔离的预置暂停剪贴板数据声明已知格式。registry 经子进程专用不可连接代理被实际阻断，本地词典和 OCR 可用；不将此描述为干净 Windows 物理断网安装。全仓 typecheck、lint、现有 32 文件/162 项测试和完整 build 通过，没有新增 Vitest 套件。

两次真实打包 OCR 的 proof 记录同一 PID 3704、workerSessionId `8887e15b38444a43a63960d96978618e`、`engineInitializations: 1`、`processed: 1/2`，worker 真实退出码 0。fresh 七包就绪 7,563.88 ms，初次自动更新剩余等待另列为 6,800.115 ms；三次综合词查询 2,563.164/238.303/281.914 ms，两次连续 OCR 1,056.960/567.416 ms。不同输入的连续任务不作为同输入冷暖性能对比。

| 最终进程树时点    | 进程数 | private bytes 合计 | working set 合计 |
| ----------------- | -----: | -----------------: | ---------------: |
| 启动器首次空闲    |     12 |        590,508,032 |      965,685,248 |
| 本地查询后        |     12 |        593,440,768 |      936,968,192 |
| OCR 后、停用前    |     14 |        800,841,728 |    1,222,656,000 |
| 停用 OCR/剪贴板后 |      9 |        643,055,616 |      902,500,352 |

这些代表快照受本机缓存和并行负载影响，不是峰值或 P95；共享工作集可能重复计算。最后人工、目标机和公开发布要求继续按完成审计保留，未以此次自动通过宣称完整一期验收完成。

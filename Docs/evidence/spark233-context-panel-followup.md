# 上下文超级面板：实现与验证续记

2026-10-27 最新补证：[集中代码包及功能测试](spark233-source-restore-functional-tests.md)已通过 42 文件/192 项测试、lint 和含 typecheck 的 build；未新增 UI/Windows 验收，本文旧报告仍保留原范围。

日期：2026-10-27，对应P3.17。本文记录早期捕获/资源/生命周期阶段的原输入，179测试/74审计候选不覆盖后来发现尚缺的按来源程序匹配。用户已确认补齐该能力，API 1.2 集中实现与功能用例现已通过，过程按[剩余实施基线](../archive/2026-10/spark233-remaining-implementation-2026-10-27.md)先补文档、集中实现、最后统一验证；实机项仍未执行，本条保持未勾选，总数60/108。

默认关闭，默认不允许模拟复制。提供中键/两个侧键、单击/200–1500ms长按及进程名排除。2026-10-27 用户明确确认保留原鼠标操作，长按释放后再打开面板。实现观察原输入并始终继续原操作，在满足长按阈值的合法释放后触发；不拦截或重放原鼠标操作。设置文案明确这一行为。复制备选必须显式开启，且说明会更新系统剪贴板，不宣称恢复原剪贴板。没有增加依赖或第二套匹配引擎。

## 原生捕获边界

`ContextPanelHelper.cs`沿用系统.NET Framework编译缓存。WH_MOUSE_LL只观察指定鼠标键，处理拖动、修饰键及注入事件；UIA TextPattern仅取当前选择并拒绝密码区，明确空选择不转为复制。仅不支持UIA且用户开启备选时发送Ctrl+C，要求本次新剪贴板序列、来源窗口/PID/进程生命周期及focus仍一致，不回退旧内容。来源token、request与helper session只在宿主协议内流转，有30秒期限；界面只收到受控状态及进程名。资源有文本UTF8 64KiB、原生图片8MiB、100文件、262144字节frame等界限。

TypeScript驱动对真实捕获串行排空：取消先发native cancel，等待实际旧响应，再处理新请求。超时或致命失败终止自有helper并上报不可用，仅显式重试/配置才重新启动；不会在不可用状态静默恢复监听。停用和shutdown等待实际子进程close。来源恢复失败不关闭当前面板；旧A恢复成功不退休新B。

`local-build/spark233/context-panel-native-probe/summary.json`保留初次三组隔离原生编译/driver验证；`context-panel-cancel-followup/summary.json`保留取消/致命失败的两组旧红、新绿，以及新字节三组回归。Windows运行的是真实csc/helper/driver，但使用helper内fixture模式，明确没有安装mouse hook、使用UIA、接触系统剪贴板/SendInput或操作用户窗口。它们证明协议、排空、文件边界和实际退出，不证明实机取选区。

## 宿主、资源和界面

捕获与materialize先完成，再创建鼠标附近的独立`context-panel`窗口。复用LauncherController、分批结果、公开命令稳定身份及PluginManager真实派发。普通启动器和面板各用自己的caller/context revision；旧文档身份没有任何上下文。窗口受信角色决定新caller的面板身份，后续导航或renderer崩溃撤权并关闭面板，初次导航保留捕获交接，不回退通用启动器上下文。

文本保留正文供用户显式选择命令，仅合法英文短词可作为查词建议。图片在受控捕获缓存验证、解码限额并转为宿主临时PNG；文件只授予本次规范化文件引用。发送文件到便签保存字面路径文本，不读取文件正文或增加Office解析器。发送图片在宿主写队列前快照已接受字节，关闭面板后已接受保存仍可完成。查词走本地词典，AI仅显式执行后进入工作区，呼出面板不产生AI网络请求。无有效选区时仍可使用常用/固定入口。

取消、新触发、关窗、导航、维护及停用撤销本次查询和资源权限。先删registry并通知各插件scope撤销context grant，再尽力删除PNG，磁盘删除失败不能保留可读句柄。context grant与原生文件选择器grant分开，读取还需核对当前resolver及原规范路径，scope关闭统一回收。每次配置变更只patch自己的字段，旧或畸形配置将面板安全恢复为默认关闭。

执行期间暂缓blur收口，保存失败保留面板可重试；完成依执行ID与原会话判定，旧A不能关闭B。另有独立presentation receipt：已接受写入完成后若出现新捕获或取消，旧结果不能开窗抢焦点；同次成功收口后的结果renderer仍可正常ready。Main窗口创建、延迟desktop_ready及show/focus均校验原展示代次，防止旧窗口的迟到ready间接触发B的blur。

设置提供状态、显式重试及无捕获预览；面板顶部提供来源、失败状态、返回来源和关闭。界面先监听再读取，使用session/revision拒绝旧回包，复用现有列表/错误/键盘行为，不显示正文或文件路径作为状态元数据。返回来源失败保留界面，不误报成功。

首轮现有Vitest为38文件179测试通过，包含Core三个连续代表组与一个真实临时文件权限失效组；typecheck/lint/整包build均实际0。日志：`local-build/spark233/context-panel-preparation/root-{tests,lint,build}-presentation-fix.log`。这些验证使用隔离输入，不替代真实Main/preload/renderer验证；后续结果单列并保存各自原始字节身份。

## 主进程代表链与边缘定位补修

真实Linux Main/preload/renderer/Controller/Manager及便签utility已取得文字、图片和文件代表链证据。图片A在宿主原read返回后，用受控Native工厂的新B事件排程，实际便签附件SHA256与已接受PNG相同；B保持打开，旧A没有抢开notepad。旧图片URL在撤权后实际404，reload图片面板实际destroy并撤权。文件发送只生成fenced paths，选中文件正文读取计数为0。这些属于原Main编译`90f4ac18…`的运行；最终报告汇总后再列完整身份，不将其改绑后续Main。

准备夹具最初选到了旧notes归档，SRI/backend严格断言阻止运行，之后改读当前dist-plugins catalog；初个运行的observer从Electron45不提供的additionalArguments推断label，业务动作前已正常退出，之后只观察实际preload label。代表链初个200%截图的查询错误来自夹具漏复制dist-host拼音资产，不能当正常拼音/词典成功证据；Linux运行参数含--no-sandbox，不能外推Windows生产sandbox证明。旧报告及错误保留，后续健康common空查询单独记录，不用业务mock绕过平台原生分支。

首个Windows候选`local-build/spark233/context-panel-2026-10-27/windows-gates-summary.json`已经通过build/lint、38文件179测试、74静态、固定样本与完整fresh，但未完成targeted binder，且不包含随后紧凑布局修复。冻结清单509源SHA256 `3a522f1460cb000261db78f5386cb215ab455b66b9b4cf13f1c5f5875363adeb`，ASAR `8c03e3796b98b9a436c288f4e2e783e63f58f58aab04bd109c7e7a761bc0681b`；它的成功运行不能代替后续新字节验收。

右下角实际定位红：`context-panel-main/run-HOmfnl/edge-observation.json`，Native工厂只将point改为1918,1078，生产Core/Main/bounds不变。1920×1080工作区中，计算以520宽夹边得到x1400，实际BrowserWindow被通用launcher的最小宽撑到640，right2040，向右越界120。已仅给面板Layout启用现有compact约束，使最小宽回到320；同一点修后实际bounds为1400,640,520,440，最小尺寸320,240，right1920不越界；新Windows候选已重新通过门禁，旧源码/原运行身份不改写。

## 自动验证收口

真实Main/UI最终报告为`local-build/spark233/context-panel-main/final-summary.json`，SHA256 `90b8d81e6e55a199bbdc0f412286a4cdbf19da81f7721834ada0a51c8d782e62`。20项明确范围的检查通过、requiredGroupPending为空；5阶段分别保留旧Main90f的完整数据流/定位红，以及新Main8e1d的紧凑定位/健康common200%/滚动执行/有界执行失焦与失败重试。只有Main一行compact变化，Core和renderer相同；没有宣称完整数据流在新Main重跑。

执行失焦原样本实际先超时、后失焦，已明确撤回该项正证。补验由真实utility进入gate后触发Main的合成blur，80ms后实际state/session不变，107ms内释放并成功，随后仅原面板关闭；连续两次真实业务失败保留同一context与可重试token，最后实际关闭。该项验证Main监听/Manager/Core链，不等同于物理OS失焦。5个主进程与10个utility全部正常退出0、没有deadline、/proc所属PID均不存在。健康200%滚动执行另有独立截图；旧缺拼音资产截图及观察器frame disposed等夹具问题全部保留，未冒称正常查询或业务失败。

配置真实FS四组报告`context-panel-config-probe/summary.json`（SHA256 `4ac6b147a4b789b3e995ed61b9587eccd6e6f57e72ba36f87bf1a4e430b45a6d`）通过旧配置缺字段defaultoff、畸形panel整块defaultoff且不改盘、strict patch与六字段保存重启，以及真实EISDIR rename失败不改内存/原文件字节。使用真实compiled HostConfigStore与atomicWrite，没有schema/文件写入mock。

最终Windows候选位于`local-build/spark233/context-panel-compact-2026-10-27/`。冻结509源清单SHA256 `e86eb450f5bd91d48ec9f62520379eac3bda9ba497e4f2e318765564b8d871dd`；ASAR `9e6d54880b228885bc0f6636cf8510d7778a8c7a80a60538dffa74701ffb0ef0`；NSIS `0d1251006c0e928f7c3d5d8ffc3c717ccccdac4ef064c464356f86cf57eea461`；最终binder `7acdb38c72b66fc408b3568b6c07eda6a9ae65687893c87fe029ca24a1077baf`。build/lint、38文件179测试、74静态及76编译文件/14原生payload/七包的绑定均通过。静态审计只证明冻结字节和结构，Main/原生/配置报告各保留完整原输入与限制，不被改绑为该Windows候选的新功能实机验收。

固定样本`seeded-smoke-UGzGqC`实际61.433秒、PID23068、ExitCode0；完整fresh `62995dfb-88cd-4045-897a-4adccb1b1439`实际225.138秒、PID34356、程序及wrapper均0、report.ok=true、未超时。原20:11:57 CIM报告返回为空，但收尾发现共用helper的PowerShell前缀后缀误写了两个字面反斜杠，不能用该空值证明排空。实际程序/utility退出0的记录保持原样；修后使用DirectorySeparatorChar及规范路径，并用自有Windows Node PID39540作真实正控：脚本实际命中该PID并退出1，Node固定10秒后自然退出0，没有kill；随后查询返回空。最终2026-10-26 20:25:37.0131853 UTC再次覆盖整个共享stage、无名称过滤，owned为空，helper退出0。正确helper SHA256为`9cf440d0e7334450eeaba83a4069a9c4b873205fbc70a14bd31a3924b27dc164`；旧helper、原空报告及ac21 binder/completion完整保留在`process-scope-before-fix`，不追认为有效清理证据。本次只修忽略的验证脚本，产品source/ASAR/build及实际smoke未改未重跑。独立Windows封存位置为`verification-runs/context-panel-compact-20261027-72252a50-f6f0-4ea7-a2c3-8b0e9c097c01`，包含509源及122文件完整release，旧509候选与定位红证据不被覆盖。此文最终汇总在该冻结之后更新，不回写冻结源中的进度。 最终封存及逐项复核实际0，manifest SHA256为`a089c0fbfdfcb3fc63d8f7d3f598d364fcf086f8008b3aa40a6a3ebe785e9fec`，4386文件/1,357,361,860字节；依赖外链单独登记，不遍历成隐含输入。

## 实机剩余项

最后必须实际检查鼠标触发、原应用行为、UIA与显式复制备选、来源焦点恢复、IME和可用多屏/DPI代表配置；不能用fixture或静态源码断言替代。Windows实机工具再次在JavaScript执行前报`sandboxCwd is not a local file URI: file:///home/bhwa233/code/galaxy-tools`，未执行任何UI动作，记录为`context-panel-preparation/windows-ui-runtime-blocked.json`。未改用自建输入脚本绕过工具入口。没有执行安装器、发布npm、安装UAC/SYSTEM服务或使用真实用户数据。

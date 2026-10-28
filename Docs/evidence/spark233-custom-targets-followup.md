# 文档与目录快捷入口：实现与验证续记

2026-10-27 最新补证：[集中代码包及功能测试](spark233-source-restore-functional-tests.md)已通过 42 文件/192 项测试、lint 和含 typecheck 的 build；未新增 UI/Windows 验收，本文旧报告仍保留原范围。

日期：2026-10-26，2026-10-27 更新。对应 P5.12。**实现与隔离自动链已通过，全屏置顶问题已修复并由独立补丁候选完成验收；实际 Shell 打开窗口仍待实机检查，本项保持未勾选，当前总清单为60/108。** 先前 47e1… 候选只证明 P3.12–P3.15，不含本文的新 apps 1.1.0。

2026-10-27后续确认：普通文档改用明确类型清单，未知类型通过程序或快捷方式添加；用户随后明确无需旧配置兼容，配置读写按现行规则校验，不保留旧未知document项的特殊豁免。1.1.2 集中实现与功能用例现已通过，下文1.1.0/1.1.1报告保持原输入，完整新规则见[剩余实施基线](../archive/2026-10/spark233-remaining-implementation-2026-10-27.md)。

## 目标、授权与兼容

沿用原自定义 UUID 及 `idFor("custom", UUID)`，增加 program、shortcut、document、directory 四种类型。用户通过入口选择器或专用拖放登记真实路径，改名、编辑、移除与原固定/个人别名使用同一稳定 ID；不按同名寻找替代，不扫描目录内容。

program 仅沿用 `.exe` 的 argv/cwd 规则；`.lnk/.url` 保留系统快捷方式本身。普通文档和目录没有 argv/cwd，通过系统默认程序/Shell 打开。2026-10-27 用户明确确认范围为普通文档/目录：脚本、安装包及系统可执行类型不通过 document 分支扩大，仍可使用原程序参数或快捷方式入口。

专用入口选择器及 preload `webUtils.getPathForFile` 拖放桥由 main 校验管理窗口/顶层 frame，再按实际 stat/realpath 记录 caller 文档内的 **路径与类型授权点**。目录不产生子树权限；原通用拖放仍只接受文件，新 Dialog 的局部 marker 阻止同时触发启动器上下文或便签打开。原程序路径输入和 cwd 改为只读选择/清空，不能靠 renderer 提交路径注册新目标。

保存先由真实 `manager.queryOwned` 读取当前配置，复核 owner 与调用文档，按 UUID 比对 path/kind/cwd。新目标或这些字段变化须重新通过选择器/拖放授权；未改变的旧引用允许改名、保留或删除，即使目标已缺失。成功/失败都推进可观察查询代次并撤销旧 session，成功另外清应用可用性缓存。关闭、导航、崩溃时撤销对应文档授权，授权表有上限。

初版只记路径的 grant 被实际测试发现可将同名目录换成程序后升级使用；现已绑定选择时的 kind，当前 classified kind 与保存 kind 必须同时匹配。原红记录保留，没有放宽用例。

## 插件数据与选择撤销

应用包升为 1.1.0、dataVersion 1、host `>=1.2.0`，新增独立 `custom-entries.mjs` 与 `migration.mjs`。数据文件 v1→v2 通过正式迁移 worker，保留旧 UUID/path/argv/cwd；legacy 缺 kind 只对原 exe/lnk/url 归一。迁移只读写插件配置，不访问、复制或备份外部引用目标；通用备份仍只处理配置引用，不扩大目录权限或加入目标目录为外置根。

get/save 返回 entries 与 supportedKinds。新 UI 遇到旧插件未声明 supportedKinds 时仅开放 program/shortcut，保存剥 kind；宿主亦做相同兼容，不迫使旧插件同时升级。

所有新查询的 launch/reveal/copy 私有参数带 selectionVersion，绑定目标类型/path/argv/cwd（不含标题）。同 UUID 显式换目标/参数后，旧查询参数不能趁 utility 提交与 main 收到回复的间隙打开新目标；query 生成新参数后才执行。实际打开前独立核对当前类型与 canonical point，新 doc/dir 不跟随后来被换向的 junction/link；原 program/shortcut 行为保持。缺失、改型或已移除的目标撤销并阻止旧缓存复活，配置仍可编辑/移除。

已接受的 Save 在 prepareStop 前排空，包括首次 loadSettings 尚 await 时的 Save；停止仍观察真正的 child close，不把取消通知当退出。

## 已取得的独立证据

- `electron/application-entries.test.ts` 四项通过：caller/目录点/子文件隔离及 revoke、旧缺 kind 与缺失原路径保留、cwd 独立授权、目录授权不能升级同名程序。第一轮真实红摘录单列于 `local-build/spark233/application-entry-admission-probe/first-red.txt`。
- `local-build/spark233/custom-targets-probe/summary.json` 的真实 Windows utility 五组通过：五种同名配置/稳定 ID、v1→v2/坏源不覆盖/幂等、目录无递归、missing/改型及旧快照保护、调用方/取消/实际 close，以及首读 await 的 Save 停止排空。补证还包括 title-only version 保持、同 UUID 改 path/argv/cwd 拒旧参数、无 version 拒绝、Windows 实际 junction 改向拒绝。
- 同目录 `manager-upgrade-report.json` 两组真实 Manager 链通过：健康 1.0.0/file v1/dataVersion 0 经实际 13 成员 tgz 和迁移 worker 升为 1.1.0/file v2/dataVersion 1，旧 owner/token 拒绝、固定/别名仍解析同稳定 ID；受控坏迁移先写坏自有配置再抛错，恢复原健康配置全部字节、旧包目录、dataVersion 0 和清空 transaction。

这些后台证据不扩写成 actual Shell 窗口或用户应用启动验收。

- `local-build/spark233/application-target-ui/final-summary.json`：本轮真实 Linux main/preload/renderer/Manager/utility，六段隔离操作均正常托盘退出且所属 utility 退出，无 renderer error/lastError。覆盖新增、编辑、同 UUID 换目标、固定、别名、移除、重启、旧插件无 supportedKinds 时剥 kind 保存及 200% 缩放。文件与目录来自实际 CDP `DOM.setFileInputFiles` 的 OS-backed File，局部 DataTransfer 为合成事件（`isTrusted=false`）；验证专用桥和全局拖放不双触发，不冒充物理 OS 拖放或真实 Windows 应用打开。
- `local-build/spark233/application-entry-native-probe/summary.json`：实际 Windows Electron 45、FS/junction/typed adapter 四组通过；真实 Node 子进程的中文、空白、引号、空参数和尾反斜线 argv 及 cwd 原样到达，`shell:false`，实际退出 0。文档/目录 Shell.openPath、showItemInFolder 与复制仅为记录 hook，未打开系统窗口或写真实剪贴板。所属进程终态为空。
- `local-build/spark233/custom-targets-2026-10-26/`：冻结 493 项源码，source-sync SHA-256 `45e41687acf1c1b765ff74579ee58c3f0835151ae60117ae516675986b5d2a23`；Windows dist:win、lint、35 文件/171 测试及 41 项静态审计通过。独立 seeded 配置实际 exit 0，56.771 秒；全新配置 GUID `ac9f4c6c-b771-492c-b771-c11183e91f70` 的程序 exit 0、110.199 秒且未超时，但报告 **ok:false**，故 wrapper exit 1，不生成成功 binding。

首轮全新配置失败在纸片固定后的 native topmost 断言：全屏监听已经让宿主降低置顶，但 CS watcher 每 650ms 将托管窗口插到外部 topmost HWND 后，重新提升其 native topmost；相同 fullscreen rect 去重后不再通知 JS，错误状态持续。真实非干预复现已证实 false→true。`local-build/spark233/p5-fullscreen-diagnosis/summary.json` 留下原 red 与修复后相同条件的 green：GetWindowLong 识别外部 WS_EX_TOPMOST，使用 HWND_NOTOPMOST 避免重新进入 topmost band；新 CS SHA-256 以该报告为准。实际新进程 exit 0、6.590 秒，46 个 100ms 采样跨多个 650ms 周期保持 false，无 show/focus 重入。强制自建前台组合未取得可信 OS foreground，原数据保留并明确不算覆盖；不据此声称正常/退出全屏组合已验。补丁候选独立从原 493 源快照构建，唯一源码差异为 CS，另留证据，不改旧失败报告。

## 实机工具缺口

[computer-use 技能](/mnt/c/Users/40417/.codex/plugins/cache/openai-bundled/computer-use/26.1021.31345/skills/computer-use/SKILL.md)及其 guidance/confirmations/API 已读。其约束要求 Windows UI 自动化通过指定运行时执行；本文将工具初始化失败与产品自动检查分开记录。按其规定通过 node_repl 导入 `@oai/sky` 初始化窗口检查，两次都在执行代码前失败：`sandboxCwd is not a local file URI: file:///home/bhwa233/code/galaxy-tools`；reset 后相同，未产生 Windows UI 操作。

继续做真实 FS/权限和系统打开接口的自动检查，不用非规定的 PowerShell UI Automation/SendInput 替代。系统接口返回成功或被测试 hook 接收不等于真实窗口内容已验收；窗口核对与关闭仍保留为缺口，不据此勾选 P5.12。

## 全屏策略补丁候选收口

`local-build/spark233/p5-fullscreen-fix-2026-10-27/completion-summary.json`：仅在原 493 源中将 CS 修为 `9f7d788f02f0bfbd0db52a96dafb7da0258500c483c768a41e3a275b359ed751`，未混入 P7 或诊断。短 stage P5FX04 的 build/lint/35 文件171测试/41 审计/seeded/fresh/binder 全部通过；seeded PID 44872 实际 exit 0、58.585 秒，fresh `f2d0adf8-2fe3-4a91-accb-7b37ef232843` PID 11896 实际 exit 0、221.986 秒，report true/errors[] 且 fullscreenAvoidanceObserved true，`2026-10-26T16:23:26.368158Z` 的全名称路径归属 CIM 为空。

补丁 sourceSync `d3907ed1e78049ec9ff0b0b4afc351f432acf03f6ebdf18e9b6d56aed166a01e`，ASAR `c5c0d8822a8f703a5e516f9f758963f6be74f9b6e063843eecb571e9a80d3bae`，installer `f39dc117877abb52a77fd49668cd8cb7d83e67f40b344b4cbd0d464db7906051`。完整源、release、profile 和原始报告已双份冻结；`snapshot-seal.json` 记录 1919 文件/1,074,847,412 字节（含 122 文件完整 release）。

原 CS 的 topmost 产品失败保留；中间长 stage 造成 285 字符 native 路径 ENOENT/缓存路径过长的环境失败也保留（实际 app exit 1/300.918 秒/timeout true，初始 marker null 与后来 process.json 终态 1 分开记录）。改用短路径后重新冻结 destination、重新 build 和检查，不把旧构建换绑新环境。P5.12 的实际 Shell 窗口仍未验收，因此保持未勾选。

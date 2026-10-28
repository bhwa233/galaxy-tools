# 一期逐项完成审计

2026-10-27 最新补证：[集中代码包及功能测试](spark233-source-restore-functional-tests.md)已通过 42 文件/192 项测试、lint 和含 typecheck 的 build；未新增 UI/Windows 验收，本文旧报告仍保留原范围。

2026-10-27执行顺序更新：本轮按[剩余实施基线](../archive/2026-10/spark233-remaining-implementation-2026-10-27.md)先补文档、集中实现、最后统一验证。复核新发现的来源程序匹配、文档正清单及恢复状态/令牌缺口仍需补齐，旧候选绿色不覆盖新增修补；完成数保持60/108。

续作状态（2026-10-26）：notes 0.1.1 utility/main、通用外置数据备份、私有根保护、崩溃恢复及设置字段补丁已经接齐。已有完整类型检查、lint、33 文件/163 项测试、真实 utility、main 七组和备份七组通过证据，Windows `dist:win` 已成功生成目录包与 NSIS。早期缺失 Windows 原生资源、没有新安装包的阻塞已解除。最终同一输入的固定旧样本 `seeded-smoke-pQcL2D` 和完整 Windows GUI smoke `c94c7be6-ea9b-4abe-a711-da40a9378cf0` 均通过；后者实际 ExitCode 0、212.288 秒、未超时、renderer `errors: []`。P3.1 据原条目范围完成，见[本轮收口](spark233-notes-finalization.md)。下文旧冻结候选继续只证明各自历史输入；完整一期及人工/目标机验收仍未完成。

审计日期：2026-10-26。范围为 [实施清单](../launcher-todo.md) 的原 98 个编号条目及本日新增十项（当前 108 项）及 [架构](../launcher-architecture.md) 的一期交付链。审计不是新增测试清单；复用已有日志、真实报告和生产源码，不为每一行新建用例。

便签引擎收口时原清单为 47/98；后续五项补证与新增十项合并后，当前在 P3.16 收口后为 **60/108 完整完成、48 项部分完成、待实现或待验收/发布**，见[工作区补证](spark233-workspace-lifecycle-followup.md)、[应用缓存补证](spark233-applications-cache-followup.md)及[入口偏好收口](spark233-launcher-preferences-followup.md)。以下累计记录保持历史输入；本轮累计补标完成项为 P2.11、P2.12、P3.1、P3.5、P3.6、P4.1、P4.3、P4.11、P4.16、P5.2、P5.7、P5.8、P6.2、P6.7、P7.2、P7.3。原 98 项要求继续保留，新增十项按当前主清单实施，不将任务勾选数当作代码实现比例。 便签 P3.1 此前因真实业务引擎仍在宿主而撤回完整标记，当前引擎已接入 utility、通用外置根备份已有七组证据，最终固定旧样本及完整 Windows GUI smoke 已绑定同一产物通过，P3.1 恢复完整标记；同名共存 P3.6 已补证完成，两项调整后曾保持 44/54，随后 P7.2 补证完成更新为 45/53；10 月 26 日先复核 P5.8 后为 46/52，随后最终固定样本与完整 smoke 通过、P3.1 完成后为 47/51。

续测补充：[Windows 无障碍及界面修复](spark233-ui-followup.md)记录原基线的真实启动器/插件页操作，以及新候选 `ui-error-details-followup` 的门禁、分发和修改管理页的 10 项 Windows 局部实际证据。新候选没有重新执行完整 21 项综合链，不能把下文原基线的成功报告改绑到新字节。

2026-10-25 当时完整通过默认 packaged smoke 的历史 Windows 候选为 `ui-contract-followup`：lint、32 文件/162 项测试、完整 typecheck/build/NSIS、354 输入一致、七包/UI 元数据/ASAR 审计和自己的 fresh 默认 packaged smoke 全部通过，见[历史候选](spark233-ui-contract-packaging.md)。最终 ASAR 文本目标 9 项及完整真实主进程 AI 显式请求检查已重放；搜索组件 5 项、词典/AI 模式 10 项、备份 UI 7 项和 manager/迁移/依赖/备份 16/14/6/9 项经源码散列或编译字节核对复用。8 份 SDK 输入、14 份 native 源及 14 个 payload 完全一致，依赖审计明确复用。旧 automated 成功、parallel 失败、lifecycle-ui pending smoke、模式键盘 13 项和旧 21 项综合链继续绑定各自历史输入。

本轮逐项检查发现并补齐了四处不能归为人工验收的实现缺口：P2.9 显式数据版本迁移、P4.11 OCR 引擎复用、P5.10 读取时文件身份与版本，以及架构 6.2 官方离线目录选择。此前 `46269+note-window-ownership` 包及测量只证明修复前代码，不能作为这四项已经完成的依据。该轮完整构建和包输入为 `87818-final-offline-catalog`，字节以[分发记录](spark233-packaging.md)为准。

“代表通过”仅表示表内所列范围；混合条目包含的物理交互、目标机或发布部分仍未完成。没有把没有发现错误、源码存在、一个绿报告或前置验证当成完整一期完成。当前完整目标仍包含最后人工/系统环境验收；执行入口和六组代表操作见[最后实机验收交接](spark233-final-acceptance.md)，状态仍为待执行。

本轮设置缩放、关闭及可访问性修复见[界面续修](spark233-settings-zoom-followup.md)；新候选 build/32 项审计/固定样本及完整 Windows smoke 通过，静态及运行结果单独绑定，旧行为链不改写为新输入已重跑。

## 核对入口

以下入口的当前文件和报告已读取；旧阶段材料只用于它们原有的阶段要求，不代替新增功能。

| 代号 | 源码/实际证据                                                                                                                                                                                                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B0   | [基线](spark233-baseline.md)，`local-build/spark233/p0/{snapshot.json,source-smoke,packaged-smoke,cold-restore,cli-mcp}`；原始工作区快照位于 `C:/tmp/spark233-refactor/p0-2026-10-24T09-57-20-895Z`                                                                                |
| B1   | [技术栈](spark233-upgrade-toolchain.md)、[Windows 升级](spark233-upgrade-windows.md)，P1 `npm-ci.log`、gate 日志、`final-smoke/report.json`、`fixed-fixture/report.json`、`cli-mcp/report.json`、开发进程快照                                                                      |
| V    | [原生前置合同](spark233-native-contracts.md)、[截图/OCR](spark233-native-capture.md)、[搜索](spark233-native-search.md)、[剪贴板](spark233-native-clipboard.md)；固定源为 `scripts/native-capture/sources.lock.json` 及各构建入口                                                  |
| H    | [宿主集成](spark233-functional-integration.md)，旧候选 `measurement-1792905486885` 的 15 项、`packaged-1792905353320` smoke 和固定数据散列；`host-report.json`、`restored-pages-fixed.json` 等限定代表界面和冷恢复                                                                 |
| L    | `electron/launcher.ts`、`launcher-command-matcher.ts`、`src/features/launcher/Launcher.tsx`；拼音 `7a5fc933…`、命令/规则/令牌 `ddfbf36a…`、隐藏查询 `72cb01a0…` 的实际报告，路径见集成记录                                                                                         |
| M    | `electron/plugins/{manager,backend,backend-worker,resources,desktop-host}.ts`；[管理器记录](spark233-plugin-manager.md)，生命周期 `local-build/evidence/plugins-lifecycle/report.json`；最新显式迁移 `plugins-manager/runs/3f7a0ef5-5dde-4b36-bd05-f016d7ce1dd1/report.json` 13 项 |
| W    | `web-host.ts`、`capabilities.ts`、SDK browser；`web-plugin/run-1792845196065/report.json` 的真实隐藏沙箱、来源/能力、主题、保存边界；[原生协议](../native-plugin-protocol.md)的完整 host/native/Web 链                                                                             |
| I    | [包安装记录](spark233-plugin-packages.md)：真实 HTTPS 安装/更新/SRI 拒绝 `2c800235…`、开发目录快照/链接拒绝 `2026-10-25T04-52-23-527Z`、Windows 真锁 `2026-10-25T05-02-55-385Z`                                                                                                    |
| O    | `capture.ts`、`native/capture/OcrWorker.h`、可重放 adapt/build；最新 OCR `ocr-result-functional/runs/107ca14b-2df8-4589-96d6-47e8eafc7a8f/report.json` 21 项及 `native-capture-p4/worker-adapt-replay.json`                                                                        |
| S    | [P5 十项审计](spark233-search-completion-audit.md)和[搜索记录](spark233-search-plugin.md)；当前 adaptation 7 的 `search-production/a9a8a308-2c90-473a-9e8f-f117e8433e96/report.json` 20 项、`current-native-binding.json`                                                          |
| T    | `packages/official/translation/{backend,dictionary,provider}.mjs`、TranslationWorkspace；`translation/runs/2026-10-24T13-29-54-823Z/report.json`，770,611 词条、本地词形/短语、无 lookup 网络、受控兼容 HTTP 流式/取消/401/缓存                                                    |
| C    | `clipboard.ts`、`clipboard-history.ts`、原生 service、ClipboardWorkspace；`history-1792900022609/report.json` 24 项、`backend-1792901092150/report.json` 15 项；真实窗口站错误 5 保留，未绕过隔离                                                                                  |
| R    | `backup.ts` 和 BackupDialog；`backup-functional/runs/8063c683-d8a1-4fcb-9112-b02cedc5c9c1/report.json` 8 项，含真实版本/包身份、正文/附件/SQLite/资源、失败恢复与保留增量                                                                                                          |
| P    | `package.json`、builder/官方包构建脚本、[分发记录](spark233-packaging.md)和其 `windows-package-final.json`；必须核对具体 frozen input，不把旧安装器散列用于新源码                                                                                                                  |
| U    | [界面代码检查](spark233-interface-review.md)；当前读取的 Vercel 指南、共享 shadcn 控件、语义主题和 reduced-motion；代码检查不等于物理 UI/辅助技术验收                                                                                                                              |
| N26  | [10 月 26 日收口](spark233-notes-finalization.md)：真实 utility、main 七组、通用备份七组、私有根与双窗设置补丁、33/163 和 Windows `dist:win`；最终固定旧样本/完整 GUI smoke 通过且实际进程退出码 0。                                                                               |

## P0、P1 与原生前置

| 条目  | 结论与依据                                                                                            |
| ----- | ----------------------------------------------------------------------------------------------------- |
| P0.1  | 历史阶段通过：B0 快照、工作区清单/散列和原始副本保留；当前仍在指定重构分支，未整体重置或提交。        |
| P0.2  | 历史阶段通过：B0 运行时、lockfile 和构建配置；B1 区分开发 Node 与 Electron 内嵌 Node。                |
| P0.3  | 历史阶段通过：B0 四个 gate 原始日志；旧 62/307 含隔离副本，当前源测试数量单列。                       |
| P0.4  | 历史阶段通过：B0 源码/目录 smoke、代表截图；不是新插件验收。                                          |
| P0.5  | 历史阶段通过：B0 CLI/MCP、保存失败与沙箱/GPU 报告；未扩大为真实全屏/IME 验收。                        |
| P0.6  | 历史阶段通过：B0 冻结样本；H 打包副本逐字节核对原 Markdown、PNG、ID/分类，原件不作运行数据。          |
| P1.1  | 历史阶段通过：B1 执行日 registry 元数据、package/lock 和 engines/peer；不声称之后始终是 latest。      |
| P1.2  | 历史阶段通过：项目专用 Node/npm、选择脚本和 CI 版本同步，未替换全局运行时。                           |
| P1.3  | 历史阶段通过：三主 tsconfig、SDK/clipboard 类型边界和完整构建，内嵌 Node 24 类型独立。                |
| P1.4  | 历史阶段通过：开发脚本使用 TypeScript 公开 CLI 元数据；B1 实际 Windows 开发进程启动。                 |
| P1.5  | 历史阶段通过：Vite/Rolldown 分块、Vitest 排除和真实公式/多窗口 smoke；没有为过升级删除有效断言。      |
| P1.6  | 历史阶段通过：B1 依赖固定与 gate；最终对应版本仍由 package-lock 约束。                                |
| P1.7  | 历史阶段通过：Vite dedupe 与根 KaTeX CSS 同版，实际公式渲染；未使用全局强制 override。                |
| P1.8  | 历史阶段通过：原测试适配真实升级，该阶段源测试 32/162；10 月 26 日已为 33/163，没有沿用重复发现数量。 |
| P1.9  | 代表通过：官方 shadcn 来源、主题 token、B1 真实深浅组件与对比度；完整日常 UI 属于 P3/P7。             |
| P1.10 | 历史阶段通过：B1 npm ci 原日志；不在本轮为重复取证重新安装依赖。                                      |
| P1.11 | 代表通过：B1 gates、目录包、核心便签/公式/图片/提醒/CLI/MCP；原条目明确保留真实 IME。                 |
| P1.12 | 历史阶段通过：B1 新基线、截图、实际计数及完整进程树；P1V 之后才进入业务拆分。                         |
| P1V.1 | 前置通过：V 固定源码、两程序构建、当时受控人工框选后同会话 OCR；不能覆盖新版全部标注。                |
| P1V.2 | 前置通过：固定 MSVC/ATL、Ling/TinyOCR/ONNX/OpenCV 来源与适配，编译输入可重放。                        |
| P1V.3 | 前置通过：独立 Pulse 文件名/Instant、受限调用者与取消/退出；没有安装 SYSTEM 服务。                    |
| P1V.4 | 前置通过：受控多格式/文件引用/敏感标记及旧库 setter 缺口；生产监听/回贴另见 P6 未验收范围。           |
| P1V.5 | 前置预算记录完成：V 少量固定样本、耗时/工作集和缓存条件；完整冷暖/系统资源仍由 P7.7 保留。            |
| P1V.6 | 前置通过：V 会话、权限、保存和进程合同已经落实到 SDK/adapter，历史限制未抹掉。                        |

## P2 宿主、SDK 与分发

| 条目  | 当前证据与未完成部分                                                                                                                                                                                                                                                                                                                                             |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2.1  | 实现与代表通过：`electron/host/`、HostConfigStore 单写者、main 编排、H；日常托盘/焦点人工体验仍待。                                                                                                                                                                                                                                                              |
| P2.2  | 实现：SDK 严格清单、兼容范围、入口、命令/模式、能力/依赖、dataVersion、迁移入口，资源由所属包与固定资源记录绑定；I/P 实际校验。                                                                                                                                                                                                                                  |
| P2.3  | 实现与代表通过：M/W/O/S 的 owner/version/instance/session/request 和资源域；不能用它宣称任意不守协议程序可控。                                                                                                                                                                                                                                                   |
| P2.4  | 完成：受限 SDK/来源/能力边界结合真实打包版管理页的第三方信任预览、取消、勾选确认及新增能力再次确认已通过；未确认前无后台执行或 grant 变化。见[授权与工作区补证](spark233-workspace-lifecycle-followup.md)。DOM 交互与受控选择器不宣称原生 picker/物理指针验收。                                                                                                  |
| P2.5  | 实现与代表通过：M/W/I 生命周期、保存拒绝、清理和死实例回收；七业务活动工作区全程更新体验待人工。                                                                                                                                                                                                                                                                 |
| P2.6  | 实现与局部代表：manager 依赖/范围与截图 availability 合同，关闭 OCR 不自动重启；原生按钮降级的物理操作待验收。                                                                                                                                                                                                                                                   |
| P2.7  | 实现与代表通过：I 实际 HTTPS 元数据/tarball、SRI 拒绝、安全解包、目录和 tgz 导入。                                                                                                                                                                                                                                                                               |
| P2.8  | 实现与代表通过：七独立预构建包/精确版本目录、P 全成员与依赖核对；客户端不执行安装脚本。                                                                                                                                                                                                                                                                          |
| P2.9  | 原缺口已补：M 的独立迁移在普通 factory 前执行，版本/包身份持久化，停用更新检查、失败与 migrating journal 恢复；R 含匹配版本。最后实机更新/断电体验仍待，模拟持久边界不是实际断电。                                                                                                                                                                               |
| P2.10 | 代表通过：W Hello Web 独立包、隐藏页面、安装/启停和 I HTTPS 两版本更新，普通 Web 未被强制使用 React。                                                                                                                                                                                                                                                            |
| P2.11 | 已完成页面实现与代表交互：版本/能力/依赖/更新状态、七条目、错误展开滚动/键盘、OCR 启停、卸载数据选项/取消，以及真实本地选择→预览→用户确认安装→启动→私有保存重开；证据见 UI 续测记录。第三方 native 信任、实际升级/卸载及完整 UI 验收仍由 P2.4/P2.5/P7 保留。                                                                                                     |
| P2.12 | 完整通过：真实宿主配置→独立 Web 页面主题→独立更新 6 项；UI 0.2.0 复用现有 shadcn 唯一源并记录 SDK/API/theme 范围，仓库外 tgz 消费的 strict 声明、实际点击/深浅色及正式 renderer 归档装配通过，官方 ClipboardWorkspace 真实使用包入口；10 月 25 日历史七包/ASAR 元数据及 packaged smoke 通过。见[UI/主题合同](spark233-theme-ui-contract.md)，物理视觉仍留 P7.8。 |

## P3 启动器与便签

| 条目  | 当前证据与未完成部分                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P3.1  | 完成：notes 0.1.1 utility 自包含引擎、包内 renderer 与 manager/owner 窗口/系统桥接已接齐。最终 `seeded-smoke-pQcL2D` 保持固定 ID、分类、原文、时间、PNG、提醒及布局；同输入完整 Windows GUI smoke `c94c7be6-ea9b-4abe-a711-da40a9378cf0` 覆盖 UI/桌面/磁贴/胶囊/提醒、保存拒绝及恢复，report `ok:true`、renderer `errors: []`、实际 ExitCode 0。见[本轮收口](spark233-notes-finalization.md)；IME/多屏/首装/SYSTEM 保留在各自原条目。 |
| P3.2  | 实现与代表：应用/便签设置分组、HostConfigStore、CLI/MCP 名称；10 月 26 日字段补丁和真实双窗保存已补齐，旧全量设置调用明确拒绝。文件关联的实际安装注册待目标机。                                                                                                                                                                                                                                                                       |
| P3.3  | 完成：正式独立 notes 包在真实 main/renderer/utility 链加载；管理页停用保存未落盘文字并撤下纸片、磁贴、胶囊、提醒和搜索，旧动作失效，宿主设置及 Hello Web 同 owner 保存仍可用；17.265 秒停用后重新启用恢复 ID、正文、几何、队列和提醒。见[工作区补证](spark233-workspace-lifecycle-followup.md)。                                                                                                                                      |
| P3.4  | 实现与代表：L 关键词/别名/拼音/文本规则/opaque action，H 图片上下文；物理快捷键、拖放与 IME 待。                                                                                                                                                                                                                                                                                                                                      |
| P3.5  | 完成：L 的命令模式/隐藏 query/取消，加上新 pin-keyboard-followup 的实际 Windows 模式进入、提示/过滤、返回按钮 Enter 不执行结果、Esc 取消及默认不混正文，13 项局部检查通过；见[模式键盘记录](spark233-launcher-mode-keyboard.md)。IME/拖放与全焦点仍在 P3.4/P3.7。                                                                                                                                                                     |
| P3.6  | 完整通过：历史 `ui-contract-followup` 的真实两个官方 provider 同一次 hello 查询返回词典、同名应用和待执行 AI，两个 opaque ID 各自解析真实词条/inventory 目标，9 项通过且 AI 请求 0；不运行 OS launcher，见[同名共存](spark233-launcher-coexistence.md)。                                                                                                                                                                              |
| P3.7  | 源码有 composition/焦点/对话框守卫；真实 IME、物理焦点、截图与多窗口内部切换尚未验证，不能判完成。                                                                                                                                                                                                                                                                                                                                    |
| P3.8  | 代表实现与 H/U 样式证据；完整工作区可读性、辅助技术和原生视觉仍待最终验收。                                                                                                                                                                                                                                                                                                                                                           |
| P3.9  | 活跃宿主/打包/服务/管道/env 身份为 spark233，P 校验 appId；历史 legacy-tauri/provenance 不是运行别名。实际安装快捷方式/关联待。                                                                                                                                                                                                                                                                                                       |
| P3.10 | H 首次零空便签/引导、默认冷恢复与 tray 代码已接；物理托盘、热键冲突与呼出体验待。                                                                                                                                                                                                                                                                                                                                                     |
| P3.11 | H/P 七插件安装启用与选择持久化、按需 OCR，未授权服务/AI 配置状态；真实启动记录不使用用户剪贴板作自动验证，待最后验收。                                                                                                                                                                                                                                                                                                                |

## P4 截图与 OCR

| 条目  | 当前证据与未完成部分                                                                                                                                                |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P4.1  | V 固定两上游 commit/tag 与依赖；O 新 worker 源可重放、生产 binary hash；新包 P 已绑定当前 EXE 散列，旧 EXE 记录仅保留历史。                                         |
| P4.2  | V 已跑受控选区→OCR，O 正式受控图片；本轮最后人工截图仍未执行。                                                                                                      |
| P4.3  | 固定 C++ 工具链和依赖，适配/构建入口可重放，O fresh replay；不依赖作者 D: 目录。                                                                                    |
| P4.4  | 独立原生产物/模型/目录和专属 session，宿主唯一入口；P 检查分发，实际原生托盘/快捷键交互待。                                                                         |
| P4.5  | V 路径与 PNG 会话，O 独立 task/result 清理；正式屏幕选区及中文/空格保存的人工流程仍待。                                                                             |
| P4.6  | CaptureController 通过宿主 recognize 路由独立 OCR 包，不查截图目录里的固定 ImageReader；O 独立资源证明，实际独立更新体验待。                                        |
| P4.7  | V/O session/PID/结果、错误、取消身份；不以监听剪贴板作回传。选中文字的前端操作有 H 代表，物理部分复制待。                                                           |
| P4.8  | availability 标志/禁用理由已实现，状态轮询不会自动启用 OCR；实际遮罩按钮与基础标注待人工。                                                                          |
| P4.9  | OCR 工作区实现图文映射/选择，H CDP 代表通过；Ctrl+A/C、跨行、缩放的物理操作未验收。                                                                                 |
| P4.10 | text_action 与目标插件启用检查已接，词典/AI/便签动作存在；完整人工跨插件使用待。                                                                                    |
| P4.11 | 原缺口已补：O 两张不同图同 PID/引擎初始化一次，同图首用/复用对照、取消和 idle/停用回收；新整包 P 已绑定，最终 packaged 原生记录也证明同 PID、单次初始化及退出码 0。 |
| P4.12 | O 21 项证明真实 exit0、无残留、输入/输出所有权和有限保留；截图未保存标注拒停体验仍待人工。                                                                          |
| P4.13 | 上游标注功能及适配可构建；框选/窗口识别/调整/各标注/撤销/复制/保存/取消的完整正式路径仍待人工，不能判通过。                                                         |
| P4.14 | 同选区传递与 OCR 代码/前置证据有；最终遮罩点击及全部/部分复制仍待人工。                                                                                             |
| P4.15 | 会话通道不借剪贴板推断结果；取消不覆盖真实剪贴板和并发外部复制的实机操作未执行。                                                                                    |
| P4.16 | V/O 固定中英文、代码、crop 的实际识别/缺陷/时延已记录；没有扩成穷举样本库。                                                                                         |
| P4.17 | 多屏/DPI 实际坐标与保存仍待目标机人工验收，现有 CDP 截图不能证明。                                                                                                  |
| P4.18 | 独立 npm/resource 域及管理器保存更新代码已接；活动截图/OCR 独立升级的人工体验待。                                                                                   |

## P5 应用与文件搜索

[单独十项审计](spark233-search-completion-audit.md)逐条覆盖 P5.1–P5.10 和架构 7.3–7.6：开始菜单/Store/自定义与 argv/cwd、固定 Pulse/Instant、授权服务、范围/分页/取消、MFT/USN、召回、私有内容合同、失败状态、默认卷排除，以及读取时身份与版本。S 20 项当前生产字节绑定已通过；实际 SYSTEM/UAC/全卷 MFT/USN 和完整物理 UI 未完成，不能将该十项整体勾选。

P5.8 于 2026-10-26 按原功能条目复核补勾选：原生产 24 项的停用清理/不可用状态，[ACL 续作](spark233-search-acl-followup.md)的真实文件撤权/精确恢复，[故障补证](spark233-search-corruption-followup.md)的私有 WAL 实际损坏拒绝/自动重建及恢复状态 11 项、目录继承 ACL 撤权与恢复 7 项、真实搜索连接不可用后应用/离线词典来源切换及选择 11 项，合并覆盖原条目的五类功能。服务面板另有[状态读取修复](spark233-search-service-read-errors.md)的真实组件 5 项红/绿回归；该组件仅控制 IPC 返回，不证明 SYSTEM 服务真实恢复。

此次只审阅既有记录，没有重跑 Windows 或把既有报告改绑到当前便签接线后的源码。原生证据绑定 adaptation 7，共存证据绑定 `ui-contract-followup` 冻结 ASAR，组件证据绑定其独立输入。未捕获 renderer 重建瞬态，也未验证任意 snapshot/WAL 故障组合、并发挂起查询延迟或完整物理 UI；SCM/SYSTEM/UAC 与全卷 MFT/USN、卷离线重连继续归 P5.3/P5.5/P5.9 的既有验收边界。

## P6 剪贴板、词典与翻译

| 条目  | 当前证据与未完成部分                                                                                                                                                                                                                                                                                                                                            |
| ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P6.1  | 生产 native listener/replay 和独立 backend 已实现；V/C 受控格式证明，私有窗口站错误 5 仍阻止当前生产 listener/真实回贴自动验收。                                                                                                                                                                                                                                |
| P6.2  | C 精确原始格式去重、外置资源/引用、缩略图和合并有代表；真实多格式日常预览仍待人工。                                                                                                                                                                                                                                                                             |
| P6.3  | copy/paste、纯文本/图像文件、文件引用有效性、目标焦点/UIPI 回执代码已接；实际原应用回贴和权限反馈未验收。                                                                                                                                                                                                                                                       |
| P6.4  | 独立 workspace 和 shared database、生命周期/筛选/备注/来源/待清理范围已接，C/H 代表；关闭后实际持续记录与小窗操作待。                                                                                                                                                                                                                                           |
| P6.5  | 完成：既有 770,611 词条/词形/短语/体积证据结合真实管理页完整词典包版本更新、失败回滚、查词及重启保持通过；DB/provenance/配置摘要保持。见[词典独立更新补证](spark233-workspace-lifecycle-followup.md)。本地版本更新不冒充新语料或公开 npm 发布。                                                                                                                 |
| P6.6  | T 实际受控兼容 HTTP 流式/取消/缓存/401、key 不泄漏，配置/默认语言/复制代码已接；真实用户 provider 配置未执行。                                                                                                                                                                                                                                                  |
| P6.7  | 完整通过：实际打包 renderer/控制器/backend/词库 10 项连续检查证明默认本地/待执行 AI、手动切换及不随输入/合成 clipboard 事件自动请求；另用同 ASAR 的完整真实 main/IPC/独立窗口证明打开 AI 请求为 0、实际点击后恰 1 次。均为隔离 loopback provider，历史暂停且零条、进程退出，见[切换证据](spark233-translation-mode-followup.md)。未外推外部模型质量或物理焦点。 |
| P6.8  | text_action、OCR/clipboard→translation/notes 已接；最终 ASAR 真实剪贴板组件/业务后端 9 项证明翻译启停降级、选区保持、停用不发 IPC 和便签实际保存片段，旧包两个失败断言保留；OCR 原生选字、OS 复制及其他目标的最终实际验收仍保留。                                                                                                                               |
| P6.9  | 完成：真实 ClipboardWorkspace 与 utility 验证历史/收藏独立排序与分别置顶、正文/备注/多标签编辑和恢复原文；清理后收藏及图库原始资源摘要保持，见[工作区补证](spark233-workspace-lifecycle-followup.md)。始终使用暂停的合成数据，无 OS 回放。                                                                                                                      |
| P6.10 | 完成：实际 UI/后台验证无限默认、启动保留样本、占用统计、范围收窄/放宽恢复、待清理预览、取消与确认；确认仅删除无引用 C，收藏/图库/置顶保持，物理资源总量与后台 198 字节一致。见[清理补证](spark233-workspace-lifecycle-followup.md)。延迟截图不用于证明最终候选数量。                                                                                            |
| P6.11 | C 文本/图文/文件合并、草稿与保留范围；workspace 快捷数字/F 键和位置代码存在，实际小窗/回贴仍待。                                                                                                                                                                                                                                                                |
| P6.12 | C 图库持久 PNG、分组/引用保护，emoji/symbol/recent UI/后台已接；实际导入/选取/复制待人工。                                                                                                                                                                                                                                                                      |
| P6.13 | C 暂停、来源排除、敏感标记代码及受控排除恢复已证；不宣称能识别所有密码，真实监听尊重标记待最后验收。                                                                                                                                                                                                                                                            |
| P6.14 | R 一致快照/版本身份/正文/SQLite/资源/新增数据保护与失败恢复已证；预览身份绑定和选择撤销后端 9 项、真实 renderer→host 的创建/预览/错误重选/取消 7 项通过并绑定最终包；完整恢复 UI、原生目录选择及系统入口待人工。                                                                                                                                                |

## P7 最终交付与验收

| 条目 | 当前证据与未完成部分                                                                                                                                                                                                                                                                                                                               |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P7.1 | 七包命名/渠道和本地完整归档已实现；实际 npm scope 归属、授权登录与公开发布未完成，不能判完成。                                                                                                                                                                                                                                                     |
| P7.2 | 完整通过：逐原要求映射见[更新合同](spark233-update-interruption.md)；既有真实HTTPS/离线/回滚、最终ASAR实际TLS中断旧版保持与半包清理、新增能力确认前后grant/owner、有效不兼容版本在取tgz前拒绝均有证据；公开发布归P7.1，未外推自动续传或完整物理UI。                                                                                                |
| P7.3 | 完整通过：官方截图 0.1.0→0.1.1 更新 gate 未释放时实际便签写入/查询和暂停合成剪贴板编辑/查询完成，16 项回归及最终包编译字节一致；外部 Hello Web 的真实 HTTPS 更新/SRI 拒绝链和统一 PluginManager.install 证明用户包沿用同一规则。原生选区/listener/公网发布范围留各自原条目，不外推。见[独立更新记录](spark233-independent-update-concurrency.md)。 |
| P7.4 | O 取消/停用/空闲进程退出，S 查询取消/停用清理有代表；物理截图继续使用和完整其他命令待最终验收。                                                                                                                                                                                                                                                    |
| P7.5 | 历史 `ui-contract-followup` 的完整 build/目录包/NSIS、七包/ASAR 和 fresh 默认 packaged smoke 通过，散列仍见[历史包](spark233-ui-contract-packaging.md)。10 月 26 日 `dist:win` 也已生成新目录包/NSIS，最终固定旧样本与完整 GUI smoke 已绑定同一输入通过并确认 ExitCode 0，见[本轮收口](spark233-notes-finalization.md)。                           |
| P7.6 | M/R 持久 journal 代表恢复和新增数据保护已有；真实断电、干净首装/卸载、热插拔显示器及 IME 未执行。                                                                                                                                                                                                                                                  |
| P7.7 | V 定义预算、O 新引擎复用对照/时点和 P 进程树样本；完整实际服务负载、物理呼出、峰值与真实冷缓存仍未证明。                                                                                                                                                                                                                                           |
| P7.8 | U 适用代码检查与 H 代表渲染已做；完整主题、真实键盘、缩放、辅助技术及物理 UI 操作待人工。                                                                                                                                                                                                                                                          |
| P7.9 | P 已实测历史包与资源，当时 measurement-1792909805347 的 21 项通过，含无 notes marker 真 fresh 首启和 proxy 阻断下词典/OCR；物理断网干净 Windows/截图遮罩首装尚未验证。                                                                                                                                                                             |

## 本日新增十项

当前总清单 108 项；以下十项补充原 98 项映射，原要求与历史证据不删除。实现顺序以主清单为准。

| 条目  | 当前证据与未完成部分                                                                                                                                                                                                                                     |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2.13 | 完整通过：结构化白名单/字节计数及容量边界、真实main/utility/UI隐私与生命周期19项、最终500源Windows的174tests/58审计/seeded/fresh/binder；见[诊断收口](spark233-diagnostics-followup.md)。                                                                |
| P3.12 | 完成：分组流、caller/request/revision、取消/owner 及真实 renderer 补验通过；维护 epoch 与七包同步校验性能补修后，最终 Windows 39 项审计/167 tests/维护快验/固定样本/完整 smoke 通过，见[分批查询](spark233-incremental-query-followup.md)。              |
| P3.13 | 完成：稳定身份固定/取消/排序、缺失/恢复与跨 npm owner 拒绝；真实 utility、命令 UI、正常重启及最终 Windows 候选通过，见[入口偏好](spark233-launcher-preferences-followup.md)。                                                                            |
| P3.14 | 完成：别名增改删、重启、同名区分和原匹配保持；13 共享别名截断红绿通过，最终候选通过，见[入口偏好](spark233-launcher-preferences-followup.md)。                                                                                                           |
| P3.15 | 完成：隐藏过滤默认/模式/Tab/alias/pins 与 provider 主次动作；管理恢复/重启及原授权不受影响，最终候选通过，见[入口偏好](spark233-launcher-preferences-followup.md)。                                                                                      |
| P3.16 | 完成：默认关闭的有界学习、同层解释排序、真实成功receipt/owner/迟到取消、开关清除及重启；真实Controller/UI与501源Windows候选175tests/66审计/seeded/fresh/binder通过，见[学习收口](spark233-keyword-learning-followup.md)。                                |
| P3.17 | 代码与隔离自动链通过：真实Main/UI20项、配置4组、原生取消排空及右下角红绿；最终509源Windows的179tests/74审计/seeded/fresh/binder通过。物理鼠标/OS选区/焦点/IME/多屏仍未验收，不勾选；见[超级面板记录](spark233-context-panel-followup.md)。               |
| P5.11 | 完成：真实菜单 ACL 拒绝及注册扫描子进程失败的逐来源缓存保护、首次 partial、恢复确认删除、目标/自定义撤销与停用 close 已红/绿补证；后续 caller 字节重放五组缓存集成通过，见[缓存补证](spark233-applications-cache-followup.md)。旧 UI ASAR 不包含新缓存。 |
| P5.12 | 自动链已通过，原生全屏置顶干预已修复并通过最终Windows烟测；真实Shell打开文档/目录窗口仍待验收，保持未勾选。                                                                                                                                              |
| P7.10 | 完整通过：真实 Windows Host/TLS、Linux main/preload/UI 的进度/说明/取消/重试/有界历史，以及最终 494 源 Windows candidate 的 build/171 tests/50审计/seeded/fresh/binder；见[更新反馈收口](spark233-package-tasks-followup.md)。                           |

## 完成结论边界

编号之外的架构要求也单独核对，不能只统计任务框：

| 明确要求                                      | 当前依据与边界                                                                                                                                                                                                                                           |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 最终产品名、全新身份、仅中英文                | 活跃 package/appId/管道/env/服务命名与两语言 whitelist；不把历史 upstream/legacy 资料当运行别名。P 的实际安装注册/快捷方式仍需目标机。                                                                                                                   |
| uTools 式首引导、后续恢复托盘、独立新便签命令 | H 的真实 fresh 零自动便签、冷恢复和命令；托盘/热键/IME 的物理操作仍待。                                                                                                                                                                                  |
| 架构 6.2 的四种安装入口                       | registry 明确来源、tgz、开发目录快照均有 I；官方离线目录选择入口已补齐，9 项隔离 host 链和最终 21 项中真实官方 clipboard 的卸载保数据/目录预览/信任拒绝/确认重装链通过；四种入口均有实际证据。                                                           |
| 标准包带齐七插件、运行时、模型与基础词库      | P 七包成员/SRI、模型、770,611 词条、字体单份、14 native/外部依赖；用户无需另装 Node/Python/模型。真实物理断网干净首装仍待。                                                                                                                              |
| 各业务独立启停更新、保存先于资源释放          | notes 真业务引擎已接入独立 utility 包，最终保存、迁移回滚、崩溃保留活编辑器及通用外置根备份已有当前代表证据；新 Windows 最终固定样本与完整 GUI smoke 已通过且实际 ExitCode 0；活动 UI 的完整更新体验仍待，见[本轮收口](spark233-notes-finalization.md)。 |
| API/代码/数据/资源与 UI/主题的版本边界        | SDK/manifest、宿主 dataVersions、所属资源的包版本/来源散列；UI 包 0.2.0、SDK 0.2.0、宿主 API 1.1.0、主题协议 1.0.0 与字体 v1 分别记录兼容范围，不承诺任意 npm 包或 uTools API 兼容。                                                                     |
| 初期第一方目录与 npm 分发，不建网页发布后台   | 本地预装目录和 registry 流程；公开 scope/授权发布未完成。没有新增 CF Workers/R2/D1 或外部市场服务。                                                                                                                                                      |
| 架构 14.2/实施清单 11 的完整交付链            | 关键词、查词、主动 AI、截图/当前选区取字、历史回贴、应用/文件正文、发送便签与独立启停更新均有实现；截图标注复制保存、真实回贴与实际服务全卷的物理链仍未验收，不能把整个交付链标记完成。                                                                  |
| MVP 验证、原数据隔离与可恢复工作区            | 当前 33/163（历史 32/162）、原有 smoke/少量真实边界，不新增格式/平台矩阵；所有验收数据位于 local-build/或明确临时目录，真实便签/历史不作测试数据，原快照保留。                                                                                           |
| 先实现、自动检查，人工验收最后                | 当前只推进授权的实现和隔离检查；没有为完成统计而请求再次框选、真实复制回贴、UAC 或公开发布。                                                                                                                                                             |

所有 98 个编号均有对应审计入口，P5 十项由专门记录承接。已确认的代码缺口先补齐并重新绑定新生产字节；未完成的人工、目标机和发布部分继续保持未完成状态。全目标目前不满足“每一项都已完成并验证”，不能标记完整一期完成，也不能通过缩小范围或删除未验收条目获得完成结论。

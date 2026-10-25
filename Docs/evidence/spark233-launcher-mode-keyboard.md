# 启动器模式工具栏键盘修复

日期：2026-10-25。范围：P3.4 / P3.5 的模式工具栏 Enter/Space 事件边界。初次源码修复仅修改 `src/features/launcher/Launcher.tsx` 和本记录；随后主线程完成新包构建与 Windows 代表操作，结果见下文。本次收口只更新记录，没有启动应用、操作桌面或修改源码。

## 源码确认的缺口

实际安装的 `node_modules/cmdk/package.json` 版本是 **1.1.1**，与根 `package.json` 的固定版本一致。其 `dist/index.mjs` 中，Command 根节点的 bubbling `onKeyDown` 对未取消的 Enter 会调用 `preventDefault()`，然后向当前选中的 CommandItem 派发选择事件；该分支没有按键目标必须是输入框的限制。

模式工具栏位于这个 Command 根节点内部。“返回全部入口”、搜索目录和范围按钮原本没有阻止 Enter 冒泡。Launcher 的 capture handler 处理 IME、Escape、Backspace、Tab 与结果动作快捷键，但普通 Enter 会继续传递；因此当焦点位于模式工具栏按钮且存在选中结果时，cmdk 会执行结果并取消按钮的原生默认激活。返回按钮可能因此打开便签而未返回，目录/范围按钮也存在相同事件边界。

源码入口为 `Launcher.tsx` 的 `onKeyDown`、`<Command onKeyDownCapture={onKeyDown}>`、模式工具栏和结果 `onSelect`。同页结果 More 按钮已经使用 Enter/Space `stopPropagation()` 保护自己的原生激活，可直接复用，无须新增通用 helper 或依赖。

## 最小修复与验证

在模式工具栏现有容器增加一个 bubbling `onKeyDown`，遇到 `Enter` 或空格时只调用 `stopPropagation()`，不取消默认行为。键盘事件先到达实际按钮，再在工具栏容器停止，阻止 cmdk 根节点执行当前结果，同时保留按钮原生 click。返回、目录选择及搜索范围按钮共用这一个边界；输入框 Enter 和其他导航按键不经过该容器。

项目选择的运行时为 Node **26.12.1** / npm **12.2.1**。本轮实际通过：

- `npm run typecheck`，包含项目五个类型边界。
- `oxlint src/features/launcher/Launcher.tsx`。
- `oxfmt --check src/features/launcher/Launcher.tsx`。

源码修复阶段没有新增测试文件、测试框架或重复执行完整测试套件。该阶段的类型、lint 与格式检查仅证明相应门禁；后续实际键盘与新包验证由主线程另行完成，并记录如下。

## 代表复现入口与实际新包操作

使用隔离 profile 和一条人工便签，保证剪贴板暂停且不使用真实数据：输入 `note` 后按 Tab 进入便签模式，等待出现一个已选中的样本结果；从输入框按 Shift+Tab 将焦点移到该模式唯一的“返回全部入口”按钮，再按 Enter。

修复前的源码事件链会进入 cmdk 的结果选择，并阻止按钮默认 click；修复后的期望为返回全部入口、输入框重新聚焦、不打开所选便签。下面的实际操作已验证 Enter 返回；空格使用同一事件隔离实现，本轮没有单独声称完成空格操作。

已查阅的 `functional-integration/host-report.json`、`ui-error-followup/native-ui/report.json` 和 `parallel-followup/native-ui/report.json` 分别覆盖宿主代表工作区、错误详情键盘收起、OCR 命令依赖启停；均未覆盖模式工具栏按钮 Enter。旧 `87818-final-offline-catalog` 的 21 项报告及 `parallel-command-availability` 的命令依赖十一项 UI 记录保持原输入绑定，不作为本次新增字节已通过的证明。原生遮罩、便签置顶 smoke 诊断及其他并行范围不由本记录改写。

当前输入为 `pin-keyboard-followup`，[独立构建记录](spark233-pin-keyboard-packaging.md)和 `local-build/spark233/pin-keyboard-followup/artifact-report.json` 的 `ok: true`、`artifactIntegrity: true` 确认本次修复已经进入实际新产物。主线程使用 fresh 七包配置 `mode-ui-1792922618215`，实际启动 PID 44740，完成 Windows 无障碍输入与原生 Tab/Shift+Tab/Enter/Escape 操作，没有 CDP/DOM 注入。

报告 `local-build/spark233/pin-keyboard-followup/native-ui/mode-report.json` 的 **13 项检查全部为 true**：默认入口不混入人工便签正文；关键词 + Tab 带余下查询进入模式；可见模式提示和单条筛选结果；Shift+Tab 到返回按钮后按 Enter 返回并清空查询、不打开所选便签；重新进入后 Esc 同样返回且不打开便签；返回后输入框重新聚焦。退出后的只读核对确认七插件仍启用、受控便签未改、剪贴板暂停且仅一条合成记录；PID 44740 已正常退出。

`native-ui/return-button-focused.png` 和 `native-ui/returned-enter.png` 是主线程核对过目标窗口的两张截图，分别保留返回按钮与返回后输入框的可见焦点环。UIA 的 `focused_element` 始终为 `RootWebArea`，因此子控件焦点依据是正确目标截图中的焦点环和实际键盘动作，**没有把 UIA 字段当作返回按钮或输入框焦点证明**。

## P3.5 原任务的验收映射

原 P3.5 要求为“实现插件模式的进入、返回、取消、提示与过滤，默认入口不强制查询和混合全部正文”。下表已结合主线程新包实际报告收口；P3.5 已由主线程完整勾选，当前任务统计为 **41 完成 / 57 部分完成或待验收 / 98 总项**。本次仅同步证据，没有编辑 TODO 勾选。

| P3.5 要求    | 当前源码与已有证据                                                                                                                                                           | 新包实际结果                                                                 |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 进入模式     | Launcher 的 `enterMode` 记录模式并清理旧列表；Tab 在唯一匹配的模式关键词上进入，便签 manifest 声明 `note` / `notes` 模式                                                     | `keywordTabEntersModeWithRemainingQuery: true`，保留余下查询进入模式         |
| 模式内过滤   | `LauncherController.query` 的 mode 分支只向该模式的插件派发 `{action: search, query, mode}`；返回结果仍检查 generation，前端还检查 sessionId 与自身 generation               | `modeShowsHintAndOneFilteredNote: true`，人工正文查询得到对应单条结果        |
| 返回         | `returnFromMode` 更新前端查询身份，清 mode、directory、query、result、selection、error，并请求输入聚焦；本轮修复工具栏 Enter/Space 冒泡                                      | Shift+Tab + Enter 实际返回、清空查询且不打开选中便签；输入焦点环与动作已核对 |
| 取消         | 模式内 Esc 复用 `returnFromMode`；每次新查询与 `clear()` 更新宿主查询身份并中止匹配，前后端均拒绝迟到结果；实际查询撤销已有下面的代表报告                                    | 再次进入模式后 Esc 实际返回、清空查询且不打开便签                            |
| 提示         | 当前代码显示模式 Badge、模式 placeholder 和底部导航提示，空列表复用 CommandEmpty                                                                                             | 模式/筛选提示已实际核对；本次没有扩展完整文案或空状态矩阵                    |
| 默认入口范围 | `electron/launcher.ts` 的默认 provider 仅在非空输入且 manifest `search` 为 `default` 或匹配 `word` 时查询；便签命令明确 `search: mode`，因此不会在默认输入中强制加入便签正文 | `defaultDoesNotMixAllNoteContent: true`，默认入口不混入受控便签正文          |

既有取消/撤销证据可复用其已经证明的机制：

- `local-build/spark233/command-pinyin/7a5fc933-8949-4510-af80-6474b6f4befa/report.json` 的 `replacement-and-stop-drain-native-sessions` 通过。对应现有 `proof.mjs` 实际并发替换两个 LauncherController 查询，断言旧查询 `items: []`、新查询结果有效；随后 `launcher.clear()` 与 matcher 停止后缓存会话为 0。该报告使用真实 native matcher 与简化 manifest manager，证明查询替换/清理，未进行模式按钮 UI 验收。
- `local-build/evidence/search-production/4428a93a-721e-44b0-a868-e9701daae49f/report.json` 的 `replacedQueryCannotPublishLateResult`、`disableCompletesAndClearsSessions` 均为 true。该报告经过真实管理器/正式搜索 adapter，补充证明来源层旧结果拒绝与实际取消清理；没有启动 SYSTEM 服务，也不作为模式键盘 UI 的替代。
- `local-build/spark233/plugin-crash-functional/query-runs/72cb01a0-441e-4468-94cf-a0e27e2fb7dd/report.json` 另已有真实隐藏 Web/混合查询的十项记录，包含查询不触发页面激活、超时向 handler 传递中止、停用取消并释放隐藏页面。它支撑查询/激活及资源生命周期合同，P3.5 无须重复搭建取消框架。

上述报告保留各自输入与历史身份；当前源码机制核对和本次新包 UI 另行绑定，没有将旧报告改名为新包运行。

**收口结论：新包代表操作全部实际通过，P3.5 已满足原任务要求并由主线程完整勾选。** 这组操作覆盖进入、过滤、提示、按钮返回、Esc 取消和默认入口范围，结合已有查询撤销证据完成收口，没有新增测试套件或矩阵。P3.4 的 IME/拖放/其他物理快捷键、P3.7 的原生对话框与多窗口焦点，以及 P5 的系统/整卷范围继续分别保留；此次通过不扩写为这些范围已经完成。

# 末次界面代码检查

日期：2026-10-25。依据为本次实际读取的 [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md)，本地副本位于 `local-build/spark233/functional-integration/web-interface-guidelines.md`。这是适用于 Electron 的代表代码检查，不代替最终人工界面、屏幕阅读器、物理键盘、缩放或 IME 验收。

原检查范围为启动器、插件管理对话框、共享 Button/Badge/Alert、全局主题 CSS 和便签搜索打开目标的保存边界。复用现有 shadcn/Radix 控件，未引入依赖或新测试套件。下文历史界面操作按当时产物保留，后续源码补齐另见本页末节。

- 启动器查询框有可访问名称、composition 守卫；结果使用 cmdk 导航，异步加载使用 `role=status` 和 `aria-busy`，空结果有 `CommandEmpty`。结果动作可用按钮及 `Alt+Enter` / `Shift+F10` 打开，使用带标题的 Dialog。
- 插件管理的 registry 表单使用关联 FieldLabel；安装信任和删除确认复用对话框，提交期间限制重复操作，错误由 Alert 呈现。导入开发目录复用原生 picker，尚未人工检查 picker 和确认流程。
- 共享按钮保留 `focus-visible` 边框/环及 hover 状态；Button/Badge 的 `transition-all` 已替换为显式属性列表。全局增加 `prefers-reduced-motion: reduce`，收敛 CSS 动画/过渡并关闭平滑滚动；最终打包链需核对这些样式确实存在。
- 全局浅/深主题设置 `color-scheme` 并沿用竹绿色语义 token。文字候选及错误信息使用已有截断、换行和空状态规则。真实缩放下的溢出、对比度、焦点遮挡及独立插件窗口主题仍需人工验收。
- 便签搜索打开新目标前等待当前正文保存；错误或保存期间再次编辑时保留当前内容。首次默认加载不能覆盖显式目标。行为证据见[集成记录](spark233-functional-integration.md)，不能仅凭代码检查宣称真实数据恢复全面通过。

本阶段没有逐页面声明全部符合指南。SSR/hydration、网页 SEO、移动浏览器安全区等规则不直接用于本地 Windows 桌面产品。多屏 DPI、原生截图遮罩、真实回贴焦点、辅助技术及完整工作区视觉检查按照用户要求留到最后，不因为代表代码检查通过而勾选全部 P7.8。

## 后续 Windows 无障碍局部操作

2026-10-25 用户手动启动最终目录包，使用隔离 profile `ui-1792913141284` 后，computer-use 已真实读到启动器无障碍树及截图，能发现欢迎引导、带名称的搜索组合框、命令列表和顶部按钮。通过引导按钮操作后，新的观察确认引导消失、命令列表仍在；这是原生 Windows 操作证据，范围仅限该启动器局部流程。

后续观察被物理 Esc 停止，已停止键鼠操作。搜索输入/键盘导航、插件管理以及完整焦点/辅助技术体验仍未完成；不能将读到控件树外推为全部无障碍验收通过。具体进程、准备运行时限制和续作状态见[验收交接](spark233-final-acceptance.md)。

用户再次授权后的实际续测已完成无障碍输入 `jietu`、Down 选择、七条目插件管理和关闭返回，见[续测与修复记录](spark233-ui-followup.md)。同时发现并修复错误详情占满管理页首屏的问题；新候选已完成门禁和独立打包，随后由代理切换并取得默认折叠、展开、详情内部滚动、空格收起及关闭返回的原生证据。旧轮错取前台 Codex 的图片仍拒绝作为目标窗口截图证据，新轮四张存档图片已分别核对目标。

追加实际交互：OCR 停用/恢复，卸载对话框默认保留数据并取消，以及用户确认后的本地 Web 包选择、预览、安装、启动器命令、私有保存和页面重开均有独立运行记录。P2.11 页面实现据此完成；这些代表操作不扩写为实际升级/卸载、第三方 native 信任或完整主题/IME/辅助技术验收。

## 并行源码续作与界面复查边界

后续检查发现停用 OCR 后截图所属的取字命令仍可能列出/调用，已补 `requiresPlugins`，用同一可用性判断约束启动器命令、管理页条目和实际派发。真实管理器/utilityProcess 的六项回归已通过，证明依赖停用时撤下命令、拒绝过期调用且不启动后台、独立 capture 仍工作且不自动启用 OCR、恢复后命令返回，以及未声明的依赖被拒绝；见[命令依赖记录](spark233-command-dependencies-followup.md)。随后在新包中另取得下面的真实 Windows 局部 UI 证据，不以管理器 probe 代替该操作记录。

原生截图工具栏也补上活动选区中的 OCR 按钮刷新，复用现有计时器、节点显隐和布局。正式适配源码重放、完整原生编译及直接调用生产 availability 的无窗口 probe 通过，见[OCR 停用补齐](spark233-ocr-disable-followup.md)。物理遮罩内的按钮隐藏/恢复、旧位置点击、基础截图功能、多屏 DPI 和工具栏可见范围仍未操作；两个 250 ms 采样周期不是已经测得的 UI 延迟上限。

[搜索 ACL 补证](spark233-search-acl-followup.md)的 24 项生产探针通过，证明受控文件真实撤权后旧正文结果不可 preview/open、新查询不返回及权限恢复。它未操作 Windows 搜索界面，也不代替 SYSTEM/全卷及真实定位/复制验收。[剪贴板隔离复查](spark233-clipboard-isolation-followup.md)仍因当前 token 的命名 station 错误 5、NULL/create-only 错误 183 而停止于 metadata；没有运行真实 listener 或回贴，不扩大既有合成历史界面证据。

`ui-error-details-followup` 包不含上述新增命令门禁与原生工具栏刷新；它的错误折叠、OCR 开关和 Web 样例安装记录仍只证明该旧候选的相应局部操作。历史 `parallel-command-availability` 虽完成 build、目录包、NSIS、七包及 14 native 审计，真实 packaged smoke 仍在便签置顶/原生层级断言超时，整体 `ok: false`，详见[原失败包记录](spark233-parallel-packaging.md)。该失败与报告没有改成通过。

前一 parallel 包使用 fresh 七包配置 `ui-1792920761844` 完成[命令依赖 Windows UI 验收](spark233-command-dependencies-ui.md)，十一项检查均为 true。实际安装截图插件为 0.1.1；OCR 停用后，管理页和启动器同时撤下取字入口，保留基础截图入口，重新启用后两处恢复。该轮只用 Windows 无障碍与原生鼠标，未使用 CDP/DOM 注入或直接改启停状态文件；正常退出后七插件启用、无安装错误，剪贴板仍暂停且仅两条合成记录。部分错取前台程序的图片未作证据。

该局部 UI 通过没有打开截图遮罩，不证明选区内按钮显隐、框选识别或基础标注/复制/保存，也不覆盖原 parallel smoke 的失败。

## pin-keyboard-followup 历史代表操作

此前候选 `pin-keyboard-followup` 已完成自己的完整 build/目录包、NSIS、七包及 14 native 审计，`artifact-report.json` 的 `ok: true`、`artifactIntegrity: true`；自己的固定样本 packaged smoke 也通过，`runtime.packaged: true`、renderer `errors: []`，见[该次打包记录](spark233-pin-keyboard-packaging.md)。这些保持当时输入的独立证据，未借用旧成功或改写原 parallel 失败。

Windows 置顶已明确使用公开 `pop-up-menu` 层级，其他平台保持 floating，原 fullscreen 判定继续保留；对照与因果见[置顶修复](spark233-native-pin-repair.md)。当前新包 `nativePinOnOpen: true`，此前失败的原生层级断言直接通过；`fullscreenAvoidanceObserved: false`，所以物理全屏/任务栏、多屏等真实体验仍需验收，没有通过改变 fullscreen 条件来规避断言。

主线程在该新包的独立 `mode-ui-1792922618215` 配置中完成模式键盘验收，`local-build/spark233/pin-keyboard-followup/native-ui/mode-report.json` 的 **十三项检查全部通过**。操作包括关键词 + Tab 保留余下查询进入便签模式、提示与合成正文过滤、Shift+Tab 后 Enter 返回且不打开选中便签、重新进入后 Esc 返回，以及默认入口不混入全部便签正文。PID 44740 正常退出；七插件启用、合成便签未改，剪贴板暂停且仅一条合成记录。完整任务映射见[模式键盘记录](spark233-launcher-mode-keyboard.md)，P3.5 已由主线程完整勾选，当前 41 完成 / 57 部分完成或待验收 / 98 总项。

两张正确目标截图 `return-button-focused.png`、`returned-enter.png` 保留返回按钮和返回后输入框的焦点环，结合实际原生键盘动作证明子焦点与行为。UIA `focused_element` 一直返回 `RootWebArea`，未把该字段写成子控件焦点证明。此次没有扩展到 IME、拖放、全部焦点、原生对话框或所有工作区的辅助技术验收。

原 `87818-final-offline-catalog` 的 21 项综合链继续绑定原产物；原 native 遮罩、剪贴板、服务、完整主题/IME/辅助技术等未执行范围继续在[验收交接](spark233-final-acceptance.md)保留。本次文档收口只更新上述记录，没有启动应用、操作桌面或修改源码。

## 自动回归集成与后续范围

后续架构核对确认便签业务引擎仍在 host，P3.1 原完整标记已撤回；P3.6 同名应用/词典共存补证完成，计数保持 44/54。便签抽取和停用时数据目录隔离属于继续实施范围，见[便签边界续作](spark233-notes-boundary-followup.md)，不能将其归为人工视觉验收。

此前 `automated-regressions-followup` 的完整 build/NSIS、32 文件/162 项、七包/14 native/ASAR 和 fresh smoke 成功继续绑定原输入，见[该次记录](spark233-automated-packaging.md)。最新 `ui-contract-followup` 已独立通过完整 build/NSIS、同一现有测试、七包/UI 元数据/ASAR、fresh 默认 smoke及绑定新 ASAR 的文本目标/真实主进程 AI 检查，见[最新记录](spark233-ui-contract-packaging.md)。两轮均未做 Windows 点选或截图迭代。

- 维护恢复复用真实 renderer 与宿主 gate，旧输入真实复现“命令已恢复而错误仍显示”，修复后暂态 query 错误清除、真实业务动作错误保持；同一局部检查已集成默认完整 smoke。
- 备份创建/有效预览/无效重选/取消的真实 BackupDialog→IPC→服务连续场景 7 项通过；仅原生 picker 返回固定隔离路径，未据此宣称系统文件选择器验收通过。
- 剪贴板文本目标启用→停用→恢复使用最终 ASAR 的真实组件、实际 manager/业务后端及受控 bridge，9 项通过，旧包两个错误断言保留；选区保持且实际保存便签片段，历史保持暂停、原记录不变。该范围不涉及 OS 复制/回贴或原生 OCR 选择。

完整输入绑定和红/绿路径见[文本目标与维护记录](spark233-text-target-availability.md)、[备份记录](spark233-backup-preview-binding.md)。独立更新并发 P7.3、词典/AI 默认与手动切换 P6.7、主题与 UI 包合同 P2.12 已按原范围验收勾选，最新计数为 45 完成 / 53 部分完成或待验收 / 98 总项；上节 41/57 是历史状态。

后续发现的 UI 包缺口已补齐：0.2.0 提供现有 shadcn 唯一源的可选组件、独立声明/预编译 CSS及框架无关主题，官方工作区真实从包入口消费；仓库外真实归档类型/点击/深浅色、正式装配及真实宿主主题/独立更新代表链通过，见[主题/UI 合同](spark233-theme-ui-contract.md)。词典/AI 默认与手动切换及完整真实主进程显式请求通过，见[切换记录](spark233-translation-mode-followup.md)；搜索服务面板读取错误清理/业务错误保留已通过真实组件红/绿回归并入最新包，见[错误恢复](spark233-search-service-read-errors.md)。这些结果不扩大为物理焦点、IME、缩放、多屏 DPI、原生遮罩、真实 listener/回贴或干净目标机验收。

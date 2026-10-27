# 设置窗口缩放、关闭与可访问性续修

日期：2026-10-26。按 [架构 3.4](../launcher-architecture.md#34-统一设计规范与绿色强调色) 与 P3.8/P7.8 继续检查。依据本轮实际读取的 [Vercel Web Interface Guidelines](https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md) 和 [shadcn Dialog 合同](https://ui.shadcn.com/docs/components/radix/dialog)。本页只记录代表操作与对应修复，P7.8 仍未完整完成。

## 实际问题与修改

启动器设置弹窗保留了 shadcn 的默认关闭控件，又嵌入 SettingsPanel 自带的关闭按钮，两者在右上角重叠。200% 缩放、380×280 CSS viewport 下，弹窗宽 348、内部固定面板宽 360，内容向右溢出。原截图与几何保留于 `local-build/spark233/ui-acceptance-2026-10-26/run-HIcbiQ/`，不将改后结果回写原输入。

现有 DialogContent 用 `showCloseButton={false}` 关闭额外控件，复用 SettingsPanel 的单一关闭入口；该入口改用已安装 Button 的 ghost/icon-sm 变体，提供本地化可访问名称、装饰 SVG 隐藏和既有焦点环。面板填满容器宽度、允许收缩，头部不收缩、正文明确 `min-h-0` 并独立滚动。便签列表的固定侧栏父容器继续决定其宽度。

检查同时发现快捷键“检测/检测中”缺少英文资源，录制入口不能区分对应命令，部分设置输入与滑块没有名称，自绘开关的隐藏 checkbox 聚焦后没有可见提示。现在补齐中英文两键、对应命令/控件名称、checkbox 所在行的焦点环及快捷键状态公告；没有新增依赖、重写交互控件或改变设置存储协议。

## 代表验证

使用真实 Linux Electron 45、正式 main/preload/renderer 与 notes utility，独立合成配置及数据目录；notes 清单仅将平台改为 Linux。通过 agent-browser/CDP 检查，键盘事件进入实际 Chromium 控件，不宣称 Windows 物理键盘、真实输入法或屏幕阅读器已验收。

最终报告为 `local-build/spark233/ui-acceptance-2026-10-26/run-sjEuO5/report.json`，`ok:true`，七组检查通过。可重放入口为父目录 `prepare.mjs`、`bootstrap.mjs`、`verify.mjs`，各次 fixture 与失败记录保留。

| 检查               | 实际结果                                                                                                                                                      |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 200% 布局          | Dialog 与 aside 都为 348 CSS px，边界重合；页面无水平溢出，关闭按钮恰好一个，没有默认重复关闭控件。                                                           |
| 关闭键盘焦点       | Tab/Shift+Tab 回到“关闭设置”，`:focus-visible` 和非空焦点环同时成立。                                                                                         |
| 正文滚动及开关焦点 | 连续 12 次 Tab，目标均在可见窗口内；正文自动滚动，两个 checkbox 的父行具有实际焦点环。                                                                        |
| 便签设置名称       | 默认便签页实际出现的 23 个 input 均有名称，含数据目录、开关、字号、Tab 缩进及五个背景滑块；条件隐藏的自定义颜色另有源码名称，不冒称本次已打开原生颜色选择器。 |
| 英文与深色         | 通过实际设置操作切换后，页面 lang=en-US、data-theme=dark、color-scheme=dark；实际控件显示 Check，录制控件名为 Launcher shortcut。                             |
| Escape 返回        | 关闭弹窗后，焦点回到启动器 combobox。                                                                                                                         |
| 空状态             | 真实进入便签模式后查询不存在的中文样本，显示现有空状态；该 fixture 未创建任何真实便签。                                                                       |

该报告记录源码 SHA。完整类型检查、lint、现有 locale/settings 两文件 8 项、Vite renderer 与正式 notes 归档组装均通过；没有为布局属性增加镜像单元测试。

同 profile 正常退出和重新打开后，英文/深色设置仍保持，稳定截图 `reopen-dark-settings.png` 已视觉核对：标题及单个关闭入口可见。产品 CLI `--exit` 与主程序均实际退出 0。

## 证据边界

首次即时深色/滚动截图出现了过期绘制，`settings-dark-en-zoom200.png` 不单独证明最终标题位置；以同 profile 稳定重开截图辅助实际 DOM 几何、键盘及持久化断言。早期 fixture 遗漏命令拼音资源、复用 CDP session 仍指向已退出端口、误用 dark class 而非 data-theme 的等待均为验证输入错误，不记产品 red；未绕过正式 Windows 的资源门禁。

本轮后续 Windows `dist:win` 已生成新候选，证据目录为 `local-build/spark233/ui-lifecycle-2026-10-26/`；32 项静态审计、固定样本与 fresh packaged smoke 已全部通过，精确结果见下文，不能沿用前一个 ASAR 的成功报告。授权/词典及便签/剪贴板代表链仍按各自冻结输入记录，见[工作区补证](spark233-workspace-lifecycle-followup.md)。

完整工作区辅助技术、原生窗口主题、物理 IME/多屏/焦点及系统剪贴板等仍按原任务保留；本页不将七组代表操作扩大为完整 P7.8。

## 新 Windows 候选绑定

本候选 `ui-lifecycle-2026-10-26` 已完成完整 `dist:win`、lint（零警告/错误）、33 文件/163 项现有测试，实际命令均退出 0。32 项静态审计覆盖七包、14 native、68 份 host/SDK 编译文件和完整 renderer；额外核对设置单一关闭逻辑、响应式/可访问属性和两语言文案。静态存在性不单独证明 UI 行为。

| 输入                            |      字节 | SHA-256                                                            |
| ------------------------------- | --------: | ------------------------------------------------------------------ |
| 安装器 `spark233-1.2.0-x64.exe` | 210273857 | `4ed2769c52fb1c2ae292a933bce76f9ff0b65e2ccee01ad8dbc5a29d330a7d9e` |
| `app.asar`                      |  36650624 | `c1a8deb1c98a0367de3376bc9b887574c4a05f17809db79fab4b5f4ce84dbf84` |
| `notes-0.1.1.tgz`               |   1368013 | `d00d3f5ba020c06f9b9914f48e48873bd011d23a43bba260a394671eb4437c2d` |

固定旧样本 `seeded-smoke-Ve0lqM` 在 52.918 秒后应用及 wrapper 均退出 0；ID、原文、时间、附件、提醒和隐藏置顶布局保持。完整 fresh `6243e922-2a53-4598-b585-0b6d7e246b51` 在 UTC 07:51:09.6335079 启动、07:55:07.1142258 退出，237.506 秒，应用及 wrapper 均退出 0、未超时，renderer `errors:[]`；两轮所属进程均已确认清空。

stderr 并非为空：保留环境 Alt+Space 注册冲突与既有维护拒绝；本候选 fresh 的托盘 notes RPC timeout 为 0。旧 inspector 会话的迟到回复诊断独立保留在工作区补证，不由本次通过反推不存在。多屏、冷恢复可见队列和 fullscreen 条件未观察到的字段仍不算通过。

`local-build/spark233/ui-lifecycle-2026-10-26/{artifact-audit,verification-summary,final-candidate-binding}.json` 保存完整输入及各轮报告位置；fresh/seeded 实际安装 notes 各 79/79 文件与本归档一致。六份关键业务源码和 68 份编译 JS 与上一候选相同，本候选仅四份 UI/locale 源码及关联 renderer bundle 变化。旧授权/词典、便签连续启停和剪贴板报告仍保留原输入，未改称在新 ASAR 重跑。

当前仓库随后已按新增需求开始 P5.11 应用缓存和 P3.12 分批查询续作；**这些后续改动不在本候选内**，其集成门禁需后续独立完成。安装器未执行、未签名、未发布，SYSTEM 服务未安装。

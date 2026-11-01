# 桌面窗口层 v3 决策依据（2026-10-31）

## 目标与范围

将[桌面层 v2](../desktop-widget-layer.md)升级为可拆任务的实现方案 v3，并同步[流量技术方案](../traffic-monitor-per-process-tech-design.md)与[早期计划](../traffic-monitor-per-process-plan.md)中的 HUD 决策。本记录归档只读原型的证据与设计变更，**不代表桌面层、便签迁移、HUD 或恢复功能已经实现**。

本次只修改这三篇文档及本记录；不改产品代码、依赖、配置、测试、CI，不构建/打包，不提交/推送/切分支。外部 Codex 证据目录只读。仓库现有无关脏文件保持原样。

## 证据位置与环境

推荐报告：

`C:\Users\bhwa233\Documents\Codex\2026-10-31\docs-traffic-monitor-per-process-tech\outputs\desktop-widget-layer-validation-and-recommendation.md`。

证据根 E（下表所有 `E/文件` 均相对此**完整绝对路径**）：

`C:\Users\bhwa233\Documents\Codex\2026-10-31\docs-traffic-monitor-per-process-tech\outputs\desktop-widget-layer-evidence\`。

| 文件                                   | 内容与本次用途                                                    |
| -------------------------------------- | ----------------------------------------------------------------- |
| `E/summary.json`                       | 运行环境、独立样本内存/进程、故障心跳、资源规则和验证边界         |
| `E/automatic-report.json`              | 原始阶段记录、frame→OS PID、app.getAppMetrics、卡死范围与加载错误 |
| `E/measure-web-0-report.json`          | 独立启动的空层样本                                                |
| `E/measure-web-5-report.json`          | 独立启动的5张独立hostname Web iframe样本                          |
| `E/measure-declarative-20-report.json` | 独立启动的20张简单宿主DOM卡片样本                                 |
| `E/native-split-readback.jsonl`        | passive / interactive 的原生扩展样式只读回查                      |
| `E/ui-final-before-stop.json`          | 输入诊断；不作为物理鼠标点透通过证据                              |
| `E/README.md`、`E/probe/`              | 隔离源码、运行方式、限制；本轮未重跑原型，未修改其文件            |

环境来自 `E/summary.json`：Windows 11 Pro build 26300，主屏2560×1440、DPI100%，Electron45.1.0 / Chromium156.0.8078.49 / Electron内置Node24.22.1。保留sandbox/contextIsolation/webSecurity/GPU/site isolation。最小HTML、短时独立启动场景，非正式产品负载。

## 实测结果与被推翻的假设

| 项                | 实测结果（不是预算）                                                        | 推翻/修正内容                                                  | 来源                                                       |
| ----------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------- |
| 空层成本          | 1个活动renderer；private22.09 MiB，working set89.24 MiB                     | 层不是零固定成本；多surface必须累加计量                        | `E/measure-web-0-report.json`                              |
| 5张Web卡片        | 6个活动renderer；private145.97 MiB，working set561.16 MiB                   | 删除“每屏两个renderer、与卡片数无关”                           | `E/measure-web-5-report.json`                              |
| 20张宿主卡片      | 1个活动renderer；private22.93 MiB，working set92.01 MiB                     | 声明式共享可作为默认方向；不推导正式React/曲线单卡固定成本     | `E/measure-declarative-20-report.json`                     |
| 独立hostname卡死  | 目标心跳停滞约1.25 s，另两卡和宿主继续                                      | 隔离来自实际进程域，iframe数量不等于故障域                     | `E/automatic-report.json`、`E/summary.json`                |
| 同hostname卡死    | 1.212 s观察窗内三卡各增加0次心跳、宿主13次                                  | 默认不提供hostname复用性能选项；共享会扩大卡死范围             | `E/summary.json`                                           |
| 宿主死循环        | 层宿主心跳停止                                                              | 共享可信UI仍有共同故障域，需主进程心跳与有界重建               | `E/automatic-report.json`                                  |
| subFrame-only策略 | 层主页面加载 `ERR_BLOCKED_BY_CLIENT (-20)`                                  | 不能简单反转插件窗请求过滤；主页面/子导航/静态资源/SDK路径分开 | `E/automatic-report.json`                                  |
| DOM和OS输入       | 子document pointer不冒泡到父；passive有WS_EX_TRANSPARENT，interactive无该位 | CSS点透≠物理点透，父容器不能自动代拖iframe                     | `E/automatic-report.json`、`E/native-split-readback.jsonl` |

MiB=2^20字节。working set求和可重复计共享页，不是整机物理内存净增；private与working set不是JS堆。原型20卡只有有界数字/文本DOM；v3独立Web壳拓扑与原型共享壳不同，必须重新测量，不能将这些值标为v3预算通过。

## 写回的决策

- D2/D6：统一宿主合同，声明式React默认；共享surface按display/zGroup/inputMode最多四类按需创建。自定义Web独立受限壳+sandbox iframe、独立session/不透明hostname，另计renderer和配额。
- D10：passive整窗ignore，interactive正常命中；编辑统一宿主手柄，不能用CSS或iframe父容器代办物理输入。**真实鼠标点透、捕获与DPI/双屏代表链是M2迁便签的硬出口。**
- D11/D18/D19：模板与实例UUID分开，宿主布局单写者；notes实际布局通过NotesDataClient保存，迁移journal及最新revision反向投影后才回旧路径，停用不清布局。
- D13：声明式合同与React执行器本期实施；原生执行器延后，二者不再混为一项。
- D14：HUD最终展示端=声明式卡片；C#保留ETW/服务/桥，不保留--widget窗。“不依赖主程序常驻”理由撤销：现行及未来展示都依赖宿主。
- HUD两阶段：层未就绪先交付桥、主页面/托盘；层M1出口后在层M3接HUD。流量D5/D10、架构/生命周期、§8和M4a及早期plan的M3b同步修改，统一标“待层落地替换展示端”。
- D15/D16/D17：有界资源配额与安装模板数量摘要，主进程按故障域限次恢复，显式编辑模式。数据/动作绑定definition、instance、PluginOwner、loadGeneration；超限拒绝完整JSON，不截断。
- SDK：旧插件保持原schema消息，新widgets需要API≥1.4.0及新SDK；旧strict schema会拒新字段。无后台静态/host数据卡合法，不要求dummy入口。

v3内的配额、CPU/内存、首帧、带宽与重建阈值均是**设计/预算值**，不是本次实测结果。完整规格与各文件接口见[主方案](../desktop-widget-layer.md) §3–§14。

## 待签字与未解决事项

产品签字项以主方案§15为准：实例/Web配额；全屏HUD例外；同hostname复用是否未来开放；编辑器交互/入口；第三方开放节奏；host provider范围；flags默认与旧路径保留；HUD依赖排期；布局/移除策略。未签字按文中建议做隔离实现，不默认发布。

工程仍需验证：真实物理点透/拖动捕获、跨屏/混合DPI、多应用/管理员窗口、全屏、休眠唤醒、24h、正式React/图表、独立Web壳完整成本、生产迁移/回滚与停用更新恢复。原型不包含这些验收，不能标为“已实现/通过”。

阅读还发现以下现状，本轮不扩到其他产品代码/历史章节：

- `electron/main.ts` 只是入口；实际编排在runtime.ts，当前方案已据此修正接入路径。
- 便签错误提示仍提electron-layout.json，但持久化实际走NotesDataClient；v3已避免用旧文件保留作为回滚保证，旧错误文案未改。
- manager.queryOwned可fallback activate，通用插件工厂会预建Web controller；无窗执行需要新增明确入口，当前代码未具备本文承诺。
- 流量早期plan仍保留ETW事件10–17、旧探针“立即行动”和历史人日等非HUD旧内容；正式技术稿已指出这些边界/探针问题。本轮按要求只改HUD决策，不重写采集历史方案，不能执行旧探针步骤充当验收。

## 本轮核对

按用户指定顺序阅读v2、报告/原始证据、流量方案、架构与现有manifest/窗口/插件代码；写回上述四份文档。核对D1–D14完整性、M0–M4/§15、schema和消息边界、HUD跨文档一致性、路径、Markdown及允许文件diff。未运行产品typecheck/lint/test/build/smoke/pack，未重跑Electron原型；原因是本轮纯文档交付。

从三份measure报告按activeRendererOsPids筛选app.getAppMetrics并重新求和，数值与本记录一致。文档静态核对通过：§1–§15、D1–D19、JSON示例解析、表格列数、代码围栏和相对链接；跟踪文档的git diff --check无空白错误。这些是文档检查，不是接口实现或产品测试通过。

发现既有.gitignore第29行 `*PLAN.md` 忽略 `Docs/traffic-monitor-per-process-plan.md`：文件已同步修改并单独核对，但不出现在普通git diff/status中。本轮未更改忽略规则、未强制暂存；后续如需纳入版本管理，应显式处理该文件，不能漏掉HUD决策同步。

# 桌面窗口层（Desktop Layer）实现方案 v3

> 日期：2026-10-31；续验：2026-11-01。状态：**平台、便签可逆迁移、接口总量流量 HUD 及截图常驻贴图迁移已实现；三个桌面开关按用户决定默认开启**。新配置及旧配置缺失字段补 `true`，已经明确保存的 `false` 保持不变。最终构建、lint、75文件/316测试及截图真实Electron自动集成23项已通过；原生图钉/继续标注/撤销重做/取消恢复代表链、默认值、超额便签兼容恢复和两次新进程贴图恢复也已有证据。此前两轮launcher-preferences rename EPERM失败日志保留，最终通过不等于该Windows间歇写入问题已根治。100/125/150%双屏既有证据、未完成的完整跨窗口拖动及长期验收均按原范围保留。详见[首版记录](evidence/desktop-widget-layer-implementation-2026-10-31.md)、[第二阶段记录](evidence/desktop-widget-layer-expansion-2026-10-31.md)和[截图迁移与默认值记录](evidence/desktop-widget-layer-screenshot-2026-10-31.md)。
> v3 替代 v2 的进程数、故障隔离、资源放行、输入、持久化回滚和 HUD 决策。不列人日或工期。
> 关联：[启动器架构](launcher-architecture.md) §13.2、[当前架构](architecture.md)、[胶囊行为](edge-capsules.md)、[插件窗口布局](plugin-window-layout-prd.md)、[原生协议](native-plugin-protocol.md)、[流量技术方案](traffic-monitor-per-process-tech-design.md)、[本次决策证据](evidence/desktop-widget-layer-decision-2026-10-31.md)。

## 1. 范围、依据与工程入口

### 1.1 交付目标

宿主统一管理桌面卡片的模板、实例、owner、数据、命令、布局、surface、生命周期和恢复。默认采用**宿主 React 声明式卡片**；自定义 Web 是隔离扩展类型，单独核算资源。便签和截图贴图是可信 consumer，不通过第三方 widget 权限桥调用其内部命令。复杂键盘输入、输入法和便签正文编辑继续在插件主窗；截图的取框、标注及继续编辑保留原生工作面，常驻展示归宿主桌面层。

| 编号 | v3 目标                                                                                            | 验收口径                                                                      |
| ---- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| G1   | 基础共享层按 `(display, zGroup, inputMode)` 按需创建，最多四类/屏；交互 widget 使用额外局部 family | 仅基础共享层有四窗上限；局部 family 和独立 Web 壳均须另计窗口及 renderer 成本 |
| G2   | 声明式、便签和 Web 使用同一实例/布局/生命周期合同                                                  | Web 可使用独立受限承载窗，不进入共享可信执行域                                |
| G3   | 数据源和动作均显式声明、绑定 owner 与代次                                                          | 无 Node、任意文件/网络/窗口 API；动作仍可间接触发已授权业务                   |
| G4   | 宿主是用户布局唯一事实来源                                                                         | 插件只给初始默认值；停用保留、删除明确、回滚可恢复最新位置                    |
| G5   | 按故障域恢复，主进程监督，有上限地重建                                                             | 单卡逻辑异常、子脚本卡死、renderer 退出、宿主层失效分别处理                   |
| G6   | 便签保存、展开、三边队列、悬停、滚轮、跨屏记忆不退化                                               | 真机输入出口通过后才允许迁入；正文不搬进层                                    |
| G7   | 不使用 widgets 的旧插件继续运行                                                                    | 新字段要求 API 1.4.0；旧 strict schema 不接受新字段                           |

完整方案包括声明式 React 执行器、隔离 Web、宿主编辑模式、便签可逆迁移、流量 HUD 展示端和截图常驻贴图。当前已实现这些功能及 SDK、持久化、生命周期和管理入口；截图保留原图、八类形状和 undo 状态的可编辑 scene，支持重新进入原生编辑器。2026-11-01 流量展示升级为 140×52 DIP 双行提示，声明可选 `desktopInteractions` 后支持 hover 排行、单击详情、拖动和原生右键菜单；置顶/贴边隐藏/全屏隐藏按实例保存。模板新增至多两个 `rank-list`、各最多三行，以及独立校验、绑定 owner/instance 的 PNG 附件。按进程服务及详情页已进入联调；物理网卡与 ETW 仍使用各自真实口径，提升权限采集与 UAC 发布出口未验收。完成实现及调整默认值不等于完整 M1/M2/M4 发布出口通过，未覆盖项见第二阶段和截图记录。原生 Direct2D 执行器、逐卡任意跨 surface z 序、可聚焦输入卡片不在本期。**声明式是内容合同，不等于原生执行器。**

### 1.2 最初只读原型实测来源（历史范围）

本节保留方案决策时的原型和未验证范围；后续产品实现与实测增量分别记录在第二阶段及截图证据页，不把不同版本的结果合并为同一次验收。

以下将外部只读证据根记作 E，**E 的完整路径**为：

`C:\Users\bhwa233\Documents\Codex\2026-10-31\docs-traffic-monitor-per-process-tech\outputs\desktop-widget-layer-evidence\`。

报告 R 为同级 `desktop-widget-layer-validation-and-recommendation.md`。本文 `E/文件名` 均指此根下实际文件，并非仓库目录；仓库内引用使用相对路径。详细归档索引见[决策证据](evidence/desktop-widget-layer-decision-2026-10-31.md)。

| 实测场景（最小 HTML，独立启动）    | 活动 renderer | renderer private 合计 | renderer working set 合计 | 来源                                   |
| ---------------------------------- | ------------: | --------------------: | ------------------------: | -------------------------------------- |
| 空层                               |          1 个 |             22.09 MiB |                 89.24 MiB | `E/measure-web-0-report.json`          |
| 5 张独立 hostname sandbox iframe   |          6 个 |            145.97 MiB |                561.16 MiB | `E/measure-web-5-report.json`          |
| 20 张宿主直接渲染的简单数字/文本卡 |          1 个 |             22.93 MiB |                 92.01 MiB | `E/measure-declarative-20-report.json` |

环境：Windows 11 Pro build 26300，2560×1440、100% DPI，Electron 45.1.0 / Chromium 156.0.8078.49 / Electron 内置 Node 24.22.1；来源 `E/summary.json`。这不是开发 Node 版本要求。working set 求和可重复计算共享页，不代表整机物理内存净增；不含完整产品后台、主进程、GPU 成本。简单 DOM 也不能代表正式 React、图表和插件业务负载。

`E/automatic-report.json` 与 `E/summary.json` 确认：

- 独立 hostname 卡死时，目标心跳停滞约 1.25 s，另两张和宿主继续；同 hostname 样本在 1.212 s 观察窗内三卡心跳均增加 0 次、宿主增加 13 次。iframe 本身不保证独立故障域。
- 宿主死循环导致层心跳停止；当前原型没有生产级自动恢复。
- 仅放行 subFrame 导致层主页面 `ERR_BLOCKED_BY_CLIENT (-20)`。
- 子 document 的冒泡 pointer 不到父文档；CSS `pointer-events:none` 只改变层内 DOM 命中。
- `E/native-split-readback.jsonl` 确认 passive 含 `WS_EX_TRANSPARENT`、interactive 不含该位；**只证明原生样式，不证明真实鼠标点透**。

真实鼠标点透/捕获、跨屏、混合 DPI、全屏避让、管理员窗口交互、输入法、生产迁移和 24h 稳定性均**未验证**。受控拖动和样式回查不能代替这些出口。

### 1.3 当前源码与 v2 路径修正

以当前源码为准：`electron/main.ts` 仅调用 `startDesktopHost()`，编排与 scheme 首次注册在 `electron/runtime.ts`；插件工厂在 `electron/plugins/desktop-host.ts`。以下文件均以仓库根为基准。

- `capsules.ts` 仍管理边缘/浮动/预览/拖动窗口，`capsule-layout.ts` 已有 DIP 队列几何；当前 Edge 只有 left/right/top，不增加底边。
- 便签布局由 `host/note-surfaces.ts` 经 `NotesDataClient.getState/putState("layout")` 保存 version 2（windows + capsuleQueues），不是直接覆盖一个 JSON 文件。旧错误文案仍提到 electron-layout.json，不能据此判断实际写入路径。
- `host/plugin-window-state.ts` 管独立插件窗；`note-window-state.ts` 派生便签 presence/pinned，不是持久化仓库。
- `plugins/manager.ts` 的旧 `queryOwned` 有 fallback activate；widget 现使用独立的 `ensureWidgetOwner` / `executeWidgetOwned`，无 fallback。工厂的 widget purpose 延迟建立 Web controller，静态 widget-only 插件只建立轻量 owner scope。
- `plugins/desktop-host.ts` 已集中分发 backend/native 的 `onEvent`。在这里增加有界广播即可；不必把两个底层 controller 都改成订阅框架。

## 2. 关键决定：D1–D14 与新增决定

§15 保留产品取值及后续发布验收问题。三个开关默认开启已由用户明确决定，按 §14 实施；安全边界、便签可逆恢复和真机验收要求继续有效。

| 编号 | 决策点      | v2 值 → v3 值                                                                                     | 依据                                                                        |
| ---- | ----------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| D1   | 实现归属    | 宿主模块 + layer 页面 → 保持；实际由 runtime.ts 编排                                              | 跨插件窗口和权限必须归宿主                                                  |
| D2   | 窗口/进程   | 每屏两窗且进程固定 → 共享声明式按 display×zGroup×inputMode，最多四窗/屏，Web 每实例独立受限窗     | `E/measure-web-5-report.json`：5 卡为 6 个 renderer；窗口上限不能当进程上限 |
| D3   | 形状        | 矩形并集 → 保持，补 clip 坐标、DPI 和输入模式；空集合隐藏并释放空 surface                         | 复用 capsule-layout；透明空白不能拦截输入                                   |
| D4   | 同步        | snapshot + diff → 保持；分离声明默认值、用户布局和运行可见性                                      | 重放、幂等和单写者                                                          |
| D5   | 便签渲染    | 可信 React → 保持；仅胶囊和预览，正文编辑仍独立窗                                                 | 保护保存和焦点语义                                                          |
| D6   | 插件渲染    | 一 widget 一 iframe → 默认 declarative；web 为独立受限壳内 sandbox iframe，不进共享层             | 实测隔离有成本；独立 hostname 不保证永恒独立 PID                            |
| D7   | 数据        | 后台/原生优先，静态/宿主次选 → 显式 data 绑定；无后台静态/宿主卡合法                              | 避免 dummy 主页面；provider 不能任意枚举                                    |
| D8   | 命令        | 同插件公开命令 → 保持并拆 query/action/open-main；调用前后检查 owner、代次、signal                | 避免偷偷开窗与迟到结果越界                                                  |
| D9   | 置顶        | normal/top → 保持；组内 order，跨 surface 有固定优先级与防重叠                                    | Windows 窗口级 z 序边界                                                     |
| D10  | 输入        | CSS 点透、父 iframe 代拖 → passive 整窗 ignore，interactive 正常命中，调整统一进宿主编辑模式      | `E/automatic-report.json` 的 DOM 边界；物理点透尚未验收                     |
| D11  | 持久化      | JSON + 停用条目 30 天清 → v1 独立布局、无自动过期删除、单写者、便签迁移 journal 和反向投影        | 停用/暂缺不是删除；旧文件存在不保证可逆                                     |
| D12  | 阶段        | M0–M3、过渡 flag → M0 抽层/M1 合同与页面/M2 便签/M3 声明式与 HUD/M4 收口，三类独立 flag           | 真机输入须先于 M2，HUD 明确受层依赖阻塞                                     |
| D13  | 声明式/原生 | 一起延后 → M1 有界声明式合同与 React 基础，M3 正式模板；原生执行器延后                            | `E/measure-declarative-20-report.json` 支持共享方向，不证明正式性能         |
| D14  | 流量 HUD    | 独立 C# 窗，称不依赖主程序 → **展示端最终为声明式卡片；C# 仅保留采集服务/桥，不保留 --widget 窗** | 两者都依赖宿主；复用统一布局/输入，采集合同不变；分两阶段见 §12             |

| 新编号 | 决策         | 可执行默认值                                                                                                                                                                                                                |
| ------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D15    | 配额与信任   | 每插件声明模板 ≤8；活动实例 ≤8（其中 Web ≤2）；每屏实例 ≤20（Web ≤4）；全应用 ≤64（Web ≤8）；便签也计实例总量，队列主入口不占用户配额。超额保留布局、挂起后创建项，不静默删除                                               |
| D16    | 故障恢复     | 1 s 心跳、活动态 5 s 超时；按故障域 1/3/10 s 退避，10 min 最多三次自动重建；熔断后手动重试                                                                                                                                  |
| D17    | 编辑器       | 托盘/设置显式进入；宿主手柄与选择框，不接管 iframe 内容事件；应用/取消、Esc 取消；编辑期暂停业务动作                                                                                                                        |
| D18    | 模板/实例    | manifest 定义模板；用户创建持久 UUID 实例；插件业务配置与宿主布局分存，支持同模板多实例                                                                                                                                     |
| D19    | 默认值与回滚 | enabled/notesEnabled/webEnabled 默认 true；新配置和缺失字段补 true，显式 false 保持。自动启动便签迁移失败保留旧路径并告警，其他桌面层继续；显式设置变更仍事务回滚。关闭便签前须完成最新反向投影，旧实现至少保留一个发布版本 |
| D20    | 截图贴图     | 原生取框/标注与宿主常驻展示分工；原图、八类形状/undo scene 和预览一起持久化，以 durable ACK/COW 交接；私有图片句柄与当前 owner、surface 生命周期绑定                                                                        |

配额为**产品推荐值，不是实测容量**。安装提示写“桌面卡片数量：N 个模板（声明式 A / Web B）；安装不会自动创建；活动上限及当前数量见管理页”，并列出 data provider 和白名单动作的间接权限。不是新增 native 授权替代现有授权；扩大 provider 或动作须更新确认。

## 3. 结构、身份与文件清单

### 3.1 执行域与数据流

```text
runtime.ts（composition root）
  DesktopLayer ─ LayoutStore（唯一布局写者）
       ├─ LayerWindow：共享 surface → DesktopLayerView → 可信便签/截图/声明式 React
       └─ WidgetHost：每 Web 实例独立 LayerWindow → 可信壳 → sandbox iframe
  ScreenshotLayerCoordinator：原生 WinPin 交接、私有图像/可编辑文档、可信截图 consumer
  DesktopPluginHost：运行 scope / 无窗命令 / backend+native 事件广播
       └─ WidgetHost 数据源、owner 绑定、动作与撤销
```

Web 每实例使用独立非持久 session、独立可信壳窗口和不透明 widget hostname，继续通过 iframe 执行插件脚本；不会把任意插件 React 代码导入宿主 DOM。这比原型共享壳可能有更高固定成本，**§1 的 6 renderer/145.97 MiB 不能直接充当此实现的测量结果**。独立壳按卡片 bounds 创建，不占四个共享 surface 配额，但计 Web 配额。共用同一套几何、输入模式、恢复控制器，不复用带完整能力桥的插件主窗。

### 3.2 身份合同

```ts
import type { JsonValue, PluginOwner } from "@spark233/sdk";
export type WidgetDefinitionId = string; // manifest ui.widgets 的 localId
export type WidgetInstanceId = string; // 宿主 randomUUID；跨重启稳定
export interface WidgetBinding {
  pluginId: string;
  widgetDefinitionId: WidgetDefinitionId;
  widgetInstanceId: WidgetInstanceId;
  owner: PluginOwner; // {pluginId, version, instanceId}，本次插件运行 scope
  loadGeneration: number; // 本次视图加载，正安全整数，只在当前运行期比较
}
export type LayerCardId = string; // widget:<UUID> / notes:<noteId> / notes-queue:<key> / screenshot:<UUID>
export type SurfaceKey = string; // JSON.stringify([displayId,zGroup,inputMode])
```

hostname 为宿主 `randomBytes(16).toString("hex")` 加固定 w 前缀，仅内存映射到完整 binding、session、壳 webContents/frame 和根目录；不拼接 pluginId.widgetId。实例持久化不保存 hostname、port、PID、运行 owner、loadGeneration。重载/迁窗/停用/更新时：先封闭旧 binding → 撤 port、request、host 映射与数据订阅 → 增代次 → 新映射/握手 → 重放最新完整快照。同一 widgetInstanceId 同时只有一个活动呈现者。

### 3.3 实现文件与初始合同映射

下表保留 v3 设计时的职责和签名草案；平台文件现已实现，实际导出以当前源码为准。截图增量新增 `electron/screenshot-layer.ts` 和 `src/features/desktop-layer/ScreenshotCard.tsx`，原生可编辑文档适配在 `scripts/native-capture/PinDocument.h` 及 `adapt.ps1`。

下列签名中的公共类型见 §4–§8；控制器构造参数全部依赖注入，禁止模块加载时创建窗口或读取用户数据。已有 Rect、JsonValue、PluginOwner、atomicWrite/confined、UI/theme 原语直接复用。

| 文件                                                           | 职责与导出                                                                                                                                                                                                                                         | 注入/依赖                                                                       |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `apps/desktop/shared/layer-contract.ts`                        | §4 类型、IPC 判别联合与有界 parser；`parseLayerRequest(value: unknown): LayerRequest`                                                                                                                                                              | SDK JSON 类型；不导入 Electron 运行值                                           |
| `apps/desktop/electron/desktop-layer.ts`                       | `DesktopLayer`、snapshot diff、consumer 注册、可见性、布局串行提交                                                                                                                                                                                 | §4 DesktopLayerOptions                                                          |
| `apps/desktop/electron/layer-window.ts`                        | `LayerWindow`、`computeShape(cards: readonly LayerCard[], area: Rect): Rect[]`、`surfaceKey(card: LayerCard): SurfaceKey`                                                                                                                          | screen/BW 工厂、时钟、诊断、可信 URL/session                                    |
| `apps/desktop/electron/layer-layout-store.ts`                  | `LayerLayoutStore`、`migrateDesktopLayout(raw: unknown): DesktopLayoutV1`、`reconcileDisplays(layout: DesktopLayoutV1, displays: readonly DisplayArea[]): DesktopLayoutV1`                                                                         | file、atomicWrite/readJson、时钟；§9                                            |
| `apps/desktop/electron/layer-notes-migration.ts`               | `importNotesLayout(source: NotesLayoutV2, current: DesktopLayoutV1): DesktopLayoutV1`、`projectNotesLayout(layout: DesktopLayoutV1, source: NotesLayoutV2): NotesLayoutV2`、`recoverNotesMigration(options: NotesMigrationOptions): Promise<void>` | NotesDataClient、布局 store、journal 原子写；§9                                 |
| `apps/desktop/electron/layer-preload.cts`                      | 仅 `window.spark233Layer: LayerClient`；IPC 订阅和白名单 relay                                                                                                                                                                                     | contextBridge/ipcRenderer；仅主 frame 暴露                                      |
| `apps/desktop/electron/plugins/widget-host.ts`                 | `widgetScheme: CustomScheme`、`WidgetHost`，资源映射、port 验证、调度、Web 实例壳                                                                                                                                                                  | §6 WidgetHostOptions                                                            |
| `packages/sdk/src/widget.ts`                                   | §3身份类型、§6 WidgetApi/WidgetInit/消息类型、`connectWidget(): Promise<WidgetApi>`                                                                                                                                                                | 浏览器 MessagePort，无 Electron 或完整插件 SDK 自动启动；SDK不反向import桌面app |
| `packages/sdk/src/widget-schema.ts`                            | `declarativeTemplateSchema`、`widgetDataFrameSchema`、`parseDeclarativeTemplate(value: unknown): DeclarativeTemplate`、`parseWidgetData(value: unknown): WidgetDataFrame`                                                                          | 已有 zod；有界遍历，§8                                                          |
| `apps/desktop/src/features/desktop-layer/DesktopLayerView.tsx` | `DesktopLayerView(props: {client: LayerClient}): React.JSX.Element`                                                                                                                                                                                | preload client；完整快照、错误边界、心跳                                        |
| `apps/desktop/src/features/desktop-layer/DeclarativeCard.tsx`  | `DeclarativeCard(props: DeclarativeCardProps): React.JSX.Element`；§8 六种叶组件与布局容器                                                                                                                                                         | 受限模板/数据、既有 UI、语义 token                                              |
| `apps/desktop/src/features/desktop-layer/WidgetFrame.tsx`      | `WidgetFrame(props: WidgetFrameProps): React.JSX.Element`；只用于 Web 独立壳                                                                                                                                                                       | 受信 init/iframe ref/port relay，无完整 capability broker                       |
| `apps/desktop/src/features/desktop-layer/LayerEditor.tsx`      | `LayerEditor(props: {snapshot: LayerSnapshot; client: LayerClient}): React.JSX.Element`                                                                                                                                                            | 宿主手柄、预览事务；不注入插件 DOM                                              |
| `apps/desktop/src/features/desktop-layer/desktop-layer.css`    | 层根透明、手柄/卡片/裁剪样式，无插件 CSS                                                                                                                                                                                                           | 现有 App.css / packages/ui 主题变量                                             |

### 3.4 集成文件与边界

| 文件                                                                                                         | 修改点、导出/接入合同                                                                                                                                         | 依赖与边界                                                             |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/desktop/electron/runtime.ts`                                                                           | 首次 scheme 注册加入 widgetScheme；实例化三个控制器、注入 fullscreen/锁屏/显示器/notes、正常退出 flush                                                        | main.ts 入口不需改；初始化顺序 §14                                     |
| `apps/desktop/electron/plugins/desktop-host.ts`                                                              | `subscribeWidgetEvents(owner: PluginOwner, listener: (event: WidgetSourceEvent) => void): () => void`；运行 scope 创建/停止 hook；无窗 runtime 分支           | 保留 tray/onPluginEvent 原分支，subscriber 抛错互不影响                |
| `apps/desktop/electron/plugins/manager.ts`                                                                   | `ensureWidgetOwner(pluginId: string): Promise<PluginOwner>`、`executeWidgetOwned(request: WidgetExecution): Promise<{owner: PluginOwner; value?: JsonValue}>` | 复用 dispatch 权限/实例检查；禁止 query fallback activate，见 §6.4     |
| `apps/desktop/electron/plugins/backend.ts`                                                                   | 不增加订阅 API；controller.activate 已支持 signal，供无窗分支复用                                                                                             | 保留 prepareStop/cancelStop；不修改 worker 协议                        |
| `apps/desktop/electron/plugins/native-runtime.ts`                                                            | 不增加窗口入口；复用 request(entryId,activation,signal) 和现有 onEvent                                                                                        | 通用 native 协议不扩权限                                               |
| `apps/desktop/electron/plugins/manifest.ts`                                                                  | ui.widgets API 下界、文件真实路径/模板验证；`ResolvedPluginEntries` 增 widgets 映射                                                                           | 复用 semver、confined/realpath；entry 不得越包根                       |
| `packages/sdk/src/manifest.ts`                                                                               | §7 完整 widget schema、总清单 refine、本地化 widgets.title；HOST_API_VERSION=1.4.0                                                                            | schemaVersion 仍 1，THEME_API_VERSION 仍 1.0.0                         |
| `packages/sdk/src/index.ts`                                                                                  | 导出 widget 类型、schema、connectWidget                                                                                                                       | 只用现有根 export，不新增 package subpath 或依赖                       |
| `apps/desktop/shared/config-schema.ts`、`apps/desktop/src/features/settings/types.ts`                        | 增 §14 三个布尔开关及类型                                                                                                                                     | 默认 true；既有配置只对缺失字段补 true，保留显式 false                 |
| `apps/desktop/electron/host-config.ts`                                                                       | `defaultConfig(dataDir: string): AppConfig` 补desktopLayer完整默认值；旧配置缺项归一化                                                                        | 原strict持久化schema复用configPatchSchema，禁把flags放进便签偏好文件   |
| `apps/desktop/electron/host/backup-runtime.ts`                                                               | 在既有pauseHost/reloadHost中注入层冻结/flush/重载与journal恢复                                                                                                | 现有backup.ts已递归保存hostRoot，无需另造备份格式；恢复后清运行binding |
| `apps/desktop/electron/smoke.ts`                                                                             | 复用现有隔离runner入口，追加少量层/端口撤销/notes回滚代表链                                                                                                   | `scripts/smoke-windows.ps1` 继续调用，不另建测试框架                   |
| `apps/desktop/shared/desktop-contract.ts`                                                                    | 为管理 IPC 增 §4.2 请求/响应映射，沿现有 import 使用 InstallPreview                                                                                           | InstallPreview 类型实际位于前端 features/plugins/types.ts              |
| `apps/desktop/src/features/plugins/PluginManagementDialog.tsx`、`apps/desktop/src/features/plugins/types.ts` | 安装信任摘要与已安装卡片入口；InstallPreview增加 `widgetSummary?: {definitions:number;web:number;declarative:number}`                                         | 新摘要可选；未声明 widgets 不增加确认步骤                              |
| `apps/desktop/src/features/plugins/PluginConfiguration.tsx`                                                  | 模板列表/实例创建移除、显示挂起原因、打开宿主编辑模式                                                                                                         | 调 LayerClient 管理接口；业务配置仍插件主窗                            |
| `apps/desktop/src/locales/zh-CN/translation.json`、`apps/desktop/src/locales/en-US/translation.json`         | quota/恢复/编辑器/信任提示语言键                                                                                                                              | 使用现有对应 namespace，不改加载器                                     |
| `apps/desktop/src/features/windows/windowRoutes.ts`、`apps/desktop/src/App.tsx`                              | view=layer 的解析与 lazy 路由（mode=shared/web-shell）                                                                                                        | layer 不套 DesktopWindow 的普通关闭/焦点语义                           |
| `apps/desktop/electron/capsules.ts`                                                                          | M0 窗口操作接适配器；M2 `asLayerConsumer(): LayerConsumer`，仍保留旧路径                                                                                      | 保留 fold/open/hide、三边队列、预览走廊、拖动业务                      |
| `apps/desktop/electron/host/note-surfaces.ts`                                                                | 布局 commit/迁移/反向投影；用宿主布局派生状态                                                                                                                 | 不改变折叠前保存、正文 bounds 和 pinned                                |
| `apps/desktop/electron/note-window-state.ts`                                                                 | 输入采用布局适配后的 NoteLayoutState，派生逻辑复用                                                                                                            | 不作为第二持久化写者                                                   |
| `apps/desktop/src/features/capsules/CapsuleHost.tsx`                                                         | 抽取 `CapsuleCardContent` / preview 内容供 layer 重用；不复制 Markdown 渲染                                                                                   | 原辅助窗口分支保留到回滚窗口结束                                       |
| `packages/sdk/README.md`、`Docs/README.md`、`Docs/launcher-todo.md`                                          | 合同、索引与实施证据                                                                                                                                          | 只勾有对应证据的实际出口                                               |

不改独立主窗 `host/plugin-window-state.ts` 的存储语义；`plugins/web-host.ts` 只复用已有首次 scheme 注册入口，**不反转其 subFrame 禁止策略**；`capabilities.ts` 不开放桌面卡片直通能力。官方便签 `packages/official/notes/package.json` 的 main/notepad/tile 声明保持现义，无需为了迁移添加 ui.widgets；已有 internal 命令只能由可信 notes consumer 使用。

流量 M3 已在 `packages/official/traffic/widgets/hud.json` 实现声明式模板，package.json 声明 ui.widgets.hud（API ≥1.4.0）并接入后台事件；业务采集的 ETW 后续部分沿用流量技术方案，不把 C# --widget 列入实现清单。

manifest.ts返回的增量为 `widgets:Record<string,ResolvedWidgetEntry>`，不把相对路径直接交renderer：

```ts
export type ResolvedWidgetEntry =
  | {
      kind: "web";
      entry: string;
      root: string;
      resources: ReadonlyMap<string, { file: string; mime: string; bytes: number }>;
    }
  | {
      kind: "declarative";
      template: DeclarativeTemplate;
      root: string;
      icons: ReadonlyMap<string, { file: string; bytes: number }>;
    };
```

这些file/root都是安装验证后的主进程绝对路径，仅WidgetHost消费。ui.widgets为空时返回空记录，不要求旧插件提供新字段。静态资源索引与template解析有界，安装失败不缓存半成功映射。

## 4. 主进程 DesktopLayer 与消费方合同

### 4.1 公共接口

```ts
export type LayerGroup = "normal" | "top";
export type LayerInputMode = "passive" | "interactive";
export interface DisplayArea {
  id: string;
  workArea: Rect;
  scaleFactor: number;
}
export interface LayerCard {
  id: LayerCardId;
  consumerId: string;
  widget?: WidgetBinding;
  renderKind: "notes" | "declarative" | "web" | "screenshot";
  displayId: string;
  group: LayerGroup;
  inputMode: LayerInputMode;
  bounds: Rect; // 全局屏幕 DIP，可为负坐标
  clip?: Rect; // 相对 bounds 左上角的可见区域，DIP；缺省为整卡
  order: number; // 同 surface 排序，最后以 id 作稳定 tie-break
  visible: boolean; // 用户意图；系统隐藏另算
  renderRef: string; // 宿主注册的模板/可信组件引用，不是任意 URL
  payload?: JsonValue; // 仅内建 notes，JSON UTF-8 ≤64 KiB；Web 无此字段
  screenshot?: {
    imageUrl: string; // 当前surface的私有随机句柄URL，无磁盘路径
    pixelWidth: number;
    pixelHeight: number;
    editable: boolean;
  };
}
export interface LayerChange {
  revision: number;
  reason: "move" | "resize" | "group" | "visibility" | "display" | "migration";
  cards: readonly LayerCard[];
}
export interface LayerConsumer {
  readonly id: string;
  snapshot(): readonly LayerCard[]; // 提供存活成员、业务 payload 与初始默认值
  onCardsChanged?(change: LayerChange): Promise<void> | void; // 已持久化后的通知
  onPointer?(event: LayerPointerEvent): Promise<void> | void;
  onPointersCancelled?(): void; // 环境/编辑模式变更先撤瞬态手势，不提交旧坐标
  onDispose?(): Promise<void> | void; // 不删除布局/业务数据
}
export interface LayerPointerEvent {
  cardId: LayerCardId;
  revision: number;
  pointerId: number;
  type:
    | "enter"
    | "leave"
    | "down"
    | "move"
    | "up"
    | "cancel"
    | "click"
    | "doubleclick"
    | "contextmenu"
    | "wheel";
  x: number;
  y: number; // 卡片局部 DIP
  screenX: number;
  screenY: number; // 屏幕 DIP，经主进程重算/核对
  buttons: number;
  button: "left" | "right" | "middle" | "none";
  deltaX?: number;
  deltaY?: number; // wheel 已转成 DIP，单次绝对值 ≤120
  modifiers: { alt: boolean; ctrl: boolean; shift: boolean; meta: boolean };
  cancelledBy?: "capture-lost" | "display-change" | "hidden" | "disposed";
}
export interface DesktopLayerOptions {
  store: LayerLayoutStore;
  displays: () => readonly DisplayArea[];
  primaryDisplay: () => string;
  createWindow: (options: LayerWindowOptions) => LayerWindow;
  now: () => number;
  diagnostic: (code: string, detail: JsonValue) => void;
  flags: () => { enabled: boolean; notesEnabled: boolean; webEnabled: boolean };
}
export class DesktopLayer {
  constructor(options: DesktopLayerOptions);
  register(consumer: LayerConsumer): () => void;
  refresh(consumerId?: string): void;
  snapshot(surface?: SurfaceKey): LayerSnapshot;
  commit(change: LayoutMutation, expectedRevision: number): Promise<LayerChange>;
  setVisibility(
    reason: "user" | "locked" | "suspend" | "fullscreen",
    hidden: boolean,
    displayId?: string,
  ): void;
  setEnabled(enabled: boolean): Promise<void>;
  beginEdit(displayId?: string): Promise<string>; // 返回宿主 editSession UUID
  endEdit(editSession: string, apply: boolean): Promise<void>;
  dispose(): Promise<void>;
}
```

渲染DTO与主进程卡片表分开；包根/磁盘路径不出主进程。只有独立Web壳的widget-init带该卡完整binding，普通共享快照不带运行owner。renderer不负责合并插件默认值：

```ts
export type LayerRenderCard = Omit<LayerCard, "widget"> & {
  widget?: Pick<
    WidgetBinding,
    "pluginId" | "widgetDefinitionId" | "widgetInstanceId" | "loadGeneration"
  >;
};
export interface LayerSnapshot {
  protocol: 1;
  surfaceId: string;
  surfaceGeneration: number;
  revision: number;
  theme: "light" | "dark";
  locale: string;
  scaleFactor: number;
  editing: boolean;
  cards: readonly LayerRenderCard[];
}
```

`LayoutMutation` 为 `{cardId:string,patch:Partial<Pick<LayerCard,"displayId"|"group"|"bounds"|"order"|"visible">>}` 的非空数组（最多64条）；inputMode 由清单和编辑事务决定，不接受插件或普通 renderer 任意改写。

### 4.2 snapshot diff、提交与 IPC

1. register 校验 consumerId 唯一；卡 id 跨 consumer 重复、非有限几何、非法引用整批拒绝，保留上一份成功快照并诊断。snapshot 必须同步、无 I/O/副作用、O(卡数)，每秒最多合并刷新10次；异常不清空旧布局。
2. 成员新增才应用清单默认值；已有实例用store的布局覆盖。可信截图consumer自身先投影durable布局，仅在普通拖动期间叠加临时bounds；编辑模式仍由统一editor草稿覆盖。其他消费方snapshot的位置变化不能重置用户布局。移除成员只停止活动呈现和端口；删除记录必须走显式remove/清数据。
3. 串行 commit：检查 expectedRevision → 校验配额/屏幕/冲突 → 计算候选状态 → store 原子写成功 → 增 revision/发布快照 → 按 consumer 分发 onCardsChanged。失败保留旧状态并恢复拖动预览；onCardsChanged失败只保留该consumer最新一份通知，按250/1000/3000 ms最多重试三次，仍失败记录待重新同步，不回滚已提交状态，也不让consumer再写另一份位置。
4. 数据帧与临时拖动不写文件、不增长布局 revision；用户 up/应用、组切换、可见性和显示器收敛才 commit。持久化的用户意图与临时系统隐藏分开。

层专用 IPC channel 为 `spark233:layer:request`（invoke）与 `spark233:layer:event`（主→renderer）。`LayerRequest` 是以下 strict 判别联合；所有请求含 `protocol:1,surfaceId,surfaceGeneration,seq`，seq 为当前方向递增安全整数：

| type              | 额外字段                                 | 结果与限制                                                                                                        |
| ----------------- | ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| ready             | 无                                       | 返回完整快照；首帧确认后才显示                                                                                    |
| heartbeat         | lastRevision                             | 更新本 surface 心跳，不混用子卡心跳                                                                               |
| pointer           | event: LayerPointerEvent                 | 仅该 surface 的可见卡片；move 合并到一帧，≤60/s                                                                   |
| layout-commit     | mutations, expectedRevision, editSession | 仅当前编辑 session 或可信 notes 手势                                                                              |
| edit-end          | editSession, apply                       | 应用/取消                                                                                                         |
| widget-relay      | binding 标识, wire:string                | 仅当前 Web 壳及其唯一 iframe；交 §6 parser                                                                        |
| screenshot-invoke | cardId, action, value?                   | 仅当前surface可见interactive截图、非桌面编辑态；action限edit/close/hide/pin/zoom/fit，只有zoom接受0.25–4有限value |
| fault             | cardId?, code, message≤512字符           | 主进程限定归属，不能请求杀 PID                                                                                    |

主→renderer 为 `snapshot`、`data`、`widget-init`、`widget-wire`、`cancel-pointer`、`edit-state`。数据完整帧上限见 §6；快照最多256 KiB，notes payload 总量最多192 KiB，超出只保留胶囊标题、预览按需从既有可信 notes 通道加载。IPC 不把任意层页面变成完整 desktop bridge。

preload 暴露 `LayerClient = {request(request: LayerRequest): Promise<JsonValue|undefined>; subscribe(listener:(event:LayerEvent)=>void):()=>void}`。主进程逐次核对注册 webContents、senderFrame 为该可信主 frame、精确可信 URL、surfaceGeneration、seq、卡归属；URL query/string 不能单独授权。管理页创建/移除/重试/更新/进编辑走现有宿主管理IPC白名单操作 `layer_listTemplates/layer_create/layer_remove/layer_retry/layer_update/layer_edit`，按可信设置窗口来源验证，不接受第三方frame。

管理请求和响应固定：`layer_listTemplates({})→{templates:LayerTemplateSummary[],instances:LayerInstanceSummary[],notesMigrationError?:string}`，`layer_create({pluginId,widgetDefinitionId})→{widgetInstanceId}`，`layer_remove/layer_retry({widgetInstanceId})→void`，`layer_update({widgetInstanceId,patch})→void`，`layer_edit({displayId?})→{editSession}`。LayerTemplateSummary为 `{pluginId,widgetDefinitionId,title,kind:"web"|"declarative",quota:{active:number,limit:number}}`；LayerInstanceSummary含实例身份、可选title、displayId、visible、group/inputMode/bounds、status及reason。status限active/hidden/suspended/orphan/fault，reason最多512字符。list合并普通widget和截图实例且不含业务配置/路径；create不接受自选UUID/owner；remove/retry/update按截图成员身份路由到可信coordinator。`desktop-pins-changed`只通知管理页刷新，不开放任意renderer发布权限。

### 4.3 便签 consumer 与输入语义

便签 snapshot 由现有 CapsuleEntry/queueGeometry/previewGeometry 派生；稳定 id 为 `notes:<noteId>` 和 `notes-queue:<displayId>:<edge>`。临时 preview/drag overlay 不落持久化，仍全局最多各一个，复用 LayerWindow 但不占四类共享窗口上限；因此“四窗”只指基础共享 surface，不包含局部交互 widget family。主入口和裁切后普通入口均按有效可见矩形计 shape。

便签 onPointer 保留 enter/leave 的220 ms悬停与预览走廊、wheel 队列滚动、pointerId/cancel 和点击阈值；down 后位移超过现有阈值才拖，up/cancel 后不合成点击，单击展开规则按[胶囊行为](edge-capsules.md)。拖动业务保留在 Capsules，调用层 commit；主进程用 screen.getCursorScreenPoint 记录拖动屏幕坐标，不信任 renderer 提交落点。取消、锁屏、DPI/显示器变更恢复起点。

`onPointer` 只描述宿主命中的可信卡片/编辑手柄；**不接收或伪造 iframe 内部 pointer**。Web 内容按钮自行处理并发白名单动作；拖动从 iframe 外宿主标题/边框手柄开始，不能把父 iframe 容器冒泡当捕获。普通 passive 卡无 hover/wheel/点击回调；编辑期把同一实例转入可交互编辑承载，暂停其动作。

`onCardsChanged` 是持久化后的投影通知，notes 只更新其内存布局镜像、发布 presence 和刷新托盘；旧 backend 布局仅通过 §9 的投影协调器写回。`note-window-state.ts` 继续派生 pinned/presence，系统全屏降层/隐藏不篡改 pinned；独立正文窗使用旧布局中的展开 bounds，不等于胶囊 bounds。`plugin-window-state.ts` 继续只管普通插件窗。

截图普通拖动的瞬态状态由可信coordinator持有。进入统一编辑、显示器变化、隐藏/关闭平台及窗口故障恢复前，DesktopLayer通过内部`onPointersCancelled`撤销该状态；管理更新同一截图时也先取消手势。迟到的up不得覆盖已收敛或已更新的持久布局。最终真实Electron23项包含两条受控IPC回归：显示几何不变时的displayChanged仍取消拖动，管理切换passive后恢复interactive也不能复活迟到up。不据此补记物理热拔验收。

### 4.4 截图可信 consumer 与可编辑会话交接（已实现）

`ScreenshotLayerCoordinator` 注册可信 `screenshot:<UUID>` 成员；宿主管位置、置顶、显示器、可见性、鼠标模式、恢复及配额，截图插件保有原生取框和标注工作面。`ScreenshotCard` 提供拖动、缩放、适应屏幕、置顶、隐藏、关闭和重新编辑；统一桌面编辑仍可调整布局。截图按 `spark233.screenshot` 单独计插件配额，并与便签/普通 widget 共用屏幕及全局配额，不借便签额度绕过总量限制。

常驻数据包括 `preview.png`、未合成标注的 `source.png` 和版本化 `document.json`。scene 保存矩形、椭圆、箭头、线条、编号、文字、马赛克、橡皮擦八类现有形状及各自 undo 状态、必要几何/样式；继续编辑时将原图和 scene 交回原生 WinPin，沿用原有 History、形状构造和编辑器。预览仅供宿主显示，不能替代可编辑源。2026-11-01已用生成的640×480图片实测：八类scene及第九条已撤销线往返一致，数字容差为1e-5；原生Ctrl+Y/Z有效，宿主策略拒绝时恢复编辑器，重新开启后接受图钉；从桌面贴图继续标注并重做后再次固定，保留同一截图UUID、生成新revision，ACK后才回收旧revision。另一次Escape退出原生编辑后，桌面贴图恢复且已接受revision保持不变。该代表链不等于逐项编辑全部形状或物理跨屏拖动验收。

宿主模式的临时原生标注窗有本地化caption，并使用APPWINDOW使其可经任务栏/Alt+Tab切换；工具栏及独立/旧原生图钉模式保持原有样式。宿主模式Ctrl+P复用既有pin动作，tooltip显示快捷键。完成交接后该原生窗退出，常驻贴图仍由skipTaskbar共享层展示，不为每张贴图保留原生编辑进程。

交接使用带当前 session/PID/attempt 的 `pin.json` 与 `pin.ack`。宿主校验当前 owner/scope、会话私有真实路径、PNG 尺寸和文档预算，先以新 revision 写私有 bundle，再提交 desktop 布局并等待承载 surface 就绪，才允许写 accepted ACK；原生收到相符 ACK 后才退出该编辑会话。拒绝、取消、超时或 owner 改变时保留原编辑器并回滚未接受的发布。重新编辑采用 COW，旧 revision 保留到 ACK 之后再回收；GC 失败保留已接受的新图，记录诊断，不撤回成功交接。未完成回滚由同一串行队列重试，不能因发布失败丢掉上一张可用贴图。

renderer 只取得 `spark233://app/__screenshot-image/<随机UUID句柄>`，不取得磁盘路径或可编辑源。资源仅向当前共享可信 surface 主 frame 的 image 请求开放，核对该 surface 的当前截图成员；独立 Web 壳、iframe、未知/失效句柄、附加 query/hash 和非 GET 请求拒绝。异步读取结束后再次核对授权，返回有界 PNG、no-store/nosniff，不扩大 CSP。句柄在图像 revision 或 owner 更换后轮换，停用/更新撤销旧句柄和活动呈现，布局及私有 bundle 按保留策略留存；重新启用读取持久数据并绑定新 owner。

截图官方插件已升至 `0.1.5`、使用 `on-startup` 恢复 owner 和已有贴图。启动激活不调用截图工作面，只有显式 capture/ocr 或贴图继续编辑才创建原生任务；仍需现有 native trust 授权。管理页合并普通实例与截图实例，支持标题、故障重试、布局控制及移除，并通过 `desktop-pins-changed` 合并刷新。全局hide/show、剪贴板/launcher的宿主焦点识别、选取侦测及全屏watch排除集合直接纳入`desktopLayer.windows()`，不依赖便签开关。官方原生截图目前只在调用前隐藏launcher，没有提供独立capture exclusion API；不能将这些宿主窗口集合写成原生截图画面排除能力。

## 5. LayerWindow：surface、形状、输入与恢复

### 5.1 接口与创建参数

```ts
export interface LayerWindowOptions {
  id: string;
  key: SurfaceKey;
  mode: "shared" | "web-shell" | "notes-preview" | "notes-drag";
  display: DisplayArea;
  group: LayerGroup;
  inputMode: LayerInputMode;
  bounds: Rect;
  generation: number;
  session: Electron.Session; // 由 WidgetHost/可信资源工厂注入
  entryURL: string;
  preloadPath: string;
  createBrowserWindow: (
    options: Electron.BrowserWindowConstructorOptions,
  ) => Electron.BrowserWindow;
  now: () => number;
  onFault: (fault: LayerFault) => void;
}
export class LayerWindow {
  constructor(options: LayerWindowOptions);
  readonly id: string;
  apply(snapshot: LayerSnapshot): void;
  setSuppressed(reason: "fullscreen" | "locked" | "suspend" | "user", value: boolean): void;
  setDisplay(display: DisplayArea): void;
  markHeartbeat(generation: number): void;
  destroy(): Promise<void>; // 不调用插件业务 prepareStop，不销毁业务 owner
}
```

`LayerFault` 为 `{surfaceId:string,generation:number,kind:"script-hang"|"renderer-gone"|"host-unresponsive"|"logic",cardId?:string,reason:string}`。恢复调度属于 DesktopLayer/WidgetHost 主进程，不由将要卡死的 React 控制器执行。

便签／截图基础共享窗 bounds=display.workArea，独立 Web 壳 bounds=卡片 bounds。带桌面交互的声明式 widget 按 `(display, group, inputMode, widgetInstanceId)` 建立稳定的局部 family，HUD、hover 和同屏拖动投影复用窗口；bounds 为工作区内实际可见内容的包围矩形。不同 family 不跨屏幕空白区合并。局部 family 属于额外原生窗口和 renderer 成本，按已有实例配额约束，不包含在“基础四类共享窗”的上限内。编辑态和显式插件栏会话才将这些交互界面切到整屏。

Windows LayerWindow 使用 `type: toolbar` 的工具窗语义，避免底层 Chromium 把透明整屏 HWND 的简单矩形 region 误判为整屏遮挡；`skipTaskbar`、`focusable: false` 和点透本身不能代替这项语义。局部 viewport 的 origin 随 geometry 消息同步到 renderer，不因每次移动重建 DOM 或冷建窗口。统一参数：

| BrowserWindow / webPreferences                                                 | 值                                                                   |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| frame / transparent / hasShadow / show                                         | false / true / false / false                                         |
| resizable / maximizable / minimizable / fullscreenable                         | false / false / false / false                                        |
| focusable / skipTaskbar / backgroundColor                                      | false / true / #00000000                                             |
| alwaysOnTop                                                                    | group===top；锁屏/全屏避让优先                                       |
| sandbox / contextIsolation / webSecurity                                       | true / true / true                                                   |
| nodeIntegration / nodeIntegrationInSubFrames / webviewTag / navigateOnDragDrop | 全为 false                                                           |
| allowRunningInsecureContent                                                    | false                                                                |
| session / preload                                                              | 注入的非持久专用 session / layer-preload.cjs（源码 .cts）            |
| backgroundThrottling                                                           | 活动层 false，按 1 s 有界心跳；隐藏/锁屏暂停业务调度，销毁无卡窗口   |
| additionalArguments                                                            | `--spark233-label=layer:<displayId>:<group>:<inputMode>:<surfaceId>` |

菜单关闭；deny window.open、下载、权限请求、重定向和 webview；仅允许宿主指定的首次导航。创建未 ready/首帧未完成不显示，5 s 加载超时进入恢复。不经普通 createHostWindow 工厂，避免引入焦点、标题栏和完整 preload。

### 5.2 shape、DPI 和 Z 序

每卡 effectiveRect = bounds ∩（bounds 原点 + clip）∩ workArea；clip 无则整 bounds。全程屏幕 DIP，不手动乘 scaleFactor；转 client DIP 时减窗口原点。输出取 floor(left/top)、ceil(right/bottom)，去空/去重、同轴相邻合并，避免重叠区重复矩形；默认最多128矩形/surface，超过时拒绝产生该布局并保留旧形状，不能退成整屏 rectangle。setShape 空前先 hide，非空按“bounds→shape→快照→ready→showInactive”执行，避免透明全屏抢输入。

静止重算≤10/s；编辑拖动合并到16 ms一帧（≤60/s），最终 up 必须 commit。正常 shared surface 不跟随每个数据帧重算。监听 display-added/removed/metrics-changed：取消捕获、隐藏 preview、以 §9 收敛 store，再更新 bounds/shape/scaleFactor，必要时迁 surface。DIP 和 CSS px 按 Electron 默认缩放对应，禁止另设 zoom 叠乘 DPI；代表性混合DPI真实命中已有第二阶段证据，本轮截图不补记物理跨屏验收。

共享 surface 优先级固定：normal-passive < normal-interactive < top-passive < top-interactive；同类内 order 后 id。Web 壳同组按稳定实例顺序排；不提供跨 HWND 精确任意 z。一般卡片不允许跨 surface 有效矩形重叠：创建按8 DIP网格从主屏右上向下寻找空位；用户提交冲突则拒绝并提示，不自动移动已有卡。notes 队列区域优先保留，preview/drag 是临时有意覆盖，不改变持久 order。插拔屏幕自动收敛时按 createdAt/id 顺序找空位，放不下的实例标记 no-space 并可在管理页找回，不丢弃。

normal 表示普通非置顶 tool window，不是嵌进 Explorer WorkerW 的桌面子窗。全屏时widget默认从渲染快照/shape中抑制并暂停发送；notes和截图贴图保留现有仅降低对应屏幕topmost的策略，不强行抬前。先计算各卡effectiveVisible，再更新surface：只有notes/截图仍可呈现时保留该窗并降层，全被抑制才hide。退出恢复逻辑group和可见意图，不偷改用户值。若要求便签也统一隐藏或HUD例外显示，需§15签字并在真机验收确认。锁屏/休眠全部隐藏、取消捕获；unlock/resume等待2 s再同步显示器、重发完整快照后恢复。

### 5.3 passive / interactive 与宿主编辑模式

passive 必须调用 `win.setIgnoreMouseEvents(true)`；Windows 回查应有 `WS_EX_TRANSPARENT`。interactive 调用 `setIgnoreMouseEvents(false)`，正常 native 命中，shape 外区域由系统命中下一窗口。CSS pointer-events 只用于层内装饰，不能承担 OS 点透。不要按鼠标每一点反复切换整窗 ignore。

进入编辑：取消现有手势 → 创建 editSession 与内存布局草稿 → 移走 passive 的旧活动呈现（先隐藏/撤端口）→ 同一共享 interactive surface 内宿主边框/手柄呈现；Web 独立壳在同窗临时关闭 ignore、显示宿主手柄和内容遮罩，撤旧端口后新代次握手。编辑不复制活动 iframe，不执行业务动作。

拖动从宿主手柄 pointerdown 开始 setPointerCapture(pointerId)，主进程采样 cursor DIP，原 surface 保留手柄直到 up，不在捕获中途跨 HWND 搬 DOM。跨屏只画暂存预览，up 后统一迁窗与新代次；capturelost/display-change/锁屏/Esc/故障均 cancel，恢复原草稿或退出。应用只提交一次 CAS revision；若期间 notes 成员/布局 revision 改变，取消受影响手势并重读，不静默覆盖。取消无落盘；退出恢复原 inputMode 并重新 ready。Esc 由宿主临时全局快捷键（仅编辑期注册、退出释放）取消，不使不可聚焦层抢键盘。详细手柄外观与入口见 §15。

### 5.4 故障域与有界恢复

活动可信页面每1 s由 renderer 主事件循环发 heartbeat；iframe shim 每1 s发独立 heartbeat，经可信壳 relay。preload 自己定时不能证明 React 主循环存活。主进程每1 s查最后有效代次，活动态5 s无心跳即故障；隐藏/锁屏/休眠不累计超时，恢复给5 s宽限。心跳只是响应性信号，恶意脚本伪造活跃不等于业务正确。

| 故障                            | 检测                                                             | 恢复范围和动作                                                                                         |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 声明式/notes 单卡逻辑异常       | schema 拒绝或 React error boundary                               | 保留最后有效数据，该卡显示错误占位/管理入口；不重启 surface，不修改业务配置                            |
| Web 脚本死循环                  | 子卡心跳超时，壳仍心跳                                           | 撤该实例端口/请求/hostname，销毁其独立壳并新建、增代次、重放；不重启后台                               |
| Web renderer 退出/iframe detach | 壳 render-process-gone、WebFrameMain destroyed，或子心跳超时兜底 | 按实际 frame→PID 关联标记受影响卡，分别重建所辖壳；不按 iframe 数推断只有一张受影响                    |
| 共享宿主 renderer 卡死/退出     | 宿主心跳超时、unresponsive、render-process-gone                  | hide/destroy 该 surface，撤所属视图端口、取消手势，重建并重放全部成员；若多个 surface 同 PID则一起恢复 |
| 资源加载/首帧超时               | did-fail-load/ready超时                                          | 相同退避，诊断资源分类、代次与错误；不通过放宽安全策略补救                                             |
| 插件后台/native 崩溃            | manager/scope 生命周期                                           | 按既有插件崩溃处理撤数据源与卡；不由层强制重启业务或绕过保存确认                                       |

每故障域10 min内自动重建最多3次，延迟1/3/10 s，正常连续运行10 min清计数；并发恢复合并、主进程全局最多1个重建/秒。第三次仍失败进入 circuit-open，撤活动视图，保留布局和最后错误，在托盘/设置给“重试该卡/重试该屏层”。手动重试建立新窗口10 min计数，1 min最多一次；不允许无限快速重试。用户停用/退出/更新立即取消恢复 timer，过时代次不得复活。

只 destroy 自己持有的 BrowserWindow/frame；不因超时按系统 PID 强杀，不关闭站点隔离。独立 hostname 的实测隔离是当前样本结果；同 hostname 复用默认禁止（§15 可讨论未来可信性能选项，需重新测量故障域）。共享宿主故障会影响该 surface 的全部可信卡片，不能承诺“单卡任何异常都不影响整层”。

## 6. WidgetHost：资源、桥、命令和数据

### 6.1 服务接口与资源域

```ts
export interface WidgetSourceEvent {
  owner: PluginOwner;
  source: "backend" | "native";
  entryId?: string;
  name: string;
  payload?: JsonValue;
}
export interface WidgetExecution {
  binding: WidgetBinding;
  actionId: string;
  origin: "widget" | "subscription"; // 仅宿主可设置，wire中没有此字段
  mode: "query" | "action"; // open-main 另走显式宿主 UI 路由
  commandId: string;
  input?: JsonValue;
  signal: AbortSignal;
}
export interface WidgetHostOptions {
  layer: DesktopLayer;
  getManifest: (pluginId: string) => PluginManifest;
  resolveEntries: (pluginId: string) => ResolvedPluginEntries;
  ensureOwner: (pluginId: string) => Promise<PluginOwner>;
  isOwnerCurrent: (owner: PluginOwner, commandId?: string) => boolean;
  execute: (request: WidgetExecution) => Promise<{ owner: PluginOwner; value?: JsonValue }>;
  openMain: (binding: WidgetBinding, commandId: string) => Promise<void>;
  subscribe: (owner: PluginOwner, cb: (event: WidgetSourceEvent) => void) => () => void;
  subscribeProvider: (id: "host.clock", cb: (value: WidgetValue) => void) => () => void;
  createSession: (partition: string) => Electron.Session;
  now: () => number;
  diagnostic: (code: string, detail: JsonValue) => void;
}
export class WidgetHost {
  constructor(options: WidgetHostOptions);
  create(pluginId: string, definitionId: string): Promise<WidgetInstanceId>;
  remove(instanceId: string): Promise<void>; // 明确删除此实例，非停用
  attach(owner: PluginOwner): Promise<void>; // scope 激活后恢复所需实例
  quiesce(owner: PluginOwner): Promise<void>; // prepareStop开始即冻结动作、取消在途
  resume(owner: PluginOwner): Promise<void>; // 保存拒绝恢复时用新 loadGeneration
  revoke(
    owner: PluginOwner,
    reason: "disable" | "update" | "uninstall" | "crash" | "clear",
  ): Promise<void>;
  acceptWire(surfaceId: string, binding: WidgetBinding, wire: string): void;
  dispose(): Promise<void>;
}
```

create 先验证已启用/配额/模板，再原子保存实例 UUID 和默认布局，后按需 ensureOwner/attach；启动失败保留 recoverable 实例，不能因加载失败丢用户位置。remove 先标 tombstone 落盘、再撤视图和删除该实例业务配置（通过插件公开删除动作，有后台拒绝则保留“待清配置”诊断），不停止同插件其他实例/后台。纯静态/host provider 插件由 manager 创建轻量 scope/owner，不启动 dummy Web/Node/native。

### 6.2 scheme、session 与资源白名单

`spark233-widget` 的 privileges 为 `standard:true,secure:true,supportFetchAPI:true,corsEnabled:true,bypassCSP:false,allowServiceWorkers:false`，通过 `registerPluginProtocolScheme([已有宿主scheme, widgetScheme])` **首次**合并，在 app.ready 前注册。共享层/每 Web 壳均使用非 persist 独立 session，permissionRequest/Check 全拒绝、will-download 阻止；每 session 只有一个 webRequest 路由器，不能后续监听器覆盖前者。

可信层 URL 使用现有 `spark233://app/index.html?view=layer` 与受控 mode/surface 查询；session 注入既有宿主资源 handler 的“layer 只读资源子集”，不复制一个任意文件服务。开发态仅显式选中开发服务器的固定 origin，禁止通配 localhost 任意端口，发布态不含此例外。

| 分类                     | 放行条件（全部满足）                                                                                               | 映射与拒绝                                                                                    |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 可信 mainFrame           | 已注册的壳/共享层 webContents，主 frame，精确 layer 入口 URL 和当前 surfaceGeneration                              | 由宿主静态构建资源服务；不把 mainFrame 误禁为 subFrame                                        |
| 可信层静态子资源         | 当前可信 frame、构建资源允许列表、固定 MIME/路径、同宿主 origin                                                    | 不开放 notes/dataDir、file/http/https；script/style/image/font仅构建清单                      |
| widget subFrame 首次导航 | 当前 Web 壳唯一预期 child frame，spark233-widget 的当前随机 hostname、精确已解析 entry，binding/session/代次仍有效 | will-frame-navigate允许一次预期导航；后续自行导航/redirect/嵌套frame全部拒绝                  |
| widget 静态子资源        | 请求 frame 属于该绑定，hostname相同，GET，已验证 widgets/目录内 js/css/png/woff2等白名单                           | 单文件≤2 MiB、HTML≤256 KiB、全 widget静态资源≤8 MiB；禁远程、svg/html子资源、worker、动态下载 |
| SDK 虚拟路径             | `spark233-widget://<opaque>/__sdk__/widget.js`，来自当前绑定 frame，脚本资源                                       | 映射固定 SDK 浏览器 bundle/静态 shim；先匹配虚拟路径，绝不当插件包路径读取                    |

请求 URL 禁 username/password/port、fragment导航；pathname只 decode 一次，拒绝残留编码分隔符、反斜杠、空段、点段、NUL；复用 isPluginPackagePath/confined + realpath 再核对包根和 widgets 子树，拒 junction/symlink 逃逸。随机 hostname 映射撤销后立即403/取消，不靠缓存继续加载；Cache-Control:no-store、nosniff、固定 MIME。协议 handler 和 webRequest 双重校验当前绑定，未知 frame 默认拒绝。安装时先生成每模板合法资源索引，运行时不接受 renderer 指定根/磁盘路径。

frame初始about:blank由宿主创建并登记为“待导航唯一子frame”，在预期导航提交后绑定routingId/processId；身份不匹配或发生第二子frame立即撤销。对opaque-origin ES module与字体，已通过session/frame/路径验证的只读响应增加 `Access-Control-Allow-Origin:*`，不允许credentials；其作用只解决Origin:null的模块资源加载，不开放跨实例资源。安装包自带构建后的JS/CSS，不依赖运行时远程import或宿主给插件打包。

Electron的protocol.handle(request)不提供完整WebFrameMain调用身份，不能在其中凭空读取frame：frame归属校验在webRequest/导航事件执行；handler依靠每Web壳独占session、当前唯一binding/hostname及路径再次检查，撤销binding即拒绝响应。任何details缺frame、未知webContentsId或无法与登记frame对上的请求默认拒绝，不能退成“URL看起来正确就放行”。

widget CSP 以当前不透明 origin 的明确 URL 列表为源（opaque sandbox 下不依赖 'self' 能正确代表插件来源）：`default-src 'none'; script-src <origin>; style-src <origin> 'unsafe-inline'; img-src <origin>; font-src <origin>; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`。不用 unsafe-eval/inline script/blob/data/远程来源；声明式图标通过宿主资源句柄，不执行 SVG。可信壳 CSP 的 frame-src 仅含它绑定的 widget origin，不是 scheme 通配；共享声明式层 frame-src 'none'。

iframe 精确属性：`sandbox="allow-scripts"`、`referrerPolicy="no-referrer"`、`allow=""`、`tabIndex={-1}`；**不加 allow-same-origin、allow-popups、allow-forms、allow-downloads、allow-top-navigation**。内容不使用完整 plugin-preload；壳 preload 只在主 frame 暴露有限桥。

### 6.3 MessagePort 协议 v1

每次 iframe load 后，可信壳确认预期 contentWindow 与当前 binding，由宿主发 bootstrap nonce（随机128 bit、单次、5 s过期）。壳创建 MessageChannel，将 port2 通过 `iframe.contentWindow.postMessage({type:"spark233-widget-connect",protocol:1,nonce,...identity},"*",[port2])` 交给唯一目标；opaque origin 必须用 *，**不是向任意 window 广播**。SDK 只接收 event.source===parent、一次一个 nonce 的连接，随后只接受 port 消息；全局 window message 不承载命令。

connectWidget在HTML模块启动时先注册一次连接监听，再由SDK向parent发送仅用于重发连接通知的 `{type:"spark233-widget-boot",protocol:1}`；壳只认当前contentWindow，每加载代次最多处理一次，解决模块监听晚于load的竞态。nonce在ready成功后标已消费；端口交付/ready超时从旧代次整体重建，不在同代次反复转移同一个port。全局boot不包含用户输入/命令，不能延长已撤销映射有效期。

port1留可信壳，由 layer-preload 的白名单 relay 转主进程；壳不能凭 renderer 提供的 owner 改绑定。主进程把 relay 物理来源绑定到唯一实例/frame/代次，端口不是插件自选身份。iframe脚本不能访问父 DOM。每次加载、编辑迁入/迁出或壳重建均新 nonce、新 port、新 loadGeneration；旧端口先close并清 handler。

消息在 port 上只传**UTF-8 JSON 字符串**，解析前 TextEncoder/Buffer.byteLength 检查，整个 envelope ≤20 KiB，业务 payload（含 data键值）≤16 KiB。不接受 ArrayBuffer/Blob/函数/transfer后续端口；JSON有限深度8、累计节点512、字符串≤2048字符（diag≤512）、键≤80字符，无 NaN/Infinity/危险原型键。主进程和SDK均strict解析未知字段；超限拒绝完整帧，不能截断 JSON。

每条 envelope 固定：

```ts
interface WidgetEnvelope {
  protocol: 1;
  widgetDefinitionId: string;
  widgetInstanceId: string;
  owner: PluginOwner;
  loadGeneration: number;
  seq: number; // 各方向从1开始，严格递增，正安全整数
  type: string; // 下表判别联合；实际 parser 不接受任意 string
  requestId?: string; // UUID；仅 RPC/cancel/result
  payload?: JsonValue; // 按 type 的 strict schema 再解析
}
```

| 方向 / type               | payload                                                                  | 行为                                                    |
| ------------------------- | ------------------------------------------------------------------------ | ------------------------------------------------------- |
| H→W init                  | locale,theme,scaleFactor,size{width,height},interactive,actions,dataKeys | 唯一绑定；不含磁盘路径/完整 capability                  |
| W→H ready                 | 无                                                                       | 5 s内确认后发送最新数据；未ready禁止动作                |
| 双向 heartbeat            | 无                                                                       | 1 s，独立于数据seq但仍递增；不能拿旧heartbeat保活新代次 |
| H→W data                  | revision,at,values（完整声明键集合）                                     | 每卡每帧≤16 KiB，宿主 revision递增                      |
| H→W visibility/size/theme | 对应visible、size、theme/locale/scaleFactor                              | 是宿主通知，不授予改窗权限                              |
| W→H invoke                | actionId,input?                                                          | 不接收mode/commandId；从manifest actions解析            |
| W→H open-main             | actionId                                                                 | 必须引用mode=open-main动作，来自直接用户手势            |
| W→H resize                | width,height                                                             | 仅 resizable，min/max和workArea约束；频率≤2/s，提交CAS  |
| W→H cancel                | 无，requestId必填                                                        | 只取消本代次自己在途请求                                |
| H→W result                | ok,value? 或 ok:false,code,message≤512                                   | 对应requestId；不能超过16 KiB                           |
| W→H diag                  | level取warn或error、message                                              | ≤1条/min/卡，去路径/隐私                                |

ready/heartbeat之外每卡接收上限20条/s、burst20，invoke最多2条/s、同时在途≤4、open-main≤1次/s。超限可先返回 widget.rateLimited，连续3次/60 s malformed/大小超限/伪造身份则撤本代次桥并标 protocol-error，需手动重试。错误 seq/旧代次消息直接丢弃并计数，伪造当前 owner/卡身份按非法消息处理。日志不落业务原文；错误码包括 widget.staleBinding/commandDenied/protocolError/payloadTooLarge/timeout/cancelled/rateLimited 与 layer.layoutConflict/quotaExceeded/persistenceFailed/circuitOpen。

SDK 导出 `WidgetApi`：`onInit(cb):()=>void`、`onData(cb:(frame:WidgetDataFrame)=>void):()=>void`、`onVisibility(cb):()=>void`、`onSize(cb):()=>void`、`invoke(actionId:string,input?:JsonValue,options?:{signal?:AbortSignal}):Promise<JsonValue|undefined>`、`openMain(actionId:string):Promise<void>`、`resize(size:{width:number;height:number}):Promise<void>`、`dispose():void`。被动卡片不能触发动作；connectWidget 初始化时创建心跳并在 dispose 结束，不注册完整 window.spark233 平台 API。

```ts
export interface WidgetInit {
  binding: WidgetBinding;
  locale: string;
  theme: "light" | "dark";
  scaleFactor: number;
  size: { width: number; height: number };
  interactive: boolean;
  actions: Readonly<Record<string, { mode: "query" | "action" | "open-main" }>>;
  dataKeys: readonly string[];
}
export interface WidgetApi {
  onInit(cb: (init: WidgetInit) => void): () => void;
  onData(cb: (data: WidgetDataFrame) => void): () => void;
  onVisibility(cb: (visible: boolean) => void): () => void;
  onSize(cb: (size: { width: number; height: number }) => void): () => void;
  invoke(
    actionId: string,
    input?: JsonValue,
    options?: { signal?: AbortSignal },
  ): Promise<JsonValue | undefined>;
  openMain(actionId: string): Promise<void>;
  resize(size: { width: number; height: number }): Promise<void>;
  dispose(): void;
}
```

### 6.4 命令：query、action、open-main

actions的id是桥公开名；commands是允许引用的同插件公开命令集合。每次调用均再核对 manifest、实例存活/非编辑/非停止、同 owner、loadGeneration、scope.active 和 manager.isOwnerCurrent，不信任发送方带来的 commandId。内部命令、来源程序绑定命令、files/image/window输入命令不允许从卡片调用；没有真实宿主来源不能伪造 context。

`executeWidgetOwned` 明确补一个**无窗**路径，复用 manager 权限/启动/实例检查与 scope task 取消，但不调用通用 runtime.activate：

- query：仅选当前工厂的 backend.activate(activation,signal) 或 native.request(清单选定entryId,activation,signal)，无后台时拒绝，不 fallback到Web activate。query仅表示返回有界JSON，不替换启动器query会话。
- action：同一无窗执行通道调用公开业务命令，允许业务副作用但**不呈现窗口**；信任/权限仍由插件scope约束。backend/native 的既有能力授权不因widget扩大。
- open-main：只有此入口通过 manager.activateOwned 走普通窗口呈现，action声明必须指向含window的公开命令；调用前后再核对 receipt.owner。原生/无主窗插件不得声明此模式。

manager.ts的ManagedPluginRuntime增加可选host-only方法：

```ts
executeWidget?(request: {
  activation: PluginActivation;
  mode: "query" | "action";
  entryId?: string;
}, signal: AbortSignal): Promise<JsonValue | undefined>;
```

工厂实现该明确路由；没有方法则拒绝widget命令，不能fallback。widget ensureOwner时不预建web controller，后台/native按需求冷启动。多个native入口通过data/actions的显式entryId选择；仅一个时允许省略，多入口缺省必须存在main，否则校验拒绝。manager先取得owner再绑定视图，beforeDispatch再次核对，调用返回的owner必须与binding相同。

open-main不能只相信iframe上报“用户点击”：声明式按钮由宿主可信组件的isTrusted点击发起；Web的open-main先登记候选request，在可信壳同一卡片内显示“打开主页面”宿主按钮，真实点击后生成单次gestureId（5 s过期）并消费，才呈现主窗。候选10 s无人点击则timeout，不排队累积；父壳不接受插件自报gestureId。宿主编辑菜单是另一受信入口。这样不依赖子document事件冒泡，也不让任意脚本以自动消息反复抢焦点。

统一10 s timeout（业务输入≤4 KiB、返回≤16 KiB），每请求有AbortController并登记scope task。超时/port撤销/停用/更新/移除取消请求和timer、删除requestId；backend/native协作取消，不因此强杀或当保存成功。取消无法撤销已经发生的业务副作用，宿主不自动重放action；网络恢复/renderer重建只恢复展示数据。返回时必须重新验owner、代次、request仍在途、未abort，迟到结果丢弃，绝不满足新实例。

### 6.5 数据推送、来源与背压

每模板data显式声明source、key和format（§7），每实例取得各键的最新值后发布完整帧。backend/native事件统一要求 `{widgetInstanceId,values:{[dataKey]:WidgetValue}}`，事件名/entryId必须匹配data声明；运行owner由已有controller提供，不能用payload自报。插件业务配置按实例自行恢复；宿主provider只开放 `host.clock`（当前时间文本/时间戳），CPU/内存/网络/路径不默认开放，流量来自自有已授权后台。无后台纯静态/clock卡合法。

host.clock的text为当前locale的HH:mm:ss文本、number为UTC epoch ms，每秒最多一次共用采样；后台/native事件只更新该source/entryId/event所声明的键，未首次取得的键为null。工厂分别包裹backend/native回调以保留source和native entryId，然后广播，不能把两种同名事件误合并。无窗actions参数由宿主包为 `{widgetInstanceId,input:原input或null}` 送进PluginActivation.parameters，插件按实例读自己的dataDir配置；不把用户业务配置塞进宿主布局。

事件广播在DesktopPluginHost原onEvent出口增加订阅，保留tray原处理和已有onPluginEvent，不改backend/native消息解析；每subscriber捕获异常，按owner注销，scope准备停止后丢弃业务事件，保存控制不受影响。每插件入站数据≤20帧/s、≤128 KiB/s；超出按key只留最新合法值并记drop计数，不扩大native协议1 MiB上限。

后台/native数据必须声明subscriptionAction，引用同模板mode=query的公开动作；由宿主以origin=subscription调用，不需要卡片脚本执行取数。取得owner后，按(owner,widgetInstanceId,subscriptionAction)去重，首次发送 `input:{operation:"attach",widgetDefinitionId}`（外层仍包widgetInstanceId）；插件幂等建立该实例默认配置/数据发布，并可返回首帧values，后续按声明event推送。暂停不需要的数据源时发送detach；显式删除发送remove，插件删除该实例配置；停用/update进入prepareStop后不再发业务detach，由现有stop清理订阅。该协议只是既有公开命令的parameters，不增加旧backend/native消息字段。

同一owner的视图重载不重复attach业务订阅；恢复订阅/重试query需幂等，相同实例不会产生两个采样器。attach失败保留实例并标source-unavailable，按1/3/10 s最多三次query重试；remove失败保留待清配置诊断，不恢复已移除视图。只有插件运行owner变化才重新建立业务订阅。origin=subscription只可引用data.subscriptionAction的query动作；widget-origin被动卡任何invoke仍拒绝，不能通过wire伪造origin。

默认refreshMs=1000、最小250、最大60000。一个调度器合并更新，每卡到期最多发一帧，后台高频只覆盖pending最新值，无无界队列。每卡每帧≤16 KiB；**全层JSON数据payload≤50 KiB/s**，每插件≤16 KiB/s，按主进程一秒token bucket、公平轮询；控制/心跳另计≤8 KiB/s全层，观测总量。单帧可用容量不足延迟到下个周期，不分割JSON；完整帧schema/大小超限则拒绝并保留上一个有效值，允许显式业务下采样后再发。

不可见、全屏被抑制、锁屏/休眠时暂停发送与可停provider订阅；共享后台是否继续采集遵循插件后台策略，不把UI隐藏等同停用。恢复只发一份最新完整帧；3个refresh周期无合法新数据标stale，流量缺失不画成零值。声明式与Web共用同一数据校验/预算，Web不能自己fetch补齐。

## 7. Manifest / SDK 1.4.0

### 7.1 ui.widgets 完整 zod 定义

以下为**计划实现代码合同**，复用 `manifest.ts` 已有 z、localId、packagePath、label，不新增依赖。模板文件在安装阶段读入 §8 schema。data/actions 是模板声明，不包含运行owner、实例配置或用户布局。

```ts
const widgetSizeSchema = z.strictObject({
  width: z.number().int().min(80).max(1200),
  height: z.number().int().min(32).max(900),
});
const widgetValueSchema = z.union([
  z.string().max(2048),
  z.number().finite(),
  z.boolean(),
  z.null(),
  z.array(z.number().finite()).max(120),
]);
const widgetFormatSchema = z.enum(["text", "number", "progress", "icon", "series"]);
const widgetDataSourceSchema = z.discriminatedUnion("source", [
  z.strictObject({
    source: z.literal("static"),
    format: widgetFormatSchema,
    value: widgetValueSchema,
  }),
  z.strictObject({
    source: z.literal("host"),
    format: widgetFormatSchema,
    provider: z.literal("host.clock"),
  }),
  z.strictObject({
    source: z.literal("backend"),
    format: widgetFormatSchema,
    event: localId,
    subscriptionAction: localId,
  }),
  z.strictObject({
    source: z.literal("native"),
    format: widgetFormatSchema,
    event: localId,
    entryId: localId.optional(),
    subscriptionAction: localId,
  }),
]);
const widgetActionSchema = z.discriminatedUnion("mode", [
  z.strictObject({
    mode: z.literal("query"),
    commandId: localId,
    entryId: localId.optional(),
  }),
  z.strictObject({
    mode: z.literal("action"),
    commandId: localId,
    entryId: localId.optional(),
  }),
  z.strictObject({
    mode: z.literal("open-main"),
    commandId: localId,
  }),
]);
const widgetCommon = {
  title: label,
  translations: z
    .strictObject({
      "zh-CN": z.strictObject({ title: label }).optional(),
      "en-US": z.strictObject({ title: label }).optional(),
    })
    .optional(),
  size: widgetSizeSchema,
  minSize: widgetSizeSchema.optional(),
  maxSize: widgetSizeSchema.optional(),
  resizable: z.boolean().default(false),
  group: z.enum(["normal", "top"]).default("normal"),
  clickThrough: z.boolean().default(false),
  interactive: z.boolean().default(true),
  commands: z.array(localId).max(8).default([]),
  refreshMs: z.number().int().min(250).max(60000).default(1000),
  data: z.record(localId, widgetDataSourceSchema).default({}),
  actions: z.record(localId, widgetActionSchema).default({}),
};
export const pluginWidgetSchema = z
  .discriminatedUnion("kind", [
    z.strictObject({
      ...widgetCommon,
      kind: z.literal("web"),
      entry: packagePath
        .refine((v) => v.startsWith("widgets/"), "Widget entry must live under widgets/")
        .refine((v) => /\.html$/i.test(v), "Widget web entry must be an .html file"),
    }),
    z.strictObject({
      ...widgetCommon,
      kind: z.literal("declarative"),
      template: packagePath
        .refine((v) => v.startsWith("widgets/"), "Widget template must live under widgets/")
        .refine((v) => /\.json$/i.test(v), "Widget template must be a .json file"),
    }),
  ])
  .superRefine((w, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: "custom", path, message });
    const min = w.minSize ?? { width: 80, height: 32 };
    const max = w.maxSize ?? { width: 1200, height: 900 };
    if (min.width > max.width || min.height > max.height)
      issue(["minSize"], "Widget minimum size cannot exceed its maximum size");
    if (
      w.size.width < min.width ||
      w.size.height < min.height ||
      w.size.width > max.width ||
      w.size.height > max.height
    )
      issue(["size"], "Widget size must be within minSize and maxSize");
    if (w.clickThrough === w.interactive)
      issue(["interactive"], "Widget must be either passive or interactive");
    if (new Set(w.commands).size !== w.commands.length)
      issue(["commands"], "Duplicate widget command ID");
    if (Object.keys(w.data).length > 16) issue(["data"], "Widget can declare at most 16 data keys");
    if (Object.keys(w.actions).length > 8)
      issue(["actions"], "Widget can declare at most 8 actions");
    if (!w.interactive && Object.values(w.actions).some((a) => a.mode !== "query"))
      issue(["actions"], "Passive widget cannot declare user actions");
    for (const [key, d] of Object.entries(w.data)) {
      if (d.source !== "static") continue;
      const valid =
        (d.format === "text" && typeof d.value === "string") ||
        (d.format === "number" && typeof d.value === "number") ||
        (d.format === "progress" && typeof d.value === "number" && d.value >= 0 && d.value <= 1) ||
        (d.format === "icon" &&
          typeof d.value === "string" &&
          /^[a-z][a-z0-9.-]{0,79}$/.test(d.value)) ||
        (d.format === "series" && Array.isArray(d.value));
      if (!valid) issue(["data", key], "Widget static value does not match its format");
    }
  });
export type PluginWidget = z.infer<typeof pluginWidgetSchema>;
```

被动必须显式 `clickThrough:true,interactive:false`，默认两者分别 false/true。保留两字段兼容 v2 术语，但合法组合只有二选一，宿主推导 inputMode。被动只可声明宿主用于取数订阅的query动作，不能从卡片发送invoke/open-main；HUD的“打开主窗/设置”由宿主编辑菜单提供，不能隐藏一个可点击区冒充被动。

ui strictObject增加 `widgets:z.record(localId,pluginWidgetSchema).optional()`（不默认为{}，避免给旧清单合成新字段）。manifest 现有其他字段及refine保持，**将原“必须有entry/backend/native”条件替换**为有上述入口或至少一个widget；不要保留两个互相矛盾的条件。追加如下完整交叉校验函数并在现有superRefine中调用：

```ts
type WidgetManifestChecks = {
  entry?: string;
  backend?: { entry: string };
  native: Record<string, { path: string; args: string[] }>;
  commands: Array<{
    id: string;
    internal: boolean;
    window?: string;
    inputs: string[];
    match?: string;
    sourceApplications?: string[];
  }>;
  ui?: { widgets?: Record<string, PluginWidget>; windows?: Record<string, unknown> };
};
function refineWidgets(m: WidgetManifestChecks, ctx: z.RefinementCtx): void {
  const issue = (path: (string | number)[], message: string) =>
    ctx.addIssue({ code: "custom", path, message });
  const widgets = m.ui?.widgets ?? {};
  if (!m.entry && !m.backend && !Object.keys(m.native).length && !Object.keys(widgets).length)
    issue([], "A plugin needs a web, backend, native or widget entry");
  if (Object.keys(widgets).length > 8)
    issue(["ui", "widgets"], "A plugin can declare at most 8 widget definitions");
  const nativeEntry = (id?: string) =>
    id
      ? Object.hasOwn(m.native, id)
      : Object.keys(m.native).length === 1 || Object.hasOwn(m.native, "main");
  for (const [id, w] of Object.entries(widgets)) {
    const p = ["ui", "widgets", id];
    if (Object.hasOwn(m.ui?.windows ?? {}, id))
      issue(p, "Widget ID must not duplicate a window ID");
    for (const commandId of w.commands) {
      if (!m.commands.some((c) => c.id === commandId && !c.internal))
        issue([...p, "commands"], "Widget command must be a public command of this plugin");
    }
    for (const [key, d] of Object.entries(w.data)) {
      if (d.source === "backend" && !m.backend)
        issue([...p, "data", key], "Widget backend data requires a backend entry");
      if (d.source === "native" && !nativeEntry(d.entryId))
        issue([...p, "data", key], "Widget native data needs an unambiguous declared entry");
      if (d.source === "host" && !["text", "number"].includes(d.format))
        issue([...p, "data", key], "host.clock supports text or number data only");
      if (d.source === "backend" || d.source === "native") {
        const a = w.actions[d.subscriptionAction];
        if (!a || a.mode !== "query") {
          issue([...p, "data", key], "Widget subscription must reference a query action");
        } else {
          if (d.source === "backend" && a.entryId)
            issue([...p, "data", key], "Widget backend subscription cannot select a native entry");
          const keys = Object.keys(m.native);
          const selected =
            d.source === "native"
              ? (d.entryId ?? (keys.length === 1 ? keys[0] : "main"))
              : undefined;
          if (
            d.source === "native" &&
            ((a.entryId && a.entryId !== selected) || (!a.entryId && !!m.backend))
          )
            issue([...p, "data", key], "Widget subscription action must select its data source");
        }
      }
    }
    for (const [key, a] of Object.entries(w.actions)) {
      const at = [...p, "actions", key];
      const c = m.commands.find((c) => c.id === a.commandId && !c.internal);
      if (!c || !w.commands.includes(a.commandId)) {
        issue(at, "Widget action must reference an allowed public command");
        continue;
      }
      if (
        c.sourceApplications ||
        c.match === "window" ||
        c.inputs.some((i) => ["files", "image", "window"].includes(i))
      )
        issue(at, "Widget action cannot require a host source or resource context");
      if (a.mode === "open-main") {
        if (!c.window || !Object.hasOwn(m.ui?.windows ?? {}, c.window))
          issue(at, "Widget open-main requires a declared command window");
      } else {
        if (c.window) issue(at, "Widget headless action cannot reference a window command");
        if (a.entryId ? !nativeEntry(a.entryId) : !m.backend && !nativeEntry())
          issue(at, "Widget headless action requires a backend or unambiguous native entry");
      }
    }
  }
}
```

data/actions对象的键在runtime parser还需拒绝 `__proto__/prototype/constructor`；记录最大数量和总 manifest 256 KiB上限在元数据与包目录验证两处都执行。命令只能作为actions引用，不允许绕过actions直接invoke。模板中的绑定必须引用声明data，按钮必须引用mode=action/open-main（query由显式刷新动作调用或后台取数，不能自动触发查询风暴）；format与组件类型匹配，passive模板不得含button。所有错误带精确字段路径，安装候选失败不启动插件。

### 7.2 兼容判定与发布

`HOST_API_VERSION` 从1.3.0升1.4.0，schemaVersion仍1。当前宿主已有semver依赖：先检查validRange，再检查 `semver.satisfies(environment.apiVersion, manifest.api)` 和现有host范围；使用非空ui.widgets时额外要求 `semver.subset(manifest.api, ">=1.4.0 <2.0.0")`，不接受 `^1.0.0`、`>=1.3.0` 或一个包含旧API的OR范围。推荐 `">=1.4.0 <2.0.0"`；元数据发现和解包校验共用同一检查。api范围上界仍按主版本兼容策略，不以“当前版本满足”掩盖声明过宽。

| 组合                                     | 行为                                                                                                  |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 旧插件不声明widgets，api允许1.4.0        | 继续运行，发给旧SDK的既有消息保持旧shape，不添加widget字段                                            |
| 旧插件把api锁死1.3.x                     | 按原兼容规则提示升级；不能声称所有旧插件无条件兼容                                                    |
| 新插件含widgets、使用SDK1.4合同、宿主1.4 | schema/授权/feature flags分别判定；flag关不等于版本不兼容                                             |
| 新插件含widgets，老宿主/旧SDK schema     | strictObject可能先报未知字段；旧宿主不会自动忽略。安装器若能先看api则给不兼容提示，否则保留schema原因 |
| 新插件含widgets但api范围仍含1.3          | 新宿主拒绝，提示“桌面卡片要求最低API 1.4.0”                                                           |

SDK运行API版本与npm包版本独立；不把SDK package当前0.3.0直接改称1.4.0。新插件构建必须使用包含widget定义的新SDK发布；不为旧SDK打补丁。UI旗标关闭时清单仍可安装/启用其他功能，卡片显示“桌面层未启用”，不谎称“宿主版本不支持”。

SDK的widget.ts仅import type，输出widget.js为无运行时import的浏览器模块，使用浏览器MessagePort/JSON/有限消息校验，不自动初始化完整Web插件SDK。主进程引用widget-schema.ts的zod解析器；不要让虚拟路径需要解析node_modules或裸模块名。`/__sdk__/widget.js`由宿主提供SDK编译输出的固定文件，路径映射不接受插件替换。

### 7.3 最小无后台声明式清单片段

```json
{
  "api": ">=1.4.0 <2.0.0",
  "ui": {
    "theme": "^1.0.0",
    "widgets": {
      "clock": {
        "kind": "declarative",
        "title": "时钟",
        "template": "widgets/clock.json",
        "size": { "width": 180, "height": 64 },
        "clickThrough": true,
        "interactive": false,
        "data": { "time": { "source": "host", "provider": "host.clock", "format": "text" } }
      }
    }
  }
}
```

这是嵌入现有完整插件清单的片段，不是可单独安装的package.json。Web改用 `kind:"web",entry:"widgets/main.html"`，不得同时带template。安装信任页给模板数量与类型，用户显式创建实例；启用不按模板数自动铺卡。

## 8. 声明式卡片组件合同

### 8.1 模板与数据类型

模板JSON根为version1，只能包含以下结构。schema必须strict，先限文件≤32 KiB，再有界遍历计数，不用无限深z.lazy递归到爆栈：

```ts
export type WidgetValue = string | number | boolean | null | readonly number[];
export interface WidgetDataFrame {
  revision: number;
  at: number; // 宿主UTC epoch ms，仅时间不是身份
  values: Readonly<Record<string, WidgetValue>>;
}
type Tone = "default" | "muted" | "accent" | "warning" | "danger";
type TextSize = "caption" | "body" | "title";
type BoundText = { text: string } | { dataKey: string }; // 严格二选一
export type DeclarativeNode =
  | {
      type: "stack";
      direction: "row" | "column";
      gap: 0 | 4 | 8 | 12;
      align: "start" | "center" | "end";
      children: DeclarativeNode[];
    }
  | { type: "text"; value: BoundText; size: TextSize; tone: Tone; maxLines: 1 | 2 | 3 }
  | { type: "number"; dataKey: string; decimals: 0 | 1 | 2; unit?: string; tone: Tone }
  | { type: "progress"; dataKey: string; tone: Tone }
  | {
      type: "icon";
      name?: "clock" | "network" | "arrow-up" | "arrow-down" | "warning";
      dataKey?: string;
      resourceId?: string;
      size: 16 | 20 | 24;
      tone: Tone;
    }
  | { type: "sparkline"; dataKey: string; min?: number; max?: number; tone: Tone }
  | { type: "button"; label: string; actionId: string; tone: Tone };
export interface DeclarativeTemplate {
  version: 1;
  padding: 0 | 4 | 8 | 12 | 16;
  background: "card" | "transparent";
  root: DeclarativeNode;
}
export interface DeclarativeCardProps {
  template: DeclarativeTemplate;
  data: WidgetDataFrame;
  disabled: boolean;
  onAction: (actionId: string) => Promise<void>;
}
export interface WidgetFrameProps {
  binding: WidgetBinding;
  url: string; // 宿主解析的当前不透明URL
  client: LayerClient;
  blocked: boolean; // 编辑/停止/未ready时遮罩
}
```

白名单只有文本、数值、进度、图标、简单曲线、动作按钮，stack只负责布局。禁止raw HTML、Markdown/raw SVG、插件React函数、CSS串、className、style对象、表达式求值、动态import、模板脚本及任意URL。图标name/dataKey/resourceId严格三选一；resourceId为安装时验证过的PNG逻辑句柄，≤64 KiB、≤256×256像素，不是文件路径。stack子数≤8、总节点≤64、树深≤4（根深1）、button≤4、sparkline≤4；每series≤120个有限数值，总series采样≤480点/卡。数值绝对值≤10^15、progress范围[0,1]、曲线min<max；非法数据拒绝整帧。

data≤16键，text每值≤2048字符、模板静态文本≤160字符、button label≤40字符、unit≤16字符。dataKey/actionId/resourceId均localId；number/progress/sparkline对应format必须number/progress/series，图标只接受已注册name或句柄。完整data帧≤16 KiB、模板≤32 KiB、刷新250–60000 ms；超预算完整拒绝保留旧值。允许null表示不可用，组件显示“—/暂无数据”，不得把缺失画零。

schema遍历要同时验证未知字段、数量、深度、类型、引用和尺寸；parseWidgetData对绑定清单验全键集合与format，不允许注入额外provider键。图标资源安装时读PNG头与像素尺寸，运行时不允许插件改成任意路径。

resourceId的固定映射：模板 `widgets/<name>.json` 的资源只从 `widgets/<name>/icons/<resourceId>.png` 解析（resourceId只用localId，不含斜杠）。安装验证模板时生成句柄表并复用confined/realpath与图像尺寸检查，不需要任意资源路径字段；不存在的资源拒绝模板，运行值只能选已登记的ID。

### 8.2 React执行与主题

DeclarativeCard是纯宿主React组件，按type switch映射已有Typography/Button/Progress等；先检查已装原语，简单曲线使用宿主固定SVG path（有界120点，不执行传入SVG），无需引图表依赖。每卡ErrorBoundary，数据变化按instance/revision替换，不累积DOM；隐藏时不跑动画，首期不做连续动画或rAF轮询。

主题tone映射现有语义变量：default→`--foreground`，muted→`--muted-foreground`，accent→`--primary`，warning→现有warning语义色（若未定义，先用muted并图标提示），danger→`--destructive`；背景/边框→`--card/--card-foreground/--border`。复用bamboo主题，不硬编码另一套颜色。字体caption/body/title为12/14/18 CSS px、单行省略/有界行数；padding/gap只取枚举值。大小来自宿主布局，不受模板自由定位。

未来原生执行器实现 `render(template:DeclarativeTemplate,data:WidgetDataFrame,theme:ResolvedLayerTheme,bounds:Rect):void`、`dispose():void`，消费同一受限合同；不得以“原生”绕过数据/动作/owner限制。本期不建立并行原生绘制栈。

## 9. 布局存储、版本与便签可逆迁移

### 9.1 desktop-layout.json v1

位置为当前宿主profile的config目录（由runtime注入，不猜用户绝对路径）。只存宿主布局、模板引用、恢复意图与便签兼容状态；不存Markdown正文、插件业务参数、授权或运行身份。插件实例业务配置为插件dataDir的 `widgets/<widgetInstanceId>.json`，纳入插件dataVersion/migration；插件提供配置编辑主窗，层不解释业务字段。截图布局使用`screenshot:<UUID>`/kind=screenshot及screenshotId和相同公共几何字段；图像与scene位于截图私有dataDir的`pins/<UUID>/revisions/<revision>/`，`current.json`指向当前revision，运行随机句柄不进入desktop-layout。

```json
{
  "version": 1,
  "revision": 12,
  "cards": {
    "widget:6535b388-900c-4e10-a83d-d7f83c407d09": {
      "kind": "widget",
      "pluginId": "spark233.traffic-monitor",
      "widgetDefinitionId": "hud",
      "widgetInstanceId": "6535b388-900c-4e10-a83d-d7f83c407d09",
      "displayId": "2528732444",
      "workAreaAtSave": { "x": 0, "y": 0, "width": 2560, "height": 1400 },
      "bounds": { "x": 2240, "y": 64, "width": 240, "height": 80 },
      "group": "top",
      "inputMode": "passive",
      "order": 4,
      "visible": true,
      "restore": true,
      "createdAt": 1793440000000
    },
    "notes:sample-note": {
      "kind": "notes",
      "noteId": "sample-note",
      "displayId": "2528732444",
      "workAreaAtSave": { "x": 0, "y": 0, "width": 2560, "height": 1400 },
      "bounds": { "x": 0, "y": 120, "width": 160, "height": 32 },
      "group": "top",
      "inputMode": "interactive",
      "order": 0,
      "visible": true,
      "restore": true,
      "createdAt": 1793440000000
    }
  },
  "notesCompat": {
    "sourceVersion": 2,
    "importId": "612818a5-b503-4572-928b-2a6a28ab8831",
    "projectedRevision": 12,
    "windows": [],
    "capsuleQueues": []
  },
  "removedInstances": []
}
```

示例ID和屏幕是虚构数据，不是用户布局。notesCompat.windows实际保存原NotesLayoutV2完整宿主窗口字段（label、view、noteId、展开bounds、visible/folded/topmost/everOpened、capsule），capsuleQueues保存完整key/offset/collapsed/scroll/centered；**示例空数组不代表迁移可丢掉它们**。主胶囊和preview/drag由queue派生，不单独持久化；notes capsule实际矩形由兼容placement/队列几何算出，cards.bounds是已提交渲染位置缓存，重算时不得改变原展开bounds。

```ts
export interface DesktopLayoutV1 {
  version: 1;
  revision: number;
  cards: Record<string, StoredLayerCard>; // widget/notes/screenshot strict判别联合
  notesCompat?: {
    sourceVersion: 2;
    importId: string;
    projectedRevision: number;
    windows: NotesLayoutV2["windows"];
    capsuleQueues: NotesLayoutV2["capsuleQueues"];
  };
  removedInstances: Array<{ id: string; removedAt: number }>;
}
export interface NotesLayoutV2 {
  version: 2;
  windows: Array<NoteLayoutState & { label: string; noteId?: string }>;
  capsuleQueues: CapsuleQueue[];
}
export interface NotesMigrationOptions {
  store: LayerLayoutStore;
  readNotes: () => Promise<NotesLayoutV2>;
  writeNotes: (value: NotesLayoutV2) => Promise<void>;
  journalFile: string;
  atomicWrite: (file: string, value: string) => void;
}
export class LayerLayoutStore {
  constructor(options: {
    file: string;
    now: () => number;
    atomicWrite: (file: string, value: string) => void;
    readJson: (file: string) => unknown;
  });
  readonly readError?: unknown;
  load(): DesktopLayoutV1;
  commit(next: DesktopLayoutV1, expectedRevision: number): Promise<void>;
  ackNotesProjection(revision: number): Promise<void>; // 只更新投影确认元数据
  schedule(next: DesktopLayoutV1): void; // 250ms合并的系统几何收敛，最长1s
  flush(): Promise<void>;
}
```

StoredLayerCard是strict discriminated union：公共display/workArea/bounds/group/inputMode/order/visible/restore/createdAt必填，widget加pluginId/definitionId/instanceId，notes加noteId，screenshot加UUID screenshotId并要求key完全匹配；不允许payload/owner/业务配置。正安全revision、有限DIP、order安全整数、总记录≤512、文件≤1 MiB、removedInstances≤512。容量用尽时拒绝创建，不淘汰仍停用的卡。

`migrateDesktopLayout`：缺文件→空v1；当前version1对widget/notes/screenshot严格解析；没有版本/未知未来version/损坏→readError，保全原文件，禁止自动写空。没有历史desktop v0自动猜测；便签v1先复用现有notes布局升级为v2，再执行显式import。不识别截图kind的旧构建也不能把解析失败当空布局覆盖；降级须先导出兼容布局，未来不兼容格式通过版本化纯迁移处理。

同一进程一条写队列，复用 `persistence.ts:atomicWrite`（同目录临时文件、fsync、rename）。commit要求next.revision=expectedRevision+1，成功才发布revision；I/O失败不假装成功。ackNotesProjection也走同一队列，只把projectedRevision推进到已实际写成功且不超过当前revision的值，**不增加布局revision、不发布新布局事件、不再次触发projection**，避免确认自身形成死循环。启动load未完成、notes未恢复或处于backup maintenance时不落空布局。系统屏幕事件250 ms合并/最长1 s，用户up/关闭编辑/移除/退出立即flush；所有等待者只在其对应或更高revision落盘后完成。

### 9.2 屏幕失效与布局冲突

displayId为Electron屏幕ID字符串，可能换接口后变化，不能称永久硬件ID。保存workAreaAtSave用于归一化映射：

1. displayId存在：按旧workArea的左上偏移映射新workArea，再clamp大小与原点，卡必须完整可见；混合DPI只用DIP。
2. display不存在：用主屏，按旧workArea内比例映射；无旧信息则右上8 DIP起网格排布。临时断屏收敛会提交新屏，不在旧屏回来时偷偷抢回。
3. 不大于workArea的min/max；屏幕小于min则以workArea为硬上界并记constrained，不产生负尺寸。冲突按 §5.2确定顺序找空位；无空间挂起可找回。

显式用户提交CAS冲突返回layer.layoutConflict并重读；系统收敛排队在用户提交之后或取消当前手势。不以时间戳比较插件快照覆盖宿主。模板更新只更新默认值和合法min/max，收紧尺寸则宿主提交一次有诊断的clamp；模板被删保留orphan实例等待用户映射/移除，不自动匹配同名不同模板。

### 9.3 便签迁入与回滚事务

迁移仅改变宿主布局归属，不迁正文、附件、历史或backend dataVersion。原展开窗不搬进层。按noteId稳定映射到notes卡，floating坐标直接用DIP，docked保留display/edge/order/queue offset和scroll，展开bounds、topmost、folded、visible、everOpened逐字段保留，隐藏不等于删除。

首次开启notesEnabled：

1. 按既有M1输入证据及待验收范围继续验证；冻结notes布局写入口与手势，flush既有保存。读NotesDataClient.layout（完成业务恢复后）和desktop store。
2. 写 `desktop-layer-migration.json` journal：`{version:1,id,phase:"prepared",sourceLayout,sourceHash,targetRevision}`，并保全原布局备份；均为当前profile下宿主数据。
3. import按noteId upsert，只填未导入便签；desktop中已有用户布局优先。将完整source写notesCompat，用原子store commit；journal转layer-committed。
4. 由同一协调器project到NotesDataClient.putState("layout")，成功后journal转projected；旧布局镜像不再接收独立写请求。
5. 销毁旧胶囊视图再启新层，成功ready才提交notesEnabled；失败恢复旧路径，使用最新已提交投影，不将“开关开了”当完成。

双文件/数据库不可能靠一次rename原子提交，所以journal是必需的。prepared且desktop未提交→保留source继续旧路径；layer-committed→以desktop为权威重做projection；projected→校验revision再清journal。启动发现journal未完成先恢复，不能同时开两套写者/视图。

默认开启后的自动启动使用可恢复路径：便签迁移失败保留旧 notes 视图和 journal/已提交状态，记录 `notesMigrationError` 并在宿主管理页显示 warning，其他声明式/Web/截图桌面层继续同步。失败不自动把用户的 notesEnabled 偏好改成 false，也不读过期坐标强行切换；下次同步/启动可继续恢复。用户在设置中显式切换开关则使用 strict 事务：迁移或应用失败须拒绝本次设置，恢复原配置与原模式，保留原错误。自动启动的降级处理不能吞掉显式设置的失败。

灰度期间每次涉及notes的层commit将完整兼容状态写desktop（唯一权威），随后协调器向backend投影最新revision；成功后调用ackNotesProjection。投影队列只留最新revision，失败按1/3/10 s最多重试三次，再保留journal与“旧路径同步未完成”诊断，由用户重试/下次启动恢复；不在失败时关flag并读过期位置。note删除也经此协调器写tombstone并撤活动卡，不因旧snapshot/备份引用复活正文；正文删除与回收仍归现有notes数据合同。

关闭notesEnabled或回退版本前：冻结提交 → flush desktop → project最新revision到NotesDataClient并等待成功 → 验证可逆字段和revision → 关闭层notes视图 → 激活旧Capsules → 切flag。写失败则保持当前模式/停在可恢复状态，不自动回滚到旧坐标。普通disable无需清空desktop；手动二进制降级前用此路径“导出旧布局”，否则旧版本只会读最近一次投影，属于明确数据时效风险。

降到不识别desktopLayer配置字段的旧二进制，还需导出旧格式host config：原子备份当前config.json，在关闭全部层flags并flush后输出不含desktopLayer键的旧shape（仍保留所有其他配置），旧strict schema才能启动；同版本关flag无需删除键。导出完成须退出当前进程再降级，恢复新版本从备份显式重开flags。不能只保留capsules旧代码却忽略host-config.ts的strict字段拒绝。新字段插件不拿去旧宿主启动；若旧宿主遇不兼容新插件，先停用/恢复兼容受信版本，不编辑包清单伪装API。

旧模式继续由同一宿主协调器接布局提交并更新desktop兼容记录；旧Capsules仅是view适配器。到不含层代码的历史版本运行后再升级，读取投影hash与NotesDataClient.layout：若外部旧模式布局已变且层未产生更新，以旧布局重新显式导入新revision；两边都变先保全两份，默认采用desktop并在设置提供“使用旧布局副本”，不按mtime偷偷选。完成至少一个发布版本的回滚窗口和验收后，才能另提删除旧路径。

## 10. 生命周期与删除边界

先复用manager现有prepareStop/保存拒绝/资源域语义。准备停用开始冻结动作、取消展示请求；未获保存确认不能宣告停用成功或强杀后台。保存拒绝则resume，创建新loadGeneration/端口、恢复最新数据；不复用停止前请求。

具体接线在DesktopPluginHost.createRuntime：非startupCheckOnly的scope先 `scope.own("event",{prepareStop,cancelStop,dispose})` 注册widget资源，再创建后台/原生controller。prepareStop(reason)调用quiesce并保存reason，返回{ok:true}，不提前删除布局；dispose调用revoke(owner,映射后的reason)。cancelStop只标记resumePending并返回，主进程下一轮监督在scope.state真正恢复active且owner仍当前时才调用resume；**不能在cancelStop内部等待active**，否则与scope恢复顺序互相等待。resume-failed保持围栏，不复活视图。runtime创建成功并由manager登记当前owner后再排队attach，安装init检查不attach。复用resources.ts现有接口，不新增第二套生命周期总线。

| 动作      | 实例/布局                                                                           | 视图、端口和请求                                         | 数据/owner/业务配置                                                                     |
| --------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| 安装/发现 | 只校验模板与摘要，不创建实例                                                        | 无窗口/端口                                              | 无widget业务激活；现有native安装init检查仍不执行业务                                    |
| 启用      | 恢复已创建且restore=true实例，受配额/flag约束                                       | 当前owner新代次绑定/ready；未开启层只显示挂起            | 根据现有后台策略及活动实例按需启动，静态卡只有轻量scope；保留配置                       |
| 停用      | **保留全部布局、实例、恢复偏好**                                                    | 先quiesce，保存成功后撤port/hostname/请求/视图/恢复timer | 注销订阅/资源；释放后台遵循现有stop；不删dataDir                                        |
| 卸载      | 默认保留数据则保存orphan引用，重新装同plugin/template可恢复；选择删数据则删所属记录 | 先保存确认再全部撤销                                     | 配置是否保留沿用户卸载选择；无游离renderer/bridge                                       |
| 更新      | 冻结布局写；保留实例UUID和布局，模板变更重新验证                                    | 先撤旧binding再切版本，新owner/代次/hostname；旧结果丢弃 | 复用已有dataVersion迁移与事务；失败恢复旧受信版本/owner，并重放布局，禁止未授权代码启动 |
| 清数据    | 用户明确确认后删除所属卡片/配置，或“只重置布局”只删布局覆盖                         | 要求先正常停用；撤销全部端口/任务后提交删除              | 业务清理走既有插件维护/备份流程，失败保全数据，不用snapshot缺项代替清空                 |

移除单卡与停用插件不同：前者持久tombstone，后者仅停止呈现。隐藏单卡保留实例配置、visible=false；单独关闭HUD不撤采集租约。全层关闭撤活动视图与端口，不停用插件其他功能；notes必须先通过§9回滚。卸载保留数据的orphan不占活动配额，但仍计存储上限。

## 11. 性能预算与实测对照

遵循[性能测量约定](launcher-architecture.md#132-性能测量)，预算是排查/发布门槛草案，非已达成承诺。v2指标保留但拆开资源类型，原“1–10卡≤100 MB、固定两renderer”的承诺撤销；MiB统一为2^20字节，KiB为2^10字节。

### 11.1 v3预算值（均未完成产品实测）

| 类别     | 指标                | 预算值/处理                                                                               |
| -------- | ------------------- | ----------------------------------------------------------------------------------------- |
| 层自身   | 常驻窗口            | 共享≤4/屏、只按需创建；预览/拖动各全局≤1；无卡销毁；renderer数量按实际frame/PID记录       |
| 层自身   | 单空surface固定成本 | private≤40 MiB、working set≤120 MiB；四surface必须逐个累计，不按一层算免费                |
| 层自身   | 首帧                | 已有壳ready后层首帧<200 ms；冷启加载另计，5 s为失败超时不是性能目标                       |
| 层自身   | shape               | 静止≤10次/s；拖动≤60次/s；记录矩形数/耗时                                                 |
| 层自身   | idle CPU            | 单surface≤0.5%单核等价CPU，四surface合计≤1%；不用整机百分比混算                           |
| 声明式   | 卡片增量            | 目标每卡JS堆/DOM相关增量≤2 MiB；20卡相对相同surface基线private增量≤40 MiB                 |
| 声明式   | 1/5卡idle CPU       | 新增≤0.5%/≤1%单核等价CPU；不包含后台采集，后台另外列                                      |
| 声明式   | 新卡首帧            | 已有surface内<100 ms；冷surface另计                                                       |
| Web      | 每实例增量          | 含可信独立壳和子renderer的private≤80 MiB、working set求和≤240 MiB；仅预算，原型不直接证明 |
| Web      | 数量与CPU           | 默认每插件≤2、每屏≤4、总≤8；1张静态Web卡idle≤0.5%单核等价CPU                              |
| Web      | 加载                | 冷加载目标<1000 ms，5 s未ready失败；不复用声明式<100 ms指标                               |
| 全层数据 | payload/带宽        | ≤16 KiB/卡/帧，payload总≤50 KiB/s、每插件≤16 KiB/s；另计控制≤8 KiB/s                      |
| 全进程树 | 24h稳定性           | 相同输入/卡数下稳定后private增长<10 MiB，frame/PID/句柄/端口/任务无持续增长；**未验证**   |

预算超出先记录真实场景和来源；禁止关闭sandbox/site isolation或减少数据准确性“达标”。活动配额在create/恢复/迁屏三处统一执行，按createdAt/id优先恢复，超额挂起可找回。一个notes队列普通卡仍逐实例计数，已存在超过推荐配额的用户便签不能迁移后丢失：标出超额，保持旧notes路径直到用户调整或批准更高配额。

### 11.2 实测值对照（独立原型，不是预算验证）

| 指标            | 实测值                                                         | 能说明什么/不能说明什么                              | 来源                                        |
| --------------- | -------------------------------------------------------------- | ---------------------------------------------------- | ------------------------------------------- |
| 空壳            | 1 renderer；private 22.09 MiB / working set 89.24 MiB          | 支持固定成本量级；不是正式React壳和四surface预算通过 | `E/measure-web-0-report.json`               |
| 5隔离Web iframe | 6 renderer；private145.97 MiB / working set561.16 MiB          | 推翻进程固定假设；不是v3独立Web壳完整成本            | `E/measure-web-5-report.json`               |
| 20简单宿主卡    | 1 renderer；private22.93 MiB / working set92.01 MiB            | 支持声明式共享方向；非正式曲线/React/长期负载        | `E/measure-declarative-20-report.json`      |
| 同hostname三卡  | 本样本宿主+子renderer共2个进程；1.212 s内三卡0次心跳、宿主13次 | 复用可能扩大故障域，不能当跨版本进程合同             | `E/summary.json`、`E/automatic-report.json` |

测量沿用少量代表样本，隔离目录 `local-build/desktop-layer/<runId>/`。每场景独立启动：flag关闭、空surface、1/5/20声明式、1/2/4Web、便签混用、主窗打开/隐藏、停用。记录开发Node/npm、Electron/Chromium、DPI、刷新频率、模板/包哈希；同样基线重复至少3次，不用单次估分位。

`app.getAppMetrics()` 每秒采进程CPU/memory（Electron KiB转MiB），按 `--spark233-label=layer:` 找宿主surface；再用WebFrameMain的osProcessId登记所有子frame，按PID去重、单列Chromium暂留进程，不能只按顶层label漏OOPIF。主进程/GPU/backend/native也纳入整树并注明共享。`performance.memory` 只在可信renderer采usedJSHeapSize/totalJSHeapSize，与DOM节点数配合；它不是working set/private，也不能推断iframe全部堆，缺失则标不可用。idle采10 min、代表业务与24h另测；正常GC波动和持续增长分开。

## 12. 落地顺序与HUD两阶段

下表保留各阶段的目标和出口合同，**不等同于当前完成情况**。截至2026-10-31，M0/M1平台、M2便签可逆迁移、M3接口总量fallback HUD及截图常驻迁移已实现，并有隔离生产类/真实Electron及100/125/150%双屏的既有代表链证据；完整跨native窗口拖动、真实唤醒/热拔和24h出口仍未完成。本轮按用户最新决定改为三开关默认true，显式false保留；这一决定不补记任何未完成验收。逐项结果见第二阶段和截图实施记录。按功能集成先行，type/lint/build和必要保存/权限/生命周期验证随阶段做；UI自动化、截图和视觉收口放M4。M1内的真机鼠标验证仍是产品验收出口。

| 阶段              | 交付物                                                                                                                                                  | 前置依赖                                                     | 可回滚点                                                             | 出口标准                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| M0 抽层           | 抽LayerWindow/shape/z序/生命周期适配，保持旧Capsules业务接口；确定shared/Web壳资源归属                                                                  | 核对当前capsule-layout、fullscreen watcher与数据根           | 历史M0以全关flags落地，旧胶囊路径仍可用、未迁布局；当前默认见§14     | 既有保存/胶囊smoke不退化；形状/释放聚焦验证；本阶段不迁便签                                                                                           |
| M1 合同与层页面   | Manifest/SDK1.4、身份/实例、布局store/journal、共享层、React基础执行器、编辑器、Web桥、无窗命令、监督；一个静态clock、一个后台、多实例、一个Web隔离样例 | M0；按§7/8冻结合同；隔离profile                              | 关enabled/webEnabled，样例布局保留；notes仍旧路径                    | 资源/owner/代次撤销、超时/迟到结果、熔断重建及可逆布局样例成立；**真实鼠标点透和捕获、100/125/150 DPI、双屏/混合DPI代表链通过并留证，否则不得进入M2** |
| M2 便签迁入       | notes consumer、三边队列/预览/拖动、旧布局import/projection/journal、回滚入口                                                                           | M1硬出口；notes保存拒绝/数据恢复链保持                       | 依§9投影最新revision再关notesEnabled，旧视图接管                     | 隔离便签保存失败不丢草稿，隐藏/展开/pinned/队列/跨屏记忆等价；重启与中断恢复、最新位置回滚通过；真机全屏/睡眠代表链通过                               |
| M3 声明式卡片/HUD | 正式文本/数值/进度/图标/曲线/动作模板、流量HUD、provider/动作授权与配额管理                                                                             | M1合同与surface出口；正式默认rollout依M2；流量桥快照独立就绪 | 只撤HUD实例/关层，流量桥及主页面保留；无--widget回退                 | HUD用同一授权快照，1Hz/缺失/暂停状态正确；关闭卡不停止采集；更新/停用撤请求不复活                                                                     |
| M4 验收收口       | 全进程树测量、24h、真实手工矩阵、最终UI/截图与文档证据                                                                                                  | M0–M3及截图功能稳定                                          | flags可独立关闭，旧notes实现保留至少一个版本；自动迁移失败走兼容路径 | §13出口逐项保留证据，预算按实测评估后签阈值；默认开启不等于验收通过                                                                                   |

HUD排期必须明确写回流量文档：

当前已交付独立官方`traffic`插件的真实接口总量采集器、主页面与声明式HUD，复用同一个持久采样后台。下列A/B是按进程ETW链的后续接入顺序；不能将已交付的接口总量fallback误写为ETW、SYSTEM服务或进程历史库已完成，亦不能把尚未完成的ETW链作为现有HUD无法使用的理由。

1. **阶段A（层未就绪）**：服务/ETW/授权/历史/桥先独立交付；数据在插件主页面与现有托盘tooltip展示，HUD状态写“待层落地替换展示端”。不开发临时C# --widget，不假装已具备常显桌面卡。若M3b所需日期早于层M1，只能延期HUD或另行重新决策，不能暗中启用旧原生窗。
2. **阶段B（层M1出口之后，正式接入在层M3）**：复用桥的完整快照映射声明式hud模板，每1 s发布速率/趋势和质量状态；布局、置顶、inputMode、恢复由宿主管。bridge保持采集租约，HUD不另拉独立采样进程、不改变服务权限；仅主页面显式触发复杂操作。

层M1是HUD最早前置条件，M2不是数据侧车开发的前置；阶段编号是层内顺序，不与流量技术方案M0–M5同名阶段混淆。C#继续承担服务/ETW和用户桥，**取消展示端native entry widget及--widget发布模式**，不是移除C#采集链。

## 13. 最小测试、真机矩阵与门禁

实施先复用现有测试/runner；仅当现有证据不足保护真实风险，补下表最低层回归，优先在已有manifest/capsule-layout/生命周期测试里增强，不按验收项建测试文件，不加框架。本次已执行类型、lint、测试、构建及隔离 Electron 功能检查；实际结果与未覆盖项见首版及第二阶段实施记录。

| 最小风险用例                                                           | 最低验证层                                                        | 实际保护                                       |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------- |
| clip局部→屏幕→client DIP，负屏、边界取整、空shape                      | 已有几何测试能覆盖则复用；必要时同目录纯函数测试                  | 不误拦下层窗口、避免不可见卡，不能代替真机点透 |
| 卡片diff保持用户覆盖、屏幕收敛幂等、迁移/投影round-trip及I/O失败不提交 | store/迁移最少代表用例；journal关键断点复用既有恢复验证           | 布局丢失、回滚读旧位置、双写者                 |
| actions只能调用同插件公开白名单且无窗，不透传internal/来源绑定         | 现有manifest和manager权限测试加强一处；隔离backend/native代表调用 | 权限越界和意外开窗                             |
| bridge解析拒绝超限/旧owner/旧代次/错seq，取消后迟到不能满足新请求      | parser/在途请求最低层；真实port撤销用已有集成runner               | 信任、并发与生命周期边界                       |

不为窗口参数、常量、文案、类型接线、每个组件样式和第三方输出写测试。不建立全格式/平台排列组合。若新增*.test.ts，随源码放置并检查当前Electron生产tsconfig排除它；当前仓库配置以实际package脚本为准，不因AGENTS的历史路径改写现有约定。

### 13.1 必须留证的Windows真机手工矩阵

100% 主屏、100/125% 与 100/150% 真实双屏的原生 SendInput 点击、125% 窗口内捕获/松开及 Esc 取消已有证据；便签迁移/回退、受控全屏分离策略也已通过隔离生产类验证。完整跨 native 窗口边界拖动、真实游戏全屏/休眠/热拔、24h 门槛仍未验证。renderer 强杀恢复、受限 IPC/SDK、布局应用/取消及隐藏后恢复已有真实 Electron 自动化功能证据；实际通过范围以原始报告为准，不将注入 DisplayArea/光标的合同验证替代物理出口。

| 场景              | 操作与观测                                                                                | 通过条件                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 物理点透          | 测试应用按钮置底，记录前后HWND/z序；真实鼠标分别点击passive实体/透明空隙、interactive按钮 | passive只触发下层一次，interactive只触发卡片一次；不以sendInputEvent或CSS证明代替 |
| 物理捕获/取消     | 宿主手柄按住拖出shape、越过iframe、松开；capturelost/Esc/切屏/锁屏取消                    | 不丢up、不误click、不双提交；iframe内容不会被父容器自动代拖                       |
| DPI 100/125/150   | 各缩放检查bounds、shape、手柄/滚轮；至少一组100↔150混合屏                                 | DIP落点、裁切和捕获无偏移，不能只验证截图缩放                                     |
| 双屏与断屏        | 负坐标屏/主副屏互换、热拔、任务栏工作区变化、跨屏up                                       | 位置收敛可见、不丢卡，回滚保留最新位置                                            |
| 全屏应用          | 代表游戏/视频全屏于一屏，另一屏继续；退出全屏                                             | 按便签既有降层/HUD默认隐藏策略，恢复group/pinned不改用户偏好                      |
| 休眠/锁屏/唤醒    | 拖动中锁屏、休眠、醒后显示器重枚举                                                        | 无误判重建风暴/幽灵拖动，完整快照恢复、实例只一份                                 |
| renderer强杀/卡死 | 只对隔离profile所持窗口/子renderer注入故障或手动强杀                                      | Web按实际故障域恢复；宿主层全部成员重放；3次上限熔断、无业务action重放            |
| 便签迁移/回退     | 隔离便签展开/折叠/隐藏/三边/浮动/滚轮、保存拒绝、重启、更新中断                           | 正文未改/未丢，presence正确，双向布局与最新位置一致                               |
| 权限/生命周期     | Web后台/原生、多实例、更新/停用/卸载保留与删除                                            | 旧port/hostname/request失效；后台保存拒绝不当停用成功                             |
| 24h/管理员窗口    | 固定代表负载长期运行；另查跨应用/管理员窗口前后关系                                       | 记录资源/恢复和实际可用边界；未测不得写全支持                                     |

### 13.2 出口与命令

**产品验收继续逐项留证**：M1物理点透、真实拖动捕获与取消、DPI/双屏代表链、受限桥和布局可逆恢复须有记录；受控输入/Win32样式只能是辅助证据。用户已授权实现并验证M2，并最新决定默认notesEnabled=true；默认值已落实，未完整通过的出口仍保留。M2完整验收需要便签全屏/唤醒和最新位置回滚；M4仍需完整矩阵与24h记录。本轮最终构建、lint、75文件/316测试、截图真实Electron自动集成23项、原生图钉/继续标注/撤销重做/Escape恢复代表链、默认值与超额便签兼容恢复已有通过证据；两次最终新进程均在初代surface直接恢复贴图，无load-timeout。早前两轮launcher-preferences rename EPERM失败日志保留，未声称其间歇Windows写入问题已根治。具体权限、输入及启动覆盖范围以截图记录为准，不能合并为全部发布出口通过。

按AGENTS与项目选定运行时执行阶段门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`；Windows集成 `pwsh -File scripts/smoke-windows.ps1`，发布阶段再 `pnpm pack:win`。开发Node要求以package.json engines/本机选定运行时核对。每小改不跑全套，边界/阶段收口跑适当gate。本次采用 Node 26.13.0 / pnpm 12.16.1；未进行安装包发布、commit 或 push。

所有profile、便签样本、插件安装、服务测试配置、桥输出和资源测量只用 `local-build/desktop-layer/<runId>/` 或显式临时目录，禁止连真实便签/剪贴板历史。测试失败只清理自己持有的窗口/资源，不扫杀进程、不覆盖外部Codex证据。

## 14. 默认值、Feature flags 与初始化

按用户最新决定，三个字段的默认值统一为true，不单独引远程flag平台。新配置直接使用完整默认值；旧配置没有desktopLayer对象，或对象缺少某个字段时，只补缺失字段为true；显式保存的false保持false。读取、保存、runtime fallback和设置UI共用同一份默认合同，不使用 `value || true` 一类写法覆盖用户关闭意图。

| 名称                        | 默认值 | 开启语义                                                                                 | 关闭语义                                                                                                  |
| --------------------------- | ------ | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `desktopLayer.enabled`      | true   | 允许实例渲染/管理和共享层运行；不会自动创建所有模板                                      | 撤widget/截图视图、端口/订阅；先完成notes回滚，保留布局/插件功能                                          |
| `desktopLayer.notesEnabled` | true   | enabled=true且notes实际恢复后执行可逆迁移，再切notes consumer；自动失败保留旧notes并告警 | 先project最新布局成功再启旧Capsules；运行始终按enabled&&notesEnabled判断，显式关闭平台时一并关闭notes迁移 |
| `desktopLayer.webEnabled`   | true   | 已授权Web模板允许用户创建/恢复，仍计独立配额                                             | Web实例挂起保留布局，声明式/notes/截图继续运行                                                            |

同一次显式配置变更串行处理：开启enabled→web/notes；关闭先notes回滚→web撤销→enabled销毁。保存或strict应用失败时配置回退原值并恢复原模式；不直接用Config监听回调destroy所有窗。自动启动/owner恢复的普通同步允许notes迁移独立降级，显示migration warning并继续其他桌面层；不会修改用户持久偏好以掩盖错误。默认开启只允许已授权的插件恢复已有实例，不自动创建模板实例，也不替代native/Web的信任确认。

初始化顺序：app.ready前合并scheme注册 → profile/config/store读成功 → 创建DesktopLayer和WidgetHost/IPC注册 → manager初始化并读取有效插件清单/恢复事务 → NotesDataClient完成布局恢复与journal处理 → 注册consumer/owner → 完成启动器、托盘及快捷键首轮初始化 → 撤启动呈现栅栏，按flags和用户restore创建surface → ready/首帧/完整数据后show。栅栏只影响运行呈现，不改写持久偏好；避免插件维护期间启动便签迁移或提前消耗窗口5s就绪预算。shared窗口自行维持heartbeat，关闭backgroundThrottling使隐藏首帧可完成ready；Web壳和旧预览/拖动窗保留原调度。停机顺序：冻结新提交/动作与恢复timer → 取消手势/在途请求 → 复用manager保存确认（拒绝遵循现有退出流程）→ flush布局/notes投影 → 撤port/映射/订阅 → destroy层窗 → dispose。业务保存拒绝不能误记“已保存”，层不自行强杀。

降级只影响展示：声明式卡schema不合法→占位；Web安全校验不通过→该卡挂起；层熔断→托盘/主窗仍可用，便签按可逆回滚入口恢复旧路径。禁止以放宽CSP、allow-same-origin、远程fetch或关闭sandbox作为灰度补救。备份/恢复将desktop-layout和迁移journal纳入宿主布局域，插件dataDir按原数据域处理；恢复后不凭布局恢复旧信任。

## 15. 产品决定与待补发布证据

下表保留产品取值及仍需验证的边界；Q7默认值已由用户明确决定并实现，其他项按既有推荐保持。没有完成的实测出口继续记录为未完成，不能用默认值决定替代验收。其余接口、失败路径、数据边界按本文实施。

| #   | 事项                             | 当前决定/建议与影响                                                                                                                                            |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Q1  | 活动卡片配额与便签超额处理       | 每插件8/Web2，每屏20/Web4，全局64/Web8；已有便签超额不裁掉，保持旧notes路径并要求用户处理/批准上限                                                             |
| Q2  | 全屏时HUD是否例外可见            | 默认隐藏HUD，便签保留现有降层；若要例外需明确按屏和用户开关并重验，不自动当top组特权                                                                           |
| Q3  | 同hostname复用是否可作为性能选项 | 默认禁止；若未来只给可信卡开放，要用户接受共同卡死并按共享故障域恢复，不承诺固定进程收益                                                                       |
| Q4  | 宿主编辑器入口和交互细节         | 托盘/设置进入，宿主手柄、应用/取消、Esc取消；不加默认全局进入快捷键，不提供自由跨surface重叠                                                                   |
| Q5  | 第三方widget开放节奏             | 先官方/开发隔离样例，第三方显式信任摘要+数量/provider/actions提示；Web需独立开关，不隐式授权                                                                   |
| Q6  | host provider范围                | 首期仅host.clock；CPU/内存/网络/电池按后续明确授权扩充，路径/进程明细不作为通用免费provider                                                                    |
| Q7  | 默认开关与旧路径保留（已决定）   | 用户要求三开关默认true，新/缺失字段true、显式false保持；自动启动notes迁移失败保留旧路径并告警，显式设置仍rollback。旧notes路径至少保留一个发布版本，删除需另审 |
| Q8  | HUD排期                          | 接受层就绪前只有主页面/托盘，M1出口后在M3接声明式HUD；不为抢排期开发--widget                                                                                   |
| Q9  | 布局与移除                       | 普通卡自由摆放+8 DIP吸附、禁止跨surface重叠；便签保持三边队列；停用永久保留布局、卸载沿用户保留/删除选择                                                       |

尚需补齐的发布证据包括：正式独立Web壳的完整进程树/资源预算、跨native窗口边界的真实拖动、管理员窗口、真实游戏全屏/休眠/热拔及24h稳定性。受限Web桥/owner代次撤销、真实100/125/150%点透和窗口内捕获、便签journal恢复/最新布局反向投影已有本轮证据，按记录中的具体范围标记；受控全屏和注入显示合同也单独标明，不能替代未完成的真实场景。

## 17. 游戏栏式桌面插件栏（2026-11-01）

现有便签／胶囊、流量 HUD 和截图图钉新增统一操作层，参考 Windows 游戏栏：顶部工具栏、原界面上方的变暗背景和可自由拖动的独立面板。默认快捷键 `Ctrl+Alt+D`，在快捷键设置中可修改或清空；桌面设置和托盘菜单均有入口。

操作层使用独立布局并共享现有业务数据，呼出不永久改动 Windows 桌面位置。退出恢复原呈现；明确调整置顶和穿透时写回相应的原插件设置。Esc／背景退出、详情窗口焦点交接、按显示器记忆、锁屏和禁用释放均已接入。当前不提供任意 Web 小组件的双视图会话。

2026-11-03 起，插件栏与普通桌面共用插件内容组件、主题、字号、间距和当前尺寸；便签直接复用胶囊，流量复用原 HUD 及悬停模板。管理工具条放在插件外侧，仅在悬停或聚焦时显示。插件栏继续独立记忆位置，旧布局的独立尺寸不再覆盖插件本身尺寸。详见[样式统一验证](evidence/desktop-plugin-style-reuse-2026-11-03.md)。

窗口复用实现进一步保留原窗口、WebContents 和内容组件树：临时展开一个已有可信共享窗口承载遮罩与顶部工具栏，其余参与窗口提升到遮罩之上。内容不跨窗口搬移，收起面板只隐藏原节点；退出时恢复桌面几何、置顶、聚焦能力和鼠标穿透。没有可用可信窗口时才创建空态窗口，任意 Web 插件页面不承担管理宿主。

切换先隐藏原生窗口并重置裁剪，再等待对应版本的 React 布局提交确认后显示；过期确认不会解除新版本的等待，超时关闭插件栏并恢复桌面呈现。操作请求同时校验原有 surface 身份、递增序号和本次插件栏会话代次，参与窗口只能管理自己的卡片。拖动读取宿主的屏幕 DIP 坐标并移动原生窗口，松手才保存独立的插件栏位置。

上述复用代码已接入。用户随后要求关闭程序、暂停测试，因此最终交互验收仍待进行；早期[隔离原型测量](evidence/desktop-overlay-reuse-prototype-2026-11-03.md)的性能数据仅说明原型，不代表本次正式实现的最终验收结果。

类型、lint、完整构建、79 文件／327 测试及隔离真实 Electron 20 项交互检查已通过，包括通过真实系统键盘事件呼出后，再次按同一隔离快捷键关闭。最终报告为 `c9dfa9a2-cc23-42f4-8786-804a7266f867`。外部窗口的正向原生焦点恢复、物理鼠标手感和真实游戏全屏仍按未验证范围保留，不能由受控输入测试推定通过。详细实现和报告／截图链接见[游戏栏式插件栏记录](evidence/desktop-plugin-bar-2026-11-01.md)。

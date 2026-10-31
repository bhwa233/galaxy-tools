# 桌面窗口层（Desktop Layer）技术方案

> 状态：技术方案 v2（2026-10-31），**设计评审中，不含实现**。
> 变更：v1 为设计草案；v2 补齐模块划分、API、协议、改动清单、测试与验收口径，具备可直接拆任务的条件。
> 相关：[胶囊行为](edge-capsules.md)、[启动器架构](launcher-architecture.md)、[按进程流量插件技术方案](traffic-monitor-per-process-tech-design.md)。

---

## 1. 文档信息

| 项       | 内容                                                                  |
| -------- | --------------------------------------------------------------------- |
| 代号     | Desktop Layer（桌面窗口层）                                           |
| 类型     | 宿主平台能力（Electron 主进程 + 层渲染页 + 插件合同增量）             |
| 首期读者 | 宿主维护者、便签模块、插件作者代表                                    |
| 依赖     | Electron 45.1.0、现有胶囊模块、插件 manifest v1、能力代理             |
| 预估工期 | M0–M3 共 14–22 人日（详见 §12）                                       |
| 不在本期 | 原生渲染执行器（C#/D2D）、逐卡独立置顶、键盘输入型卡片、流量 HUD 迁入 |

### 1.1 一句话定义

**宿主按显示器维护少量「桌面层窗口」，层内每个桌面元素称为「卡片」；卡片由消费方（便签 / 插件 widget）注册，窗口、形状、层级、置顶、命中测试、持久化、崩溃恢复全部由宿主统一负责。**

---

## 2. 背景与问题

### 2.1 现状

| 能力            | 现状                                                              | 位置                                                                                      |
| --------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| 贴边便签胶囊    | 每 `(display, edge)` 一个 BrowserWindow，`setShape` 多矩形        | `apps/desktop/electron/capsules.ts:217-269`、`:360-375`                                   |
| 浮动便签胶囊    | 每便签一个 BrowserWindow（`focusable:false`、`alwaysOnTop:true`） | `capsules.ts:270-295`、`:315-339`                                                         |
| 悬停预览 / 拖拽 | 全局各一个窗口                                                    | `capsules.ts:432`、`:503`                                                                 |
| 插件窗口        | 每窗独立 session、`spark233-plugin` scheme、独立渲染进程          | `apps/desktop/electron/plugins/web-host.ts:470-600`                                       |
| 窗口置顶        | 按窗口 `layout.topmost` 持久化                                    | `apps/desktop/electron/host/desktop-windows.ts:212/398`、`host/plugin-window-state.ts:16` |
| 渲染器崩溃      | 仅上报                                                            | `capsules.ts:342-346`                                                                     |

### 2.2 问题

1. **成本线性**：每个常驻桌面元素 = 一个 60–100MB 的 Chromium 渲染进程；浮动便签、插件 HUD 都会叠加。
2. **能力割裂**：便签胶囊有完整的贴边/吸附/全屏避让/多屏记忆，插件窗口什么都没有；插件页甚至无法自行置顶（能力代理无窗口操作）。
3. **重复实现风险**：如果为插件桌面卡片再做一套摆窗/持久化逻辑，等于第二次实现胶囊。

### 2.3 目标

| 编号 | 目标                                                                     | 可验证              |
| ---- | ------------------------------------------------------------------------ | ------------------- |
| G1   | 每显示器常驻层渲染进程 ≤ 2，与卡片数量解耦                               | 任务管理器/进程统计 |
| G2   | 同一层同时承载宿主卡片（便签）与插件卡片（widget），交互与持久化规则一致 | 手工矩阵            |
| G3   | 插件卡片默认零能力（数据推送 + 白名单命令）                              | 安全用例            |
| G4   | 几何/形状/层级/置顶/多屏/DPI/全屏避让/吸附/持久化由宿主统一管理          | 代码评审            |
| G5   | 崩溃可恢复；单卡片异常不牵连整层                                         | 注入测试            |
| G6   | 便签行为逐项等价                                                         | 回归矩阵            |
| G7   | 未声明 `widgets` 的插件完全不受影响                                      | 兼容用例            |

### 2.4 非目标

- N1 不把任意插件页面塞进共享进程共享 DOM（信任边界不允许）。
- N2 不做原生渲染执行器，只预留 `kind:"declarative"` 的 schema。
- N3 不替代插件主窗（`presentation: standard|compact` 继续用于交互复杂的界面）。
- N4 不改托盘语义、不改快捷键、不改插件生命周期契约。
- N5 不支持卡片之间任意重叠/自由 z 序编辑，只支持分组级置顶 + 组内顺序。
- N6 不把流量 HUD（C# 分层窗）迁入层，仅保留迁移路径（§15 Q8）。

---

## 3. 设计决策清单（待签字）

> 每条给出**推荐值**；签字后进 §12 任务拆解。有异议直接改这一节。

| 编号 | 决策点       | 推荐值                                                                                                             | 理由 / 备选                                            |
| ---- | ------------ | ------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| D1   | 层归谁实现   | 宿主主进程模块 + 应用内层页面 `index.html?view=layer`                                                              | 备选「插件内实现」否：能力越权、无法跨插件共享         |
| D2   | 窗口数量     | 每显示 × 每置顶组 一个 BrowserWindow（≤2/屏）                                                                      | 备选「每卡一窗」回到现状成本；「每屏单组」无法分组置顶 |
| D3   | 形状裁剪     | `win.setShape(矩形并集)`，形状为空则 `hide()`                                                                      | `capsules.ts:360` 已验证；不裁剪会让透明窗拦截整屏点击 |
| D4   | 卡片同步     | 消费方 `snapshot()` 拉取全量，层做 diff                                                                            | 比逐条命令简单、可重放、天然幂等                       |
| D5   | 便签卡片渲染 | 宿主 React 组件直接渲染在层页面（可信代码，不 iframe）                                                             | 便签是内建插件，无第三方内容                           |
| D6   | 插件卡片渲染 | 每 widget 一个 `<iframe sandbox="allow-scripts">`，独立 `spark233-widget://` hostname                              | opaque origin 隔离；不给 `allow-same-origin`           |
| D7   | 插件数据来源 | 优先插件 backend/native 实例事件；次选宿主 provider；纯 Web 插件只能渲染静态/宿主数据                              | 避免 widget 直接持能力                                 |
| D8   | 命令权限     | widget 只能调用 manifest 声明且属于同插件非 internal 的命令；宿主按插件实例 owner 校验                             | 复用 `capabilities.ts:74-105` 的白名单思路             |
| D9   | 置顶粒度     | 卡片声明 `group: top                                                                                               | normal`，默认 normal；便签默认 top                     | 窗口级置顶是 Windows 现实约束 |
| D10  | 交互范围     | v1 无键盘输入（层窗 `focusable:false`）；`clickThrough` 卡片 `pointer-events:none`；`interactive` 卡片允许宿主代拖 | 输入类界面回插件主窗                                   |
| D11  | 持久化       | `desktop-layout.json`（v1，DIP 坐标）；屏幕不存在时收敛到主屏                                                      | 与 `plugin-window-state.ts:16` 并存、互不替代          |
| D12  | 迁移策略     | M0 抽层（便签为唯一 consumer，行为不变）→ M1 widget → M2 便签迁入 → M3 验收；过渡期保留 feature flag               | 降低回归风险                                           |
| D13  | 原生执行器   | 不实现，仅 schema 预留 `kind:"declarative"`                                                                        | 待卡片数量或内存压力触发                               |
| D14  | 流量 HUD     | 保持独立 C# 窗，不进层                                                                                             | 10–20MB < 层内额外成本，且不依赖主程序常驻             |

---

## 4. 总体架构

### 4.1 进程与模块

```
主进程
├─ desktop-layer.ts          DesktopLayer：消费方注册、卡片注册表、快照 diff、IPC
├─ layer-window.ts           每 display×group 的 BrowserWindow：形状、z 序、全屏避让、DPI、崩溃守护
├─ layer-layout-store.ts     卡片布局持久化（desktop-layout.json）
├─ plugins/widget-host.ts    widget scheme、iframe 会话、MessagePort 桥、命令路由、数据调度
├─ plugins/backend.ts        已有：backend 实例与 onEvent（backend.ts:38/179）
├─ plugins/native-runtime.ts 已有：原生事件 onEvent（native-runtime.ts:179-195）
└─ plugins/manager.ts        已有：命令路由与实例 owner 判定（manager.ts:1016-1046、1184-1218）

渲染进程（层页面 index.html?view=layer，preload=layer-preload.cts）
├─ DesktopLayerView           读快照，渲染宿主卡片（便签）与 iframe 容器
├─ NoteCard                   便签卡片组件（复用现有胶囊组件与样式）
└─ WidgetFrame                iframe 容器（sandbox、样式、pointer-events）

渲染进程（插件主窗，不变）  ← plugins/web-host.ts

(optional) 原生层执行器（未来）← 读取同一份 widget schema
```

### 4.2 数据流

1. 消费方（便签模块 / widget-host）向 `DesktopLayer` 注册 `LayerConsumer`。
2. `DesktopLayer` 周期/事件驱动调用 `consumer.snapshot()`，与内存中卡片表 diff。
3. diff 结果写入 `layer-layout-store`，并把渲染快照通过 IPC 推给对应层页面。
4. 层页面用快照渲染卡片；指针事件回到主进程做命中测试，再回调消费方 `onPointer()`。
5. widget 数据：`widget-host` 订阅插件实例事件 → 按 `refreshMs` 节流 → 经层页面转发到 iframe 的 MessagePort。

---

## 5. 详细设计：DesktopLayer

### 5.1 公开接口（主进程）

```ts
// apps/desktop/electron/desktop-layer.ts
export type LayerGroup = "top" | "normal";

export interface LayerCard {
  id: string; // 全局唯一，形如 "notes:<noteId>" / "plugin:<pluginId>:<widgetId>"
  consumerId: string;
  displayId: string; // display.id 字符串
  group: LayerGroup;
  bounds: Rect; // 屏幕 DIP 坐标
  order: number; // 同组内顺序，小在下
  visible: boolean;
  clickThrough?: boolean;
  interactive?: boolean;
  /** 仅内建消费方用：渲染时带上业务数据，插件卡片不读取（数据走 iframe 通道） */
  payload?: JsonValue;
}

export interface LayerConsumer {
  readonly id: string;
  snapshot(): LayerCard[];
  onCardsChanged?(cards: LayerCard[]): void; // 层确认布局/可见性变化后回调
  onPointer?(event: LayerPointerEvent): void;
  onDispose?(): void;
}

export interface LayerPointerEvent {
  cardId: string;
  type: "down" | "move" | "up" | "doubleclick" | "contextmenu";
  /** 相对卡片左上角的 DIP 坐标 */
  x: number;
  y: number;
  screenX: number;
  screenY: number;
  button?: "left" | "right" | "middle";
}

export class DesktopLayer {
  constructor(options: DesktopLayerOptions);
  register(consumer: LayerConsumer): () => void; // 返回解除注册函数
  refresh(consumerId?: string): void; // 触发 diff（也接受事件驱动）
  setHidden(hidden: boolean): void; // 全屏应用/锁屏时隐藏
  setEnabled(enabled: boolean): void; // feature flag 关时回落旧路径
  dispose(): Promise<void>;
}
```

约束：

- `snapshot()` 必须 O(卡片数) 且无副作用；层每秒最多 refresh 10 次（合并调用）。
- `payload` 只允许 JSON 子集，单卡片 ≤64KB；插件卡片的 `payload` 恒为空。
- 跨消费方 id 冲突视为注册失败并写诊断（`layer.card.duplicate`）。

### 5.2 层窗口创建参数（LayerWindow）

| 选项                                 | 值                                           | 理由                                            |
| ------------------------------------ | -------------------------------------------- | ----------------------------------------------- |
| `frame`                              | false                                        | 无边框                                          |
| `transparent`                        | true                                         | 卡片圆角/阴影外为透明                           |
| `resizable`                          | false                                        | 尺寸由 workArea 决定                            |
| `skipTaskbar`                        | true                                         | 不进任务栏                                      |
| `show`                               | false（首帧就绪后再 show）                   | 避免白闪                                        |
| `hasShadow`                          | false                                        | 形状自带阴影由渲染层画                          |
| `focusable`                          | false                                        | 不抢用户当前窗口焦点（D10）                     |
| `alwaysOnTop`                        | group==="top"                                | 组级置顶（D9）                                  |
| `backgroundColor`                    | "#00000000"                                  | 透明                                            |
| `webPreferences.preload`             | `layer-preload.cts`                          | 只暴露快照订阅/指针上报                         |
| `webPreferences.sandbox`             | true                                         | 与现有宿主窗口一致                              |
| `webPreferences.contextIsolation`    | true                                         | 同上                                            |
| `webPreferences.nodeIntegration`     | false                                        | 同上                                            |
| `webPreferences.additionalArguments` | `--spark233-label=layer:<group>:<displayId>` | 便于按标签测内存（复用 `capsules.ts:337` 手法） |

不进入 `createHostWindow`（`host/windows.ts:20-32`）：那条路径服务于 launcher/onboarding 等带焦点与阴影的窗口，语义不同，避免污染统一窗口工厂。

### 5.3 形状计算

```
shape(cardsOnDisplay) =
  for card in cards where visible and bounds.Size > 0:
    if card.clip: intersect(bounds, clip) else bounds
  → 去重合并（同一行/列可合并以减少 region rect 数）
  → 若为空: win.hide()；否则 win.showInactive() + win.setShape(rects)
```

- 坐标：屏幕 DIP → 层窗 client DIP（层窗 bounds 固定为 `display.workArea`，故差值为 workArea 原点）。
- 节流：多个 refresh 合并到下一个 16ms 帧；形状重算 ≤10 次/秒（拖动期间允许 60fps 但只重算一次）。
- `setShape` 在 Windows/Linux 有效，macOS 忽略（平台判断复用 `capsules.ts:360` 的写法）。
- 混合 DPI：监听 `display-metrics-changed`/`screen` 事件，重建窗口 bounds 与形状；`WM_DPICHANGED` 由 Electron 透传，无需原生。

### 5.4 命中测试与指针路由

```
onLayerPointer(viewX, viewY):
  card = topmost card in snapshot where contains(card, viewX, viewY)
  if card?.clickThrough: forward to window below (ignore)
  else dispatch pointer event with card-relative coords to consumer.onPointer
```

- 形状已裁掉卡片外区域，`setShape` 外点击天然穿透到下层应用。
- iframe 内部命中由 Chromium 处理，宿主收不到（这是预期：可交互 widget 自己处理交互；宿主只负责 `pointer-events` 与拖动代办）。
- 便签的拖动/吸附/预览沿用现有状态机（`capsules.ts:467-600`），只把「窗口坐标」换成「卡片坐标」，几何库继续用 `capsule-layout.ts`。

### 5.5 置顶分组

- 每屏最多两窗：`top`（alwaysOnTop）与 `normal`；同屏两种卡片都有时才建两窗。
- 卡片迁组 = 从 A 窗移除、加入 B 窗、重算两窗形状、持久化；无需重建渲染进程。
- 托盘/右键菜单入口由消费方提供（便签沿用现有菜单；widget 由 `widget-host` 提供「置顶/取消置顶/移除」三项宿主菜单）。

### 5.6 持久化（desktop-layout.json）

```json
{
  "version": 1,
  "cards": {
    "notes:<noteId>": {
      "displayId": "DISPLAY1",
      "x": 1840,
      "y": 120,
      "width": 220,
      "height": 32,
      "group": "top",
      "order": 3
    },
    "plugin:traffic:main": {
      "displayId": "DISPLAY1",
      "x": 1780,
      "y": 40,
      "width": 260,
      "height": 90,
      "group": "top",
      "order": 4
    }
  }
}
```

规则：

- 只存**布局覆盖**：消费方 snapshot 给的默认几何作为缺省，文件里的值优先；卡片消失后条目保留 30 天再清（便于插件重启用同一位置）。
- 屏幕数据 `displayId` 失效：迁移到主屏 `workArea` 右下角对齐，避免丢卡。
- 与 `plugin-window-state.ts:16` 并存：独立插件窗继续用它，层窗不读写它。
- 写入节流 2s，退出时强制落盘；写失败仅诊断不阻塞。

### 5.7 崩溃与恢复

| 场景                           | 处理                                                                                     |
| ------------------------------ | ---------------------------------------------------------------------------------------- |
| 层渲染器 `render-process-gone` | 记录诊断；销毁该 display 组窗；重建并重放快照；卡片顺序与数据由消费方提供，无需额外状态  |
| widget iframe 抛错/无响应      | `widget-host` 标记该卡片 `error`，显示占位并限流重试（1min 内最多 2 次）；不影响其他卡片 |
| 主进程退出                     | 层窗随应用退出；布局节流落盘已保证                                                       |
| 卡片消费方注销（插件停用）     | 立即移除卡片、更新形状、删持久化条目；对应 iframe 销毁                                   |

---

## 6. 详细设计：Widget Host

### 6.1 scheme 与 session

- 新增 scheme `spark233-widget`，与 `spark233-plugin` 一同在 **首次** protocol 注册时声明（`web-host.ts:46` 的 `registerSchemesAsPrivileged`，该函数要求 scheme 合并在第一次注册，否则抛错；主进程启动时把新 scheme 传进去）。
- 每个 widget 一个 hostname：`spark233-widget://<pluginId>.<widgetId>/`，path 解析复用 `isPluginPackagePath`/`confined`，限定插件包内 `widgets/` 目录；单文件 ≤32MB；MIME 白名单同 `web-host.ts:513`。
- 层窗使用独立 session（`session.fromPartition("spark233-layer", { cache:false })`）：
  - `protocol.handle("spark233-widget")` 只服务 `widgets/` 下资源；
  - `webRequest.onBeforeRequest`：**仅放行** `resourceType === "subFrame"` 且 hostname 在「已注册 widget 集合」内的请求，其余一律取消；
  - 权限请求/下载/权限检查一律拒绝（对齐 `web-host.ts:478-480`）。
- **不修改**插件主窗 session 的 subFrame 拒绝策略（避免扩大攻击面）。

### 6.2 iframe 与 CSP

- `<iframe sandbox="allow-scripts" src="spark233-widget://<pluginId>.<widgetId>/entry.html">`，不加 `allow-same-origin`（opaque origin）。
- 响应 CSP：`default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri 'none'`。
- 不注入 preload；SDK 以独立 JS 形式由 scheme 提供并允许 widget 页面 `<script src="/__spark233/widget.js">` 加载（同一 hostname，属 `'self'`）。
- 层页面侧对 iframe 容器设置 `border-radius`、`overflow:hidden`，`clickThrough` 时 `pointer-events:none`，`interactive` 时由容器处理拖动（转发给主进程 `DesktopLayer`）。

### 6.3 MessagePort 协议

宿主为每个 iframe 建 `MessageChannel`，通过 `postMessage(port, "*", [port])` 交付；**只信任该 port 上到达的消息**，端口与 cardId 绑定，跨卡片伪造无效。

| 方向 | type         | 字段                                                    | 说明                                      |
| ---- | ------------ | ------------------------------------------------------- | ----------------------------------------- |
| H→W  | `init`       | `widgetId, locale, theme, dpiScale, size{width,height}` | 首帧与 DPI/主题变更                       |
| H→W  | `data`       | `key, payload, at`                                      | 宿主推送（按 `refreshMs` 节流）           |
| H→W  | `visibility` | `visible`                                               | 层隐藏/切屏暂停渲染                       |
| H→W  | `size`       | `width, height, resizable`                              | 布局变更                                  |
| W→H  | `ready`      | —                                                       | 请求首批数据                              |
| W→H  | `resize`     | `width, height`                                         | 仅 `resizable:true` 接受，受 min/max 约束 |
| W→H  | `invoke`     | `requestId, commandId, input`                           | 白名单命令                                |
| W→H  | `open-main`  | `commandId?`                                            | 打开插件主窗（宿主决定激活哪个命令）      |
| W→H  | `diag`       | `level, message`                                        | 限流写诊断（1/min/卡片）                  |
| H→W  | `ack/error`  | `requestId, ok, value?, code?`                          | invoke 结果                               |

### 6.4 命令路由

1. widget 声明 `commands: string[]`，校验时必须同时满足：存在于同插件 `commands`、非 `internal`、且插件存在非窗口 owner（backend/native）或在层运行时允许冷激活。
2. 宿主收到 `invoke` → 校验卡片是否属于该插件实例 → `manager.activate(pluginId, {commandId, input})` 或 `manager.query(...)`（沿用 `manager.ts:1016-1046` 的 `dispatch/activate/query` 路径）。
3. 超时沿用插件能力代理的 10s 上限（`web-host.ts:440-443` 同款语义），超时返回 `widget.timeout`。
4. 禁止从 widget 直达 `capabilities.ts` 的 windows/tray/native/files 分支（桥不暴露这些通道，物理不可达）。

### 6.5 数据推送

- 安装/启用插件时 `widget-host` 为声明了 widget 的插件建立数据源订阅：
  - backend 实例：`BackendService` 现有 `onEvent`（`plugins/backend.ts:38/179`）目前是构造期单消费者，需要改为多路订阅（新增 `subscribe(pluginId, listener)`，或在 `desktop-host` 层做广播），**这是本方案唯一需要改动既有事件通道的地方**；
  - native 实例：`native-runtime.ts:179-195` 的 `onEvent` 同样需要广播给 widget-host；
  - 宿主 provider：注册表 `host:system-stats` 等，按需提供，widget 通过 `data.key` 订阅。
- 推送节流：每卡片按 `refreshMs`（默认 1000，最小 250）；层隐藏时暂停；payload 序列化后 ≤16KB/次，超限截断并诊断。

---

## 7. Manifest 与 SDK 增量

### 7.1 schema（`packages/sdk/src/manifest.ts`）

```ts
const widgetSizeSchema = z.strictObject({
  width: z.number().int().min(80).max(1200),
  height: z.number().int().min(32).max(900),
});

export const pluginWidgetSchema = z.strictObject({
  entry: packagePath
    .refine((v) => /^widgets\//.test(v), "Widget entry must live under widgets/")
    .refine((v) => /\.html$/i.test(v), "Widget entry must be an .html file"),
  title: label,
  translations: z
    .strictObject({
      "zh-CN": z.strictObject({ title: label }).optional(),
      "en-US": z.strictObject({ title: label }).optional(),
    })
    .optional(),
  kind: z.literal("web").default("web"), // 预留 "declarative"
  size: widgetSizeSchema,
  minSize: widgetSizeSchema.optional(),
  maxSize: widgetSizeSchema.optional(),
  resizable: z.boolean().default(false),
  group: z.enum(["top", "normal"]).default("normal"),
  clickThrough: z.boolean().default(false),
  interactive: z.boolean().default(true), // 允许宿主代拖
  commands: z.array(localId).max(8).default([]),
  refreshMs: z.number().int().min(250).max(60_000).default(1000),
});
```

插入位置：`pluginManifestSchema` 的 `ui` 内新增 `widgets: z.record(localId, pluginWidgetSchema).optional()`（与现有 `ui.windows` 同级，`manifest.ts:231-237`）。

### 7.2 superRefine 增加校验

- widget 的 `commands` 必须存在于 `manifest.commands` 且非 `internal`（否则 `"Widget command must be a public command of this plugin"`）；
- widget id 与 `ui.windows` 的 id 不冲突（命名空间分开，但诊断信息一致）；
- 声明 `widgets` 的插件必须至少具备 web entry、backend 或 native 之一（与现有 `:246` 规则保持一致）；
- 声明了 `widgets` 的插件，`dataVersion`/更新流程不需要特殊处理，但安装信任提示追加一行「桌面卡片数量」。

### 7.3 API 版本

- `HOST_API_VERSION` 从 `1.3.0` 升至 `1.4.0`；插件若使用 `ui.widgets`，`api` 范围需覆盖 `>=1.4.0`（按现有兼容检查逻辑生效）。
- `packages/sdk/README.md` 增加 widget 合同小节（字段表 + 最小示例 + 「无能力」说明）。

---

## 8. 渲染层（层页面）设计

- `apps/desktop/src/App.tsx` 增加 `view=layer` 路由（现有已有 `view=capsule`，`App.tsx:40-46`）。
- 层页面只做三件事：订阅快照、渲染宿主卡片、渲染 iframe 容器。**不直接读插件数据**。
- 便签卡片组件：优先复用现有 `CapsuleHost` 的子组件与样式；若耦合过深，抽出纯展示组件（不引入重复样式）。
- 主题：跟随 `nativeTheme`，快照里带 `theme`；DPI 变化通过 `webContents` 的 `zoom` 或 CSS 变量（不重建窗口）。
- 首帧：层窗 `show:false`，收到渲染器 `ready` 后 `showInactive()`，避免白闪。

---

## 9. 性能预算与测量

| 指标                 | 目标                       | 测量                                                       |
| -------------------- | -------------------------- | ---------------------------------------------------------- |
| 层渲染进程数         | 单屏 ≤2，且与卡片数无关    | `measure-app.ps1` 按 `--spark233-label=layer:` 分组        |
| 单屏新增 working set | ≤100MB（1–10 卡）          | 24h 采样，对比 feature flag 关闭基线                       |
| idle CPU             | 1 卡 ≤0.5% 单核；5 卡 ≤1%  | 性能计数器 10min                                           |
| 卡片增量成本         | 每卡 ≤2MB DOM/堆           | `webContents.executeJavaScript('performance.memory')` 采样 |
| 数据推送             | ≤16KB/卡/次，总 ≤50KB/s    | 桥计数                                                     |
| 形状更新             | ≤10 次/秒                  | 采样日志                                                   |
| 首帧                 | 层窗 <200ms；新卡 <100ms   | 时间戳打点                                                 |
| 24h 稳定性           | 增长 <10MB，无渲染进程泄漏 | 长挂测试                                                   |

> 按 `Docs/launcher-architecture.md` §13.2：以上为**预算值**，实测前不对外承诺。

---

## 10. 测试与验收（遵循仓库最小测试原则）

### 10.1 新增测试（只保护真实风险）

| 对象                                         | 测试类型               | 保护的风险         |
| -------------------------------------------- | ---------------------- | ------------------ |
| `shape` 计算（矩形并集/相交/去重/空集合）    | Vitest 纯函数单测      | 命中测试与闪烁回归 |
| 卡片 diff 与持久化收敛（屏幕失效/顺序/覆盖） | Vitest 纯函数单测      | 布局丢失           |
| widget 命令白名单校验（manifest 规则）       | 现有 manifest 测试扩展 | 越权调用           |
| widget 桥协议解析（非法消息/跨卡端口）       | Vitest 单测            | 信任边界           |

不加：窗口创建、iframe 样式、IPC 接线、Electron 自身行为等测试（无法保护数据/权限/生命周期真实风险）。

### 10.2 手工矩阵（Windows 真机）

- 便签：贴边 4 边、浮动、悬停预览、拖拽换边、双击展开；DPI 100/125/150；双屏；全屏应用（游戏/视频）；休眠唤醒。
- widget：1/3/5 卡数据刷新、点击穿透、置顶切换、插件停用即移除、重启恢复、崩溃恢复（`chrome://crashes` 或进程强杀）。
- 混合：同屏便签 + widget 交错摆放。

### 10.3 门禁

`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`、`pwsh -File scripts/smoke-windows.ps1`。测试数据与配置隔离在 `local-build/`（AGENTS.md 约定）。

---

## 11. 改动清单

| 类型 | 文件                                                                                                         | 内容                                                              |
| ---- | ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 新增 | `apps/desktop/electron/desktop-layer.ts`                                                                     | 消费方/卡片注册表、diff、IPC、feature flag                        |
| 新增 | `apps/desktop/electron/layer-window.ts`                                                                      | 每 display×group 窗口、形状、z 序、全屏避让、DPI、崩溃守护        |
| 新增 | `apps/desktop/electron/layer-layout-store.ts`                                                                | `desktop-layout.json` 读写/收敛/节流                              |
| 新增 | `apps/desktop/electron/layer-preload.cts`                                                                    | 快照订阅、指针上报、ready 通知                                    |
| 新增 | `apps/desktop/electron/plugins/widget-host.ts`                                                               | scheme、session、iframe 注册、MessagePort 桥、命令路由、数据调度  |
| 新增 | `apps/desktop/src/features/desktop-layer/*`                                                                  | 层页面、卡片、iframe 容器                                         |
| 新增 | `packages/sdk/src/widget.ts`                                                                                 | widget SDK shim 与类型                                            |
| 修改 | `apps/desktop/electron/main.ts`                                                                              | 注册 widget scheme（合并进首次注册）、实例化 DesktopLayer、接 IPC |
| 修改 | `apps/desktop/electron/capsules.ts`                                                                          | M0 抽层：窗口/shape/z 序迁出；M2 变为 consumer                    |
| 修改 | `apps/desktop/src/App.tsx`                                                                                   | `view=layer` 路由                                                 |
| 修改 | `packages/sdk/src/manifest.ts`                                                                               | `ui.widgets` schema + superRefine                                 |
| 修改 | `apps/desktop/electron/plugins/backend.ts`、`native-runtime.ts`                                              | `onEvent` 单消费者 → 多路订阅（广播）                             |
| 修改 | `packages/sdk/README.md`、`Docs/README.md`                                                                   | 合同文档与索引                                                    |
| 不改 | `plugins/web-host.ts`（除 scheme 传入）、`host/windows.ts`、`host/plugin-window-state.ts`、`capabilities.ts` | 保持既有语义                                                      |

---

## 12. 里程碑与任务拆解

### M0 抽取 DesktopLayer（4–5 人日，可独立交付）

1. 新建 `layer-window.ts` + `desktop-layer.ts`，把 `capsules.ts` 的 `surface()`（`:315`）、shape（`:360-375`）、`applyZOrder()`（`:630`）、`setFullscreen`（`:625`）、`dispose`（`:785`）搬过去；
2. Capsules 保留业务（fold/refresh/render/preview/drag 状态机），窗口操作改为调用层；
3. 行为不变，`capsules.ts` 对外接口不变；旧路径与层路径由 feature flag 切换（默认旧路径）；
4. 验收：typecheck/lint/build、smoke、手工胶囊矩阵；层路径开关打开后与关闭时行为一致。

### M1 widget 合同与层页面（5–7 人日）

1. `instance renderer` 页面 + 层页面 + iframe 容器；
2. widget scheme/session/CSP（含 `registerSchemesAsPrivileged` 合并）；
3. MessagePort 桥 + 命令路由 + 数据订阅广播（backend/native `onEvent` 多路化）；
4. manifest `ui.widgets` + superRefine + SDK shim + README；
5. 示例 widget（宿主 provider 数据：时钟/系统指标）打磨协议；
6. 验收：示例 widget 在层内 1/3/5 卡运行，安全用例通过。

### M2 便签迁入统一层（3–5 人日）

1. Capsules 改为 `LayerConsumer`，贴边队列计算保留；
2. 每屏一个组窗替代每 edge 一窗；预览/拖拽/双击/右键/多屏记忆回归；
3. 持久化合并到 `desktop-layout.json`（浮动便签坐标迁移）；
4. 验收：手工矩阵全绿，内存对比基线。

### M3 文档、示例与验收（2–3 人日）

1. `Docs/` 文档定稿 + SDK 文档；
2. 性能测量脚本（`local-build/spike/ps/`）+ 24h 长挂；
3. smoke 用例补充；feature flag 默认值评估。

---

## 13. 风险

| #   | 风险                                      | 影响         | 缓解                                                                       |
| --- | ----------------------------------------- | ------------ | -------------------------------------------------------------------------- |
| 1   | shape 命中在混合 DPI 下偏差               | 点不中/误点  | 统一 DIP 换算；M0 先做纯 shape 验证；实测 125/150%                         |
| 2   | 单渲染进程 = 单点故障                     | 全部卡片消失 | iframe 错误隔离 + 层重建 + 快照重放                                        |
| 3   | 便签 800 行状态机迁移回归                 | 桌面交互破坏 | M2 独立交付；feature flag 双轨；手工矩阵                                   |
| 4   | 放开 subFrame 扩大攻击面                  | 安全         | 只限 `spark233-widget` hostname、`widgets/` 目录、极简 CSP；插件窗策略不动 |
| 5   | iframe 内交互与宿主命中冲突               | 体验割裂     | `interactive`/`clickThrough` 声明 + 宿主代拖；复杂交互回主窗               |
| 6   | backend/native `onEvent` 改造影响现有插件 | 事件丢失     | 广播层先做兼容封装，现有单消费者行为不变，加回归用例                       |
| 7   | 两窗口分组置顶与用户预期不符              | 困惑         | 默认 top，右键可切，设置页说明                                             |
| 8   | 层常驻内存被当免费                        | 产品误判     | §9 明确 60–100MB 固定成本，收益在 ≥2 卡片                                  |

---

## 14. 兼容性与灰度

- feature flag：设置项 `desktopLayer.enabled`（默认关，M2 后再评估默认开）；关闭时便签走旧路径，widget 不可用（manifest 仍可声明，宿主给「宿主版本不支持」诊断）。
- 已安装插件不受影响；`ui.widgets` 为可选字段，旧 SDK 校验通过。
- 回滚：flag 关闭 + 保留旧 `capsules.ts` 路径一个版本；`desktop-layout.json` 与 `plugin-window-state.ts` 无耦合，回滚不丢数据。

---

## 15. 待评审问题

1. **便签是否同期迁移（M2）**？只做 widget 层可裁到 11–15 人日。推荐：M1 先交付，M2 视卡片数量排期。
2. **widget 是否需要键盘输入**？推荐 v1 否；需要则单开可聚焦交互窗（+2–3 人日）。
3. **置顶粒度**：接受「两组窗口」还是有逐卡独立置顶需求？
4. **数据源优先级**（backend/native 事件 → 宿主 provider → 不支持）是否认可？纯 Web 插件仅允许静态/宿主数据。
5. **是否本期做原生执行器**？推荐只留 schema。
6. **卡片默认排布**：自由摆放+吸附 vs 贴边队列？两种是否共存？
7. **是否对第三方插件开放 widget**？开放则改安装信任提示与审核文案。
8. **与流量插件的衔接**：HUD 保持 C# 独立（推荐）还是 M1 后迁为 widget？
9. **feature flag 默认值**：M2 验收后默认开，还是长期保持可选？
10. **是否允许 widget 读取宿主 provider 的哪些指标**（CPU/内存/网络/电池）？需要列白名单。

---

## 16. 附录 A：manifest 示例

```json
{
  "schemaVersion": 1,
  "id": "example.stats",
  "displayName": "系统指标卡片",
  "api": ">=1.4.0 <2.0.0",
  "host": ">=0.0.1",
  "platforms": ["win32"],
  "architectures": ["x64"],
  "activation": "on-startup",
  "capabilities": ["node.backend"],
  "backend": { "entry": "backend/index.js" },
  "ui": {
    "theme": ">=1.0.0",
    "widgets": {
      "cpu": {
        "entry": "widgets/cpu.html",
        "title": "CPU",
        "size": { "width": 180, "height": 72 },
        "group": "top",
        "refreshMs": 1000,
        "commands": ["snapshot"]
      }
    }
  },
  "commands": [{ "id": "snapshot", "title": "读取指标", "keywords": [] }]
}
```

## 17. 附录 B：widget SDK 类型

```ts
export interface WidgetInit {
  widgetId: string;
  locale: "zh-CN" | "en-US";
  theme: "light" | "dark";
  dpiScale: number;
  size: { width: number; height: number };
}

export interface WidgetApi {
  onInit(cb: (init: WidgetInit) => void): void;
  onData(cb: (key: string, payload: unknown) => void): void;
  onVisibility(cb: (visible: boolean) => void): void;
  onResize(cb: (size: { width: number; height: number }) => void): void;
  resize(size: { width: number; height: number }): Promise<void>;
  invoke<T = unknown>(commandId: string, input?: unknown): Promise<T>;
  openMain(commandId?: string): Promise<void>;
  reportError(message: string): void;
}
declare global {
  interface Window {
    spark233: { widget: WidgetApi };
  }
}
```

## 18. 附录 C：错误码

| 码                        | 场景                               |
| ------------------------- | ---------------------------------- |
| `layer.card.duplicate`    | 卡片 id 冲突                       |
| `layer.card.invalid`      | 几何非法/超出 workArea 且不可收敛  |
| `layer.consumer.disposed` | 消费方注销后仍有更新               |
| `widget.notDeclared`      | iframe 请求的 widget 不在 manifest |
| `widget.commandDenied`    | 命令不在白名单/非公开/无 owner     |
| `widget.timeout`          | invoke 超时（10s）                 |
| `widget.payloadTooLarge`  | 数据超过 16KB                      |
| `widget.protocolError`    | 桥消息不符合 schema                |

# 流量监控插件可行性评估（对比 TrafficMonitor）

日期：2026-10-31
状态：**评估，未实现**。本文只做可行性/难度/性能对比，不改产品代码。
评估对象：spark233（分支 `codex/spark233-refactor`，Windows 11 x64，Electron 45.1.0）
参考输入：用户提供的三张火绒安全流量监控截图（实时每进程上下行、历史按进程流量）、[zhongyang219/TrafficMonitor](https://github.com/zhongyang219/TrafficMonitor)

> 证据等级说明：仓库内结论均来自本仓库源码（给出 `文件:行`）；Windows 采集能力结论来自公开 API 文档 + 本机可执行的验证；TrafficMonitor 结论已按其 master 源码快照逐处核对（见 §7 与 `local-build/research/traffic-monitor-report.md` 的文件:行证据）；所有性能数字都是量级估算，按 `Docs/launcher-architecture.md` §13.2 必须在真机按完整进程树实测后才能对外承诺。
>
> 后续更新（2026-10-31）：用户选定"火绒同款"按进程方案，技术方案见 [traffic-monitor-per-process-tech-design.md](traffic-monitor-per-process-tech-design.md)；悬浮窗已定案为 C# 原生分层窗（见该文 §8.1/§8.2），本文中 Electron 悬浮窗的内存数字仅用于方案对照，不代表最终形态。

## 0. 结论摘要

| 问题                                     | 结论                                                                                                                                                                                                                                                               |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 放在 spark233 里做插件，工程量多大？     | **v1（网卡级实时 + 悬浮窗 + 历史）约 12–14 人日**，熟悉仓库的 1 人约 3 周；不需要改内核、不需要 MSVC。                                                                                                                                                             |
| 能不能做成火绒截图那种"按进程实时网速"？ | **能，但必须提权**。Windows 上不存在"免提权 + 纯用户态 + 按进程实时字节"的方案；唯一实时数据源是 ETW `Microsoft-Windows-Kernel-Network`（需管理员）。按进程版另需 **16–22 人日** + 代码签名/服务安装运维。                                                         |
| 性能如何？                               | 网卡级 1s 采样侧车开销可忽略（估算 CPU <0.1% 单核、内存 ≤2 MB）；真正成本是**常开悬浮窗的 Electron 渲染进程**（估算 +60~120 MB working set）。ETW 按进程：空闲 <0.1%，1 Gbps 约 1–3%，10 Gbps 约 10–25%。                                                          |
| 和 TrafficMonitor 比？                   | 定位不同：TM 是 C++/MFC 原生常驻工具，**只做网卡级**统计（源码全仓无 ETW/驱动/IP Helper 表调用），"按进程"在 TM 里是 Issue 里长期未实现的请求；我们是 Electron 插件，**无法贴任务栏、常驻内存高**，但能补上 TM 缺的按进程与更细历史。**不建议把"复刻 TM"当目标**。 |
| 现在能直接用的宿主能力                   | on-startup 无窗后台激活、utilityProcess 后端、原生侧车 JSON-line 协议（`init` 直接下发 `dataDir`）、事件推送、`node:sqlite`、插件窗无边框透明。                                                                                                                    |
| 现在缺的宿主能力                         | ① 插件页不能设置置顶（能力代理没有窗口操作）② 没有"开机自动打开悬浮窗"声明 ③ 任务栏嵌入不可行 ④ Windows 托盘无法常显数字。                                                                                                                                         |

一句话判断：**v1 值得做，按进程版要先回答"是否接受管理员/服务"这个问题，限速版不做。**

## 1. 需求拆解（来自截图）

| 截图 | 能力                                               | 本期是否需要                   |
| ---- | -------------------------------------------------- | ------------------------------ |
| 图 1 | 悬浮/托盘区域实时显示总上行下行                    | 需要                           |
| 图 1 | 按进程实时上下行（node.exe / chrome.exe / System） | 需要，但是分水岭（见 §2、§6）  |
| 图 2 | 按进程连接数 + 限速入口                            | 连接数可做（免提权），限速不做 |
| 图 3 | 按进程历史流量（日/月）                            | 需要，用本地历史库             |
| 隐含 | 常驻、开机自启、低占用、不挡操作                   | 需要                           |

## 2. Windows 采集能力矩阵

| 方案                                                              | 粒度                         | 实时性                  | 需管理员    | UDP/QUIC                                              | 结论                                                                  |
| ----------------------------------------------------------------- | ---------------------------- | ----------------------- | ----------- | ----------------------------------------------------- | --------------------------------------------------------------------- |
| `GetIfTable2`（`MIB_IF_ROW2` 64 位 `InOctets/OutOctets`）累计差分 | 网卡（可含 VPN 虚拟网卡）    | 1s 差分                 | **否**      | 含（在网卡层）                                        | **v1 主路线**（TM 用的是 32 位 `GetIfTable`，4 GiB 会回绕，不要照抄） |
| `GetExtendedTcpTable(OWNER_PID)`                                  | 连接 → PID 拓扑              | 轮询                    | **否**      | TCP only                                              | 做"每进程连接数"，不做速率                                            |
| `GetPerTcpConnectionEStats`                                       | 单 TCP 连接字节              | 需先逐连接 enable       | **是**      | **无 UDP 版本**（`GetPerUdpConnectionEStats` 不存在） | 不做主路，短连接漏计严重                                              |
| ETW `Microsoft-Windows-Kernel-Network`                            | 按 PID 字节（事件 ID 10–17） | 事件驱动，真实时        | **是**      | 含 UDP                                                | **按进程版唯一实时路**                                                |
| SRUM / `SRUDB.dat`                                                | 按应用累计                   | 小时桶、延迟 30–60 分钟 | 读需 SYSTEM | 含                                                    | 只适合"日/月流量"，不能做 1s                                          |
| WFP callout / NDIS 过滤驱动                                       | 最高精度 + 可限速            | 实时                    | 驱动        | 含                                                    | **不做**：EV 签名、蓝屏责任、Secure Boot 装机                         |
| Npcap / WinDivert                                                 | 包级、无 PID                 | 实时                    | 驱动        | 含                                                    | 不做（授权/无 PID/性能）                                              |
| Sysmon EID 3                                                      | 连接事件，**无字节数**       | 实时                    | 是          | 含                                                    | 不可用                                                                |
| `Process(*)\IO Data Bytes/sec`                                    | 进程 IO，混磁盘              | —                       | 否          | 不可拆                                                | **不能当网速用**                                                      |

本机可验证的事实（2026-10-31，非提权账户）：

- PDH 计数器 `\Network Interface(*)\Bytes Received/sec`、`\Bytes Sent/sec` 在当前用户下可直接读，实测读到 17.3 MB/s 下载、59 KB/s 上传，与截图量级一致 → **总速免提权这条路在本机成立**。
- 想验证"ETW 内核会话需要管理员"时，`logman` 被本会话沙箱拒绝执行，没能实测；该结论依据 API 文档与"`resmon.exe` 网络页必须管理员启动"这一公开事实，落地前应真机复核。
- PDH 计数器名随系统语言本地化（中文 Windows 是中文名），**不建议**用 PDH 字符串路径；侧车应直接 P/Invoke `GetIfTable2`，避免语言/区域差异。

## 3. spark233 侧：可复用能力与缺口

| 能力                   | 现状                                                                       | 位置                                                                                                                                             | 缺口                                                                                                                                                          |
| ---------------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 插件生命周期           | `on-startup` 后台激活，明确不显示窗口                                      | `apps/desktop/electron/plugins/desktop-host.ts:386`；`packages/sdk/src/manifest.ts:219`                                                          | —                                                                                                                                                             |
| 后台 Node 进程         | utilityProcess 可信后端                                                    | `apps/desktop/electron/plugins/backend.ts`                                                                                                       | —                                                                                                                                                             |
| 原生侧车               | stdin/stdout JSON-line v1，`init` 下发 `dataDir`/`cacheDir`                | `Docs/native-plugin-protocol.md`；`apps/desktop/electron/plugins/native-runtime.ts`                                                              | —                                                                                                                                                             |
| 原生事件推送           | native `event` → 插件页 `listen`                                           | `native-runtime.ts:179-195`                                                                                                                      | 事件只归属在途请求，长订阅要续期；1s 轮询更简单                                                                                                               |
| 历史存储               | `node:sqlite` 已在用（剪贴板历史、词典）                                   | `apps/desktop/electron/plugins/official/clipboard-history.ts:4`；`packages/official/translation/dictionary.mjs:1`                                | 零依赖可用                                                                                                                                                    |
| 无边框透明窗           | `transparent: label !== "launcher"`，插件窗 label 为 `plugin:*`            | `apps/desktop/electron/host/windows.ts:20-32`                                                                                                    | 插件页需自行画 UI                                                                                                                                             |
| 窗口置顶               | 宿主 IPC 已支持 `alwaysOnTop` 读写，且插件窗 topmost 已持久化              | `apps/desktop/electron/ipc/window-commands.ts:107-113`；`apps/desktop/electron/host/plugin-window-state.ts:16`；`desktop-windows.ts:249,254,398` | **能力代理未暴露**：`capabilities.ts` 只有 tray/native/clipboard/notifications/shortcuts/files/network/commands，没有窗口操作 → 需新增（约 1–1.5 人日含测试） |
| 开机自动开悬浮窗       | `on-startup` 激活不得显示窗口，插件也不能自己开窗                          | `desktop-host.ts:386`；`packages/sdk/src/manifest.ts:235`                                                                                        | 需新增窗口声明（如 `autoOpen`）或"恢复上次插件窗口"（约 0.5–1 人日）                                                                                          |
| 托盘                   | 宿主单例 TrayController，仅 tooltip + 菜单；Windows 不支持 `Tray.setTitle` | `apps/desktop/electron/host/tray.ts`                                                                                                             | 不能像 TM 那样在托盘常显数字                                                                                                                                  |
| 任务栏嵌入             | 无                                                                         | —                                                                                                                                                | `SetParent` 到 `Shell_TrayWnd` 等非公开结构，Explorer 重启/多屏/DPI 都脆弱，**不做**                                                                          |
| 免 MSVC 的 C# 侧车范式 | 系统自带 `csc.exe` 运行时编译 C#，按源码 SHA-256 缓存                      | `apps/desktop/electron/windows-runtime.ts:34-60`；`Docs/edge-capsules.md:32-36`                                                                  | 现成可套用                                                                                                                                                    |
| 官方插件打包           | 固定 7 个 id；原生 payload 只允许 5 个根                                   | `scripts/build-official-plugins.mjs:58-62`；`scripts/native-payloads.mjs:19-27`                                                                  | 新插件要同步这两处 + electron-builder 预装清单（约 0.5 人日）                                                                                                 |

本机工具链现状：PATH 无 `cl`/`cmake`/`ninja`/`cargo`/`rustc`；有 dotnet SDK 9.0.320 和系统 `csc.exe`；`%LOCALAPPDATA%/spark233/toolchains` 只有 pnpm。**结论：v1 用 C# 侧车（csc 运行时编译）最快落地；C++（ETW，参考 krabsetw）留给需要 CI 的 v2。**

## 4. 推荐架构（v1，免提权）

```
GetIfTable2 (1s) ──> C# 侧车（系统 csc 编译，按源码 hash 缓存）
                     ├─ 环形缓冲：每秒每网卡 rx/tx 字节
                     ├─ 分钟桶聚合 ──> <pluginDataDir>/history.jsonl（自带轮转/保留）
                     └─ 协议：init/query/prepareStop/stop（JSON-line v1）
                                │
宿主 native-runtime（已声明的 native 入口，启动时显式原生信任）
                                │ 1Hz capability.invoke（快照 <2 KB）
插件页（无边框透明窗，透明 + 置顶）
  ├─ 悬浮小窗：canvas 绘制数字/迷你曲线，-webkit-app-region 拖拽
  ├─ 主窗口：实时曲线 + 网卡/连接表 + 历史查询（读侧车聚合结果）
  └─ 设置：采样间隔、显示项、历史保留
```

设计取舍：

- **不给侧车上引擎太重的东西**：每秒差分 + 分钟桶足够，历史查询由侧车返回聚合结果，避免把原始 1s 序列写库。
- **不逐事件 IPC**：每秒一条快照；ETW 版也一样（侧车内部聚合，1s 一行）。
- **不用 PDH 字符串**：直接 `GetIfTable2`，避免中文系统计数器名。
- **前端每秒重绘要控**：悬浮窗用 canvas/直接写 DOM，不要每秒整棵 React 重渲染。
- **历史库二选一**：① 侧车写 JSONL（零依赖，C# 好写）② 插件后端写 `node:sqlite`（查询强）。v1 建议 ①，v2 有按进程需求时再上 sqlite。

## 5. 工作量估算（人日，单人、熟悉本仓库）

### v1：网卡级实时 + 悬浮窗 + 主窗 + 历史

| 工作项                                                                               | 人日      | 说明                                                                          |
| ------------------------------------------------------------------------------------ | --------- | ----------------------------------------------------------------------------- |
| 宿主：能力代理暴露窗口操作（置顶/取位置/改位置）+ 校验 + 文档                        | 1.5       | `capabilities.ts` 增 `windows` 操作，接到 `desktop-windows` 现有 topmost 分支 |
| 宿主：开机自动打开悬浮窗（`autoOpen` 声明或恢复上次窗口）                            | 0.5–1     | 二选一，改动小但要过 `presentation-contract` 类聚焦测试                       |
| 插件工程接入（manifest/命令/i18n/构建脚本/expectedIds/native-payloads/builder 预装） | 1         | 机械但必须一次到位，否则打包缺件                                              |
| C# 侧车：`GetIfTable2` 采样、差分、环形缓冲、分钟桶落盘、协议实现、取消与优雅退出    | 3         | 复用 `windows-runtime.ts` 的 csc 编译缓存范式                                 |
| 悬浮窗前端（透明无边框、拖拽、右键菜单、DPI/多屏、全屏避让参考胶囊）                 | 2.5       | 全屏避让可参考 `capsules.ts`/`Docs/edge-capsules.md`                          |
| 主窗口（实时曲线 + 网卡表 + 历史视图）                                               | 2.5       | —                                                                             |
| 设置项 + 启停/托盘菜单入口                                                           | 1         | —                                                                             |
| 验收实测（完整进程树 CPU/内存、多屏、Explorer 重启、打包冒烟）                       | 2         | 按 §13.2 出真实数字                                                           |
| **合计**                                                                             | **12–14** | 可拆成 2 个可交付里程碑（先跑通"侧车+悬浮窗"，再补历史与设置）                |

### v2：按进程（管理员）与限速

| 工作项                                                                            | 人日           | 说明                                           |
| --------------------------------------------------------------------------------- | -------------- | ---------------------------------------------- |
| 提权形态 POC（LocalSystem 服务 + 命名管道 / 计划任务 / 管理员启动）               | 3–4            | 决定产品体验与安装包结构                       |
| ETW 消费者（C++ krabsetw 或 C# raw ETW P/Invoke），按 (PID, 进程创建时间) 聚合    | 5–8            | 全局只允许一个内核 ETW 会话，需冲突降级        |
| 进程归并去重（PID 复用、System/Idle、Chromium 多进程合并、VPN/环回/代理重复计数） | 3              | 数据可信度的关键                               |
| 按进程 UI + 历史                                                                  | 2              | —                                              |
| 验收 + 签名/安装卸载/EDR 白名单沟通                                               | 3（+外部流程） | 证书与审核周期另计                             |
| **合计**                                                                          | **16–22**      | 未含证书采购、代码签名审核、卸载清理的运维成本 |

折中方案（`GetPerTcpConnectionEStats`）约 8–10 人日，但**没有 UDP/QUIC、短连接漏计、仍需管理员**，不建议当卖点。

限速：需要 WFP/NDIS 内核驱动（EV 签名 + 蓝屏责任 + Secure Boot 装机限制），**明确不做**。

## 6. 性能预期（估算，须真机实测）

| 场景               | 估算                                                | 备注                                                                          |
| ------------------ | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| 网卡级 1s 差分侧车 | CPU <0.1% 单核，RSS ≤2 MB                           | 网卡计数一次系统调用，几乎无成本                                              |
| 1Hz JSON 往返      | <2 KB/次，带宽/CPU 可忽略                           | 瓶颈在前端每秒重绘                                                            |
| 常开悬浮窗         | **+60~120 MB working set**（Electron 渲染进程）     | 本方案最大成本；TM 是原生进程，RSS 显著更低（本次未实测其 RSS，不作数字承诺） |
| ETW 按进程         | 空闲 <0.1%，1 Gbps 1–3%，10 Gbps 10–25%，内存 <2 MB | 事件驱动、无包拷贝                                                            |
| 历史库             | 1 分钟桶 × 90 天 ≈ 数十 MB 以内                     | 需实测                                                                        |

**注意**：Electron 应用本身的常驻内存（宿主 + 渲染）加上去，会明显高于 TrafficMonitor；这是形态决定的，不是实现问题。悬浮窗应复用同一个渲染进程或做极简画布页，别每个窗口一个重页面。

## 7. 与 TrafficMonitor 对比

以下 TM 侧事实来自 master 源码快照核验（`local-build/research/traffic-monitor-report.md`，行号对应 2026-10-31 快照）：

- **只做网卡级**：统计核心是 `GetIfTable`（遗留 API）+ `MIB_IFROW.dwInOctets/dwOutOctets` 32 位累计字节差分（`TrafficMonitorDlg.cpp:396-415,1206-1246`）；全仓 grep `StartTrace/OpenTrace/GetExtendedTcpTable/GetProcessIoCounters` 等 **0 命中**，无 ETW、无驱动、无 IP Helper 连接表。
- **没有按进程能力**：Issue #269/#1196/#540/#1779/#2366 长期请求未实现，官方口径是"用插件"，社区插件如 ProcessNetMonitor 自行采集。
- **已知缺陷**：32 位计数 4 GiB 回绕（回绕周期速度置 0）、多接口求和重复计数（VPN/TUN/Hyper-V，判重代码被注释）、今日流量 `+= bytes/sec` 未乘采样周期（非 1000ms 周期有系统偏差）、未声明 DPI 感知。
- **任务栏窗口是 Hack**：`SetParent(Shell_TrayWnd/ReBarWindow32/TrayNotifyWnd)` 寄生 + 压缩最小化按钮区，未用 `SHAppBarMessage`；Win11 更新后易错位，官方 FAQ 明确"不要反馈此问题"。
- **"连接详情"窗口名不副实**：`NetworkInfoDlg.cpp:23-137` 只用 `MIB_IFROW` 显示网卡属性（链路速率/MAC/IP/网关/累计字节），没有 TCP/UDP 连接列表、没有 PID；不需要管理员（标准版要 admin 只为温度传感器）。
- **其它现状**：CPU 走 PDH `% Processor Utility`（回退 `GetSystemTimes` 差分），内存 `GlobalMemoryStatusEx`；皮肤是 `skins/<name>/skin.ini` + PNG 的声明式配置；开机自启走 Task Scheduler COM（非 Run 键）；**无全局热键**；更新只拉 `version_utf8.info` 并跳浏览器，无签名校验无静默升级。
- **体积/依赖**：Lite x64 zip 1.02 MB，exe 1.83 MB，包内 0 个 DLL，但 `UseOfMfc=Dynamic` → 依赖系统 VC++/MFC 运行库；标准版 `RequireAdministrator`（读温度），Lite 版 asInvoker。
- **许可**：自定义 "Anti 996" License v1.0（非 OSI），复用代码前必须先审条款（本方案不复制其代码）。

| 维度       | TrafficMonitor                                          | 本插件方案                                                     |
| ---------- | ------------------------------------------------------- | -------------------------------------------------------------- |
| 形态       | C++/MFC 原生常驻，exe 1.83 MB + 皮肤/语言资源           | Electron 插件，复用宿主                                        |
| 显示       | 桌面悬浮窗 + **任务栏窗口**（SetParent 寄生）+ XML 皮肤 | 桌面悬浮窗（置顶）；**不能贴任务栏**；无皮肤生态，跟随应用主题 |
| 总速数据源 | `GetIfTable` 32 位累计差分（4 GiB 回绕）                | `GetIfTable2` 64 位 `InOctets/OutOctets`（无回绕）             |
| 按进程     | **不支持**（Issue 长期请求，靠第三方插件）              | 火绒截图那种按进程 = v2，必须管理员                            |
| 连接详情   | 只有网卡属性页，无 TCP/UDP 表、无 PID                   | 可做每进程连接数（`GetExtendedTcpTable`，免提权）              |
| 历史       | 按天、整数 KB 文本文件，有采样周期偏差与写盘抖动 Issue  | 分钟桶 + 可查询历史（更细，落盘节流）                          |
| 内存/体积  | 原生轻量（exe 1.83 MB；RSS 未在本机实测）               | 大（Electron 基线 + 一个渲染进程，估算 +60~120 MB）            |
| 分发       | 直接下 zip；更新只跳浏览器、无签名校验                  | 插件市场/npm 包，原生信任弹窗 + 更新链路                       |
| 开发成本   | 多年积累                                                | v1 约 3 周（复用宿主）                                         |
| 适合场景   | 想替代任务栏系统监控工具                                | 已经在用 spark233，希望顺手看网速/留历史/后续接告警            |

结论：**不要按"复刻 TM"立项**。按 TM 的形态比，我们必输在体积、内存和任务栏嵌入（且那是它的 Hack 层）；按"启动器生态里的网络状态面板"比，插件化 + 更细历史 + 未来的按进程能力，是 TM 明确没有的。反过来，**做按进程时 TM 源码没有可借鉴实现**，属于我们要自研的部分。

## 8. 风险清单

| #   | 风险                                                                                         | 影响                          | 缓解                                                           |
| --- | -------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------- |
| 1   | 按进程必须提权（服务/UAC/计划任务）                                                          | 体验断崖、安装包复杂化        | v1 免提权先上线；v2 单独立项，先 POC 服务 + 命名管道           |
| 2   | 内核 ETW 会话全局唯一，与 WPR/Process Monitor/其他网速工具冲突（`ERROR_ALREADY_EXISTS` 183） | 起不来或数据缺失              | 启动失败降级为网卡级 + 明确提示                                |
| 3   | 慢消费者丢事件（只看 `EventsLost`）                                                          | 统计偏低且静默                | 聚合循环无分配、无日志；定期读丢失计数                         |
| 4   | PID 复用 / 系统进程 / Chromium 多进程                                                        | 归属错误                      | 用 (PID, 创建时间) 聚合；按映像路径归并；映射不到归"系统/未知" |
| 5   | 重复计数（VPN/代理/环回）                                                                    | 总量虚高、排行榜失真          | 默认排除环回；用网卡总数对账；代理流量单独标注                 |
| 6   | EStats 无 UDP、QUIC 统计不到                                                                 | 数据不完整                    | 不用 EStats 做主路                                             |
| 7   | 任务栏嵌入                                                                                   | Explorer 重启、多屏、DPI 脆弱 | 不做；用悬浮窗 + 托盘菜单                                      |
| 8   | 常驻服务 + 全网流量是 EDR 最敏感组合                                                         | 被安全软件拦、需要签名/白名单 | 提前规划签名；v2 前与用户确认                                  |
| 9   | Electron 常驻内存/功耗                                                                       | 用户抱怨                      | 悬浮窗极简页、采样间隔可调、可只开托盘模式                     |
| 10  | 原生信任与更新流程                                                                           | 首次安装多一次确认、升级失败  | 复用现有 native 信任弹窗与官方插件打包链路                     |
| 11  | 本沙箱无法做 ETW/驱动实测                                                                    | 评估数字可能偏                | 真机按 §13.2 实测后更新本文                                    |
| 12  | 中文系统 PDH 计数器名                                                                        | 读数失败                      | 用 `GetIfTable2` 而非 PDH 字符串                               |

## 9. 需要用户确认的问题

1. **是否必须"按进程"**（火绒截图那种）？接受以管理员/后台服务形式运行吗？还是 v1 先只做总速 + 历史？
2. **显示形态**：桌面悬浮窗优先？要不要贴任务栏（不建议）？还是只放启动器/托盘 tooltip？
3. **是否需要限速**？（需要内核驱动，基本不做；若要，只能对接第三方驱动或明确放弃）
4. **历史保留**：粒度（建议 1 分钟桶）与时长（建议 90 天）？
5. **分发方式**：随官方插件预装（需扩 `expectedIds`/原生 payload 清单）还是走插件市场？

## 10. 建议下一步

1. **1–2 天 spike**：C# 侧车 `GetIfTable2` 1s 采样 + 一个最小悬浮窗，验证观感与真实内存/CPU（这是唯一能快速否掉方案的点）。
2. spike 通过后补宿主两处能力（置顶、开机自动打开），按门禁跑 `pnpm typecheck/lint/test/build`，并用 `scripts/smoke-windows.ps1` 做一次真实链路冒烟。
3. 按进程功能单独立项：先做提权形态 POC，再决定 ETW（C++/CI）还是放弃。

## 参考

- [zhongyang219/TrafficMonitor](https://github.com/zhongyang219/TrafficMonitor)（源码快照已核对，见 `local-build/research/traffic-monitor-report.md`）
- [TrafficMonitor Core Architecture（DeepWiki）](https://deepwiki.com/zhongyang219/TrafficMonitor/2-core-architecture)
- [deYangar/ProcessNetMonitor](https://github.com/deYangar/ProcessNetMonitor)（第三方"按进程网速"工具，可作为数据可信度的对照）
- [GetIfTable2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/nf-netioapi-getiftable2)、[GetExtendedTcpTable](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable)、[GetPerTcpConnectionEStats](https://learn.microsoft.com/en-us/windows/win32/api/tcpestats/nf-tcpestats-getpertcpconnectionestats)
- 本仓库：`Docs/native-plugin-protocol.md`、`Docs/edge-capsules.md`、`Docs/launcher-architecture.md` §4.3/§4.4/§6.5/§13.2

> 环境限制：本次评估所在会话只有 `web_search` 可用（`web_fetch` 不可用、域名解析到非公网地址），因此外部链接未逐页复核；`logman`（ETW 验证）被会话沙箱拒绝执行。文中的 Windows 能力结论建议在真机上用 10 分钟复核一次再进入开发。

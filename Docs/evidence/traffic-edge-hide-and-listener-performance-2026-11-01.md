# 网速悬浮窗贴边动画、宽度与监听性能验证

日期：2026-11-01。

## 实现

- 共享 WidgetHost 为贴边收起和展开增加约 180 ms cubic ease-out 位移动画。宿主每帧同时更新原生 shape 与 renderer geometry，隐藏后保留 4 DIP 唤回条。
- 所有卡片共用一个仅在动画期间存在的 16 ms 调度器。反向动画从实际呈现位置继续；开始拖动、取消、锁屏、卸载和销毁会清理临时动画。遵循系统减少动态效果设置。
- 网速 HUD 固定宽度由 140 缩为 120 DIP，排行浮层由 300 缩为 260 DIP，速率前的间距由 8 缩为 4 DIP。保留固定宽度以避免速率变化时卡片边界跳动。
- 固定尺寸迁移保留原有右侧／底侧贴边位置、输入模式和鼠标穿透设置；重复 reconcile 不产生额外布局 revision。

## 功能验证

复用生产 WidgetHost、DesktopLayer、LayerWindow、preload 与 renderer，在 `local-build/edge-hide-perf/` 下运行隔离 Electron fixture，没有读写真实便签或剪贴板数据。

- 动画集成 27 项通过。滑出位置经过 `0 → -36 → -75 → -89 → -105 → -113 → -115 → -116` DIP，原生 shape 同步收窄至 4 DIP，生产 renderer 的 rAF 记录确认了中间呈现位置。
- 覆盖滑入／滑出、中途反向、展开时按下拖动、cancel、锁屏、减少动态效果及插件 quiesce/drop。动画交互阶段仅一个共享窗口，布局提交 0 次，renderer 错误和 diagnostics 均为 0。
- 固定宽度迁移 6 项通过。负坐标副屏旧右下贴边 `(-140,788,140,72)` 变为 `(-120,808,120,52)`，右侧和底侧间距仍为 0，passive 偏好保留，revision 为 `1 → 2 → 2`。
- 真实 DeclarativeCard、应用字体和 CSS 的隔离 Chromium 检查确认，120 DIP 能容纳 `1024.0 MiB/s`，文字无截断，行内右侧余量约 8.5 DIP；112 DIP 仅剩约 0.5 DIP，因此采用 120。

报告：

- `local-build/edge-hide-perf/runs/edge-hide-current-20261101-final/report.json`
- `local-build/edge-hide-perf/runs/fixed-width-migration-20261101-final/report.json`
- `local-build/edge-hide-perf/hud-width-check.json`

这些动画 fixture 使用合成 cursor 与真实 preload 请求，未测量输入到显示器出光的延迟。名义动画时长为 180 ms，实际呈现受机器负载影响；fixture 的总运行时间包含额外等待，不能当作动画本身的耗时。

## 工程检查

- 完整 `pnpm build` 通过，9 个官方插件成功构建。
- `pnpm lint` 通过，保留其他已有 warning。
- 4 个相关 Node 测试文件共 28 项通过：layer-layout-store、capsule-layout、capabilities-context、official/capture。
- 最后的贴边尺寸迁移修正后，Electron TypeScript 编译、文件 lint 和 `git diff --check` 再次通过。
- 日志位于 `local-build/edge-hide-perf/{build,lint,tests}.log`。

本轮未重跑全套测试。前一轮翻译历史测试存在 Windows 原子 rename `EPERM`，与本轮文件无关；不能据此宣称全套测试全部通过。

## 当前运行项目的实时性能

Windows、16 个逻辑处理器、Electron 45.1.0。正式采样使用已构建应用，沿用 `local-build/spark233/dev/` 的隔离配置及已安装插件；没有 Vite 或开发 watcher。四组样本始终为主进程 PID 21688，前后均有两个 BrowserWindow（隐藏的启动器及共享桌面 surface），没有因拖动新增窗口。

CPU 从 Windows 各进程 KernelModeTime + UserModeTime 的差值除以实际墙钟时长，再除以 16，使用与任务管理器相近的整机百分比口径。范围包含应用全部后代、接口采集 PowerShell、流量原生桥接以及独立的 `spark233Traffic` ETW 服务。测量 shell 不计入。网络流量及其他插件保持实际运行，因此整树数值不能当作某个监听器的占用。

| 状态             | 进程采样时长 | 整体平均 CPU | 宿主主进程 CPU | 桌面 renderer CPU | 整体私有内存均值 |
| ---------------- | -----------: | -----------: | -------------: | ----------------: | ---------------: |
| 常驻，不悬停     |      20.00 s |        1.18% |          0.25% |             0.07% |        743.2 MiB |
| 悬停，排行展开   |      20.01 s |        2.28% |          1.16% |             0.05% |        767.2 MiB |
| 贴边收起         |      20.01 s |        1.02% |          0.28% |             0.02% |        757.2 MiB |
| 有间隔的原生短拖 |      45.01 s |        1.30% |          0.52% |             0.07% |        724.5 MiB |

常驻阶段的独立采集成本为：ETW 服务 0.469%、流量原生桥接 0.186%、流量 backend 0.103%、接口 PowerShell 0.068%。这些数字均为整机 CPU，不能与另一个阶段直接相减来推断单个功能的增量。

监听计数使用临时同步包装器，计数窗口覆盖上述 OS 采样并额外包含两端取状态／CIM 初始化约 2.7–3 s：

- `tickInteraction` 实际约 3.87–3.89 Hz，平均同步耗时在 0.142–0.186 ms 之间；整个 `WidgetHost.tick` 平均约 0.516–0.617 ms。二者有嵌套关系，耗时不能相加，也不能把同步墙钟耗时直接当作 CPU 归因。
- 常驻和收起阶段，指针 IPC 和原生 `setShape` 均为 0。收起前后动画定时器均未调度，呈现 x=2556，工作区右界=2560，实际仅露 4 DIP。
- 悬停计数窗口内，排行内容高度随数据变化，收到 12 次高度消息并执行 12 次 shape 更新，shape 平均同步耗时约 1.20 ms；未出现持续高频尺寸消息。
- 原生短拖窗口记录 4 次 down/up 和 22 次 move，move IPC 同步分发平均 0.375 ms、最大 0.522 ms。up 的同步部分平均 17.36 ms，包含提交前的同步工作，不包含异步保存等待。该组包含操作间隔及悬停时间，不是持续拖动压力测试，也不是物理输入到显示器出光的延迟。

悬停阶段整体 CPU 上升，另开一次 20 s 主进程 V8 CPU profile 后，99.18% 的采样为 `(idle)`，未定位到 JavaScript 热点。该 profile 仅覆盖 V8 线程，不能据此解释 Chromium 原生线程开销，也不能把整机 CPU 增量归因给鼠标或高度监听。

本轮没有关闭监听器做 A/B，因此没有得出监听器的独立 CPU／内存增量。私有内存属于全应用及 ETW 服务，工作集相加还会重复计算共享页；短时样本也不足以判断长期内存增长。Electron 返回的 `eventLoopUtilization` 计账为 0，已剔除，没有将其误报为零事件循环开销，也没有引入高频延迟探针。

证据：`local-build/edge-hide-perf/listener-performance-summary.json`，以及 `idle`、`hover`、`hidden`、`drag-actions` 各自的 `.json`、`-counters.json` 和 `-summary.json`。悬停调用栈为 `hover-main.cpuprofile` 及 `hover-main-profile-summary.json`。旧 PID 的样本、开发重载期间样本和未记录到指针事件的第一组拖动样本均未采用。

## 测试后的运行状态

真实鼠标操作验证了右键启用贴边隐藏、离开后收起、进入 4 DIP 条后展开及原生短拖。已恢复本轮测试前的位置 `(2440,1253,120,52)` 和 `edgeAutoHide=false`，未修改其他偏好。所有临时同步包装器均已还原，`__listenerPerf`、`__hudObjects` 已删除，Inspector 已关闭；最终确认无活动动画计时器，应用 PID 21688 保持运行并正常响应。清理证据为 `local-build/edge-hide-perf/cleanup-report.json`。

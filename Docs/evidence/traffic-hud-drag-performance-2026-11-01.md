# 桌面网速悬浮窗拖动优化与验证

日期：2026-11-01。用户确认问题出在右下角的小网速悬浮窗，并授权继续处理。

## 完成的修改

1. `WidgetHost.pointer` 在按下／打开右键菜单时执行完整校验，后续移动使用现有缓存及实时 owner/scope 检查，命令执行继续走完整校验。
2. `LayerWindow` 对未变化的 bounds、shape、置顶状态、显示／隐藏状态去重。同值 resize/move 不使 shape cache 反复失效；真实 OS geometry 变化与显示器／DPI／恢复会使缓存失效。
3. `DesktopLayer` 只在层成员、可见性或全屏等条件变化时重新排列 HWND。相同快照不发送；只有卡片 bounds 改变时发送绑定 surfaceGeneration/revision 的 geometry 消息，成员、内容、主题及其他上下文变化继续发送完整快照。独立数据消息同步更新发布基线，避免位置更新回退流量内容。
4. Renderer 保留一个 move 在途请求和一个最新等待位置。up/cancel、代次／revision／编辑状态改变、宿主取消和卸载会清理待发送位置。up 先发送再释放 pointer capture，避免 lostpointercapture 先取消提交。
5. 声明式卡片复用原有 memo 组件并稳定 action callback，纯位置更新保留模板／数据引用。

## 隔离的真实 Electron 对比

使用同一个 120 次位置更新序列和三个共享 surface，比较修改前保存的编译产物与修改后的产物。所有 profile、store 与探针均位于 `local-build/hud-drag-perf`。使用真实隐藏的 BrowserWindow 和原生调用；没有注入物理鼠标输入，也没有使用真实便签或剪贴板数据。

| 项目                                | 修改前 |              修改后 |
| ----------------------------------- | -----: | ------------------: |
| setBounds                           |    360 |                   0 |
| setShape                            |    360 |                 120 |
| setAlwaysOnTop                      |   2160 |                   0 |
| setFocusable / setIgnoreMouseEvents | 各 360 |                各 0 |
| 完整 snapshot                       |    360 |                   0 |
| geometry 消息                       |      0 | 120，仅变化 surface |
| 消息字节                            | 432720 |               16320 |

消息体积减少约 96.2%。该序列耗时为 2231.7 ms / 397.5 ms；这是隐藏窗口测试工作负载的单次结果，不能当作物理拖动帧率或用户手感的测量。

六项真实集成检查通过：只更新移动 surface；无变化刷新零原生设置／零消息；独立数据更新后仍可发送 geometry；成员变化回退完整 snapshot；renderer ready 强制完整引导；显示器恢复在相同 DIP 下仍重设 bounds 和 shape。

报告：`local-build/hud-drag-perf/runs/1736b0d3-09f1-4e22-a61d-3bdb3e4b82c0/report.json`。报告包含前后编译产物 SHA256，运行中新版的 desktop-layer/layer-window 编译哈希与修改后产物一致。

## 其他验证

- Desktop 四项类型检查通过；相关文件 lint、格式与 diff-check 通过。
- 六个相关 Node 测试文件共 34 项通过。
- 新的真实 Chromium 组件回归通过：慢回复合并、结束边界的 up/cancel 顺序、丢弃旧代次 geometry、切换代次及卸载后不补发旧 move。
- 开发启动重新构建了 Electron、前端及八个官方插件。

## 当前运行状态

已启动新版开发主进程 PID 47632，主窗可唤起且响应正常，只有一个 GUI 主进程。八个官方插件均已更新；流量插件开发构建为 `0.2.1793513490818`，声明 `titleBar: custom` 与 API >=1.5.0，lastError 为空。此前采样告警和统一标题栏修复本次一并加载。

只读 Inspector 确认 startupComplete/layerStartupReady 均 true，notes/widget 队列 fulfilled，HUD 实例 active、owner current、保存位置与 visible 配置均保留。主屏当时检测到 2560×1440 全屏范围，HUD 的 fullscreenAutoHide=true，因此按规则暂不创建显示 surface；不是迁移或恢复失败。Inspector 已关闭。

用户此前停止了桌面自动操作，本轮没有继续自动拖动真实桌面窗口。真实鼠标手感留待新版自测。

本状态补充并取代 `traffic-quality-and-titlebar-2026-11-01.md` 中“旧开发实例尚未切换”的运行边界。

## 后续实测：起拖延迟与错误点击修复

用户再次确认桌面小网速窗存在明显延迟，本轮重新测量了真实鼠标输入及完整首次拖动生命周期，不能沿用前面的固定 surface 更新结果代替手感验收。

- 运行中项目的真实原生鼠标短拖动：renderer 在按下约 8 ms 后已经收到移动 80×15 的事件，但主进程的 down 处理耗时约 166 ms。旧代码在完整插件包校验后才读取鼠标位置，把已经移动后的坐标当作起点；该次拖动被误判为点击，打开流量详情。原始记录：`local-build/hud-drag-latency/native-before.json`。
- 隔离生产链路还发现：每次拖动首次移动都把原 interactive 卡片设为透明，另建 passive surface 承载移动图像。新窗口须重新加载 session、renderer 并报告 ready，松手后销毁；此前的固定窗口测试没有覆盖这段冷启动。

修复复用既有 live owner/scope fence：指针展示事件不再每次按下都完整读取校验插件包；实际命令和菜单动作继续执行原有完整校验。起点采用 `DesktopLayer` 已验证并转换的原始按下 DIP 坐标，move/up 仍使用原生屏幕 DIP。来源屏幕的拖动投影沿用原输入模式，复用已经 ready 的窗口及原始 pointer capture 锚点。

使用同一可见 DOM + rAF 检查的隔离结果：

| 项目                               |    修改前 |   修改后 |
| ---------------------------------- | --------: | -------: |
| 首次 move 到可见卡片位置跟上       | 513.14 ms | 69.59 ms |
| 首次 move 的 preload IPC 返回      |  26.08 ms |  2.63 ms |
| 同屏 61 次 move 新建 BrowserWindow |         1 |        0 |

报告：`local-build/hud-drag-latency/runs/baseline-comparable/report.json`、`local-build/hud-drag-latency/runs/after-comparable/report.json`。修改后 6 项检查通过，renderer errors 为零；包括 native cursor 在 down handler 前已经移动时仍按实际按下点计算完整位移，以及 cancel 清理投影、保留来源窗口。

隔离探针使用生产 WidgetHost 指针／投影、DesktopLayer、LayerWindow、session、preload 和 renderer，业务数据及当前 owner 为合成 fixture。这是事件到 DOM/rAF 的单次测量，不是显示器扫描或物理输入到光子的总延迟。本轮优化和该对比针对同屏拖动；跨屏目标 surface 首次创建的路径仍需单独验证。

### 当前运行项目的最终原生输入复测

只修复前述投影后，实际运行配置中仍测得 down 147 ms、move 130 ms。进一步的调用探针发现：没有图钉时，截图 consumer 的 `active → manager.isOwnerCurrent → metadata` 也会在每次 HUD reconcile 中执行至少三次；单次完整同步包／入口／图标验证约 40–50 ms，单次 reconcile 最高约 142.5 ms。中间记录保留于 `local-build/hud-drag-latency/native-intermediate.json`，没有将这一轮误报为完成。

截图呈现与配额现在使用已有缓存元数据和实时 owner/scope 检查；没有图钉直接返回。实际读取图片前后、发布、编辑和写入仍走原有完整检查。

最终在运行中的开发项目，通过 Windows 原生鼠标输入做了两次反向短拖动：

| 原生输入链路测量        |                     修复前 |     最终修复后 |
| ----------------------- | -------------------------: | -------------: |
| 主进程 down 处理        |                     166 ms |       2 / 1 ms |
| 主进程 move 处理        | 未形成有效拖动，误点开详情 |         0–3 ms |
| 按下到移动卡片 DOM 出现 |             未形成有效拖动 | 11.1 / 12.6 ms |
| up 保存处理             |             误执行打开详情 |     60 / 55 ms |
| 两次拖动期间新增窗口    |               打开详情窗口 |              0 |

原始记录：`local-build/hud-drag-latency/native-before.json`、`native-after.json`，汇总 `native-summary.json`。up 时间包含结束后的保存与同步，不是拖动中逐帧的延迟。这里记录事件处理和 DOM 更新，未测输入到显示器出光的总延迟。

测试结束已恢复原位置 `{x:1691,y:1022,width:140,height:52}`，还原临时 IPC 观察器，经既有卡片重试路径重建 HUD renderer、移除页面探针，并关闭 Inspector。最终代码的全仓类型检查、lint、完整 `pnpm build` 以及四个相关文件共 17 项回归通过；开发启动器完成宿主及 9 个插件的构建与重载。保留其他文件已有 lint warning。

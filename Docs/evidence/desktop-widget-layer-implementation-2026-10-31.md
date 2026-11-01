# 桌面卡片平台首版实施记录

日期：2026-10-31。仓库 `C:\own\code\galaxy-tools`，分支 `codex/spark233-refactor`。用户已授权按推荐方案开始实施。本文记录可运行的首版，不代表完整 v3 的便签迁移、流量 HUD 或发布验收完成。

## 已交付的运行路径

- 宿主管理模板和实例 UUID，绑定现有 PluginOwner 与 loadGeneration。API 1.4.0 增加严格的 widget manifest、声明式模板校验与浏览器专用 SDK，不引入产品依赖。
- 声明式卡片复用可信 React 页面，按 `(display, normal/top, passive/interactive)` 共享按需窗口；数据发送完整的有界帧，日常数据更新不重建窗口 shape 或反复发送模板/图片。
- Web 卡片使用独立临时 session、可信壳和 `sandbox="allow-scripts"` iframe，每次加载使用独立 hostname、nonce 和代次。子页面没有 LayerClient、通用 desktop preload 或 Node。固定本地资源、CSP、frame 归属和精确 IPC sender 检查共同约束资源与通信。
- 宿主提供布局编辑手柄、Apply/Cancel/Esc、持久化 CAS、原子写、tombstone、屏幕几何约束和超额挂起。普通隐藏、关闭平台和停用插件保留实例布局；明确移除单卡才写 tombstone。
- `host.clock` 为唯一通用宿主 provider；backend/native 来源与订阅动作必须显式声明。订阅首帧只可更新自己负责的键，隐藏时暂停发布并解绑，恢复后重放最新完整帧；attach 失败按 1/3/10 秒最多自动重试三次，再提供手动恢复。
- 无窗 query/action 走独立 `executeWidgetOwned` 路由，遵循原有插件权限、资源域与停止确认；不 fallback 到普通 activate。Web open-main 先建立短期候选，再由可信宿主按钮与 preload 用户激活证明确认，候选一次性消费。旧 owner、旧代次、过期序号、取消后的旧结果均被拒绝。
- 原生壳与 Web 子页面均受主进程 ready/heartbeat 监督，按 1/3/10 秒有限恢复，十分钟内超过三次恢复后熔断；设置提供故障卡片重试入口。备份前 flush，恢复后重读布局并撤旧实例定义/绑定。
- 设置增加“桌面”页，托盘提供卡片管理和编辑入口。`enabled`、`webEnabled`、`notesEnabled` 默认全关；当前拒绝启用 notesEnabled，保留原便签路径。
- `examples/plugins/desktop-widgets` 提供一个无后台声明式时钟和一个隔离 Web 时钟，可从真实 `.tgz` 安装。安装不会自动铺出所有模板。

## 验证与原始证据

开发运行时为 Node 26.13.0 / pnpm 12.16.1。测试桌面运行时为 Electron 45.1.0 / Chromium 156.0.8078.49 / Electron Node 24.22.1，Windows 11。

| 检查                                                                      | 结果                                                                                                                  |
| ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `pnpm build`（含全 workspace typecheck、UI、7 个官方插件、Electron 编译） | 通过                                                                                                                  |
| `pnpm test`                                                               | 73 个文件、309 个测试通过                                                                                             |
| `pnpm lint` 与 locales 一致性                                             | 通过；旧模块仍有 warning，新增层代码另做 scoped 检查                                                                  |
| 真实 Electron 桌面卡片专项 smoke                                          | 26 项通过，0 failure，0 Console error，0 renderer load failure                                                        |
| 真实后台首帧、自动订阅重试、headless query/action、事件与停止             | 已包含在上述 26 项中，使用实际 utility backend 与真实安装包                                                           |
| 现有 Windows 整机 smoke                                                   | 未通过：首次旧胶囊入口未 hydrate；修入口后的重跑在 notes backend activate 10 秒超时处失败                             |
| Windows launcher/maintenance 专项                                         | 未通过：Launcher commands did not settle before maintenance；失败时仍在 first-run 引导，具体因果未确认                |
| 旧胶囊入口隔离回归                                                        | 真实 notes renderer、LayerWindow/preload 的 DOM 与 desktop_ready probe 通过；状态响应来自隔离 fixture，不代替整机门禁 |

专项 smoke 导入生产编译模块、真实 Vite 和 SDK 产物，实际安装 tgz。拒绝测试使用真实 foreign BrowserWindow sender、重放序号和旧 load binding。一次 `forcefullyCrashRenderer()` 后确认窗口 PID、surface generation、widget loadGeneration 改变，并恢复 SDK 时钟 DOM。隐藏 1300ms 期间两类卡片数据停止推进，恢复后同一存活 Web 窗口继续发布。Apply/Cancel 经过实际 LayerClient 和编辑按钮，另外新建 Store 验证落盘恢复。

后台 fixture 的第一次 attach 故意失败，生产宿主约 1 秒后自行重试成功。backend 只返回自己的一个键，DOM 仍同时显示 host.clock；query 和 action 均未打开已声明的主页面。隐藏触发 detach、恢复触发 attach，禁用后实际 utility PID 退出、层窗口清零、布局保留。

所有测试配置、用户 profile、插件安装和后台样本均在 `local-build/` 隔离目录内。未接真实便签、剪贴板历史或用户插件目录。最终归档位置：

`C:\Users\bhwa233\Documents\Codex\2026-10-31\docs-traffic-monitor-per-process-tech\outputs\desktop-widget-layer-implementation-evidence\`

归档包含最终 JSON 报告、原始日志、后台操作记录、页面截图、复现脚本和示例 tgz；不含隔离 profile 或安装缓存。页面截图仅用于视觉检查。

最终专项 run 为 `eea0641c-9b58-4d6e-b344-79a2df1bb605`；声明式与 Web 截图均已实际查看，显示真实时间并应用正确 light 主题。最终验证还修正了宿主快照只设置 dark class、未同步主题 CSS 所用 `data-theme` 的问题。

整机失败的三次运行均正常退出、未触发 300 秒进程超时，report 的 ok 仍为 false，不能以进程 exit 0 替代产品通过。完整失败日志、修复后的胶囊入口 probe 和维护专项结果均在 `windows-smoke/`；后台慢请求和引导时序尚未定位到可确认根因。平台 flags 保持默认关闭，不据专项成功宣告所有产品门禁通过。

## 明确未完成的阶段

- M1 的物理鼠标点透、实际拖动捕获/取消、100/125/150% DPI、双屏和混合 DPI 代表链。
- M2 的便签 consumer、三边队列迁移、布局 import/projection journal、最新位置反向投影及发布回滚。
- 流量服务/ETW、流量 provider 和正式流量 HUD；本次只完成可供其接入的平台。
- 全屏游戏、管理员窗口、真实锁屏/休眠、长期资源预算和 24 小时稳定性。
- 第三方正式开放时的完整授权摘要与分发验收、安装包发布。

自动化 DOM、受控 Electron 输入、capturePage 截图和 Win32 样式不替代物理输入验收。因此 notesEnabled 保持不可启用，三个 flags 不默认开启，不能将本次结果写成完整 v3/M1 硬出口已通过。

本次未执行 commit、push 或发布。保留实施前已有的流量文档、capsule M0、翻译 provenance 等未提交改动。官方 notes backend 的生成文件随共享配置 schema 构建更新；另外修复了其独立 renderer 入口遗漏 capsule 路由的既有问题，没有改写便签业务保存逻辑。

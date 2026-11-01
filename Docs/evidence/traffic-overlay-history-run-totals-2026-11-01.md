# 悬浮层遮挡、历史查询与本次运行累计修复

日期：2026-11-01。用户已授权按讨论顺序实施全部修复。源码正式流量插件版本为 0.2.3；现有其他工作区改动保留，未引入依赖。

## 完成的行为

1. Windows LayerWindow 使用工具窗类型 `toolbar`。带桌面交互的声明式 widget 按稳定 family 使用局部原生 viewport，HUD、hover、同屏拖动复用窗口；不同 widget 不跨整屏空白合并。geometry 同时传递窗口 bounds，renderer 更新原点并保留 capture DOM。便签和截图沿用基础共享窗口，显式插件栏／编辑态仍可整屏。
2. 历史查询以固定大小 `coverageSummary` 替代每页重复的完整区间列表。SQLite 在同一读事务内扫描全部区间计算覆盖状态，去掉原有前 1000 条截断；保留 64 KiB 帧、分页预算、调用者和查询绑定的游标。旧服务的区间返回仍有兼容路径，技术错误映射为简短中文。
3. 实时表格及展开实例新增“本次下载／本次上传”。原生服务按实例真实 ETW 字节维护独立运行累计；应用 run 包含已退出成员贡献，所有成员退出后新运行归零。scope、owner SID、开机及 PID 创建代次继续隔离。TS 按 appRunId 去重，不把重复实例或分页片段再次相加；求和和累计排序使用 BigInt。
4. 窗口关闭／切页／bridge 重连不清零。运行累计 checkpoint 使用同一 SQLite 文件中的独立 run_* 表，不受清历史／历史保留期影响。所有视图单位统一为 KB／MB／GB、KB/s／MB/s／GB/s，保留 1024 进位与原始字节值。

## 悬浮层验证与边界

真实 Electron、生产 DesktopLayer／LayerWindow／preload／renderer 的隔离验证 43 项通过。实际 HWND 确认 TOOLWINDOW，交互态保持可交互，passive 模式带 TRANSPARENT；单 HUD 窗口和 region 均为 120×52，收起为 4×52。HUD 与排行共用局部窗，连续移动不新建窗口，viewport 原点、画面和 pointer capture 节点一致；原有 27 项贴边动画和取消／生命周期检查继续通过。两个相距较远的交互 widget 各用局部窗口，显式编辑仍可全屏并获得焦点。未写入 fixture 布局，renderer 错误和 diagnostics 均为 0。

报告：`local-build/overlay-occlusion/runs/compact-toolbar-final-passive/report.json`。现有 `DesktopLayerView.browser.test.tsx` 回归通过。

曾尝试以真实 Edge 的本地 30 fps 测试视频做前后对照，但期间浏览器发生其他标签切换，未控制前台连续性；之后 Computer Use 因不能可靠确定 Windows 浏览器当前 URL 而停止。该帧率尝试已标记无效，不用它宣称真实视频已经恢复，也未绕过工具限制继续操作用户浏览器。记录为 `local-build/traffic-repairs/occlusion/browser-attempt.json`；本轮没有修改浏览器硬件加速或全局 GPU 配置。实际视频播放、物理拖动和混合 DPI 的这轮组合验收仍留待自测。

## 原生历史及运行累计验证

Core、Client、Service、Setup 锁依赖 Release 编译为 0 警告／0 错误；37 个 staging 文件、大小和 SHA256 及源输入哈希均已核对。复用已存在的 NuGet 缓存，没有修改依赖锁文件。

现有 Verification 在隔离 SQLite 与独立命名管道中验证了 2401 段交错／重叠覆盖记录、250 个历史进程、有界真实帧分页、完整总量、游标 scope 隔离和 durable 尾部。运行累计回归覆盖退出成员清理不降数、完整退出后新 run、PID 复用、迟到事件、超过 2^53 的整数、未知元数据补全、缺口、清历史后 checkpoint 恢复，以及多个 machine 租约的单 ledger 去重。全部通过。

报告：

- `local-build/traffic-repairs/native/history-verification-report.json`
- `local-build/traffic-repairs/native/run-totals-verification-report.json`

## 本机真实服务和生产插件验证

使用包内固定安装器完成已授权服务升级，保留历史和采集意图。真实 SYSTEM 服务 PID 5028、SCM 状态 Running，版本目录为 `v1-267aefc0533d0b5ddc19`。

普通用户 bridge 真实查询成功：原有历史返回 6410 行、65 页；没有清历史。公开 1 MiB 下载期间，探针进程本次接收从 0 增长为 1,057,284 B、发送为 1,922 B。ETW 网络字节与下载的有效载荷不是同一口径。bridge 正常关闭再连接后，实例和应用 run 保持，累计没有清零。

报告：`local-build/traffic-repairs/live/460b940f-7ebb-49ab-951f-959dc3f5d2ec/report.json`。

正式 `traffic-0.2.3.tgz` 通过生产 Host、broker、preload、backend/native 和真实 renderer，在独立 profile 的始终隐藏窗口中完成 14 项检查：87 个应用／404 个实例均有累计展示；6 页的 115 个片段合并成 87 个应用；一个 35 子进程应用的原始累计 34,509 B／21,945 B 实际显示 33.7 KB／21.4 KB，没有重复相加。历史 UI 显示 81 个应用记录，无 row-too-large；窗口关闭重开后 87 个持续应用的累计不下降。界面无 KiB／MiB，renderer、preload、IPC 错误均为 0。自有测试进程及租约已正常释放，没有操作用户浏览器或便签／剪贴板数据。

报告：`local-build/traffic-repairs/plugin-probe/runs/1440bb4f-d68f-4589-a19b-76a256810236/report.json` 及同目录 `process-cleanup.json`。

## 最终工程与运行状态

全仓 typecheck、lint、完整 pnpm build 和 9 个相关 Node 测试文件的 35 项回归通过；保留其他已有 lint warning，未宣称全套测试全部通过。日志为 `local-build/traffic-repairs/{typecheck,lint,build,tests}.log`。

当前应用 PID 7736 已使用新宿主及新流量开发包 `0.2.1793537497616`，插件 enabled、采样 collecting、当前窗口 coverage complete。运行时首个显示分页 11 个应用均有本次累计字段，HUD active 且实际原生窗口为 120×52。保留用户当时位置 `(2393,1258)`，没有用旧测试位置覆盖。静态启动不会自动替换已安装开发插件，因此这次额外通过既有 package staging 和 manager 安装事务升级了流量插件，最终版本经过运行时核对。

读回证据：`local-build/traffic-repairs/final-readiness.json`、`running-plugin-upgrade.json`。临时运行时引用和 Inspector 在最后清理，应用保留运行。

累计边界：监控晚于目标程序启动时，只包含实际采集部分；暂停、离线和丢事件不补估算。正常停止先 flush，异常服务崩溃只能恢复最后 checkpoint，最近约 30 秒未落盘字节可能丢失或较最后 UI 帧回退，恢复后保持 gap。

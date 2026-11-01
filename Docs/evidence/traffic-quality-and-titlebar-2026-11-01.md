# 流量采样质量与统一标题栏修复

日期：2026-11-01。

## 实现

- Native `Quality` 使用对应 scope 最近发布窗口的 covered/gap 状态；累计丢失计数继续返回诊断，不再永久使恢复后的窗口 partial。存储失败、采集不可用及真实历史缺口保留。
- TypeScript 兼容已安装的旧服务：只有明确 covered、没有当前错误原因且 partial 来自累计丢失计数时，才将恢复窗口视为 complete。
- 流量插件 0.2.2 使用共享 `WindowTitleBar`，与宿主独立工具使用同一外观。窗口声明 custom 后 frame=false；SDK 1.5 的最小化、最大化、状态读取仅限当前 owner/main frame，不接受目标窗口参数。关闭沿用保存生命周期。
- 初始化期间的显式 CLI exit 在配置已加载后直接进入既有保存退出链，避免排在桌面初始化之后。

## 已完成验证

- SDK/UI 构建、desktop 四项类型检查、Electron 编译通过。
- 4 个相关 Vitest 文件，8 项通过；native 四项目 locked Release 构建零警告/错误，Verification 8 组通过。
- 所改文件 lint 无新增问题，存在原有 shadow 警告；diff-check 通过。
- 已用固定安装 helper 更新真实 LocalSystem 服务，验证时 PID 14884；普通账户可认证，真实公开测试下载的本进程观测 RX 1,057,280 B / TX 1,922 B。
- 0.2.2 完整打包插件通过 production broker/preload/backend/native 的 12 项实际检查：采样正常、告警消失、共享顶部栏、按钮操作、非法窗口目标拒绝、F12、正常关闭和无 renderer/preload 错误。
- Computer Use 真实点击最大化、标题栏双击还原已确认。拖动输入未得到可测量的位置变化，拖动尚不能标为实测通过。用户随后按 Esc 停止桌面自动操作，未继续操作窗口。

## 证据

- Native: `local-build/spark233/native-traffic/verification/21bbb126-4c80-4486-944a-88bc655db0b6/report.json`
- 服务更新: `local-build/traffic-admin-repair/runs/d046b9bf-6a91-4e28-a8f1-0ca3a8453900/report.json`
- 完整插件: `local-build/traffic-chrome/runs/bc0d9f28-98c0-4845-9b81-6a3feb50dcae/report.json`
- 物理输入边界: 同目录 `physical-input.json`
- `traffic-0.2.2.tgz` SHA256: `8F93E0FFCD5174321FAAA68730341CC0B2B1829DB005C7E0A6254C28C17DA458`

## 继续点与当前运行边界

旧开发主进程 PID 42636（13:20:18 启动）仍未退出，只存在隐藏 launcher 窗口；开发配置安装的 traffic 为 `0.2.1793510401197`，未确认已切换到最终 0.2.2 代码。CLI 显示/退出请求没有使其窗口出现或正常结束，不能宣称已把最终新版留在运行中。一次正常 app.quit 也未结束该实例。临时打开的本机 Inspector 已关闭；没有强制终止真实应用。隔离验证进程均已清理。

继续时先定位实际启动/退出等待点，使用保存退出路径关闭旧实例，再重新启动开发项目并确认最终 manifest titleBar=custom。不可因未确认的启动阶段就断定 syncDesktopLayer 存在死锁。

网速悬浮窗当前入口：托盘右键“桌面卡片”，或设置“桌面卡片”，在“桌面流量窗”模板点击“添加”；上方“启用桌面卡片”需开启。“调整桌面卡片”仅管理已有卡片位置。

后续更新：新版已在 2026-11-01 的拖动优化任务中重新启动并确认加载，旧实例切换边界已解决。见 `traffic-hud-drag-performance-2026-11-01.md` 的当前运行状态与实际验证。

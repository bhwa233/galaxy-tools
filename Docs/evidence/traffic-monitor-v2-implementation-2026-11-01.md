# 流量监控 v2 实现与验证记录

日期：2026-11-01。用户已明确授权按讨论方案实现，排除限制网速和程序限速。此记录区分源码实现、普通权限隔离验证与尚未完成的特权采集验收。

## 已实现

- 桌面提示改为 140×52 DIP，上传橙色、下载绿色；悬停两个 Top 3 排行，单击复用独立详情窗，拖动不误触单击。
- 原生菜单为置顶（默认开）、贴边隐藏（默认关）、全屏隐藏（默认开）、查看详情、关闭提示。偏好按实例持久化；关闭提示保留实例、采集和历史。
- 四边隐藏保留激活条，临时几何不落盘。按显示器工作区限位 hover；跨屏拖动使用源 capture 与临时投影。全屏隐藏按卡片及显示器执行。
- 可选 SDK `desktopInteractions`、至多两份三行 `rank-list`、upload/download tones 与 owner/instance 绑定 PNG 附件；旧卡片仍使用原行为。
- 实时/历史独立页面、分组实例、搜索、筛选、排序、TCP/UDP 明细、日期范围、确认清空、标签切换缓存与交互期间冻结行顺序。
- 真实接口采集继续提供网卡总量；进程来源为 ETW，口径明确分开。没有把接口流量或 IO 计数变成程序排行。
- net48 x64 的 Core/Client/Service/Setup、锁定依赖构建、native v1、受认证本机 pipe、SID 授权、持久意图和租约、完整三级 SQLite 历史。
- 进程使用 boot/PID/创建时间身份；64 位字节为字符串，覆盖缺口用 null。快照、历史、连接与图标有稳定分页，保持现有 64 KiB 插件结果边界。
- 粗粒度历史对齐 UTC 桶并显示实际范围；无覆盖时累计为不可用，不显示零。暂停恢复范围和选定范围保存到插件私有偏好。
- 原生安装闭包和源码哈希纳入官方包构建及 native payload 传递；不在用户机现场编译服务。
- 旧版固定交互 HUD 在尺寸变化时迁移到 140×52/interactive，保留位置、显隐和偏好；当前固定尺寸的用户主动 passive 选择保持。

## 验证证据

- 完整 `pnpm build` 与 TypeScript gate 通过，八个官方包构建成功。
- `pnpm lint` 退出成功，仓库既有 warning 保留，新增 traffic 业务文件 scoped lint 零警告。
- 单元回归 76 文件、318 项通过；分页回归保护超过 2^53 的计数、完整实例/图标、消息预算、过期及错误命令游标。
- 原生四项目 locked Release 构建零警告、零错误；执行闭包 37 文件、10,868,519 bytes，输入哈希 27 项全部匹配。
- 真实隔离服务/桥接 12 项通过：`local-build/spark233/native-traffic/runs/2648967b-f774-4f83-a129-61fba3081111/report.json`。
- 最低层数据/生命周期 6 项通过：`local-build/spark233/native-traffic/verification/2b7cbb94-02c5-4dea-94bc-82289f84e8c5/report.json`。
- 独立浏览器夹具通过分页合并、图标分片、实例展开、排序冻结、标签缓存、日期边界、TCP/UDP、暂停和未安装空态：`local-build/traffic-detail-ui/ui-probe-evidence.md`。这是模拟 preload 的 UI 证据。
- 真实 Electron 生产模块联调及旧布局升级 25 项通过：`local-build/traffic-v2/runs/9a03aafb-1ede-4162-9bb6-7f26c4519831/report.json`。使用最终哈希安装包、真实网卡采集和真实服务未安装状态；输入与菜单 handler 采用程序化验证。升级修复另通过既有三个文件 25 项回归。

## 未验收边界

1. 当前普通权限 token 尝试 ETW 返回 `etw-unavailable:UnauthorizedAccessException`。未实际安装 SYSTEM 服务或触发 UAC，因此尚未实测 TCP/UDP IPv4/IPv6 的真实字节归属、完整特权采集链与受控传输对照。
2. 安装/升级/失败回滚的实现已落地，实际管理员环境尚未验收。二进制未签名，正式签名发布仍是独立出口。
3. 新版物理鼠标 hover、右键、跨屏连续拖动与混合 DPI 尚未重新验收。Sky 不暴露隔离工具窗口，报告明确 `physicalMouseAcceptance:false`；程序化输入不能替代此证据。
4. 睡眠恢复、长时间运行、事件压力、历史压力和 SQLite 硬取消仍需专门实测。当前实现使用自有 manifest ETW 会话，没有 classic kernel logger fallback。

所有验证安装、配置、历史和夹具均隔离在 `local-build/`；未访问真实用户便签或剪贴板作为测试数据。未执行提交、推送或发布。

## 产物

`dist-plugins/traffic-0.2.0.tgz`：19,619,701 bytes，SHA256 `c3ccd90403be6202a60ca6efca13f58f38c091f3b72b1a26bbffb943032ae8c9`。

原生 `resources.json` SHA256：`c0c3f84be3246bdfe7378db972f4e403e208774b550285a9702df4331178a57b`。

对外可读的报告、产物副本和区分真实/夹具的截图保存在本任务 `outputs/traffic-monitor-v2-evidence/`。后续用户自测从“设置 → 桌面 → 桌面流量窗”进入，按程序能力需在详情页点击启用并由用户处理 UAC。

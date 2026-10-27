# 插件说明、进度与取消：实现与验证续记

日期：2026-10-27（Asia/Shanghai）。对应 P7.10。P7.10 按原验收范围完成并勾选，该次收口总数为 58/108；其余物理操作、发布及系统服务仍按原任务保留。

## 运行合同

说明入口固定为包根 `CHANGELOG.md`，不增加 registry 后台或 SDK 入口。候选说明在 SRI、解包和身份验证通过后从该归档提取；只读取有界 UTF-8 常规文件，拒绝链接、超限及无效编码。缺失与读取失败分别展示，说明失败不跳过安装确认、能力授权或原生信任。已安装说明只允许以 pluginId 读取当前已安装目录的固定文件；该重读表示磁盘当前字节，不冒充原归档 SRI 认证。前端复用 MarkdownPreview，`renderHtml=false`、`imageDisplay=hidden`，无编辑或本地图片目录授权。

在线安装与更新在慢操作前注册独立 taskId，owner 为宿主管理窗口文档的 UUID，renderer 不提交 owner。元数据解析、下载、校验、待确认与保存/备份/迁移/切换/启动/恢复分别报告实际阶段。字节来自现有下载 Transform；总量只接受对应流可信的 Content-Length，chunked 或内容编码解压后的流保持未知总量。下载 100% 不等于安装完成。

任务进度使用独立、按 owner 投递的事件，不触发通用 plugins-changed、启动器 token 撤销或快捷键重建；高频进度限频，taskId/revision 防止旧全量列表覆盖新事件。活动下载和待确认、排队离线准备一起受容量上限约束；终态任务记录有界。

取消 RPC 不进入全局安装队列，先核 taskId 与真实 caller，只取消指定任务的 controller。下载取消等待真实 pipeline 清理后正常结束，不显示成升级失败；校验阶段不承诺用户即时取消，文档退役可撤销其迟到结果。已进入最终保存、提交或恢复的安装不能被下载取消绕过。rename 后的中止仅清理由本次 stage 新建且身份仍匹配的版本目录；Host 在丢弃迟到候选时还核 manager/journal/其他 preview 所有权。

同 owner 的同一请求合并；其他 owner 或冲突来源不得接管活动任务，真实 pluginId 解析后再次排除身份冲突。更新捕获开始时的包名、精确已安装版本和来源，在预览发布与用户确认时复核；下载期间当前版本或来源变化则要求重新检查。确认失败回滚后的 preview 仍可取消或重试；窗口文档退役清理其可安全丢弃的失败候选，需恢复的事务目录继续保留。

## 当前证据及边界

`local-build/spark233/package-tasks-preparation/summary.json` 的五组底层检查通过：真实 HTTPS 长度/chunked/内容编码流的实际字节与未知总量、observer 抛错不破坏流程、下载中止与 rename 后中止清理、包内说明边界，以及真实 Manager 启动失败回滚健康旧版和数据。此组 runtime factory 为受控进程内对象，不能充当真实 utility/UI 证据。

后续 Windows raw Electron 使用真实 Host、installer、Manager、可信 utility 和独立 HTTPS，四组通过：同请求去重/跨 owner 拒绝，取消 A 保持 B 与旧数据/实例，保存门后拒取消和真实回滚阶段，以及 owner 退役后的迟到结果、更新期间版本/来源变化。旧 Host 允许“从版本 1 下载候选 4，期间当前版本变成 2.5”仍发布预览的红结果已保留；加入精确 baseVersion 复核后相同链变绿。`local-build/spark233/package-host-tasks-probe/summary.json` 的最终 `run-EJj3HS` 实际 exit 0，18 次受控 TLS 请求，全部所属进程退出；包括失败候选随 caller 退役清理、新文档重试成功。对应 Host TS `2ac8eef147d62b35bfaa9823f1983031c0937ec3251c0135285807d2c5d6b09b`、JS `a0f7d4d9f40c73856e8ecd2088cab7eed2e38817c2de7c85dfa388ca572bec6d`。UI/新归档 identity 待本轮收口补齐，不将源字符串或静态存在检查视为这些运行行为的证明。

Linux 当前 typecheck、lint、35 文件/171 测试与完整 build 通过。首次 build 因缺本机忽略的 Windows 原生资源停止；从已核对 stage 恢复缺失的 20 个忽略资源后，词典与旧 provenance 不匹配，已按固定 CSV/许可证源码本机重新生成并完成构建。派生数据库仍为 102,096,896 字节、770,611 词条，当前 Linux SHA-256 `92f67ad5d33d33bf29fd3b36a4e6ed12bbef3b79033d403a267d007fa383bb38`；Windows 数据库保持独立的已验证字节与 provenance。未运行安装器、服务安装或公开发布。

## 最终 UI 与 Windows 候选

`local-build/spark233/package-tasks-ui/final-summary.json` 保留两个独立冻结运行：完整 `run-TSOvHn` 的 17 组通过，主进程和 notes/A/B/C 四 utility 实际 exit 0；UI 实测 A/B 并发、B 确认安装忙碌期间取消 A、真实未知总量、缺少说明、HTML/图片禁用、说明读取失败和已安装重试、失败预览重试及 200% 滚动。最初长 hold 导致的真实 idle timeout、harness 时序和截图限制单列在原报告，不改写为无错误历史。

最新 `run-SohVJk` 的 9 组验证绑定 `index-DIw2uoNP.js`：代表表单启动一个活动下载，另外 70 次经真实 preload invoke 发起实际 TLS 404（不是 70 次表单点击），界面最终只保留 64 张卡片，旧终态淘汰，活动下载仍存在且可取消，取消后仍有界。主进程和 notes utility 正常托盘退出，两个运行均无遗留进程、renderer error 或 OS 效果。两轮 UI 源码仅历史上限有差异，各报告保留原字节，不重绑全流程输入。

`local-build/spark233/package-tasks-2026-10-27/summary.json` 与 `final-candidate-binding.json`：

- 494 项源码 freeze SHA-256 `e0578c1a16508347fbde19cd247855ccb331cc0415f24fbe3d0dae90c49492fa`；Windows dist:win、lint、35 文件/171 测试、50 项静态审计、71 编译成员、七归档和 14 native 字节绑定全部通过。
- seeded `seeded-smoke-AgcEuV`，PID 19732，实际 exit 0、62.088 秒；fresh `8572e657-acb8-4e0d-98f8-a68b93e5d3b8`，PID 4064，实际 exit 0、220.932 秒，未超时，wrapper 0。三次无名称过滤的路径归属 CIM 检查均为空，最后为 `2026-10-26T16:33:22.8705692Z`。
- ASAR 36,756,055 字节，SHA-256 `55576bf8137c3e137a1651f483352d1231f564ad443996fad3fc56eec7f49548`；NSIS 210,329,135 字节，SHA-256 `bc09a96056ad173da05e70e38f0ce4e5a214fd920fa5b796931294d2192d6f36`；binding SHA-256 `411bb9e62c32940ba3fb2fcae5aebe21bfbc773aa5ce0b5296c7896b355bdd23`。
- 完整 122 文件/702,788,163 字节 release 与 494 源分别保存在 root candidate 和 Windows `verification-runs/package-tasks-20261027T002035+0800`，逐文件核对。首次静态断言只接受双引号 hidden，而真实 Vite 使用等价 template literal，旧 49/50 失败报告与脚本修正说明保留；产品代码和其他校验不放宽。

真实 Linux main/preload/UI 与真实 Windows Host/TLS 分别证明各自路径，同一 Windows 候选验证实际归档与整体启动/退出。没有声称已操作 Windows 管理页进行物理取消，也未执行安装器、SYSTEM 安装或公开发布。该 494 源候选不包含后续 P2.13 诊断功能；后续功能必须使用自己的冻结输入与验收记录。

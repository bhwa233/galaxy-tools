# 有界诊断记录：实现与验证续记

日期：2026-10-27。对应 P2.13。P2.13 按原验收范围完成并勾选；当前清单为 59/108。结构化日志、真实主进程/界面隐私与生命周期，以及最终 Windows 候选均有独立通过记录。

## 数据合同

诊断记录采用严格结构化白名单：固定 kind/code/level、时间和序号、真实 owner 的 pluginId/version/instanceId、尚无实例时独立的 target 身份，以及 taskId、耗时和数值计数。未知字段整条拒收；任意 message、stack、details、URL、query 或业务 payload 均不进入记录。错误仅按固定 code/name 映射到有界类别，不读取错误正文或 toString；未知/异常 getter 归 unknownFailure。不是先记录正文再靠正则脱敏。

既有后台文本 onLog 接口保留兼容，生产 Host 只接原始 Buffer.length 的新计数回调，不向诊断仓库传文本；stdout/stderr 按捕获的 owner/stream/kind 聚合。原 PluginManager 的业务 lastError 和测试 fixture 原始 stdout 不属于这套诊断仓库，不自动导入旧 stderr 或业务错误正文。隐私验证分别检查新 snapshot、批次、三份诊断磁盘文件和导出 JSON，不将整个应用数据域混作日志。

Manager 在实例真实创建、准备保存、退出、崩溃、启停和命令完成/失败边界记录结构化事件；Search/OCR/翻译只记录类别、结果码与耗时，不记录查询、图片或返回值。已退役实例的回调不补成新 owner，停止后的输出计数按原 scope 拒绝。独立包任务记录其阶段与 UUID；尚无运行实例的包或生命周期 target 可按插件来源筛选，缺省 owner 不伪造 instanceId。

## 容量、磁盘与管理权限

历史最多 1000 条/2 MiB，待写队列最多 256 条/512 KiB，单条最多 2048 字节；输出聚合最多 64 组，订阅最多 16 个，每 200ms 最多推 100 条，所有溢出有丢弃计数。磁盘最多三份、每份 2 MiB 的 NDJSON；启动先限尺寸再解析，拒绝链接、硬链接、意外目录项及被换向的文件。日志观察异常不能中断业务事务。

批次 cursor 是本批最后交付序号，lastSequence 是全局高水位，两者不混用。清空通过 epoch/generation 使旧写入和旧批次失效；先排空已开始的写入，再删除所属日志文件，新增记录不复活旧数据。若磁盘删除失败，界面只报告内存已清空、磁盘清理未完成，保留故障状态。

仅顶层宿主管理窗口可读取、订阅、清空及导出；订阅绑定调用窗口文档 UUID，关闭页面时主动释放，文档关闭/导航/崩溃时宿主再撤销。UI 先监听再订阅，按 epoch/sequence 去重，串行处理同文档的关闭与重开，列表继续有界。来源、插件 ID、级别和时间在有界快照中筛选。

导出仅接收严格过滤条件，固定生成安全 JSON 快照，再通过原生保存对话框让用户选择目标；renderer 不能提供文件路径。选择返回后重新核对调用文档，拒绝覆盖应用私有配置、插件数据、便签与恢复根目录。取消对话框正常结束。日志目录初始化失败时宿主继续可用，管理界面显示固定不可用提示；操作者修复日志目录后可重新加载初始化，不自动删除未知文件。

## 当前证据

`local-build/spark233/diagnostics-preparation/summary.json` 保存初始 store/DTO/测试的独立输入与三组验证：敏感 canary 拒绝/输出聚合、真实溢出与轮转/不安全磁盘，以及持有真实 append 时清空/epoch/订阅游标与退订。后续宿主接线额外将 target-only 事件归入插件来源，并在同一测试组加入实际过滤回归；当前 `root-tests.log` 为 36 文件/174 项全部通过。初始 summary 不换绑后续源码。

真实 main/preload/renderer/utility 的敏感数据隔离、订阅释放、清空、导出和缩放报告将在本轮收口单列，最终归档也保留自己的源码/编译/包身份。尚未取得的 UI 或 Windows 结果不以静态源字符串、store 单元检查或构建成功代替。

## 真实主进程、界面及隐私收口

`local-build/spark233/diagnostics-main/final-summary.json` 的两次冻结运行：主 `run-4WtBhv` 15 项、不可用恢复 `run-htbDEn` 4 项均通过。实际 140 次可信 utility 激活产生 282 条事件，最大批 100 条，界面完整接收；唯一传输时序 shim 仅延迟已产生的原样旧批，前后 SHA 一致，清空取得新 epoch 后释放旧批仍保持空列表，新事件继续有效。不是 mock DTO、store 或成功状态。

来源/插件/级别/时间筛选、原生保存对话框取消与受控保存、拒绝 renderer 路径、清空磁盘失败的部分反馈、关闭/重新挂载及合法第二窗口 destroy 后退订、旧 owner 停用与新 instance、200% 代表视口均取得实际证据。移除 fixture 自己的未知日志目录项后，Reconnect 真实恢复，宿主全程可用。

293 份实际诊断响应/批次及四份实际文件（两轮各 events.0，另两导出）未检出合成敏感 canary，entry 只有白名单字段；Unicode stdout 实测为每行 57 UTF-8 字节，区别于 51 UTF-16 单位。另两个诊断轮转文件路径当时不存在，GUI 不冒充已强制轮转；真实轮转由 store 测试证明。没有扫描包含合成业务 lastError 的整个 profile。

主进程 PID 267971/281710 实际正常托盘退出，全部四个 utility exit 0；无 deadline、强杀或遗留，最终订阅 0，无 renderer error 或 OS 效果。旧 timer 先 quiet 再 disable，不外推恶意退役输出；SaveDialog 为受控返回，DOM 操作为自动化，不声称 Windows 物理对话框操作。原独立 notes renderer 没有新诊断页，第二合法窗口仅证明真实 preload 订阅及 destroy 释放。完整原输入/限制在报告中保留。

## 最终 Windows 候选

`local-build/spark233/diagnostics-2026-10-27/completion-summary.json`、`final-candidate-binding.json`、`snapshot-seal.json`：

- 500 源 freeze `43661750b29022ae7534b97fc3b2f2c4190cb52888e4991edb281c11a74947a4`；build/lint、36 文件174测试、58 静态审计、73 编译成员、七归档与14 native全部绑定通过。初次 Win 测试在 symlink 夹具权限处为173/174；保留整轮失败源/产物，只将两处 fixture 改为 Windows 真硬链接、Linux 真符号链接，原拒绝及外部文件不变断言未跳过。其余499源逐字节不变，重建后产品ASAR与首轮完全相同。
- seeded `seeded-smoke-4HmdMY` PID21200 实际 exit0/58.992秒；fresh `b2b3fa64-1d2e-425d-a33d-9644304e967b` PID22336 实际 exit0/217.097秒、未超时、report true/errors[]、wrapper0；`2026-10-26T17:18:28.8699054Z` 无名称过滤的路径归属 CIM为空。
- ASAR 36,807,538字节，SHA `2e1ecef521f1c963244b1cb8b7ecf105355fbfb63165690a2238207c0f01ecd6`；NSIS 210,362,584字节，SHA `b1c755a88aed96edba460c3341cf54af5803b796e86eac09bc52c01320f4eb06`；binding `1c3871dbe808a2d956d9f8b7ae96f971e5de8c618f1361c9871fb96001e0bfaa`。
- root candidate与 Windows `verification-runs/diagnostics-20261027-71287dc0-725a-4e5a-b30c-d50193a377c1` 完整冻结；seal1664文件/1,064,742,767字节，含122文件/702,899,025字节release、500源、两轮完整profile及原始lower证据。58静态项不当作真实UI证明，原GUI/lower报告只核原输入、不换绑Windows物理UI。

该500源候选不含后续关键词选择记忆。未执行安装器、SYSTEM服务安装、公开发布或实际用户数据采集。

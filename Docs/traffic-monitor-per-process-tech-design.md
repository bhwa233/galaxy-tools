# 按进程流量监控：技术方案（评审修订稿）

日期：2026-10-31  
状态：**已按技术评审修订，待 M0 验证正式采集与发布链路**。本次更新设计文档，不代表服务、插件或探针已经实现或验收。  
评审原则：**不以人月、工期或本机暂缺的工具链决定方案**；按功能完整性、数据正确性、性能、稳定性和可维护性选型。  
关联：[可行性评估](traffic-monitor-plugin-assessment.md)、[早期实施方案](traffic-monitor-per-process-plan.md)、[宿主架构](launcher-architecture.md)、[原生协议](native-plugin-protocol.md)。早期文档与本稿冲突时，以本稿的采集、权限、历史和生命周期合同为准。

## 1. 目标与统计范围

### 1.1 功能目标

1. 按进程实例显示实时上下行，默认 1s 统计窗口；支持排序、筛选、最近曲线及按完整映像路径分组。
2. 显示 TCP 连接、本地 UDP 端点和近期观察到的 UDP 流；UDP/QUIC 远端来自实际事件，不把 UDP 端点数称为连接数。
3. 完整保存有流量的进程实例历史，分钟、小时、天三级查询。TopN 只控制查询和显示，不在存储阶段合并为 Other。
4. 服务未安装、未运行或采集不可用时，仍提供接口总速、TCP 表和 UDP 本地端点，并明确能力缺失及原因。
5. 服务首次安装、授权范围变更和受保护产物升级通过 UAC；日常采集、查询和窗口操作以普通用户权限运行。
6. 插件停用、更新和宿主退出时，完成必要落盘，撤销所属采集租约，释放桥与悬浮窗。服务已安装不等于持续采集。
7. 展示数据覆盖、丢事件、解析错误、归属不明和采集空白，避免把缺失数据画成零流量。

### 1.2 可见范围与数据口径

| 范围            | 可见内容                                        | 授权与采集条件                                                                     |
| --------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------- |
| `own`，默认     | 调用者 SID 拥有的进程、该用户范围历史           | 安装时登记允许使用服务的 SID；该 SID 启用插件且存在有效运行租约                    |
| `machine`，可选 | 包含 SYSTEM、其他用户和归属不明项的全机进程视图 | 管理员通过固定 UAC helper 明确授予调用者 SID 全机查看/采集权限；另行启用并持有租约 |
| 接口总量        | 用户选定接口的总速                              | 普通权限可读；始终标为接口/全机统计，不冒充本用户进程总量                          |

默认用户视图不包含 SYSTEM 服务、其他用户进程，以及由这些进程实际承载的代理/VPN 流量。全机视图属于明确授权的本机管理能力，不默认授予所有交互用户。

按进程字节的来源是所选 ETW 收发事件的 `size`，不承诺它等于应用有效载荷、接口 octets 或运营商计费字节。QUIC 作为 UDP 流量计入，不解析 QUIC 内容或推断其逻辑连接。环回、LAN、代理与 VPN 的包含范围由来源和观察到的端点标明，不在缺少接口映射依据时宣称能准确按网卡筛选进程流量。

### 1.3 非目标

- 本期限速、内容解析、DNS 内容记录、目标地址持久化和流量外发均不做。
- 不嵌入任务栏，不复用 TrafficMonitor 的任务栏寄生方式。
- 不构建跨进程重启的应用身份账本；按映像路径汇总是显式查询维度，原始身份仍为进程实例。
- 不承诺宿主未运行、用户未登录或租约失效期间仍连续记录。历史必须体现这些空白。

## 2. 关键设计决定

| #   | 决定       | 选择与依据                                                                                                           |
| --- | ---------- | -------------------------------------------------------------------------------------------------------------------- |
| D1  | 采集来源   | ETW 收发白名单，覆盖 TCP/UDP、IPv4/IPv6；成熟事件消费者和版本化解析优先，见 §4                                       |
| D2  | 特权边界   | SYSTEM Windows 服务处理 ETW 与服务端存储；用户态组件通过经认证的本机命名管道访问有限业务操作                         |
| D3  | 安装时机   | 首次使用按进程能力时，经宿主说明授权范围并 UAC 安装；现有 per-user 安装不因此改为强制 per-machine                    |
| D4  | 语言与构建 | 保留 C#、.NET Framework 4.8 基线；正式项目构建、NuGet 锁定、发布清单及代码签名，取消裸 csc 运行时编译与单文件假设    |
| D5  | 宿主边界   | bridge、widget 均为清单声明的 native 入口并由宿主资源域托管；renderer 不提交路径、PID、shell 或任意参数              |
| D6  | 查询方式   | 默认 1Hz 拉快照；快照、历史、连接均支持分页、取消及稳定查询身份，不承诺固定 2 KB/s                                   |
| D7  | 会话策略   | 自有命名实时会话优先；普通 manifest 提供者会话和命名 system logger 分别验证。不默认使用或停止别人的 NT Kernel Logger |
| D8  | 历史保留   | 完整分钟桶 48h、小时桶 90 天、天桶 2 年；压缩/清理只改变保留与粒度，不丢弃低排名进程                                 |
| D9  | 进程身份   | 服务生成字符串 `processInstanceId`，绑定已确认的进程代次；PID 仅作为属性。100ns 时间和 64 位字节以十进制字符串传输   |
| D10 | 悬浮窗     | C# 原生分层窗，与桥共享代码及发布包，可为两个 OS 进程；Electron 宿主继续驻留，主页面按需打开                         |
| D11 | 权限范围   | 默认 SID 隔离；全机能力须单独管理员授权。可执行代码与历史数据使用不同目录和 ACL                                      |
| D12 | 采集启停   | 持久化启用意图 + 有时限租约 + generation；有合法消费者才采集，停止行为见 §7                                          |

语言和窗口选择依据成熟组件、实际资源表现、Windows 集成、部署与长期维护，不以开发投入或当前机器缺少 MSVC/Rust 工具链排除其他语言。M0 若证明候选链路不合格，按证据更换适配器或技术实现，不把一次探针失败等同于必须放弃按进程统计。

## 3. 架构与复用边界

```text
SYSTEM：spark233.TrafficService.exe（SCM 自启，但无合法租约时不启动 ETW）
  ├─ NetworkEventSource：成熟 ETW 消费器、会话所有权与来源 schema
  ├─ ProcessCatalog：进程代次、owner SID、开始/结束时间及晚到事件
  ├─ ScopeCollector：own/machine 授权范围、租约、1s 快照与数据质量
  ├─ HistoryStore：完整桶、coverage、SQLite 单写者与迁移
  └─ 本机命名管道：认证后的查询 + 有限采集控制

普通用户：Electron 宿主（驻留；业务页按需）
  ├─ native entry main → spark233.TrafficClient.exe --bridge
  │    ├─ 持有所属采集租约、续租、查询与降级
  │    └─ 原生协议 v1：init/activate/query/cancel/prepareStop/stop
  ├─ native entry widget → spark233.TrafficClient.exe --widget
  │    ├─ 原生协议 v1 与同一资源域，接受 prepareStop/stop
  │    └─ C# 原生分层窗；只查询快照，不自行启用采集
  └─ 插件页面：排行、曲线、历史、连接、设置与质量状态
```

服务不执行任意命令，不读取用户正文，不访问外网。业务控制只修改本服务的采集状态，不接受文件路径、可执行程序或其他服务名称。桥负责普通权限降级和数据整形；widget 不绕过插件启用、信任和生命周期规则。

### 3.1 成熟组件与正式构建

仓库可复用现有 native 协议、资源域、安装授权入口、受保护版本部署和 Win32 观察代码。现有 `node:sqlite` 属于 Node 运行时，不能直接作为 C# 服务的数据层；现有桥也没有可直接复用的 C# ETW 消费层。

以下为 **2026-10-31 核对官方包元数据后的 M0 候选基线**，并非已经还原或运行验证：

| 组件               | 推荐候选                                          | 现有能力不足与维护依据                                                                                                         |
| ------------------ | ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| ETW                | `Microsoft.Diagnostics.Tracing.TraceEvent 4.0.0`  | Microsoft/PerfView 维护，2026-10-14 稳定发布，MIT；目标 netstandard2.0，NuGet 计算兼容 net48。经 `NetworkEventSource` 封装使用 |
| SQLite             | `Microsoft.Data.Sqlite 10.0.14`                   | Microsoft 维护，2026-10-25 稳定发布，MIT；目标 netstandard2.0，NuGet 计算兼容 net48。经 `HistoryStore` 封装使用                |
| SQLite native 闭包 | 兼容的 `SQLitePCLRaw 2.1.14` 依赖族及 `e_sqlite3` | 2026-10-13 发布；适配层 Apache-2.0，SQLite 保留上游声明。固定完整传递依赖，不混用不同主版本                                    |

- 使用 net48 项目、选定 SDK/MSBuild、NuGet 锁文件和 locked restore。记录直接/传递依赖、许可证、目标位数及所有发布文件的哈希。
- .NET 包元数据兼容不等于真机兼容；M0 必须验证正式发布闭包在目标 Windows 和服务账号下的 ETW、SQLite、binding redirect 与 native 加载。
- 用户机运行预构建并签名的产物，不现场编译 SYSTEM 服务。选定支持架构后按架构发布，不以 AnyCPU 掩盖 native DLL 位数差异。
- TraceEvent 的架构相关资产及 SQLite native 库均纳入发布检查。只有证明正式使用路径不需要的文件才可剔除。
- 服务加载的全部 DLL 随版本部署到受保护代码目录；不从用户目录或可写 cwd 搜索依赖。不为省一个 DLL 改用版本随系统变化的 SQLite。
- C++/Rust 是验证失败时的技术备选；更换需重新证明解析、丢失监控、服务生命周期、依赖和发布链路。

桌面卡片另有 [桌面窗口层评审稿](desktop-widget-layer.md)。本版 HUD 保持独立 C# 原生渲染，该层不作为本功能前置依赖；层落地后可仅替换展示端，服务、身份、历史和授权合同继续复用。是否迁移按完整进程树、交互与隔离验证决定，不预设必然省多少内存。当前版与未来展示层都依赖宿主生命周期，不能以此推导当前 HUD 可脱离 Electron 独立常驻。

## 4. 采集设计

### 4.1 事件白名单与会话

本机 manifest 元数据核对结果：提供者 `Microsoft-Windows-Kernel-Network`，GUID `7dd42a49-5329-4832-8dfd-43d979153a88`，当前收发事件版本为 0：

| 类型     | 发送 EventId | 接收 EventId |
| -------- | ------------ | ------------ |
| TCP IPv4 | 10           | 11           |
| TCP IPv6 | 26           | 27           |
| UDP IPv4 | 42           | 43           |
| UDP IPv6 | 58           | 59           |

事件 12–17 包含连接、断开、重传、接受、重连和失败，不能当作其余收发组合；失败事件也不保证包含 PID/size。只有明确映射的收发事件进入字节聚合，额外连接事件只进入对应拓扑逻辑。

会话路径按以下顺序由正式适配器验证，选用通过 M0 的路径：

1. 自有命名的普通实时会话，启用 manifest 网络提供者及必要进程元数据来源。
2. 自有命名的 system logger，使用 `EVENT_TRACE_SYSTEM_LOGGER_MODE`、独立 session GUID 和所需网络/进程标志。Windows 8 起支持多个 SystemTraceProvider logger，不能把它概括为只能使用唯一 NT Kernel Logger。
3. 仅在前两条有明确不兼容证据时评估自有的 NT Kernel Logger 路径；已存在则记录冲突并放弃，不附着后关闭、不抢占、不自动取消 WPR。

“自有命名会话”不指 `EVENT_TRACE_PRIVATE_LOGGER_MODE`。普通提供者会话、system logger 和经典内核事件使用不同来源适配，不能共享仅按 EventId 判断的解析器。来源识别至少包含 provider GUID、EventId/Opcode、Version 和必要的事件头布局标记；PID 取已验证的事件载荷，不把回调线程/事件头 PID 当成进程归属。

服务记录自建会话的名称、GUID 和启动结果；只有确认属于本实例的会话才可停止。崩溃残留仅按严格所有权规则恢复。权限不足、会话冲突、来源不支持和资源不足分别返回错误，不统一提示“被抓包工具占用”。

### 4.2 进程身份与事件时间

- 结合启动枚举、进程 start/stop/rundown 和按需查询建立代次表。已知实例内部关联 `bootId + PID + createdFileTime`，外部使用持久化的 `processInstanceId` 字符串。
- 进程名、完整映像路径、创建时间和 owner SID 都是元数据，不能使用映像名或 PID 单独作为身份。缓存按实例失效，短期墓碑保留到允许的晚到窗口之后。
- 以事件时间匹配进程生命周期；晚到的旧代次事件不能归给当前占用同一 PID 的进程。单靠一次 `OpenProcess` 得到的当前创建时间不足以完成关联。
- 无法确认代次或 owner 时标为 unresolved，使用独立临时身份及有界待解析队列；只有证明同一实例才补齐身份。不能把未知进程归给请求用户，也不能跨代合并。
- own 范围仅聚合 owner SID 已确认且匹配的事件；machine 范围可展示归属不明项，并附质量标记。未知路径不向未获全机授权的调用者泄露。

### 4.3 聚合、覆盖与质量

- 事件回调只做必要校验和有界入队/计数；进程解析、JSON、数据库、日志和慢查询不得阻塞实时消费。队列溢出必须计数。
- 使用单调时钟计算采样耗时和速率，UTC 事件时间划分历史桶；返回 `windowStart/windowEnd/elapsedMs`。系统校时、睡眠和恢复不产生负速率或巨型补偿尖峰。
- 每 1s 发布不可变快照和递增 `snapshotId`；最近曲线保留 60s。累计值、窗口增量和每秒速率分别命名，避免重复差分。
- `own:<SID>` 与 `machine` 是不同存储范围。同一范围内同一事件只计一次；两种范围同时启用时分别形成账本，不能再相加作为全机总量。
- 返回 ETW `EventsLost/RealTimeBuffersLost`、应用队列丢失、解析错误、身份未解析计数、来源和 `collectorEpoch`。重启换 epoch，计数重置不冒充数据改善。
- 丢失、进程身份不可恢复或停采区间进入 coverage/quality，不能靠放大剩余进程字节或填零修补。

### 4.4 接口总量与进程量的比较

`GetIfTable2` 只用于接口统计和辅助诊断，不作为进程统计的等式真值：

- 接口以 LUID/GUID 等稳定身份映射，显示别名仅用于展示；用户可选择接口。默认排除 loopback，物理与虚拟/隧道接口不做无条件求和，避免重复计算。
- 明确总速包含 LAN；无可验证依据时不宣称已分离互联网流量。接口热插拔、计数器重置和睡眠恢复重新建立基线。
- ETW 与接口 octets 的层级、范围、协议开销、重传与时间边界可能不同；仅在可比范围中提供有符号 `differenceRxBytes/differenceTxBytes`，不可比时返回 null 和原因。
- UI 名称为“统计差异”，允许负值；不命名为“未归属（系统/驱动）”，不把差值用于补齐某个进程或历史账本。

### 4.5 TCP 与 UDP 明细

- TCP：普通权限调用 `GetExtendedTcpTable`，覆盖 AF_INET/AF_INET6；区分已建立、监听和其他状态，说明轮询会漏掉短连接。服务不越过 scope 返回其他用户端点。
- UDP 本地端点：`GetExtendedUdpTable` 只返回本地地址/端口和 PID，不包含远端。服务不可用时仅提供此表。
- UDP 观察流：仅在 ETW 有效时，以进程实例、IP 家族、本地/远端地址端口及必要的 IPv6 scope 构成键；记录首次/末次观察时间、方向和字节。默认 60s 无事件过期，可配置，设有界容量并报告淘汰。
- 一个 UDP socket 可对应多个远端，QUIC 迁移可出现多个端点组合；UI 使用“近期 UDP 流”，不展示推断出的 QUIC 逻辑连接数。
- 远端地址只保留内存，关闭明细后清理对应缓存；不做域名反查、不把地址写入历史、日志或崩溃诊断。

## 5. 完整历史与持久化

### 5.1 数据模型

SQLite 由服务单写者独占管理，WAL；用户通过认证管道查询，不直接打开数据库。以下为逻辑 schema，正式迁移脚本在实现时维护：

```sql
CREATE TABLE process_instance (
  instance_id TEXT PRIMARY KEY,
  boot_id TEXT NOT NULL,
  pid INTEGER NOT NULL,
  created_filetime TEXT,
  owner_sid TEXT,
  image_path TEXT,
  identity_state TEXT NOT NULL
);
CREATE TABLE traffic_bucket (
  scope_id TEXT NOT NULL,
  resolution_sec INTEGER NOT NULL CHECK(resolution_sec IN (60, 3600, 86400)),
  bucket_start_utc INTEGER NOT NULL,
  instance_id TEXT NOT NULL REFERENCES process_instance(instance_id),
  rx_bytes INTEGER NOT NULL CHECK(rx_bytes >= 0),
  tx_bytes INTEGER NOT NULL CHECK(tx_bytes >= 0),
  quality_flags INTEGER NOT NULL,
  PRIMARY KEY(scope_id, resolution_sec, bucket_start_utc, instance_id)
);
CREATE TABLE coverage_interval (
  scope_id TEXT NOT NULL,
  collector_epoch TEXT NOT NULL,
  start_utc_ms INTEGER NOT NULL,
  end_utc_ms INTEGER NOT NULL,
  state TEXT NOT NULL,
  reason TEXT NOT NULL,
  PRIMARY KEY(scope_id, collector_epoch, start_utc_ms)
);
```

- `scope_id` 由服务生成和授权，客户端不能提交任意 SID。process 元数据在仍被任一桶引用时保留。
- UTC 秒构成固定桶边界，区间采用 `[from,to)`；本地日期转换只在查询/显示层执行，明确跨时区和夏令时行为。
- 分钟 48h、小时 90 天、天 2 年内完整保留有流量的实例；无流量可稀疏存储，但必须结合 coverage 区分“观测为零”和“没有采集”。
- 按完整映像路径分组是查询选项，不能覆盖原始实例。未解析路径不合并成某个已知应用。
- 字节用有符号 64 位非负 INTEGER，并检查溢出；协议传十进制字符串，前端用 BigInt 或明确的格式化边界处理，不先转为不安全 Number。

### 5.2 写盘、分层与清理

- 正常运行以固定 30s 批次事务持久化；字节阈值只用于内存压力决策，不允许每累计 1 MB 就触发一次事务。压力触发的提交设置最短 5s 间隔；正常停止、停用、升级时执行最终提交。
- 写入当前完整桶值或使用有唯一批次身份的增量，重试必须幂等。小时/天层由完整事实更新，桶、聚合游标和提交标记在同一事务中一致推进。
- 在上层已完整且持久化之前不删除下层贡献；允许窗口内的晚到事件同步修正受影响层。超出可恢复窗口的事件明确标质量，不静默改错桶。
- 保留清理分批执行，和查询/写者协调；若采用 incremental vacuum，在建库时明确设置 `auto_vacuum=INCREMENTAL`。WAL checkpoint 与清理单独节流。
- 磁盘度量包括 DB、WAL、SHM、备份和暂存，不承诺固定小于 50 MB。按实际活跃实例数、路径字典及保留策略测量。
- 磁盘不足时先停止写盘并标记 storage gap，仍可保留有界实时视图；不自动通过 TopN 或缩短保留期掩盖数据丢失。
- 正常停止以最后确认的 durable 时间为准。崩溃/断电可能丢失未提交批次，恢复后标记不确定区间；未知丢失量不得写成零。

### 5.3 目录与 ACL

- 服务代码：`%ProgramData%\spark233\traffic\service\<version-id>\`，SYSTEM/Administrators 可写，用户仅获得运行所需的读取执行权限。
- 数据与服务状态：`%ProgramData%\spark233\traffic\data\`，仅 SYSTEM/Administrators 可访问；history.db、WAL、SHM、备份、授权与启用状态继承该限制，**不授予 BU 读取历史权限**。
- 复用 search 的 owner、DACL、reparse 拒绝和受保护版本检查，代码目录的用户读取 ACL 不得照搬到历史目录。
- 普通用户 widget 设置归插件 `dataDir`，由 native init 下发；不另建游离于插件生命周期的全局配置路径。

## 6. 管道协议与授权

### 6.1 认证和有限操作

服务使用版本化本机命名管道 `\\.\pipe\spark233-traffic-v1`，消息模式、UTF-8 JSON-line；这是本服务业务协议，不与宿主 native 协议混用。

- 拒绝远程客户端，显式配置 DACL。允许连接的 SID 来自管理员批准的服务使用名单，不能简单授权全部 Interactive Users。
- 每次连接从管道客户端 token 取得 SID、登录会话及必要的完整性/进程身份，校验后立即恢复服务线程身份。PID 仅作辅助证据，不能替代 token 授权。
- 查询默认 own；machine 查询必须命中该 SID 的全机授权。客户端传入的 SID、路径、插件 ID 或 scope_id 不能扩大权限。
- 白名单操作为 `status/snapshot/history/connections`、`lease.acquire/renew/release`、`scope.setEnabled`。控制只能作用于调用者已获准的范围，无任意文件、命令或 SCM 操作。
- 安装、卸载、授予/撤销 machine、切换服务版本只由固定 elevated helper 完成，不放入普通查询管道。
- 同一用户下获得原生执行能力的程序不构成 OS 权限沙箱；服务不声称能仅凭插件 ID 排除同 SID 的其他程序。宿主仍负责插件信任、启用状态和资源归属。

### 6.2 数据示例和有界查询

```jsonc
// 范围由服务按已认证调用者解释；没有任意 SID 参数
{"v":1,"id":"7","op":"snapshot","scope":"own","limit":100}
{"v":1,"id":"8","op":"history","scope":"own","from":"2026-10-30T00:00:00Z","to":"2026-10-31T00:00:00Z","resolutionSec":3600,"processInstanceId":"proc-uuid","limit":100}
{"v":1,"id":"9","op":"connections","scope":"own","kind":"udp-observed","limit":100}
{"v":1,"id":"10","op":"lease.acquire","scope":"own"}

// rxBytes/txBytes 是此窗口内字节；64 位数统一字符串
{"v":1,"id":"7","ok":true,"data":{
  "mode":"process","scope":"own","collectorEpoch":"epoch-uuid","snapshotId":"42",
  "windowStart":"2026-10-31T06:00:00Z","windowEnd":"2026-10-31T06:00:01Z","elapsedMs":1000,
  "quality":{"state":"good","eventsLost":"0","realtimeBuffersLost":"0","queueDropped":"0","parseErrors":"0","identityUnresolved":"0"},
  "processes":[{"processInstanceId":"proc-uuid","pid":1234,"createdFileTime":"132000000000000001","imagePath":"C:\\Program Files\\Example\\example.exe","rxBytes":"1234","txBytes":"567"}],
  "nextCursor":null
}}
```

- 每条服务协议消息最多 64 KiB；默认每页 100 项，上限 200，实际还按序列化字节预算分页。宿主 native 协议仍遵循其 1 MiB 上限。
- 同一分页快照固定 snapshotId，短期保留供翻页；游标绑定调用者、scope、查询参数与过期时间。过期返回 `cursor-expired`，不混入新快照。
- 历史按粒度和时间范围限制计算量；分页不静默丢记录。TopN 查询显式返回展示范围和其余合计，完整历史仍可按实例查询。
- 支持请求取消与有界执行时间；实时查询预算 1s，历史查询预算 5s，超时取消而非堵住采集线程。总并发和每 SID 配额通过代表负载确定，至少覆盖桥、widget 及主页面。
- 拆开返回进程总量、接口总量及可比性信息；差值各方向有符号，缺少可比依据时不填伪精确数字。
- history 返回 coverage/gaps、最早可用时间、粒度及 durable 时间。协议/数据库版本不兼容返回明确错误，禁止自动使用不兼容数据库。

## 7. 安装、采集与升级生命周期

### 7.1 安装和运行状态

服务安装沿用 search 的固定 helper、UAC 说明及受保护版本部署模式，但其真实 SYSTEM 路径仍需本功能自行验收，不将已有源码视为真机通过。

服务支持固定的安装、卸载、状态和版本切换入口；只复制固定发布清单内的文件，校验哈希/签名、owner、DACL、绝对路径、服务参数和 reparse。SCM 只注册受保护目录内的服务，不注册插件用户目录里的 EXE/DLL。

per-user 安装器可提供明确的可选服务步骤；silent 安装不弹交互 UAC，也不把未获权安装记录为成功。拒绝授权返回可重试状态，基础模式继续工作。

以下状态分别管理：

| 状态                       | 是否持久化                   | 含义                                                                              |
| -------------------------- | ---------------------------- | --------------------------------------------------------------------------------- |
| installed / grantedScopes  | 是                           | 服务部署及管理员允许该 SID 使用的范围                                             |
| enabled / generation       | 按调用者 SID 和 scope 持久化 | 用户启用意图和旧实例失效代次                                                      |
| lease                      | 否                           | 当前普通用户桥实例的有效消费许可，绑定 token 身份、登录会话、进程代次与服务 epoch |
| view open / widget visible | 插件保存恢复偏好             | UI 状态，不独立决定采集启停                                                       |

### 7.2 租约和采集状态机

- 桥在有效启用意图下申请租约，初始 TTL 15s，每 5s 续租；服务使用单调时钟计算期限。init 只握手，不隐式启用业务。
- 只有 `enabled && granted && leaseValid && generationMatches` 才为该范围聚合/落盘。停用后的旧租约不能续期或自行重新启用。
- 服务开机加载授权与意图，但等待普通用户宿主的合法启动激活取得租约。服务恢复后旧 lease 全部失效，桥经状态校验重新申请。
- 桥负责所属采集租约，widget 只查询，不因打开窗口另行永久启用采集。桥、窗口和主页面消费同一采集快照。
- 最后一个合法租约失效后停止自有 ETW 会话并完成有界收尾；其他用户仍有合法消费者时保留共享会话，仅路由到仍启用的范围。
- own 范围停用后不再产生该范围的新桶；已获明确授权的其他 machine 消费者可能继续记录全机账本，这是独立授权，不冒称能替其他用户停止它。
- 服务不可达、租约过期、未登录、宿主未运行、睡眠和恢复期间均有 coverage 状态。恢复不回填推测流量。

### 7.3 宿主行为与两阶段停止

| 动作                  | 必须发生的行为                                                                          |
| --------------------- | --------------------------------------------------------------------------------------- |
| 启动且插件已启用      | 无窗启动桥，校验授权/启用状态并申请租约；按明确的窗口恢复偏好决定是否显示 widget        |
| 关闭主页面            | 释放页面；桥与已开启 widget 按后台策略继续                                              |
| 关闭 widget           | 仅关闭该窗口并释放对应 native entry；不撤销桥的采集租约、不停用插件                     |
| 宿主正常退出/用户注销 | 最终落盘，释放本登录会话租约，停止所属桥/widget；保留启用意图供下次合法启动恢复         |
| 显式停用插件          | 持久化禁用所属范围、增加 generation、撤销同 SID 对应旧租约；释放桥/widget，停止所属聚合 |
| 插件更新              | 先保存并撤销旧实例租约，关闭旧入口，再启动新版；启用意图保留，失败恢复匹配版本          |
| 崩溃/断管             | 宿主按资源域回收已退出入口；服务通过 token/进程状态与租约 TTL 兜底，记录空白            |
| 卸载插件/应用         | 先按停用规则完成停止；服务与共享数据清理另走明确授权步骤，不能影响其他合法用户          |

`prepareStop` 只做可恢复的准备、状态检查和落盘确认，不提前提交不可逆停用；其他资源拒绝后必须能恢复工作。确认 `stop` 后才提交本次停用/释放决定，并等待服务确认及 native 进程实际退出。确认失败不能报“停用成功”；只有明确的强制退出可绕过正常保存，且依赖租约失效兜底，不能当成已完整落盘。

停用是同 SID、对应 scope 的明确状态改变；单个登录会话退出只是释放该会话 lease，不误停其他有效会话。machine grant 撤销由管理员操作，撤销立即使相关 generation/lease 失效。

### 7.4 版本切换、迁移和卸载

- 插件包版本、服务协议、服务二进制版本和数据库 schema 分别检查兼容，普通查询不自动触发 UAC 更新。
- helper 将完整发布闭包置于新的受保护版本目录，停止旧服务、完成最终提交/备份，再切换 SCM 路径。启动健康检查涵盖 schema、管道、授权状态和采集可恢复性。
- 数据库迁移前用 SQLite 一致性备份或明确停止写者并完成 checkpoint；不能只复制正在使用的 history.db。
- 回滚二进制必须匹配数据版本。新版若已接收新流量，先保全该库与增量，只有无损迁移或显式确认恢复点后才回退；禁止恢复旧库静默覆盖新数据。
- 更新卸载阶段保留服务和数据。彻底移除服务前检查其他用户使用情况，默认只撤销当前用户配置；全机服务移除和全机历史删除需要管理员明确选择。
- UAC 取消或 helper 缺失时保留受保护服务，并准确提示残留状态；当前用户插件停用和租约撤销仍需完成。保留数据和删除数据分别处理。

## 8. 原生悬浮窗与资源表现

### 8.1 技术选择

采用 C# 原生分层窗，复用与桥相同的非 UI 客户端模块，但不承诺单文件或单进程。框架/组件选择以真实 DPI、文字、交互与资源表现验证，不通过未经实测的语言内存排名作决定。

| 路线                    | 技术判断                                                                         |
| ----------------------- | -------------------------------------------------------------------------------- |
| C# 原生分层窗           | 本稿采用；可共享服务客户端与模型，Win32/DPI/透明绘制边界明确，需验证正式依赖闭包 |
| Electron 窗口           | 仍可作为功能回退；能复用网页 UI，但常开 renderer 的实际增量须计入完整进程树      |
| C++/Rust 原生           | 技术备选；按成熟组件、渲染质量、发布和维护实测比较，不因本机暂缺工具链排除       |
| WebView2 等嵌入网页方案 | 依然存在 WebView 运行时和进程开销，需实测，不预设一定比 Electron 更轻            |

Electron 宿主继续驻留，页面关闭不等于主进程消失。普通状态可能有服务、桥、widget 和 Electron；必须测量实际完整进程树及各组件增量，不再承诺“正常态只有两个进程”。

### 8.2 窗口与运行归属

- 包内固定 native 入口 `main --bridge` 与 `widget --widget`，均实现原生协议 v1。stdin/stdout 仅用于协议，日志走 stderr。初始化/安装检查不能创建窗口或采集。
- 宿主增加按已声明 entry 正常释放的能力，复用资源域与 `prepareStop/stop`；renderer 不得指定任意 PID、路径或强杀进程。窗口关闭请求由宿主处理并等待 entry 退出。
- 启动恢复 widget 属于需补齐的宿主声明/恢复策略，只有插件启用且用户选择恢复时才执行；不能在 on-startup 的 init 中偷偷开窗绕过当前无窗启动规则。
- 实例锁至少包含用户 SID、登录会话及插件运行实例边界，支持不同登录会话，避免全局 mutex 互相阻断。
- 位置、显示器稳定 ID、相对坐标、透明度、置顶、显示密度和恢复偏好保存在插件 dataDir；多入口经原子保存/协调共享设置，避免互相覆盖。
- 正常以 1Hz 查询授权范围快照；服务不可用时复用非 UI totals 采样代码，不再启动额外桥来采样。采集暂停与服务缺失分别标示，窗口不自动取得或提升权限。

### 8.3 绘制与交互

- Win32 layered window，32bpp 预乘 BGRA。文字优先采用经过验证的 DirectWrite/Direct2D 与内存表面互操作，GDI+ 可处理基础图形；颜色通道及 alpha 只按约定预乘一次。
- 资源按窗口持有并复用，在尺寸/DPI 变化时重建，停止时释放 COM、GDI、计时器与管道。渲染失败可退回灰度抗锯齿文字，避免透明背景 ClearType 彩边。
- PerMonitorV2；处理 WM_DPICHANGED、显示器移除、工作区变化、睡眠恢复和浅深色主题。位置失效时回到可见工作区。
- 使用 tool window、置顶和不抢焦点策略，不进入任务栏或 Alt-Tab；默认可拖动，锁定后才允许穿透。
- 交互：左键拖动、贴边吸附；右键置顶/密度/打开主页面/设置/关闭窗口；双击展开。关闭窗口与停用插件分开。
- 首帧、重绘延迟、GDI 对象数和 24h 内存变化实测；不把固定帧耗时或内存估算写成已达成指标。

### 8.4 性能与容量验证

| 项目       | 记录方式与出口                                                                                                     |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| CPU        | 记录单核等价时间及整机百分比，覆盖空闲、代表大包传输、小包高事件率；包含服务、桥、widget、Electron 与相关 ETW 开销 |
| 内存       | working set、private bytes、队列/缓存上限、GDI/句柄；比较无 widget、有 widget、主页面打开及停用状态                |
| 端到端延迟 | 从事件时间到快照再到界面，计入 ETW flush、1s 结算、轮询和 IPC；记录分布，M0 后冻结可兑现阈值                       |
| 吞吐与质量 | 按事件率而非仅按 Gbps 描述；代表负载下无静默丢失，超预算时有明确质量降级与有界资源                                 |
| IPC        | 记录真实分页字节和延迟，不用固定 2 KB/s 反向截断数据                                                               |
| 历史容量   | 记录 DB/WAL/备份、活跃实例与保留范围，验证层间总量和回收，不承诺固定 50 MB                                         |
| 停用       | 正常停用确认后无所属采集、写盘、租约、窗口和桥残留；他人独立授权活动单独列明                                       |
| 长期运行   | 24h 代表采样及恢复检查，区分正常 GC 波动与持续增长；保留测量环境和原始证据                                         |

M0/M1 先给出实测基线和运行上限，再形成发布验收阈值。不能以降低准确性或不显示丢失来满足低 CPU/低内存数字。

## 9. 降级与失败矩阵

| 场景                         | 行为                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| 服务未安装/授权取消          | totals + TCP 表 + UDP 本地端点；按进程、UDP 远端和相应历史明确不可用             |
| 服务已安装但暂停/无租约      | 显示暂停或等待宿主，不误报成被抓包工具占用，不自行重新启用                       |
| 会话冲突/来源不支持/权限不足 | 独立错误码；有限退避或用户重试，不抢占其他会话                                   |
| ETW 丢失/解析失败/未知身份   | 显示质量及 coverage；连续不可用时退回 totals，保留不完整区间                     |
| 服务/管道断开                | 有上限的重连和抖动退避；重建 lease 前重新校验 epoch、generation 和启用状态       |
| 服务崩溃/恢复                | SCM 有限恢复，旧 lease 失效；桥恢复授权消费前不采集，历史标记空白                |
| 历史库损坏/磁盘不足          | 保全 DB/WAL/诊断，暂停受影响写者；经明确恢复流程新建或恢复，不把损坏等同于零历史 |
| widget 渲染或显示器变化      | 回退文字/重建表面/移回工作区；不阻塞采集线程                                     |
| 协议或 schema 不兼容         | 提示匹配升级或回滚入口，不自动读写不兼容数据                                     |

## 10. 安全、隐私与维护

- 服务只监听本机管道；业务过程不联网、不解析正文，不记录远端 IP/域名到历史和日志。
- own 只返回经 token 授权的 SID 范围；machine 的采集与读取在授权界面明确说明含其他用户和系统进程。
- 数据库、WAL、备份和授权状态不向普通用户直接开放；代码目录和数据目录分别保护。
- 普通管道只接受有限业务操作；参数、长度、页数、并发、速率和执行时间均有上限。
- 服务、桥、widget 及发布依赖纳入签名/哈希清单、许可证和补丁维护；签名不能替代权限控制，不保证不会被 EDR 拦截。
- 版本检查、数据迁移、机器授权和卸载由固定 helper 处理；不把用户可写 EXE 或 DLL 加载到 SYSTEM 进程。
- 历史清理与卸载尊重用户数据保留选择，跨用户数据删除需管理员明确授权。维护、恢复和导出均不得绕过 scope 权限。

## 11. 验证与验收

### 11.1 M0：先修正探针，再验证正式路径

现有 [PowerShell 探针](../local-build/spike/etw-network-probe.ps1) **不能直接作为可执行验收入口**：它会无条件停止 NT Kernel Logger/WPR，且仅以 CSV 提供者字样判断事件存在。本次只修订文档，探针尚未修复，也未重新运行。

M0 出口必须同时满足：

1. 使用唯一自有会话名称和所有权记录；仅清理本次成功创建的会话。启动失败不能执行全局 stop/cancel，也不能删除别人的任务或作业。
2. 每种候选路径独立产生受控流量，记录进程实例、协议、IP 家族、方向、传输有效载荷和时间。TCP/UDP v4/v6 分别确认，不以 DNS/浏览网页替代全部覆盖。
3. 用正式选定的 C# 消费器实时接收，保存脱敏 schema/事件样本，验证提供者、版本、PID、size、端点及丢失计数。ETL/CSV 仅为辅助诊断，不替代正式实时链路。
4. 将已知有效载荷、ETW 观察量和接口 octets 分开比较；说明每层差异来源与实际允许偏差，不强求三者相等。
5. 验证进程退出、PID 复用/晚到事件和未解析身份处理；无法确认的字节保持未知，不归错进程。
6. 核对固定 NuGet 闭包、目标位数和 native 加载，在隔离目录完成 net48 发布、ETW 与 SQLite/WAL 读写；SYSTEM 账号路径须有单独实测。
7. 报告候选路径成功/失败原因、事件覆盖、正式消费延迟、事件率、资源开销及未验证边界。没有数据或只有关键字命中不算通过。

管理员执行、SYSTEM 部署和代表网络环境由真实操作证明；缺少条件时保留未验证项，不勾选通过。

### 11.2 最小必要验证

- 复用现有 smoke、生命周期和权限验证；不为每条验收项新增测试文件或搭建完整矩阵。
- 仅在现有证据不足时补最小必要保护：事件/schema 适配、身份代次与大整数、幂等聚合/恢复、SID/lease/generation 隔离、停用与更新回滚等真实不变量。优先加强已有验证，一个风险在最低有效层证明一次。
- 服务与客户端手工代表链路涵盖 own/machine、授权拒绝、短进程、UDP、停用、重启、租约过期、升级及失败恢复；不把纯 init 握手当成业务通过。
- Windows 集成沿用 `pwsh -File scripts/smoke-windows.ps1`；数据、profile、插件、构建和流量接收端隔离在 `local-build/` 或明确临时目录，不使用真实便签/剪贴板/历史。
- 实现或边界变更收口执行仓库规定的 `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build` 及相关原生构建；纯文档修订只做内容、格式和链接核对。
- 视觉验收按仓库约定留到功能链路稳定后，覆盖少量代表 DPI/多屏和交互，不先建设 UI 自动化矩阵。

## 12. 实施顺序与阶段出口

不列人日、人月或工期，以技术依赖和可验证出口推进。

| 阶段 | 交付内容                                              | 出口                                                 |
| ---- | ----------------------------------------------------- | ---------------------------------------------------- |
| M0   | 安全探针、正式 ETW 适配候选、依赖与发布闭包、统计口径 | §11.1 有实际证据，来源和不能覆盖的范围明确           |
| M1   | 服务、身份目录、范围授权、租约、快照、完整历史        | 受控传输正确归属，SID 隔离、幂等提交与覆盖区间可核对 |
| M2   | 用户桥、普通权限降级、分页/取消及有限业务控制         | 服务不可用可降级；协议和生命周期不扩大权限           |
| M3   | 插件声明、后台激活、按 entry 资源释放与窗口恢复策略   | 现有宿主合同真实接入；停用/退出/更新无所属资源残留   |
| M4a  | C# 原生窗口、DPI/主题/交互、设置与客户端复用          | 原生入口可管理，完整进程树资源和长期表现实测         |
| M4b  | 排行、曲线、完整历史、TCP/UDP 明细与状态 UI           | 进程身份、授权范围、分页和质量信息展示正确           |
| M5   | 受保护安装、签名、迁移/回滚、卸载、打包与验收         | 真机 UAC/SYSTEM 路径、数据保留与匹配回滚证明通过     |

## 13. 实现前检查清单

- [ ] 修正旧探针的会话/作业所有权与判定规则，随后执行 M0。
- [ ] 确认正式 ETW 路径和版本化 schema；不再使用事件 10–17 的错误组合。
- [ ] 固定候选包完整锁文件、目标架构、native 发布清单及许可证。
- [ ] 明确当前用户授权与可选全机授权，并验证数据库 ACL、调用者 token 和分页权限。
- [ ] 完成字符串进程身份、完整三层桶、coverage、幂等写入及一致性备份合同。
- [ ] 将桥与 widget 纳入宿主资源域，补齐按 entry 释放和经授权的启动恢复。
- [ ] 用启用意图、generation 和运行租约证明停用/退出/恢复行为。
- [ ] 根据正式链路测量冻结资源与延迟阈值，不以未经验证的数字作为已达成结果。

## 14. 已有证据与待验证边界

- 已核对本机 manifest 网络提供者的收发事件映射，并确认将 FILETIME 放入 JavaScript JSON number 会丢精度。
- 已核对现有 native 协议、宿主启停资源域及 search 的受保护服务安装实现；它们提供复用基础，不能替代本功能的实际服务验收。
- 已核对候选 NuGet 的版本、发布日期、目标框架与许可证；没有据此声称包还原、net48 运行、SYSTEM 加载或性能已通过。
- 未执行修正后的 M0，未安装本功能服务，未实现插件、窗口和历史链路。当前阻塞是上述技术证据，不是等待工作量签字。
- 开发机器的编译器、权限和输出目录按实现时状态检查；构建失败保留具体证据，不把历史会话的权限现象写成永久平台限制。

## 15. 官方资料

- [配置 SystemTraceProvider 与命名 system logger](https://learn.microsoft.com/en-us/windows/win32/etw/configuring-and-starting-a-systemtraceprovider-session)
- [ETW logging mode 与实时缓冲行为](https://learn.microsoft.com/en-us/windows/win32/etw/logging-mode-constants)
- [EVENT_TRACE_PROPERTIES：flush 与丢失计数](https://learn.microsoft.com/en-us/windows/win32/api/evntrace/ns-evntrace-event_trace_properties)
- [GetExtendedTcpTable](https://learn.microsoft.com/en-us/windows/win32/api/iphlpapi/nf-iphlpapi-getextendedtcptable)、[UDP 本地端点结构](https://learn.microsoft.com/en-us/windows/win32/api/udpmib/ns-udpmib-mib_udprow_owner_pid)、[接口计数 MIB_IF_ROW2](https://learn.microsoft.com/en-us/windows/win32/api/netioapi/ns-netioapi-mib_if_row2)
- [TraceEvent 4.0.0](https://www.nuget.org/packages/Microsoft.Diagnostics.Tracing.TraceEvent/4.0.0)、[官方发布资产](https://github.com/microsoft/perfview/blob/v4.0.0/src/TraceEvent/Microsoft.Diagnostics.Tracing.TraceEvent.nuspec)
- [Microsoft.Data.Sqlite 10.0.14](https://www.nuget.org/packages/Microsoft.Data.Sqlite/10.0.14)、[SQLitePCLRaw 2.1.14](https://www.nuget.org/packages/SQLitePCLRaw.bundle_e_sqlite3/2.1.14)、[SQLite native bundle 选择](https://learn.microsoft.com/en-us/dotnet/standard/data/sqlite/custom-versions)

# P7.2 更新合同与真实 HTTPS 下载中断

日期：2026-10-25。按 TODO 原文核对：自动检查且用户确认更新、精确版本、完整性、下载中断、离线导入、能力重新授权、兼容拒绝与失败回滚，不向客户端分发发布凭据。公网 npm scope/账号/正式发布属于 P7.1，不把它额外加入 P7.2。

## 已有权威证据与准确范围

| 原要求                 | 已有依据                                                                                                                                                                                                                                                                                                                     |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 自动检查、用户确认更新 | `plugin-crash-functional/registry-https-runs/2c800235-257d-447c-8416-e8e459bc3560/report.json` 及 child report：生产 DesktopPluginHost 重启后自动发现 0.2.0，只读 metadata，不下载/切换；prepare 仅产生 preview，明确 confirm 才更新。                                                                                       |
| 精确版本               | 同一真实 HTTPS 链分别解析、下载并安装 0.1.0/0.2.0，identity-bound manifest、SRI、精确版本目录与 source 均保留；生产安装器拒绝覆盖相同精确版本。                                                                                                                                                                              |
| 完整性                 | 同链真实下载错误 SRI，生产校验拒绝，旧版本、正文、pending、staging 保持；修正 SRI 后才可 prepare/confirm。正式七包还有逐成员与散列审计。                                                                                                                                                                                     |
| 下载中断               | 此前只证明 SRI/取消合同，未记录真正中断的 HTTP body；本次只补下节一条真实流断开代表。                                                                                                                                                                                                                                        |
| 离线导入               | `desktop-host/runs/2026-10-25T04-52-23-527Z/report.json` 的本地 tgz/preview 重启确认及开发目录不可变快照链；`desktop-host/runs/2026-10-25T06-20-07-667Z/report.json` 官方离线目录链。较早 measurement 的真实官方 clipboard 卸载保数据/离线重装有独立证据，不改绑为新包重跑结果。                                             |
| 能力重新授权           | 本次补充的连续报告 `registry-https-runs/5f3c4dc2-865e-42e4-a621-634959c586b1/report.json`：v2 真正新增 `network`，preview 展示新能力，确认前旧 grant/owner/状态/正文全部相同；明确 confirm 后才切换新 owner 和新版 grant。没有调用该网络能力。旧 Web 未授权调用拒绝证明继续复用。                                            |
| 兼容拒绝               | 同一补充报告中的 v0.3.0 是完整有效 Hello Web 清单，明确要求宿主 `>=99.0.0 <100`；生产 manifest 在符合范围的 host99 校验通过，实际 host1.2.0 的生产 resolver 对精确 `0.3.0` 请求返回 `No compatible ...`，未请求该 tarball，已安装 v2/数据/owner 不变。没有用缺少插件 schema 的普通 npm 包冒充本条。                          |
| 失败回滚               | `evidence/plugins-manager/runs/01692e0c-da6c-4562-a783-9368d5006b42/report.json` 的 14 项当前 manager 证据：失败新版本恢复旧代码/启停、原数据和匹配 dataVersion，新版新增数据保护，switched/migrating journal 重启恢复。最终包已核对 manager/backup 编译模块相同。                                                           |
| 不向客户端分发发布凭据 | 产品是只读 HTTPS metadata/tarball 消费者，没有 npm publish/login 入口或给客户端供应发布 token 的配置路径。`registryPackageUrl` 明确拒绝 URL 内用户名/密码，registry base 也不接受查询；客户端只接收来源、版本、SRI、能力和 preview。真实受控 registry 使用临时测试 TLS CA，不是发布凭据；本轮没有账号、registry 写入或发布。 |

上表路径除 `evidence/plugins-manager/` 外均以 `local-build/spark233/` 为前缀；前者位于 `local-build/evidence/`。历史证据的具体输入与限制继续保留，不将它们统一改写为最新 ASAR 的运行结果。

## 仅新增的一条真实中断代表

扩展既有 `plugin-crash-functional/registry-https.mjs` / `registry-https-child.cjs`，增加环境控制的 `interrupted-download-only` 模式。没有新 Vitest、框架、产品 helper 或产品源码修改，不运行 shared build/pack，不修改最终安装包与 artifact 报告。

本次实际导入 **最终 `ui-contract-followup` ASAR 内的 `dist-electron` 模块**，不是较早默认 registry-compiled。DesktopPluginHost、installer、resolver、archive、I/O、manager、WebRuntime 的七份实际编译模块 SHA-256 保存在 child report。ASAR 身份为：

`94ed07fe0a851d40a9110fef9567d97f7c7a9528af18faee9aa3ac77fd83e836`

先通过生产 prepare/confirm 安装 Hello Web 0.1.0，隐藏页面完成真实 SDK 握手，用真实 storage IPC 写入私有正文。随后将受控 registry 的 latest 切到 0.2.0，metadata 给出正确的完整 SRI；v2 tarball 响应声明 Content-Length **4,795 字节**，实际经 TLS 1.3 发送 **512 字节**后由服务端 `response.destroy()` 断开，既未发送剩余内容，也未正常结束响应。

生产 `plugins_prepare_update` 经 npm-registry-fetch 和 stream pipeline 实际返回 **`ECONNRESET` / `aborted`**。断开前后的断言共同证明：

- 已安装 state 文件 SHA-256 相同，仍是 0.1.0。
- 实际 Web 业务数据文件 SHA-256 相同；旧窗口真实 `storage.get` 仍读回原正文。
- plugin instance ID 与窗口 ID 均相同，没有产生新版 runtime 或半包激活。
- pending 为 0，staging 为空，0.2.0 精确版本目录不存在。
- 全程没有可见插件窗口，shutdown 后旧 renderer 也释放。

本次报告：`local-build/spark233/plugin-crash-functional/registry-https-runs/8166670c-f02b-4ec1-9b93-c250902e58cd/report.json`，**`ok:true`**；父传输检查与 child 检查均通过，运行退出 0。`requests` 保留 declaredBytes/sentBytes/streamDestroyed 及真实 TLS 版本；`child.interruption` 保存完整 before/after hash、实例、窗口和具体拒绝错误。

父进程默认信任库对临时证书的请求实际失败 `DEPTH_ZERO_SELF_SIGNED_CERT`；仅测试子进程通过 `NODE_EXTRA_CA_CERTS` 增加本 run 的临时 CA，没有关闭 TLS 校验或修改系统证书存储。所有归档、证书、profile、数据、状态与日志均在该 fresh run 中，没有调用用户便签、剪贴板、截图、UAC、SYSTEM 服务或 Windows 点选。

## 复现与绑定

根任务复核指出，原有源码合同和非插件 metadata 拒绝对“新增能力”和“有效插件版本不兼容”仍偏间接，因此又补了**一条连续场景**，没有重跑已通过的中断模式或原完整 registry 套件：

`local-build/spark233/plugin-crash-functional/registry-https-runs/5f3c4dc2-865e-42e4-a621-634959c586b1/report.json` 为 **`ok:true`**，退出 0；child 八项检查、父传输检查均通过。该 run 同样加载最终 ASAR 的七份实际模块，绑定同一 ASAR hash。

v1 只授予 storage；准备 v2 时新版清单实际是 `[storage, network]`。生产 preview 暴露该新集合，旧持久 state hash、业务 data hash、grant、instance ID 和 window ID 与准备前相同。显式 confirm 后，新版本、新 instance 和完整新 grant 才出现，旧正文仍可通过新版真实 storage IPC 读取。`networkCapabilityWasInvoked:false`，没有请求第三方网络或剪贴板。

随后生产 resolver 收到结构完整的 v0.3.0，清单 host 范围为 `>=99.0.0 <100`、API 为有效 `^1.0.0`。先由同一生产 manifest validator 在 host99 环境成功校验该包，确认不是 schema 缺失；再通过真实 TLS metadata 对实际 host1.2.0 发精确版本范围 `0.3.0`，生产 resolver 拒绝无兼容版本。请求日志没有 v3 tarball，拒绝前后的 v2 state/data/grant/instance/window 完全相同，pending 0、staging 空、无 v3 目录。shutdown 后窗口全部释放。

这条场景首次尝试 `e22bdac1-8fd9-47dd-8ea3-40d231b007f6` 在 v1 初装阶段的 state.json 原子 rename 遇 Windows `EPERM`，尚未进入新增能力或兼容断言；失败报告原样保留。未修改产品或断言，用 fresh run 单次重放得到上述通过结果。没有声称解决了操作系统瞬态文件锁。

项目选定 Node 26.12.1 / npm 12.2.1 下：

```powershell
. ./scripts/use-toolchain.ps1
$env:SPARK233_REGISTRY_INTERRUPTION_ONLY = '1'
$env:SPARK233_REGISTRY_INPUT_ASAR = Join-Path (Get-Location) 'local-build/spark233/ui-contract-followup/release/win-unpacked/resources/app.asar'
$env:SPARK233_REGISTRY_COMPILED = Join-Path $env:SPARK233_REGISTRY_INPUT_ASAR 'dist-electron'
node local-build/spark233/plugin-crash-functional/registry-https.mjs
```

要运行新增能力/兼容这条场景，保持同一 ASAR/compiled 环境变量，清除 `SPARK233_REGISTRY_INTERRUPTION_ONLY`，改设 `SPARK233_REGISTRY_CAPABILITY_COMPATIBILITY_ONLY='1'`。两种模式分别运行，补充场景不重复中断断言。

两份现有 runner 的 Node 语法检查通过。七份实际 ASAR 模块与对应当前 TypeScript 源输入在 `input-hashes.json` 中核对，当前源码还与该候选冻结输入相同；同时复核安装包和 ASAR 散列均保持原身份。没有为此重复已通过的 lint/test/build、完整 registry 正常升级、SDK/native 或 packaged smoke。

本报告不声称网络自动断点续传、任意代理/公网故障矩阵或用户操作物理安装界面已验收；原 P7.2 没有要求增加这些范围。是否勾选总 TODO 由 root 按原条目及上表各类证据统一处理。

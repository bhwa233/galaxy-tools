# 外部原生插件协议 v1

本协议供明确实现 spark233 宿主协议的可信原生程序使用，不自动适配普通 EXE 的命令行或窗口。官方截图、OCR、剪贴板和搜索仍使用各自专用 adapter。Web 插件调用原生能力时只选择本插件清单声明的入口 ID 和公开命令；renderer 不能提交可执行路径或进程参数。

类型定义见 [native-protocol.ts](../packages/sdk/src/native-protocol.ts)，宿主实现见 [native-runtime.ts](../electron/plugins/native-runtime.ts)。SDK 入口导出 `NATIVE_PLUGIN_PROTOCOL`、`NativePluginRequest` 和 `NativePluginMessage`。

## 程序与权限

清单必须声明 `native.process` 能力，安装授权必须包含原生信任。可执行文件必须属于已验证插件目录，启动只使用该清单中的固定 `path` 和 `args`，不经过 shell。程序以宿主当前用户身份运行；显式原生信任不是操作系统沙箱。

只有一个原生入口时默认使用该入口；有多个入口时，默认命令使用名为 `main` 的入口，没有 `main` 则拒绝歧义，不能任意挑选。显式调用仍可使用已声明的入口 ID。每个入口按需启动一个持久进程，宿主为其创建独立 session。native-only 插件安装/更新的启动检查执行默认入口 `init` 握手；Web 插件的附带原生入口保持按需启动。

程序从 stdin 接收 UTF-8 JSON，每行一条；stdout 只输出协议 JSON 行，诊断使用 stderr。支持 LF 和 CRLF，UTF-8 字符可以跨系统管道 chunk。每个请求和响应行最多 1 MiB，限制以 UTF-8 字节计；每个入口最多 64 个同时等待的请求。输入和输出都是 JSON 数据，不是 shell 文本。

## 身份与消息

每条消息都带 `protocol: 1`、`owner`、`sessionId` 和 `requestId`。`owner` 含 `pluginId`、`version`、`instanceId`；session 和 request 是宿主生成的 UUID。程序必须原样回传身份。错误身份、已取消或过期 request 的输出不能满足当前请求。

宿主请求类型：

| type          | 额外字段                         | 行为                                                             |
| ------------- | -------------------------------- | ---------------------------------------------------------------- |
| `init`        | `entryId`, `dataDir`, `cacheDir` | 初始化该实例，准备独立业务数据和缓存；不执行业务命令             |
| `activate`    | `activation`                     | 执行已授权命令，参数/上下文属于业务 JSON                         |
| `query`       | `activation`                     | 查询本地结果；新的默认 query 会取消旧 query                      |
| `cancel`      | 无                               | 取消**同一 requestId**的任务，无需响应；停止工作且不要发布旧结果 |
| `prepareStop` | `reason`                         | 保存并等待进行中的写入；可以明确拒绝停止                         |
| `stop`        | 无                               | 仅在保存确认成功后发送；清理并正常退出                           |

普通响应为 `{...identity, type:"response", ok:true, value?: JsonValue}`；失败为 `{...identity, type:"response", ok:false, error:"有界错误描述"}`，错误最多 4096 字符。消息中的 `ok` 表示 RPC 成败，`prepareStop.value.ok` 另表示是否允许停机。

初始化响应必须包含 `value: {ready:true, pid:<实际进程PID>}`。宿主核对实际 PID；不能只输出普通日志或一个任意成功字符串。

`prepareStop` 成功响应为 `value: {ok:true}`，拒绝为 `value: {ok:false, reason:"尚未保存的具体原因"}`。拒绝、超时和协议错误均不视为已保存，进程继续受追踪，存活业务进程不会因此被强杀。若其他资源拒绝停机后宿主恢复此实例，程序必须继续接受新的业务请求；下次停机重新保存确认。

收到 `stop` 后，程序先停止订阅、结束任务、完成资源释放，再响应成功并以退出码 0 结束。宿主仍等待实际退出；只有响应而没有退出不算释放成功。进程已经真实退出时，可通过 `crash` 语义回收；这不等于未保存业务得到成功确认。

事件为 `{...identity, type:"event", name:"事件名", payload?: JsonValue}`。任务事件使用对应请求 ID；后台事件可使用本次 `init` 的 request ID。事件名最多 80 字符，整个行仍受 1 MiB 限制。准备停机、过期实例和已释放资源的业务结果与事件被丢弃；每个在途业务请求都归属资源域 task，释放时协作取消，保存和停止控制 RPC 不受业务取消干扰。

## 取消、超时与启动失败

默认请求预算为 10 秒，宿主可配置上限 120 秒。普通请求超时或调用方取消只取消该任务、撤销其 request 身份，保留进程；迟到结果不会复用为其他请求的结果。程序应协作响应取消，不能把超时当作保存成功。

只有**未完成 init 握手、尚未获准执行业务命令**的启动失败可以由宿主终止进程。正常运行后的保存拒绝或超时不适用这个例外。错误协议或程序异常应向管理页报告，真实进程退出后可按崩溃流程释放资源。

查询返回启动器结果时，仍需符合宿主结果 schema 和本插件声明的命令；实现此协议不扩大命令、文件、窗口或其他插件数据权限。

## 当前实现证据

2026-10-25，隔离报告 `local-build/spark233/native-plugin-runtime/runs/2a455f14-36c7-491d-8f86-b414ef67f8d1/report.json` 的 10 条记录通过。真实 Electron 45 / Node 24.22 宿主把项目 Node 程序作为包内受控 native fixture 启动，证明固定参数与 cwd、owner/session/PID 握手、跨 chunk UTF-8 中文、未声明入口及缺少信任拒绝、调用方取消、保存拒绝后继续运行并重新正常停机。

在同一次代表生命周期中，一个业务结果被受控保留到 `prepareStop` 才发布，另一个任务持续等待；宿主分别拒绝准备阶段的旧结果，并在 scope 释放时取消剩余任务。另证真实进程退出码 7 的崩溃回收，以及不提供 init 握手的启动失败清理。三个进程 PID 为 10772、54624、29220，检查后均已退出。类型检查与聚焦 lint 通过，没有新增测试框架、访问真实剪贴板、执行 UAC 或使用用户数据；完整包安装和外部插件界面仍按主线程最终验收收口。

后续正式工厂链报告为 `local-build/spark233/native-plugin-runtime/host-runs/deef804e-4341-455d-9a7c-b30db054b94e/report.json`，10 条记录通过。使用隔离编译的 Electron 源码和真实 `DesktopPluginHost`，将同一原生 fixture 打为本地 `.tgz`，经过 `plugins_import`、缺少信任拒绝、确认信任、安装时专用 init 检查、manager 激活/查询、保存拒绝、停用和保留数据卸载，未使用官方 adapter 替代外部 native-only 工厂。选择器仅由探针提供固定隔离 tarball，没有人工操作文件对话框。

同次复用现有 Hello Web fixture，附加已声明原生入口，通过真实隐藏沙箱页面的 `native.process/invoke` 到达相同原生进程；安装时仍 lazy，显式调用后才握手。未声明入口或携带任意 `path`/`args` 的 payload 被拒绝，Web 与 native 共同停用及保留数据卸载通过。两个 native PID 为 27808、24668，结束后均已退出。此证据包含真实包安装与工厂分派，不包含目录包运行、原生选择器人工操作或视觉验收。

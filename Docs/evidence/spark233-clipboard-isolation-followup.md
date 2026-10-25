# spark233 剪贴板隔离阻塞复查

日期：2026-10-25（Asia/Hong_Kong）。分支：`codex/spark233-refactor`。

本轮重新核实当前 token 和私有 window station 的两个既有创建路径。**当前会话仍无法建立可证明独占的新 station，因此没有启动生产剪贴板监听、读取、写入或回贴。** 未发现足以据此修改生产监听/回放实现的产品缺陷；保留现有 fail-closed 守卫，不将 backend 人工快照的成功扩大为原生监听已通过。

## 当前证据

输出目录：`local-build/spark233/native-clipboard-p6/isolation-followup-20261025-170432-456/`。

- `report.json`：2026-10-25 09:04:47 UTC，诊断 PID 23044，session 6，`enabledAdministrator: false`。
- `token-summary.txt`：当前 token 为 `S-1-16-8192`（Medium）；`BUILTIN\\Administrators` 为 `Group used for deny only`。
- `metadata-probe.ps1`：一次性 metadata 诊断源码。复用原边界的 current-user-only DACL、`CWF_CREATE_ONLY` 和 `WINSTA_ALL_ACCESS`，仅调用 station 创建/名称查询/句柄释放；不导入剪贴板 API，不创建 desktop，不切换 station，不启动子进程。
- `microsoft-api-reference.json`：本轮读取的微软 API 链接、时间及决定性原文。
- `source-hashes.json`：本轮读取的三个 native 源文件和诊断脚本 SHA-256；没有构建或运行生产原生服务。

| 创建方式                               | 本轮结果                       | 含义                                                                 |
| -------------------------------------- | ------------------------------ | -------------------------------------------------------------------- |
| 唯一显式名称 + `CWF_CREATE_ONLY`       | 无句柄，错误 5（拒绝访问）     | 当前 token 无权使用此方式创建 station；与既有 named-station 失败一致 |
| 真正的 `NULL` 名称 + `CWF_CREATE_ONLY` | 无句柄，错误 183（对象已存在） | 当前 logon 派生的 station 已存在；没有取得、更没有加入该对象         |

诊断前后 process station 均为 `WinSta0`，`stationUnchanged: true`。这里只查询了对象名称；没有访问此 station 的剪贴板。两个创建尝试均未返回句柄，未产生需要留下的 station。`clipboardOpened`、`clipboardListenerStarted`、`childProcessesStarted`、`freshLogonUsed`、`securityPolicyChanged` 和 `productionServiceExecuted` 均为 `false`。

## 为什么不是调整 DACL 或改一个名字就能解决

本轮实时核对 [CreateWindowStationW 微软文档](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-createwindowstationw)：

> Only members of the Administrators group are allowed to specify a name.

> If lpwinsta is NULL or an empty string, the system forms a window station name using the logon session identifier for the calling process.

> If this parameter is CWF_CREATE_ONLY and the window station already exists, the call fails.

现有 `native/clipboard/clipboard-common.h` 的 `Isolate`（75 行起）在调用 `CreateWindowStationW`（94 行）时已使用唯一名称、create-only 和当前用户独占 DACL。显式命名失败发生在取得 station 之前，扩大 DACL 不能解决当前 token 的命名限制。本轮以相同 DACL 直接验证 `NULL` 名称，仍返回 183，因此把源码改成 `NULL` 也不能解除本会话阻塞。

本轮没有移除 create-only、打开已有 station、借用现有 desktop、创建新 logon、提升权限或修改 Windows 安全设置。这些动作不能作为本任务中“独占且无真实数据”的隐式替代。

## 生产代码与验收边界

静态复查确认原生服务的 `--spark233-mode=isolated` 在注册 listener 之前调用 `RequireIsolation`；守卫要求实际 station 与 `SPARK233_CLIPBOARD_STATION` 完全一致，并拒绝 `WinSta0`。`Clipboard` 的打开入口也先经过同一守卫。产品的显式 `production` 模式用于正常桌面功能，本轮没有运行该模式。

本轮没有修改 `native/clipboard/`、`scripts/native-clipboard/` 或 `electron/plugins/official/clipboard*.ts`，也没有重建 native、dist、官方插件包或 Windows 分发。运行时选择脚本确认项目 Node `26.12.1` / npm `12.2.1`；本次诊断本身由 PowerShell 的窄范围 Win32 P/Invoke 完成。

既有 `named-station-b3e58cf8797649c386a7bfd91dd73618/report.json` 的错误 5 和 `clipboardOpened: false` 仍成立。P1V 旧原型在独立 logon 中的历史成功、当前 backend/历史数据库/崩溃恢复的人工数据成功，均不能证明当前生产服务的 `AddClipboardFormatListener`、原始多格式 replay 或停机释放已实机通过。

因此以下事项继续保留：P6.1 的生产实时多格式捕获和恢复，P6.3 的原应用焦点/UIPI/回贴，P6.4 的关闭工作区继续记录及停用停止。私有非交互 station 即使以后可用，也只适合证明监听/原始事务/敏感标记/生命周期，不能独自证明真实应用焦点或键盘回贴。

## 续作入口

本机当前 token/session 的两个既有安全创建路径已得到确定失败结果；不再重复构建相同探针或运行实际剪贴板服务。可在后续**专用、可丢弃的 Windows 验证环境**中继续当前服务的集成链，前置条件仍是 launcher 成功创建新独占 station，且子进程在任何 clipboard 操作之前确认实际 station 身份并拒绝 `WinSta0`。本轮不配置该环境、不请求额外权限，也不新建 logon。

现有 `local-build/spark233/native-clipboard-p6/integration.mjs` 保留受控四格式 listener/replay/去重/敏感标记/暂停/停机的原链，可作为后续入口；它导入当时的编译宿主代码并依赖当时的包布局，重跑前需核对当前 backend 架构和私有路径，不能将其直接运行等同于当前版本验收。继续时所有样本与 spool 仍须位于独立 `local-build/` 运行目录，不能使用当前 UI profile 或真实用户剪贴板。

本轮交付为证据与阻塞归因，没有新增产品逻辑或测试框架，因此没有重复运行全仓 typecheck/lint/test/build。对当前输入的综合门禁和打包验收由主线程统一执行。

# spark233 应用发现：失败保留完整缓存与调用方隔离补证

日期：2026-10-26。本记录对应 [P5.11 原范围](../launcher-todo.md)；P3.12 的应用 provider 补证单独列出，不据此验收整个分批查询功能。本轮只复用内存快照、现有 utility/controller 与原生拼音 matcher，没有新增数据库、依赖、测试框架或桌面扫描范围。

**结论：P5.11 原条目的实现与最小隔离故障验收已经满足，证据足以支持主线勾选该项。** 本文不修改任务框和计数；后续完整打包与集成仍须绑定新输入。设置 UI 候选 `app.asar` SHA-256 `c1a8deb1c98a0367de3376bc9b887574c4a05f17809db79fab4b5f4ce84dbf84` 不含本次缓存改动，其成功报告不能用于声称该缓存代码已进入发布产物，详见[该候选记录](spark233-settings-zoom-followup.md)。

## P5.11 行为与边界

实现文件为 `packages/official/applications/backend.mjs`。两个开始菜单根分别保存完整快照，Windows 注册应用保存独立快照；自定义入口始终由最新受控设置合并，不进入可能回退的扫描快照。

- 某来源扫描完整成功才替换该来源快照并确认删除；目录递归读取失败、注册进程失败或不完整记录不会覆盖该来源既有完整快照。其他成功来源仍能增加和删除条目。
- 已有完整快照的来源失败后标为 `stale`；首次失败、尚无完整快照时只能临时显示可用结果，保持 `partial`。返回 `inventoryState`、逐来源 `sourceStatus` 和异常提示；部分结果不会在下一次缓存命中时冒充正常完整结果。
- `refreshedAt` 仅代表完整扫描成功；`lastAttemptAt` 控制重试预算。保留递归监听及 `CACHE_MS = 60_000` 的按查询校准，监听失效仍触发重新发现；失败后不会每敲一个字就重跑注册进程。没有引入新的后台轮询器。
- 内部稳定 ID、原快捷方式路径、参数/工作目录和宿主 live 校验保持。已拒绝的失效目标由撤销集合阻止通过旧快照重新授权；新完整扫描且未越过撤销代次才可确认有效条目。自定义保存取最新设置，并撤销在途旧查询，删除的自定义 ID 不会被迟到扫描复活。
- 停用/取消保留既有资源归属。注册发现等待子进程真实 `close`，不把提前到达的 abort/execFile 回调当成进程已退出；停用待清理完成后才释放 utility。

## 原始 P5.11 红 / 绿输入

仓库内保留摘要 `local-build/spark233/applications-cache-probe/summary.json`，原报告分别为同目录 `red-report.json` 与 `green-report.json`。冻结实现副本 `p5.11-complete-backend.mjs` 保持原 SHA，不因后续 caller 改动改绑已取得的绿色结果。

| 输入                                               | SHA-256 / 身份                                                     |
| -------------------------------------------------- | ------------------------------------------------------------------ |
| 修复前 backend                                     | `ad254694fb394bc792cda2194d958626e6e51220e75110f6bac5aba755671912` |
| P5.11 冻结 backend                                 | `363a237ec774423e5f56832cc151403b559fa5553112746d72d7e5e2456d6b53` |
| 实际拼音 matcher `spark233.ApplicationMatcher.exe` | `a790769f70080fc9fbee1b4e57ecfe80213ba067878b20f1961bcc7c7a58d165` |
| 实际宿主 `official/applications.js` live 校验      | `984c0599a180b626baca421e64fd50e740c624334a4792ae17aed442bd06ee65` |
| P5.11 使用的冻结 controller `backend.js`           | `52e7f9f270f3dcf846e10980b33948ee476a07008aee46f2b1803efabca39e38` |
| utility `backend-worker.js`                        | `8ac6f66895bc05c6d16d3115bbc41bd14cf7e974d091ecb24b7286a82981c947` |

controller/worker 来自 `notes-rpc-replay-20261026T065629Z/old-app-extracted/dist-electron/electron/plugins/` 的独立冻结运行树；本次文档整理时重新回读其散列，与 P3.12 独立编译 worker 相同，不将 P3.12 的新 controller 混称为原 P5.11 输入。原 probe 的 `windows-info.json`、`prepare.mjs` 和 `windows-probe.cjs` 保存实际加载路径、包来源与执行方式。

Windows 隔离基目录为 `C:/Users/40417/AppData/Local/spark233/verification-runs/applications-cache-20261026/`，所有菜单、自定义样本、设置和 profile 均在各 run 内新建。真正启动 Electron utility，并运行正式 backend 与 matcher；没有启动合成应用、读取真实开始菜单、操作剪贴板或系统服务。

- 红：`red-dkiK00`，`ok: false`，断言 `Cached complete menu root was overwritten by a partial scan`，直接证明修复前部分扫描覆盖了已有完整菜单缓存。
- 绿：`green-OOzmO1`，`ok: true`，以下五组全部通过。

| 组                  | 实际输入与结果                                                                                                                                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 单来源失败       | 对合成菜单的嵌套目录用 `icacls` 给当前 SID 添加读取拒绝，另令注册来源进程失败。失败菜单和注册应用保留完整旧条目；另一成功菜单确认新增和删除，整体 `stale`，提示可能过期，完整成功时间不前移。   |
| 2. 撤销与自定义删除 | 删除旧菜单目标后，backend 内部 ID 与正式宿主 live 校验都拒绝执行；后续失败刷新不会重新授权它。注册扫描延迟期间移除自定义入口，旧查询失败且无结果发布，最新列表及旧自定义 ID 均不能复活该入口。  |
| 3. 完整恢复         | 恢复目录 ACL、注册来源成功后，结果变为 `complete`，清除异常，确认旧菜单/注册项的真实删除、纳入新项，并保持自定义删除。正式拼音 matcher 查询成功、退出码 0。                                     |
| 4. 首轮部分结果     | 全新 utility 在菜单和注册来源失败时只显示成功来源；`inventoryState: partial`、`refreshedAt: 0`、缺失来源 `hasCompleteSnapshot: false`，提示不完整。紧接缓存查询仍为 partial，未新增注册子进程。 |
| 5. 停用清理         | 延迟的真实注册子进程在刷新中被停用取消；旧查询拒绝、不迟到发布，utility 停止、资源归零，每个注册子进程都捕获真实 `close` 且不再存活。                                                           |

**ACL 错误码校正：** 报告 `fixture` 描述中保留了早期通称 “ACL EACCES”，实际观测字段 `realMenuError` 明确为 Windows/Electron 的 **`EPERM`**，红、绿及后续集成均如此。故障是实际目录读取拒绝，不是模拟 `readdir` 抛错；probe 接受 EACCES/EPERM 两种访问拒绝码，`finally` 移除只加在合成目录上的显式拒绝。

**注册来源替身边界：** `fixture-entry.mjs` 只拦截包含 `Get-StartApps` 的 PowerShell 编码命令，替换为真实 Windows Node 26.12.1 子进程 `registered-source.cjs`，其余 `execFile` 原样转发。子进程读取合成计划，实际延迟、输出 JSON、返回错误码 5 或接受 SIGTERM；这证明 backend 对注册发现失败/恢复与进程清理的处理，不声称真实 Get-StartApps/Store 枚举已在此轮运行。替身和注册脚本 SHA-256 分别为 `21d858dbc0a03cf195fdfd20968c8e3269a26118ca06ee17f1e0adac89bd0d06`、`04e61ec5046b9a8afe1d0c1a9e0587b9dbea3d417d62eb4550d94faf02dd38c0`。

绿色报告的 utility PID 39584、14940 均 `running: false`、`resources: 0`；注册 PID 36460 在停用阶段取得 `close` / SIGTERM，全部注册 spawn 都有对应 close；matcher PID 22208 退出 0，约 86.20 ms。不是用 abort 回调或内存布尔值替代实际子进程终态。

60 秒时长来自保留的生产常量与重试分支审查；本代表链实际验证失败后的连续缓存读取不额外 spawn，没有等待整整 60 秒再声称完成壁钟精度测试。原监听、参数/cwd、内部 ID 与宿主执行保护通过源码复核及代表执行描述符/失效拒绝保持；没有实际启动应用来扩张本项验收。

已执行门禁：固定工具链 `node --check packages/official/applications/backend.mjs`、定向 `oxlint`、`git diff --check` 均通过。本 lane 未产生新的官方插件归档或 Windows 候选，不以这些门禁替代后续完整 build、包审计及 packaged smoke。

## P3.12 应用 caller 隔离：独立证据

对应 `local-build/spark233/applications-caller-probe/{summary,red-report,green-report}.json`。

- 红：`caller-red-3hEbDp`，输入正是 P5.11 冻结 SHA `363a237e…`，失败 `Different caller cancelled the first caller`。该失败属于原全局 query slot 的跨 caller 串扰，不推翻 P5.11 的缓存绿色结果。
- 绿：`caller-green-NNTV8Y`，backend SHA **`d5a395c4118d8f9d9589081dbdbb82a25f07efd1b6ec9139caf6088da45e2391`**；冻结副本为该目录 `tested-backend.mjs`。使用独立编译的支持 `activate(activation, signal?)` 的 controller SHA `a5b6b0de1364188f462816fbeec39800c7ea3d9a0dae8c13034bd54aa425633f`，worker 仍为上表 `8ac6f668…`，没有覆盖原 P5.11 controller。

五组通过：不同可信 caller/document 并行；同 caller 替换且旧 finally 不删除新 slot；transport signal 仅取消本请求、另一 caller/新请求存活且 pre-abort 拒绝；缺 callerId 时保留 legacy slot 行为；lifetime stop 取消所有 caller 并释放真实 utility 与注册子进程。绿色报告 `utility.running: false`、`resources: 0`。callerId/requestId 由隔离宿主侧传入，不接受 renderer 自报身份。

随后在 **新 backend SHA `d5a395c4…`** 上完整重跑原缓存五组，独立报告为 `applications-caller-probe/cache-integration-report.json`，run **`green-9pBjqF`**，`ok: true`、五组全过。这个报告重新证明 caller 改动没有破坏缓存行为，不把原 `green-OOzmO1` 重新绑定到新源码。它继续使用原缓存 harness 的冻结宿主 live 校验/controller，实际 matcher 身份与上表相同；signal-aware controller 的五组由 caller probe 单独证明。

集成报告 utility PID 7716、10520 均停止且资源归零；注册 PID 24872 在停用阶段捕获真实 close / SIGTERM，全部注册进程闭合；matcher PID 28684 退出 0，约 47.57 ms。新 backend 的语法、定向 lint、diff-check 和 signal-aware controller 的隔离 TypeScript 编译通过。

**P3.12 整体尚未验收，不在这里勾选。** 本段只证明应用 provider 的 caller/request 取消边界及缓存兼容性，不代替默认入口命令先返回、分组稳定补充、快慢失败 provider、窗口关闭/代次/owner 撤销、旧执行 token 和默认 AI 零请求等 launcher/main/renderer 完整验收。

notes/search provider 的后续隔离报告另见 `local-build/spark233/provider-caller-probe/summary.json`：真实 notes utility 7 项、固定生产 Search/Index 的 Windows raw native 24 项通过，最终源码及编译字节在报告内绑定；`termination-check.json` 的 UTC 09:02:46.3231325 核对该 run 相关进程为 0。它们属于 P3.12 provider 边界，**不计入 P5.11 的五组或缓存集成五组**。

## 菜单目录暂时消失：ENOENT 边界补证

后续只读审查发现，`discover()` 原先将 `readdir` 的 `ENOENT` 例外视为完整扫描。菜单根暂时消失，或已经列出的子目录在读取前消失时，不能据此确认整个来源的删除；已有完整快照可能被空或部分结果覆盖，首次缺失来源也可能被误报为 complete。本段保留上述原始故障与 caller 绿色报告的原输入，不将它们改绑到后续修复。

复用既有缓存 probe 的真实 Windows utility、合成菜单及注册来源子进程，独立运行树为 `C:/Users/40417/AppData/Local/spark233/verification-runs/applications-enoent-85l3_iwq/`。新增边界 runner 仅 77 行，仓库副本和报告在 `local-build/spark233/applications-enoent-probe/`；`windows-info.json`、`summary.json` 记录实际加载路径与输入。没有读取真实开始菜单、启动应用、访问剪贴板或操作服务。

| 输入                            | SHA-256 / 绑定                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------- |
| ENOENT 修复前 backend           | `d5a395c4118d8f9d9589081dbdbb82a25f07efd1b6ec9139caf6088da45e2391`，`red-backend.mjs`    |
| ENOENT 修复后 backend           | `cc4d14b7515ed3357163318ca3734f371ff46e5eff38efa1fda4d6af706eff90`，`tested-backend.mjs` |
| 边界 runner `enoent-probe.cjs`  | `7f103575b6c224847cf638fcd53d1cda45d72e662b90a2db145caf029432c623`                       |
| 边界与 caller 的冻结 controller | `a5b6b0de1364188f462816fbeec39800c7ea3d9a0dae8c13034bd54aa425633f`                       |

worker、matcher 与正式宿主 live 校验分别仍为上文的 `8ac6f668…`、`a790769f…`、`984c0599…`；完整原缓存五组继续使用原冻结 controller `52e7f9f…`。这些是独立运行输入，没有修改共享 runtime 指针或 Windows staging。

红报告 `red-report.json` 对应 `enoent-red-5LnRcr`，Electron 和外层 Windows Node harness 均退出 1。实际将自有 `Programs` 根改名，宿主 `readdir` 观测 **ENOENT**；原有两项菜单缓存消失，来源从 count 2 变成 count 0，却继续报告 complete、前移完整扫描时间且没有异常提示。全新 utility 在根仍不存在时也报告 complete，并错误设置 `hasCompleteSnapshot: true`。报告保留全部五个失败判断。

最小修复只移除 `readdir` 对 ENOENT 的例外：任何目录读取失败都将所属菜单来源标记为不完整，复用已有 stale/partial 与快照保留逻辑。恢复为**存在且可成功枚举的空目录**后，才能用完整扫描确认删除；caller 隔离、撤销集合、60 秒预算和真实 close 清理路径未改。

绿报告 `green-report.json` 对应 `enoent-green-pICU72`，`ok: true`，Electron 与 harness 均退出 0。同一流程取得：

1. 先完整扫描，再实际改名菜单根；两条旧菜单记录保持，来源与整体为 stale、告警存在，完整时间保持原值；另一可读菜单仍独立确认新增与删除。
2. 在原位置创建可读空根后，来源恢复 complete、count 0，才删除旧菜单缓存。
3. 再移除空根并启动全新 utility，缺失来源为 partial、`hasCompleteSnapshot: false`、完整时间 0，成功菜单和注册来源继续可用。

本次代表流程实际覆盖根目录消失；已列出子目录消失走同一个生产 catch 分支，未另铺目录竞争矩阵，也不声称实际执行了该竞争时序。

在 **`cc4d14b7…` 新 backend** 上另原样重跑原缓存与 caller 验证：

| 报告                             | Windows run           | 结果                                                                                                                                      |
| -------------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `cache-integration-report.json`  | `green-TNs7ge`        | 原缓存五组全部通过，包括真实 ACL EPERM、注册来源失败、恢复删除、撤销/自定义保护、拼音 matcher 和停用清理；Electron / harness exit 0。     |
| `caller-integration-report.json` | `caller-green-lZZ4ax` | 原 caller 五组全部通过，包括并行、同 caller 替换、单请求 signal 取消与 pre-abort、legacy slot、lifetime stop；Electron / harness exit 0。 |

边界两轮的四个 utility 均 `running: false`、资源 0。`termination-check.json` 于 **2026-10-26 09:58:20.836 UTC** 用 Windows Node 对本段红/绿及两次回归报告中的 27 个实际 utility、注册来源和 matcher PID 做只读检查，全部不再存活。语法检查、定向 lint、格式检查及 diff 检查通过。本段不声称这些后续字节已进入现有 Windows 候选，仍需主线统一构建与门禁。

## 验收结论与后续集成

P5.11 要求的按来源完整快照、失败提示、首轮 partial、成功来源更新、恢复删除、撤销保护、自定义移除及取消/停用清理，都已通过实际隔离输入取得证据；生产 watcher/60 秒分支、内存复用和宿主执行边界保持，source、controller/worker、matcher 与 host live 校验身份已区分记录。因此原条目可以按功能范围完成，由主线更新清单。

尚未宣称本次应用缓存或 P3.12 改动进入设置 UI 候选 `c1a8deb1…`，也未执行新的完整打包、安装器或发布。后续完整构建必须把最终 backend、宿主分批查询和所有 provider 接线一起打包并重新验证，不沿用旧候选报告。P5.1 自定义入口 UI/真实应用操作、P3.12 整体查询体验及其他原验收项仍各自保留。

## 后续完整候选绑定

P3.13/P3.14 增加稳定 ID 解析后的 backend `43bcfcd1dac6358ac65b3531fec533949259053716fba31eea06c493e2a1c9c1` 已进入独立最终 Windows 候选，ASAR 为 `47e1f8216964a54ed9fc7af766df628008965fdcb6b33f3219f74710f57684a1`。七包/14 native/69 compiled 的 39 项审计、34 文件/167 tests、固定旧样本和 fresh 完整 smoke 均通过，实际应用安装成员 11/11 匹配当前 tgz；见[入口偏好最终绑定](spark233-launcher-preferences-followup.md)。本页较早 363a/d5a/cc4 报告仍保留各自原始输入，不改绑到后续字节，也不借旧 c1 UI 包宣称当前功能已集成。

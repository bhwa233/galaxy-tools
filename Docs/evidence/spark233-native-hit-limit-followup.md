# spark233 Instant 正常命中截断：适配 8 修复与正式原生补证

日期：2026-10-26。本轮修复真实隔离查询中出现的正文分页错误：请求第一页 60 条、实际至少 61 条命中时，正常达到命中上限有时返回 `Content query did not complete`，错误码 995/1237，已找到的整页结果被丢弃。修复位于可重放的原生适配脚本，保留固定上游和真实文件版本、ACL、主动取消边界。

最终摘要为 `local-build/spark233/native-hit-limit-probe/summary.json`。**旧字节相同 runner 的 8 次边界查询中 5 次失败；新字节全部正常且没有显式重试，后续 22 项连续检查、原生 reader 33 项和原 native smoke 均通过。** 正式 Windows 原生资源已经重建、staging 已更新；新的完整应用候选由主线另行构建和绑定，本文不宣称该候选或其 packaged smoke 已完成，也不据此单独验收 P5.4/P5.6 全部范围。

## 故障机制与修复边界

`native/search/search.cpp` 的正文请求设定 `maximum_hits = offset + limit + 1`，以额外一条判断是否还有下一页。第一页 `limit=60` 因而在 61 hits 触发正常截断。

固定 Pulse 的 `src/index/content_task_search.cpp` 达到上限后设置 `progress.truncated`、退出结果循环，并在 `Join::Finish` 中设置内部 stop、对 worker 调用 `CancelSynchronousIo`。此前仍在读取或核对元数据的 worker 可能因此得到 `ERROR_OPERATION_ABORTED`（995）；旧 `text_task_reader.cpp` 的布尔 `Stable` 还会把元数据 API 失败和真正的文件身份变化统一变成 `ERROR_RETRY`（1237）。共享 error 只过滤 `ERROR_CANCELLED`（1223），故内部收尾可能污染终态错误。Search bridge 随后按这个非零错误返回整页失败。

旧原始 timing 有 `hits=61`、`enumeration_complete=true`、`cancelled=false` 且 text lane 出现单个 995/1237 的记录。fixture 显式指定内容根，没有进入共享 feed；保留的记录不支持把这些错误解释为初始 Index 未就绪或索引 revision 更新。旧日志没有逐个 Windows API 调用轨迹，因此不把每个历史 1237 都强行归为同一个底层 syscall；本轮通过相同输入的原生红绿闭环验证了这条可复现的截断收尾错误链。

适配 8 在 `scripts/native-search/build.ps1` 中对固定源码应用带唯一锚点校验的补丁：

1. `Stable` 返回错误码。真实大小、mtime、ChangeTime、卷及文件身份不一致仍返回 `ERROR_RETRY`；元数据 API 失败保留其实际错误码，异常零错误码仍按读取失败拒绝。
2. reader 仅在错误为 `ERROR_OPERATION_ABORTED` **且已有中断信号**时，将它保留为 `ERROR_CANCELLED`。短读、真正版本变化、ACL 拒绝和没有中断信号的 995 不被宽泛忽略。
3. worker 汇总同样只排除已有中断信号导致的 995，保留真正的读取/版本错误。用户主动取消仍走独立的取消终态；没有把所有 995/1237 转成成功，也没有改 Search bridge 的通用错误拒绝规则。

这次实现修改为适配脚本及必要的 `packages/official/search/licenses/Pulse/source-manifest.json` 来源归档。`native/search/search.cpp`、CMake 与 JS provider 本轮未改。生成树中的改动由固定源码导出和适配脚本重放产生，不是只修改解压后的文件。

## 固定来源、重放与输入身份

- 上游：`https://github.com/jimmgreen/pulse`。
- 固定 commit：`c4fe01ed82fe091f495f531972a854aa32caac2b`，没有升级上游。
- 源码归档 SHA-256：`cd158fcb689324df5065fecccd5db0147b86bfcc7b06a4ffb9b160427e096634`。
- 原生适配版本：**8**，既有命名、隐藏文件策略及 read-handle 文件版本合同保留。

使用正式 Windows 工具链从固定本地 checkout 重新导出干净源码，执行完整 `PrepareOnly` 适配重放；**1131 份 `.cpp/.h/.rc` 与正式 prepared 编译树逐文件一致**。报告 `replay-binding.json` 保存完整路径、散列及比较结果；上游源码快照位于独立验证目录 `native-hit-limit-20261026/replay/`。

| 输入                                           | SHA-256                                                            |
| ---------------------------------------------- | ------------------------------------------------------------------ |
| `scripts/native-search/build.ps1`              | `e9673bc32ffc0c81cb3e67fe4afb0ad719634779166f79217875cde3082434e2` |
| `native/search/search.cpp`                     | `517654fe92d7ef0d2c484a1275db2cada6006cd1e10132f4a540ed13bb64186d` |
| `native/search/CMakeLists.txt`                 | `5ad3a833f34b1ede35d3e3fce5a4a01a46d8d5bee4d6a5748be6950863839e3d` |
| 来源归档 `licenses/Pulse/source-manifest.json` | `bdefa4011f52f4ce35fb25e7328b86f9c10377228714ca2e4265953a8e522e06` |
| 重放后 `src/index/text_task_reader.cpp`        | `b0f015a1e7b3bc9e3f00bf48c34344d2f55e317fcd02a50c4180e17fa1bce5d6` |
| 重放后 `src/index/content_task_search.cpp`     | `cd5e6ea84a21abf7b0dfad57e8341ea88b1a9f1fdbc0c89c11846d80bca951ea` |

正式 `resources.json` 的 `inputs` 绑定上表前三份桥接/构建输入，`upstream` 绑定固定 commit、归档和适配 8。其副本与来源归档、实际测试脚本/补丁后源码快照均保存在本证据目录。

工具链为 Node 26.12.1、PowerShell 7.5.4、CMake 4.4.4、Ninja 1.13.2、MSVC 19.51.36260.0 / VC Tools 14.51.36231、Windows SDK 10.0.28000.0、Electron 45.0.0。最终正式 MSVC 构建成功，没有新增编译警告；初次编译发现的局部变量遮蔽已修正并完成重新重放、构建，未把第一次临时字节当作最终输入。

## 正式四个 payload

最终 staging 为 `C:/Users/40417/AppData/Local/spark233/build-staging/00C2B9AB54BF/packages/official/search/`；`native/resources.json` 和 `licenses/Pulse/source-manifest.json` 均为适配 8，来源归档也已同步回仓库，避免后续源码同步覆盖回 7。

| 文件                    |    字节 | SHA-256                                                            |
| ----------------------- | ------: | ------------------------------------------------------------------ |
| `spark233.Search.exe`   | 1518592 | `2bd0e8e517576bf337358f0ba28bd7bbacd4912442f2199bf25ca55f98126571` |
| `spark233.Index.exe`    | 3389952 | `4639ee477f46568a5e39902f2c10a3025bdf0f5b76be1216c419d15f85e0bfe2` |
| `spark233.Document.exe` |  239616 | `c4e84bbe724e05fd4666dd2396210247ae32cfa5f274de9746bc4636f206f28f` |
| `pdfium.dll`            | 7370752 | `04100c03e41cac1f979e36e5e26fb860bcb5a7461f53830d3c098716624a27a9` |

本次只 Index 二进制变化：旧 Index 为 `4503e45eb72c287084582de4b9f852e15ce5cbc5e7f6ed689b59a861e6de26b7`。Search、Document 和 PDFium 保持原字节；不要求四个 payload 为了新适配而全部变化。

## 无重试原生红绿与连续边界

复用既有 raw Electron / 正式 Search runtime、Search/Index test-host 入口及合成 Markdown 文件，没有新增测试框架或公开测试入口。两个 run 分别使用冻结旧包和正式新包，查询/profile/缓存/临时文件均在 `C:/Users/40417/AppData/Local/spark233/verification-runs/native-hit-limit-20261026/{red,green}/` 内。

相同 runner 对 61、66 个真实文件各执行 4 次独立查询，每次要求 60 个真实文件结果及下一页 cursor。**8 次是独立样本，不是失败后的自动重试；新 runner 不含早期分页诊断中的有界准备重试。**

| 输入             | 61 hits，4 次         | 66 hits，4 次                 | 结果                                                  |
| ---------------- | --------------------- | ----------------------------- | ----------------------------------------------------- |
| 旧 Index，适配 7 | 3 次正常，1 次 1237   | 4 次失败：2 次 995、2 次 1237 | 共 5/8 错误，`red-report.json` 的正常截断断言实际失败 |
| 新 Index，适配 8 | 4 次均 60 条 + cursor | 4 次均 60 条 + cursor         | 8/8 正常，显式重试 0                                  |

`red-raw/`、`green-raw/` 保留每次 request/result/native stderr，`red-timing/`、`green-timing/` 保留 worker summary。旧失败报告保留为红，不因后续成功改写。

绿色完整连续链为 **22/22**，涵盖正常截断，以及 61 个文件的第一页 60 条→第二页 1 条→继续使用第一页命中；preview 读取合成文件，open 使用记录型宿主回调核对原路径，没有打开真实用户文件或启动系统应用。还证明消费后的 cursor 不可重放、新输入撤销旧 cursor/selection、另一 caller 不受影响、翻页时 test-host 不可用仍保留上一页有效项。

权限与取消没有被修复绕过：改变已返回文件后旧命中仍被文件版本检查拒绝；给合成文件添加实际 ACL 读取拒绝，独立读取得到 **EPERM**，preview/open 不产生旧内容/打开副作用，随后恢复该文件 ACL。会话取消只撤对应 caller，旧 scope 不删除新状态，全局保护根变更及停用撤销相应 token；真正主动取消在途 Search 时没有迟到发布，并等到实际 native 退出。

最终绿色 raw 结果没有 995/1237。唯一非 `ok` 结果是两个刻意故障：`result-12.json` 的 test-host 关闭/连接不可用 **1460**，以及 `result-19.json` 的显式用户取消 **1223**。它们分别证明失败和取消仍保留原语义，不算正常查询失败。

## 原生 reader 与原 smoke

复用固定上游既有 `pulse_text_task_test`，没有另造 reader 逻辑替身。`reader-checks.log` 为 **33 项 PASS、`failures=0`**，包括真正的读取中修改、同尺寸同 mtime 但 ChangeTime 改变、handle preflight 后修改及路径替换，结果仍以 `ERROR_RETRY` 拒绝且清除内容/版本；读取中取消关闭句柄、预读取消和 preflight 取消仍为取消。它直接约束适配 8 没有把真正的版本错误吞成成功。

随后执行原 `scripts/native-search/smoke.ps1`，报告为本目录 `native-smoke-report.json`，原始 Windows run 为 `.../local-build/spark233/native-search/runs/20261026-181927-376/`。filename、shutdown、fixture host、caller-permissions、中文正文及代码正文的实际进程均退出 0；受限 caller 的真实 ACL/命名管道隔离检查通过。代码样本 `CANCEL_REPLACE=1`，中文及代码均 `AGENT_STOPPED=1`，`instant-no-body-writer.bodyDatabases=[]`。这是私有 test-host 和当前用户/受限 token 的代表证据，没有安装 SYSTEM 服务。

最终核对 `termination-check.json`：**UTC 2026-10-26 10:29:04.8291019，两个自有验证范围相关进程 0**。绿色报告的 Search 子进程均实际关闭、退出码 0，fixture host 正常退出；原 smoke 也观察 agent 停止。不是仅用 abort 回调推定子进程已退出。

## 旧候选保护与集成边界

正式 native 重建前，已将旧 UI 候选整套 `win-unpacked`、安装器、原 32 项审计输入及旧搜索包冻结到 `native-hit-limit-20261026/frozen-ui-c1/` 和 `old-search-package/`，150 个文件的大小/散列见 `frozen-inputs.json`。旧 ASAR 保持 `c1a8deb1c98a0367de3376bc9b887574c4a05f17809db79fab4b5f4ce84dbf84`；本轮收尾时旧 release 与冻结副本仍一致，没有重写旧候选报告或把新 Index 绑定到旧候选成功结论。

已完成固定源重放、正式 native 构建、同 runner 原生红绿、既有 reader 测试、原 native smoke 和定向 `git diff --check`。本轮没有改 JS、main/launcher、服务配置或其他文档，没有安装服务、触发 UAC、扫描用户卷、使用真实剪贴板或执行安装器。真实 SCM/SYSTEM 服务、完整卷范围及目标机行为仍按原 P5.3/P5.4/P5.5/P5.6 等条目验收；新完整 Windows 候选的源同步、包审计与 packaged smoke 由主线独立记录，不能从本报告推定已经完成。

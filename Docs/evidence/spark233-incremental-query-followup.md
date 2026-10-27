# 启动器分批查询、调用方与执行边界

日期：2026-10-26。对应 [实施清单 P3.12](../launcher-todo.md)，接续 [P5.11 应用缓存](spark233-applications-cache-followup.md)。**P3.12 原条目已补验完成并勾选。** 最终新 Windows 候选已完成绑定；下列历史报告继续只证明各自输入，不以底层 green 单独代替 UI/IPC 或产物验收。

## 行为变化

原默认查询等待所有本地 provider 的 Promise.allSettled，命令也随慢来源延后；Controller 的匹配、代次和执行 token 共用一个全局集合。现在宿主先返回可执行的本地命令及固定顺序分组，各来源独立从 pending 变为 ready/error。拼音匹配异步补充命令排序；同一查询内命令 token 保持稳定，仍存在的选择不因快组或慢组返回而重置。模式查询继续使用原单 provider 路由。

每次响应/事件携带 renderer sessionId、宿主新建的 requestId 和递增 revision。后续完整分组快照仅发送给原窗口；renderer 先订阅再发 IPC，按代次、请求身份与 revision 合并，迟到的初始响应不能覆盖较新的事件。分组键由 pluginId/commandId 决定，不按完成先后排序，单组错误不会清空命令和其他来源。

默认仍仅查询清单声明 search=default/word 的本地 provider，AI 命令不自动查询或提交网络请求。进入模式、命令/应用/词典同名共存及 opaque action 路由保持。

## 会话、取消与 owner

调用方由 main 的已验证 webContents ID 与 document UUID 注入，renderer 不能自报 caller。查询、执行、条件取消、隐藏、导航、崩溃和关闭都使用该身份；旧 cleanup 只能取消其原 session/request，不能撤销新请求或其他窗口。

manager.queryOwned 统一走既有派发链，捕获实际启动后的 PluginOwner；返回前再次检查安装记录、runtime、active scope、命令与依赖。创建和执行 token 时也复核安装身份与 owner。公开命令可在未启动时匹配，首次实际启动后绑定 owner；旧实例的命令及内部动作不能落到更新后的新实例。

AbortSignal 沿 manager、runtime、utility/Web/native 通道传递，复用 requestId 和 scope task 的取消机制。普通执行结束分批流时只取消仍 pending 的 provider 与拼音任务，保留已完成结果的 query authority，供预览/分页使用；真正换输入、条件 clear、隐藏或关闭才撤销整个 authority。Search 在这一信号撤销时解绑并删除原 caller state，不长期保留旧 document 的路径、cursor 或查询文本；普通分页保留初始 authority，设置、私有根、服务与停用仍全局撤销并等待所属 native 退出。

插件通知包含冷启动和检查更新，因此不会无条件清空所有查询。宿主只按真实可用性/安装身份/owner 撤销相关动作与组，前端以稳定 catalog key 避免每次冷启动通知重新发出整个查询。

## 集成中发现并修复的边界

- 进入独立工作区原先仅停止事件、仍可执行旧 token。main 现在用现有 Node AsyncLocalStorage 绑定实际执行 caller 和原 session/request，在真正打开工作区时条件撤销；执行结束置 active=false，后台资源继承的异步上下文不能在未来清掉别的新查询。执行 A 等待时创建的新 B 也不应被 A 的后续开窗撤销。
- 连续拖入不同单文件的可见标签相同，前端稳定 key 原先漏掉这一输入变化。host contextRevision 现在进入 state/key，context token 同时绑定该版本，资源替换即拒绝旧 token。
- Search 翻页原先清掉第一页 selections，但 UI 继续 append，第一页与旧“下一页”行都会失效。分页现在保留同查询已有 selection、消费旧 cursor；UI 追加时移除该 plugin 的旧分页入口。新查询、权限/版本变化和全局撤销继续拒绝旧选择。
- 失败组 Retry 的 Enter/Space 不再冒泡给 cmdk 执行当前选中项；按键只发起重查。
- 执行响应与查询事件分别校验代次：预览或分页执行 A 等待期间切换到输入 B，前端只接收当前执行代次的结果和错误；Search 预览返回前也复核原会话与 action 可用性，防止迟到预览覆盖新输入。

## 已取得的独立证据

以下均是忽略的本机报告路径，相对于 local-build/spark233。每份报告只证明其实际冻结输入，不自动改绑随后修复。

| 范围                        | 已执行结果及限制                                                                                                                                                                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| manager/utility             | query-owned-probe/runtime-bZxTY8/run-hWGQm5/report.json 五项通过：真实 owner、pre-abort、单请求取消/并行成功、prepare 恢复及旧 owner 结果拒绝；退出 0。                                                                                                                                                      |
| 应用 caller                 | applications-caller-probe/summary.json 五项红/绿，原全局 currentQuery 精准重现其他 caller 互取消；新 caller/request 边界及缓存集成通过。后续 ENOENT 补修又重放缓存/caller，详见缓存文档。                                                                                                                    |
| controller                  | launcher-stream-probe/runtime-zv3zLf/run-hYvlkH/report.json 七组通过，包含 commands 初始先返、快慢失败、稳定组、双 caller/token、代次/关闭/owner 与默认 AI 0；不冒称实际 renderer 倒序合并。                                                                                                                 |
| notes/Search caller         | provider-caller-probe/summary.json：真实 notes utility 七项、Windows raw native 24 项；仅证明当时 provider 输入，后续分页/回收有独立报告。                                                                                                                                                                   |
| 真实 main/renderer 第一轮   | launcher-streaming-main/final-summary.json 的 run-Ngz8U1 十三项通过，实际 IPC 初始响应延迟、事件先到、选择/取消/工作区撤销、第二合法 host、hide/navigation/close 与 Retry Enter；冻结 main 为 e2330876…，退出 0。context/旧执行换代及分页后续修复需新输入补证。                                              |
| 真实 main/renderer 最终边界 | launcher-streaming-main/followup-final-summary.json 的 run-Qeou5f 六项通过：同标签 context 1→2、A 执行不清 B、完成 scope 保留到实际 clear、分页移除旧 cursor/旧 hit 可执行、迟到 preview 不覆盖新 UI、无 AI/外部动作。旧 run-GLJEo8 实际复现预览覆盖并退出 1；新 run 退出 0、rendererErrors=[]、所属 PID 0。 |
| 真实 Search 分页/回收       | search-pagination-probe/summary.json 二十项通过：61 个真实文件的 60+1、第一页再预览/打开、cursor、版本/ACL、其他 caller 及 scope 回收。该 run 明确保留六次 native 首屏准备错误及显式重试，不能称原生大结果可靠性已通过。                                                                                     |

十三项 UI 代表使用真实 Linux main/preload/renderer 与 utility，只有平台清单及可控 fixture 适配；Retry 使用可信 Chromium CDP 键盘事件，未宣称 WSLg 原生物理焦点。probe 的退出 0 不代替产品 CLI 正常退出验收。原 workspace-token-red.json 与各验证器输入错误保留。

## 原生命中上限问题

61-hit 附近的部分 raw 结果为 995/1237。现有 timing 能关联的四次均已收集 61 hits、enumeration 完成、非用户 cancelled，错误来自 Index Instant text task，Search 将其提升为整页失败。只读源链支持“命中上限正常收尾的内部取消污染读取错误”机制；不能把每个 1237 的底层 syscall 都归为同一原因，也不能称为真实 SYSTEM 服务的新回归。

已通过固定上游可重放适配 8 修复，区分内部已发取消与真实读取/版本错误。相同 runner 的 61/66 hits 各四次独立查询，旧字节共 5/8 失败，新字节 8/8 正常且无重试；连续分页/回收/版本/ACL/取消 22 项、既有原生 reader 33 项及原 native smoke 均通过。完整来源、四个 payload 散列与边界见[原生截断修复](spark233-native-hit-limit-followup.md)，不以先前带重试的分页报告代替该结果。

## 历史集成与最终候选

最终 UI 补验的 main 为 `efca76cafb282814bbac408140b53a47a16ddb07ab2589da7b81c3388be4d2f1`，controller 为 `2755a4b6694ef0cba706f23cc301dfb19a604d11e7b6e0d94ef53fca15df6bfb`，renderer 主包为 `8d1ce7d33b0f3819d902a7bcb5a33f012a0a4cb36646d80fc64831c882c41a70`。三者与随后 Windows 构建对应产物逐字节相同。补验使用的分页与迟到预览 provider 为明确受控 fixture，只证明 host/UI，真实原生分页由上一节独立证明；受控 picker 也不代替 OS 对话框验收。

Windows 初个新候选已完成构建、lint、33 文件/163 tests、七包/native/ASAR 37 项审计及固定旧样本 11 项（64.305 秒、实际退出 0）。该候选 ASAR 为 `1613a87a86a983ca4d80697b24b0a8bbf338a72db10a8726e60b5cd586e7f1b7`，**fresh smoke 没有通过，P3.12 保持未勾选**。证据位于 `local-build/spark233/incremental-search-2026-10-26/`。

第一份 fresh run `1c6aee7d-37ef-4a3f-9039-d9aa7d22aa8d` 在 0.423 秒实际退出 1：当前 Windows PowerShell 的 `SetEnvironmentVariable(name,$null)` 留下存在但为空的 `ELECTRON_RUN_AS_NODE`，导致 Electron 进入 Node 模式。验证 wrapper 改用 `Remove-Item Env:`，WinNode 替身的父进程、Start-Process 及 ProcessStartInfo 子进程都证实键确实不存在；没有为此修改产品或正式 smoke。

修正环境后的 run `23b988b2-a501-4822-8474-b85e59c583b1` 实际运行 168.064 秒、进程退出 0，但报告失败于 `Maintenance query rejection was not shown by the renderer`。宿主 gate 的 stateReadAllowed/queryRejected 已通过；原因是维护只改变 main flag、不改变 manager catalog，稳定 query key 因而漏掉这次真实可用性变化。主线已在维护进入/退出时递增独立 availability revision，纳入 catalogSignature；恢复后发送状态通知，进入时撤销原 query authority，并保留可见入口供清楚的动作拒绝反馈。不会恢复为每次 cold-start 通知都重查。后续维护快速代表及最终完整候选已经通过，见下段；失败报告仍保留为失败，不改写。

上述源/产物/旧样本和两份失败报告保持原绑定。后续 P3.13–P3.15 及维护 epoch、七包同步目录性能补修在独立的最终候选 `47e1f821…` 中收口：39 项包审计、167 tests、33.630 秒维护快验、53.602 秒固定旧样本、199.859 秒完整 Windows smoke 均通过且实际退出 0；source/ASAR/七包/native 及两次实际安装的 notes 79、applications 11 个成员已核对绑定。详见[入口偏好最终记录](spark233-launcher-preferences-followup.md)。不把新输入冒称为前一 `1613a87a…` 已经验收的功能。

旧设置候选 c1a8deb1… 的门禁继续只证明其输入，不含 P5.11/P3.12。完整一期的实机、OS 剪贴板、SYSTEM/UAC、IME/多屏及公开发布范围仍由原条目保留。

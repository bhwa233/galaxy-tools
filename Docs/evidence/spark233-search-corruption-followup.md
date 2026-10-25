# P5.8 私有索引损坏、目录撤权与其他命令可用证据

日期：2026-10-25。当前正式 Index/Search 在私有磁盘索引的增量日志头损坏后，真实拒绝 replay、自动重建并恢复文件名搜索；原始样本字节未变。正式 adapter/Instant 也拒绝继承目录读取 Deny 后的旧命中，新查询不返回受限正文；目录和子文件原 ACL 精确恢复。另以现有打包候选的真实 LauncherController、PluginManager 和 Search adapter，证明文件搜索连接不可用后仍能查询和选择官方应用、离线词典结果。本轮没有修改产品源码、正式 runner、总 TODO 或总审计，也没有新增 Vitest、框架、依赖或故障矩阵。

## 先核查既有证据

`search-production/4428a93a-721e-44b0-a868-e9701daae49f/report.json` 的 24 项检查没有损坏/重建验证。其 fixture 没有预先创建 `name-index`，报告状态为“索引可用，但保存失败，请检查索引目录权限及磁盘空间”，所以不能据其可搜索结果声称磁盘缓存已经持久化。本轮先创建私有索引目录，核验实际 `PIDX` 和 `PDLT` 文件，再注入损坏。

源码边界已确认：`StartFixture` 设置显式 fixture root 后调用正常 `Start`；`Worker` 真实执行 `TryLoadCache` 和 `ReplayDeltasLocked`；拒绝增量后撤下映射、设置 rebuild_required 并执行 `FullRebuild`。显式 fixture root 限定 `WalkTree`，不进入 MFT 扫描。此处是正式二进制提供的私有测试入口，没有替换 IPC 或搜索实现。

## 正式原生字节与实际损坏恢复

报告：`local-build/evidence/search-corruption/3672850e-820b-4b71-acc1-b94e0fcaf176/report.json`，`ok=true`，11 项检查全部 true。专属一次性 runner 为 `local-build/spark233/native-search/corruption-followup.mjs`，SHA-256 `9ad569e33ac6ce1652cf3cf45a1cf54335dd5491d16888431d83e093dc0c1058`；复用现有 production-smoke 的 `--test-host`、真实 Search 请求文件协议及现有 shutdown probe，没有更改通用生产 runner。

| 输入                                                                | SHA-256                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `packages/official/search/native/spark233.Index.exe` 的 run 内副本  | `32ca4bd14e1633264b19386b9d317494866bf6c00e57759d3763310042fdf614` |
| `packages/official/search/native/spark233.Search.exe` 的 run 内副本 | `80299ce859bb3b3500f287cbf4718809fc8631ae92ff2a16717b103ce73dd521` |

实际顺序及证据：

1. 两个私有文件 `corruption-needle.md`、`corruption-worker.ts` 先记录 SHA-256。基线 Index PID `53008` 以专属 fixture pipe、显式 files/name-index、私有 profile/machine/TEMP 启动，正式 Search 返回两条实际路径，状态为“已索引 11 项 · 正在监视”。11 项包含路径祖先节点，不代表扫描了其他目录。
2. 通过已有 probe 的真实状态往返和 test shutdown 正常退出，exit code 0。磁盘 snapshot 为 525968 bytes、magic `PIDX`；WAL 为 16 bytes、magic `PDLT`。完整未损坏 index 复制留在同 run 的 `undamaged-index/`。
3. 仅把该 run 中 `spark233-index.dlt` 的前四字节 `PDLT` 写为 `BAD!`。snapshot SHA-256 保持 `77f8db9092d623c4ed94499f3dd8b3639d97403605960c2f0208be22b450d8ba`；WAL 从 `3a87bbabb8ae41c7323569c0f0c88dd038db74067ea4f321da0f6e3a6209052c` 变为 `c0ed760dd411fe844412d530bba8cc326586277f676943094bf6b6f40d241ec5`。
4. 同字节 Index PID `48924` 重启，原生 `native-profile/spark233/Diagnostics/Runtime/index-helper-48924.jsonl` 依次记录 `index_wal_header_rejected`、`index_replay_rejected`（`rebuild_required=1`）、`index_rebuild_begin`（`reason=1`、`nodes=0`）、`index_rebuild_end`（`nodes=11`、`elapsed_ms=31`、`error=0`、`outcome=0`、`used_mft=0`）。这是实际拒绝后从零开始的自动重建，不是仅观察到搜索成功。
5. 正式 Search 再次返回两个原始路径，真实 service-status 返回 connected=true 和“已索引 11 项 · 正在监视”，没有保存失败。重建 WAL 恢复 `PDLT`。两个源文件前后 SHA-256 完全相同。恢复 host 经同一 probe 正常退出，exit code 0。

重建瞬态只持续数十毫秒，本轮没有抓取或宣称 renderer 已显示“正在重建”；明确的损坏原因由真实原生诊断记录证明，恢复后的状态由正式 Search service-status 返回证明。源码中的损坏状态文本不能冒充本轮已显示的 UI。

## 私有目录继承撤权

报告：`local-build/evidence/search-directory-acl/26b04ea7-724a-4c6e-80f2-e268785df4f1/report.json`，`ok=true`，7 项检查全部 true；同目录 `current-binding.json` 为 true。复用原 production-smoke 的实际 staging/manager/adapter/Instant 初始化与 ACL helper，仅保留本项和正常停机，没有重跑原 24 项。独占 runner 为 `local-build/spark233/native-search/directory-acl-followup.cjs`，SHA-256 `36ffa39ddac35a81c8c637d13decda88994510afb363cf6ae0511c924c61bc96`。

实际 staging 内 Search/Index/Document/pdfium 四文件与当前源包散列完全一致。adapter 使用原 ACL 报告的隔离编译目录，当前 `search.ts` 散列仍为 `b8d40312f29e2c52e0052b9f38f9bdaa73eb060cacd25c42ecc6b715431ba461`，编译 JS 仍为 `ef28de9a8725447265a2cc701fea878c03154b6f3a5ebc502306928c2af5e68d`，均与既有绑定记录相同。

1. 唯一被改 ACL 的目录是本 run 新建的 `files/acl-revocation`。变更前 `realpath` 核对与预期绝对路径相同，位于本 run resolved 根下，且不是符号链接。保存该目录和子文件 `revocable.md` 的原 Access SDDL。
2. 正式 Instant 先读到子文件正文并返回真实 opaque selection。PowerShell 仅在上述父目录为当前 SID 添加 `ReadData` Deny，设置 `ContainerInherit|ObjectInherit`；实际子文件 ACL `childInheritedDeny=true`。没有对文件单独写显式 Deny，也没有改 owner 或 WRITE_DAC。
3. 同一调用者实际读子文件返回 `EPERM`。沿旧 selection 请求 preview/open，都返回“文件已更改，请重新搜索 / 旧命中位置已经失效”，没有得到正文 preview，也没有调用 open 回调。这是实际安全拒绝后的通用失效提示，不声称提示已细分为 ACL 原因。
4. 新正式 Instant 查询不返回受限文件；当前实测返回“搜索暂时不可用，点击重试 / Content query did not complete”，保留 content 重试动作。没有把该结果描述成健康的空结果页。
5. `finally` 恢复父目录原 Access SDDL，并分别比较父目录、子文件恢复后的 SDDL 与各自原快照，均逐字相等；子文件正文也重新可读且与原始字符串完全相同。Index PID `45364` 经正常 test shutdown 退出0。

首轮 `5942c6b8-4f73-4bcf-8cee-9f1c51b13487` 已全部通过6项并记录子文件继承为 true、精确恢复为 true；最终只增加显式的继承断言和 preview/open/新查询实际响应留存，7项再次通过。所有真实撤权与恢复都严格限于各自私有 run。

## 搜索不可用后，其他启动器命令仍可执行

报告：`local-build/spark233/functional-integration/search-fault-coexistence-runs/1cffe9d5-c8c8-4a93-9258-ee29d3dab861/report.json`，`ok=true`，11 项检查全部 true。同目录 `native-binding.json` 再次确认实际安装的 Search/Index 与上表当前 package 字节相同，`ok=true`。

runner 从现有 `launcher-coexistence.mjs` 派生到独占 `search-fault-coexistence.mjs`，没有改动原 runner。SHA-256 `79192443578ed8937dd7c25f819ddf8d54be13cedd4298e65979f3df63b90319`。宿主来自现有 `ui-contract-followup/release/win-unpacked/resources/app.asar` 的 run 内冻结副本，SHA-256 `94ed07fe0a851d40a9110fef9567d97f7c7a9528af18faee9aa3ac77fd83e836`；这是明确绑定的现有候选，不声称等于之后新出的统一候选。报告记录实际 launcher/manager/backend 编译 JS 散列。

三个官方归档均先与候选 catalog SHA-512 校验，再经过生产 staging/manager 安装：

| 归档         | SHA-256                                                            |
| ------------ | ------------------------------------------------------------------ |
| applications | `76667e97e50abfdc6630b41a442b27f30cdc491e629eb215deb1abd51be0bf22` |
| translation  | `9c0a8c1f2ed80235e48f45eab6c48c228ab45d45bd8ece1f50c610c035547116` |
| search       | `a492cb01f8bc91fa0e829b77e2032dd664f5ecb6c473282388955b5bbff7601b` |

本次 Search adapter 连接唯一、实际未监听的私有 fixture pipe，根为 run 内空目录。实际 native Search 尝试连接并返回 service-unavailable，真实 launcher 的 `spark233.search:files` 模式返回“搜索暂时不可用，点击重试”，保留 `commandId=search`。没有 mock IPC、模拟返回或启动服务。

随后在该搜索连接仍不可用时切回默认查询 `hello`，真实应用 provider 与真实 ECDICT provider 同页返回精确同名结果；分别通过真实 LauncherController.execute 使用各自 opaque selection：词条返回 `hello`、`interj. 喂, 嘿`、`networkUsed=false`，应用返回该 run 私有 `hello.url` 的 custom 目标。没有运行 shell、启动关联应用、写入真实剪贴板或执行待选 AI 命令；loopback AI endpoint 收到请求数为 0。两个 utility PID `28088`、`36016` 正常 shutdown 并确认退出。

此项证明故障后的来源切换及应用/词典选择仍可用，没有测量并发挂起查询的响应延迟，也没有做 renderer 点选或键盘验收。

## 隔离、首轮修正与范围

所有文件、profile、索引、原始样本、归档安装、应用设置、TEMP 和日志均在上述 `local-build` run。没有服务安装/卸载/配置、UAC、SYSTEM 进程、全卷扫描、用户目录采集、实际便签或剪贴板操作。

保留的原生首轮 `9c0f725a-8d1b-4c01-ac24-d68d004ef509` 未先创建 native-profile 父目录，诊断初始化失败而未产生日志；基线持久化及搜索恢复实际成功，但该轮不可用作拒绝日志证明。第二轮 `eaf21532-294c-406f-9899-80a990d71a43` 已产生真实完整拒绝/重建日志，runner 误把日志 `data.error/outcome/used_mft` 当顶层字段，断言失败。最终仅修正这些证据读取问题后通过，没有产品修复。

共存补证的 `dc235268-f151-474a-a1db-4194ac74d6bf` 与 `44821b6f-b15d-4250-b669-2d80400b4e49` 在 Search 初始化前因 probe 的 pipe 字符串转义错误被正式隔离参数校验拒绝；已保留失败报告，utility 均退出。最终只修正 probe 的 Windows pipe 字符串；产品校验未改动。

按 P5.8 原文“服务不可用、目录撤权、索引损坏和插件停用有明确状态，其他命令仍可使用”，本轮补证与原生产24项停用清理、服务面板错误恢复证据合并后，已覆盖这五类功能的代表路径：真实不可用重试、真实目录继承撤权的失效/重试、真实损坏拒绝/自动重建/恢复状态、真实停用清理、故障后其他来源查询和选择。因此可按该条目的功能范围判断完成，由主线更新勾选；本文件不直接修改总 TODO。

该判断不扩大为全部故障组合或视觉验收。本轮没有验证主 snapshot 任意损坏、所有 WAL 截断/层级错误、手动重建按钮、并发挂起查询延迟或 renderer 重建瞬态显示。真实 SCM/SYSTEM 部署与全卷 MFT/USN、卷离线重连等仍归原 P5.3/P5.5/P5.9 等条目的验收范围，不能从本报告推导已完成，也不将它们新增为 P5.8 的勾选前提。

复现：

```powershell
. ./scripts/use-toolchain.ps1
node local-build/spark233/native-search/corruption-followup.mjs
node local-build/spark233/functional-integration/search-fault-coexistence.mjs
$env:SPARK233_SEARCH_COMPILED_ROOT = Join-Path (Get-Location) 'local-build/spark233/search-acl/compiled'
& ./node_modules/.bin/electron.cmd local-build/spark233/native-search/directory-acl-followup.cjs
```

各 runner 每次创建独立新 run。本轮只新增专属证据文档及忽略目录中的 probe/报告，未改源码，未重跑 typecheck/lint/test/build/pack；产品源码及新统一候选由主线的统一 gate 与打包验证负责。

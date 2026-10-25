# spark233 独立更新的业务派发与生命周期边界

日期：2026-10-25；分支：`codex/spark233-refactor`。本轮修复 P7.3/P2.5 的实际全局排队问题，并以真实官方包、私有便签和暂停的合成剪贴板数据验证。未将活动选区、listener 或全部业务工作区人工验收标为完成。

## 实现

此前 `install()` 将 stop、备份、迁移、切换与新 runtime 初始化完整放入全局 `serial()`；`dispatch/query` 也等待该队列。因此截图的异步停机/初始化会阻塞无关插件的新命令。

`electron/plugins/manager.ts` 现保留全局串行 mutation，业务派发独立：

- `starting` 按 plugin 去重 factory Promise，登记 record、scope/owner 和相关依赖后才进入异步 factory。外部并发启动共享 setup；成功发布、业务派发前后都重新核对安装 record、owner、scope 和生命周期 fence。无关插件的活动命令和冷启动都可以在另一插件事务期间执行，不持有覆盖完整业务任务的插件锁。
- 同插件或相关依赖已有未完成 setup 时，mutation 在状态/数据变更前一致拒绝；目标或所需提供者停止/更新期间的新命令立即拒绝，不能排队到新版实例上继续执行旧调用。必需依赖和当前命令的 `requiresPlugins` 参与检查；可选提供者不可用不阻止消费者独立 factory/命令。
- 使用内建 `AsyncLocalStorage` 的短生命周期 factory token。factory 内遇到已经 starting 的嵌套目标会明确返回 `pluginStarting`，不等待自身；未开始的无关冷目标仍能启动。token 在 finally 失活，后续普通回调不会被永久当作初始化调用。
- `withQuiesced`、initialize、shutdown 全程独占业务：拒绝新派发/新启动，等待已经进入的 factory settle，然后 prepare、快照/恢复和重启。factory 重入全局维护在入队前拒绝，防止维护等待包含自己。业务任务原有 scope 取消、保存与 maintenance 合同继续使用。
- 故障 owner 在 `reportCrash` 入队前立即被阻止派发；持久化仍在全局 mutation 队列中。排队回调同时要求当时捕获的安装 record 对象仍相同，避免旧 owner 污染快照替换出的同版本新记录；同 record 冷 factory 清理后无 instance 的合法错误仍可记录。
- 可用性通知复用安全 `notifyChange`：生命周期、starting、exclusive 解除后通知 observer，异常不破坏 fence/清理；首次提交 stateFile 前不发临时事件，保留 observer 可读已提交状态的合同。
- `copyData` 使用现有 `fs.promises.mkdir/cp`，所有复制调用点均 await 后再推进 journal 阶段，保留链接拒绝。截图数据复制不再用同步 cp 阻塞无关业务事件循环；这不是大目录性能预算报告。

源码冻结时 manager SHA-256 为 `5ea03eb632bd7beb82951425ccb8426ce331ee69d0ec5bb7dde35febcb1e5492`。源码、已有 runner、独立编译配置和产物散列记录在 `local-build/spark233/independent-update-concurrency/input-hashes.json`。

## 直接证据

复用 `local-build/evidence/plugins-manager/app/main.cjs` 增加 `--official-independent-update-only`，没有新测试套件、Vitest 文件或框架。独立 tsc 输出为 `local-build/spark233/independent-update-concurrency/compiled/`，未写 root dist；Node 26.12.1 / npm 12.2.1。全项目 `npm run typecheck` 和 manager/已有 runner 的聚焦 lint 均通过，日志为同目录 `full-typecheck.log`、`final-lint.log`。

最终四份报告全部 `ok: true`：

| 运行                     | 当前报告与范围                                                                                                                                                                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 官方独立更新 / 并发      | [5461c44d 报告](../../local-build/evidence/plugins-manager/runs/5461c44d-6901-4696-8a61-f481b755fe70/report.json)，16 项；15 个真实 utilityProcess 全部退出，`alivePids: []`                                                          |
| 管理器 / 显式迁移 / 回滚 | [01692e0c 报告](../../local-build/evidence/plugins-manager/runs/01692e0c-da6c-4562-a783-9368d5006b42/report.json)，14 项；准备写入失败、live/restart 回滚、增量保护、迁移和 dataVersion/包身份、fresh 空树保护保持；10 个进程全部退出 |
| 命令依赖                 | [fa82b5ae 报告](../../local-build/evidence/plugins-manager/runs/fa82b5ae-d6fd-492a-b0b8-f9c27005ce26/report.json)，6 项；提供者启停、旧调用不拉 runtime、独立命令、恢复和非法清单；3 个进程全部退出                                   |
| 备份                     | [f519b443 报告](../../local-build/spark233/backup-functional/runs/f519b443-bcc9-4d18-bd36-dadceed0e9ef/report.json)，9 项；含备份预览身份绑定、真实 Markdown/附件/SQLite、版本一致性、增量保护、失败恢复和断电 journal                |

官方更新使用现存、未经伪造版本号的真实 archive：旧 `release-electron/win-unpacked/resources/plugins/screenshot-0.1.0.tgz` → `pin-keyboard-followup/release/win-unpacked/resources/plugins/screenshot-0.1.1.tgz`，以及该目录的官方 notes/clipboard 包。每包先核对原 index 的 SRI、生产 staging 和精确身份，实际输入 SHA 保存在报告 `officialInputs`。

截图使用真实 `createCaptureRuntime`，但不创建选区。只给其旧 scope 增加一个受控 prepareStop 等待资源，用于稳定观察事务尚未完成的时刻。在释放该 gate 之前，报告直接证明：

- notes 真实 backend utilityProcess + `createNotesRuntime` + 私有 `NoteStore` 完成新正文写入和查询。
- clipboard 真实官方 data backend utilityProcess 在暂停设置下完成合成 PNG 记录的备注修改和查询，原 entry ID、暂停状态、业务内容保持。
- 无关冷插件的两个并发命令完成，使用同一 PID，factory 只增加一次。该额外 scheduling fixture 只证明冷启动机制，没有用它替代官方便签/剪贴板业务。
- 截图安全旧命令 `cancel` 立即返回具体 `pluginStopping`。未使用 capture/ocr，所以守卫回归也不会打开桌面遮罩；本轮截图 runtime 激活计数为 0。超时只会使断言失败，不作为成功依据。
- 报告故障 owner 后，即使其持久化仍排在截图事务后，新命令也已被拒绝。

其他最低层代表覆盖同插件 setup/mutation 竞争、factory 全局维护重入、嵌套冷 factory cycle，以及维护同时排除活动/冷业务。`onChange` observer 实际读取 `commands()`，记录 starting、生命周期与 exclusive 期间撤下并在结束后恢复，避免只核对内部布尔值。

旧 owner 代表在维护等待另一插件 prepare 时提交 notes 的旧故障报告，随后替换为同版本 disabled 新安装 record；释放维护后旧报告没有写入新记录 `lastError`。没有通过杀真实业务进程制造这个时序。

截图/OCR/剪贴板 native 在 gate 与结束后的私有路径 CIM 盘点都为空，截图 runtime 激活计数始终 0；没有构造 ClipboardController/listener。clipboard 通过仅供该 headless probe 使用的 history→data 映射调用实际业务 backend，证据范围是暂停的合成数据操作，不是 listener/完整官方 workspace UI。

## 运行记录与限制

最初 backup invocation 忘记传 `SPARK233_BACKUP_COMPILED_ROOT`，新版 driver 使用默认旧编译目录，因其没有 manifestFingerprint 而失败；日志保存在 `backup-wrong-compiled-path.log`。显式指向本轮独立输出后上述 9 项通过，没有将错误编译路径当作产品缺陷或修改断言。此前官方/manager 草稿运行只作历史，最终引用上表固定路径。

本 lane 当时未运行 root build/pack、桌面 automation、截图遮罩、用户真实便签/剪贴板、UAC 或 SYSTEM 服务；后续根任务的[自动回归集成包](spark233-automated-packaging.md)已完成全量现有测试、完整 build/pack 和 fresh 默认 packaged smoke，并核对 manager/backup 编译字节及关联输入。本报告的并发结果据此绑定到该候选，没有冒充重新执行 probe。

P7.3 原文为“单独更新截图插件期间便签和剪贴板保持可用；预装插件与用户插件走相同更新规则”。上述真实官方业务操作满足第一句；生产 `PluginManager.install()` 为官方/用户包复用相同授权、依赖、保存停机、快照、切换及恢复路径，且外部 Hello Web 的 [HTTPS 更新报告](../../local-build/spark233/plugin-crash-functional/registry-https-runs/2c800235-257d-447c-8416-e8e459bc3560/report.json)已实际完成 prepare/confirm、0.1.0→0.2.0 更新及 SRI 拒绝链。因此按原范围完整勾选 P7.3。

此前将活动选区、实时 listener 和完整工作区操作合并为 P7.3 完成条件的结论过度扩大了原条目，现更正；这些范围分别留在 P4.18、P6.1 和 P2.5 等对应条目，仍不能由此宣称它们通过。公开 npm 发布继续留 P7.1。

# spark233 2026-10-25 收尾与明日接续

状态：按用户要求暂停，明天继续。分支为 `codex/spark233-refactor`，HEAD 为 `0e8c2637558ee1c6640daf59a192cf53a35e8e89`。本轮没有提交、推送、重置或清理工作区；此前及本轮的未提交修改均保留。

**当前 TODO：45/98 项完整完成，53 项部分完成或待验收，约 45.9%。这不是代码开发完成率。当前源码停在便签异步接线中途，不能直接作为已验证版本运行或打包。**

## 先看这几个入口

- [主实施清单](launcher-todo.md)与[架构](launcher-architecture.md)：继续沿用原始一期范围。
- [便签边界续作](evidence/spark233-notes-boundary-followup.md)：为什么 P3.1 撤回完整标记，哪些业务必须真正移入插件。
- [便签存储隔离](evidence/spark233-notes-storage-isolation.md)：已完成的 lazy-init 红/绿证据，不覆盖后续异步接线。
- [最后已验证安装包](evidence/spark233-ui-contract-packaging.md)：可运行候选与当前未完成源码分开保存。

## 今晚实际保存的检查点

`local-build/spark233/pause-2026-10-25/source/` 保存本轮接线涉及的 **24 个文件副本**；`snapshot.json` 记录分支、HEAD、逐文件 SHA-256、大小与当前检查状态。它是额外副本，工作区原文件保留，没有执行 stash 或回退。不要用该副本整体覆盖明天的新改动。

收尾实际运行了项目选定 Node 26.12.1 / npm 12.2.1 的 `npm run typecheck`，**退出 1，42 个错误全部在 `electron/main.ts`**。日志：`local-build/spark233/pause-2026-10-25-typecheck.log`。主要是旧 `store/reminders` 引用、未完成的 startup 和 IPC 接线、异步菜单 `.popup`、Capsules 选项及 smoke 的同步接口。这个结果准确描述暂停源码；早先 green 的日志不能替代它。

所有并行分工已停止。收尾只读核对没有遗留的专属 notes/registry/候选 smoke/Index/Search 测试进程或待续 tool session。没有保留后台构建或自动验收任务。

## 最近一个完整通过的候选

标签：`ui-contract-followup`。

| 内容           | 身份与结果                                                                                                                  |
| -------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 安装器         | `local-build/spark233/ui-contract-followup/release/spark233-1.2.0-x64.exe`，210,070,753 字节，未签名、未执行                |
| 安装器 SHA-256 | `80e05bcaf0eec530684af59773b8f27b57540640381d87886b0c8123c1fb1efe`                                                          |
| ASAR SHA-256   | `94ed07fe0a851d40a9110fef9567d97f7c7a9528af18faee9aa3ac77fd83e836`                                                          |
| 总报告         | `local-build/spark233/ui-contract-followup/artifact-report.json`，`ok:true`、`artifactIntegrity:true`                       |
| 门禁           | typecheck、lint、现有 32 文件/162 项、完整 build、Windows 目录包与 NSIS、七包/UI/ASAR 审计及 fresh 默认 packaged smoke 通过 |
| 运行检查       | 维护恢复、最终 ASAR 文本目标 9 项、真实 main 的 AI 显式请求检查通过；固定数据保持、剪贴板暂停且零条、七包启用且零安装失败   |

该包包含 UI 0.2.0 和搜索面板错误恢复，**不包含随后开始的 notes 0.1.1 数据引擎与异步接线，也不包含便签 lazy-init 中间修复**。保留它用于对照，不把暂停源码的新结果改绑为该包通过。

## 本轮已经取得的证据

- P2.12：版本化 `@spark233/ui@0.2.0`、真实宿主主题通知、独立 Web 包升级、仓库外归档类型/点击/深浅色消费、官方工作区实际包入口均通过，已勾选。见[主题/UI 合同](evidence/spark233-theme-ui-contract.md)。
- P6.7、P3.6：词典/AI 默认与手动切换、打开 AI 不请求而点击才请求，以及同名应用/实际词典/待执行 AI 共存通过，已勾选。见[模式切换](evidence/spark233-translation-mode-followup.md)、[同名共存](evidence/spark233-launcher-coexistence.md)。
- P7.2：实际 TLS body 中断保护旧版、新增能力确认前后 grant、有效但宿主版本不兼容的拒绝，结合原 HTTPS/离线/回滚证据通过，已勾选。见[更新合同](evidence/spark233-update-interruption.md)。公开发布仍归 P7.1。
- P7.3：真实截图插件更新等待期间，官方便签与暂停合成剪贴板的数据操作保持可用，且预装/用户包共用更新规则，已勾选。见[独立更新](evidence/spark233-independent-update-concurrency.md)。
- P5.8 新增证据：私有真实 WAL 损坏/重建 11 项、目录继承撤权/精确恢复 ACL 7 项、搜索故障时其他命令 11 项通过。见[搜索补证](evidence/spark233-search-corruption-followup.md)。**总 TODO 暂未勾选；明天核对其状态反馈与原条目后再决定，不重复跑已通过场景。**
- 便签 lazy-init：真实 red 退出 1，修复后真实 main 的 13 项、现有 store/reminders 16 项、相关备份 9 项通过。独立源码冻结副本为 `local-build/spark233/notes-storage-isolation/lazy-source-freeze/`。它是参考基线，勿覆盖当前后续异步改动。

## 暂停时的源码状态与责任边界

| 分工与文件                                                                                                                                  | 已落地                                                                                                                                                                                     | 未完成                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| notes 引擎：`packages/official/notes/{backend.ts,build.mjs,tsconfig.json,package.json}`、`electron/plugins/official/notes-data-contract.ts` | notes 0.1.1；内部 `{version:1,action,...}`；实际 CRUD、分类、搜索、append、图片/背景、opaque layout、提醒等在 utility backend；notes 单独类型检查和自包含 backend 构建通过（213,646 字节） | 尚未真实运行新 engine 的 utility 保存、trash 拒绝、取消、prepare/drain；根目录迁移事务尚需宿主接入                                         |
| 通道：`electron/plugins/{backend-worker,backend,desktop-host}.ts`、`scripts/build-official-plugins.mjs`                                     | owner/request-bound `file.trash` 请求/回复，结构化 code/details 兼容旧字符串错误，实际 grant 传递，组装 notes 前构建 backend                                                               | 尚未与完整真实 main 验证；不可把通过编译当成生命周期/信任验收完成                                                                          |
| client/runtime/MCP：`electron/plugins/official/{notes-data-client,notes}.ts`、`electron/mcp-protocol.ts`                                    | 全 Promise 数据 API、`fromTransport`、active drain、前端保存后的第二次 backend durable prepare；MCP 等待异步删除；聚焦 lint 和原 MCP 12 项通过                                             | 整体接线未验收；不能绕 manager 暴露任意私有 transport                                                                                      |
| main/store：`electron/main.ts`、`electron/store.ts`                                                                                         | lazy-init 已有独立证据；HostConfig 读取、部分窗口/菜单/布局/MCP 已转异步；Store 配置注入为最小 Pick 类型                                                                                   | `handle()` 和 startup 仍残留旧对象；最终保存白名单、trash/提醒事件/asset、迁移、await/error handling 未全部接完；当前 42 个类型错误在 main |
| native shell：`electron/capsules.ts`、`electron/host/tray.ts`                                                                               | async notes DTO、配置与数据根分离、摘要/preview/tray 的 generation 守卫、异步菜单/保存接口                                                                                                 | 未做真实 native/生命周期验证；与 main 的选项还需接齐                                                                                       |
| 现有 smoke：`electron/smoke*.ts`                                                                                                            | 原有效回归均保留                                                                                                                                                                           | 尚未适配 Promise 数据 API 与 `openNote():Promise<string>`；不能删除断言或用同步缓存绕过                                                    |

“便签已独立启停”和“真实业务引擎可以随插件更新”是不同范围。当前 engine 仍有主进程旧接线，故 P3.1 保持未完成；没有把这个实现缺口转成最后人工验收。

## 明天接着做的顺序

1. **读最终合同并完成 main 接线。** 对照 `notes-data-contract.ts` 和 `notes-data-client.ts`，逐组替换 notes/categories/images/reminders、背景图与迁移分支；移除 startup/will-quit/second-instance 的旧 `NoteStore/Reminders` 运行对象，补齐 Promise 菜单、窗口调用和错误处理。Capsules 选项使用 `notes/getConfig/dataRoot`；打开便签回调要处理 Promise 返回。
2. **守住保存与生命周期。** 公共调用经 manager；factory 启动只用当前 owner 的 `backend.activate`；只有正在等待 prepare 的真实窗口且属于最终写白名单才可 `backend.maintenance`，窗口 ack 后拒绝新写。页面最后维护写入会使旧 backend ack 失效，必须保留 runtime 的第二次 durable prepare。保存拒绝后恢复暂停的提醒 timer，保留旧窗口与实例。
3. **接齐平台与数据归属。** main 的 `onBackendHostCall` 检查 signal/owner/plugin，再等待 `shell.trashItem`；通道已重验授权 root、storage grant、活跃请求和相对路径。删除失败不提交 metadata。资源通过 engine `resolveImage`，宿主不继续拼 `notes/images` 规则；布局为 opaque state。`storage.migrate` 目前只准备副本并返回新 root，worker 随后恢复旧 root，需宿主事务提交指针、失败恢复和重启，不能直接写 config 就称迁移完成。备份 notesRoot 特例仍需继续按架构处理。
4. **适配原 smoke，再做最小集成验证。** 保留原断言，改为 await 数据操作、异步 `openNote`，config/dataDir/configDir 独立传入。把 notes 自身 TS 检查纳入正常 gate（当前根 typecheck 脚本尚只列官方 clipboard）。先定向编译，再用已有 runner 验证真实 utility 保存、回收站失败保护、prepare/refusal、停用目录隔离及原 ID/附件/布局/提醒保持。
5. **只在集成收口后统一跑门禁与新候选。** 按影响范围跑相关现有回归，最后 typecheck/lint/test/build、pack 和 smoke；明确新输入身份。更新 TODO/审计；未完成的首装、原生选择/回贴、SYSTEM/UAC、IME/多屏、性能和公开发布继续保留。人工界面验收仍放最后。

## 继续工作的命令入口

```powershell
. ./scripts/use-toolchain.ps1
git branch --show-current
npm run typecheck
```

当前这条 typecheck 预计仍失败，先修接线，不应反复启动旧目录包来验证新源码。接线完成后再按需执行：

```powershell
npm run lint
npm test
npm run build
npm run pack:win
pwsh -File scripts/smoke-windows.ps1
```

继续遵守 MVP 约束：不新增测试框架、穷举矩阵或大量用例；优先复用已有有效测试和 runner，新增只保护实际数据/信任/生命周期风险。所有 profile、安装、便签、历史、索引与 native 配置放 `local-build/` 或明确临时目录，冻结原始样本不用于运行。

下一次可直接说：“按 `Docs/spark233-handoff-2026-10-25.md` 继续，先完成便签异步接线。”

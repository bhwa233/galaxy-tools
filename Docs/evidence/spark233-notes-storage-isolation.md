# 停用便签的存储故障隔离：中间阶段证据

日期：2026-10-25。本记录绑定下述冻结源码与隔离编译产物，证明一个实际启动故障已修复；它不代表便签 engine 抽取完成，也不代表此中间态已重新打包。随后完整 utility engine 接线必须在最终真实 main 上重放这些关键边界。

## 真实故障与最小修复

私有配置将 notes、clipboard 预先 disabled，其他业务数据为空；notes `dataDir` 指向本次 run 下的受控普通文件，原合成便签、提醒和布局保存在旁边的独立目录。现有真实 `main.ts` 经隔离 tsc 编译运行，bootstrap 只替换错误对话框为 JSON 记录，并只读观测 Electron utility PID；不 mock NoteStore、宿主、插件管理器或 provider。

Red：`local-build/spark233/notes-storage-isolation/b349e312-1589-4acb-a858-6b6439830e30/report.json`。`new NoteStore()` 在插件启用判定前无条件 `ensure()`，尝试 `mkdir data/notes`，抛出 `ENOTDIR`，真实宿主退出码 1。错误保留在同目录 `dialogs.json`、`stderr.log`；受控文件与原布局散列不变。

此阶段仅改 `electron/main.ts`、`electron/store.ts`：NoteStore 构造可显式延迟初始化，默认构造行为保持兼容；宿主创建延迟实例，便签 runtime start 才依次 ensure、加载提醒和布局，成功后设置 active。停用时托盘不列便签，`persistLayout` 必须同时满足 active 与布局已成功加载，避免停用后退出碰坏目录或写空布局。备份 reload 仍通过原恢复服务执行，便签数据加载延迟至对应 runtime；原恢复日志校验、文件切换、版本账本与回滚流程未替换。

## Green 与相关回归

Green：`local-build/spark233/notes-storage-isolation/dca8b097-776a-430e-93d8-0798c150604c/report.json`，13 项检查通过，真实宿主退出码 0。

- notes/clipboard 停用且 notes 根目录为普通文件时，宿主启动，配置可读，真实 translation provider 能查询 `hello`。
- 无效根目录下显式启用只使 notes 返回错误，宿主及配置继续可用。
- 根目录恢复后，再将其 `notes` 子目录设为普通文件；真实 notes utility 已启动，但 host adapter 的 ensure 失败，notes 保持 inactive。utility PID `49248` 被实际观测到并正常释放。
- 恢复目录后显式重试，新实例 PID `52268` 成功启动，原合成便签、原提醒与保存的布局均恢复，真实 `notes_create` 能保存新便签。
- 再次停用，令根目录重新成为普通文件，宿主仍可读配置并正常退出；原布局与阻断文件散列均不变。未启动真实应用、剪贴板采集或外部服务。

完整 `npm run typecheck` 通过；对 main/store 的现有 oxlint 通过；现有 `store.test.ts`、`reminders.test.ts` 共 16 项回归通过。现有 `independent-update-concurrency/backup-driver.mjs` 通过 `SPARK233_BACKUP_COMPILED_ROOT` 绑定本次隔离编译产物，9 项回归通过，报告 `local-build/spark233/backup-functional/runs/55143bfb-b004-4e46-b37f-3ff8a46a6501/report.json`，包含 reload 失败后的 journal 回滚和停电后自定义 notes 根目录恢复。该 driver 验证服务与回调边界，不冒充真实 main 的整套备份 UI 验收。

基础 renderer、官方归档和 native assets 来自 `ui-contract-followup` 候选，原 ASAR SHA-256 为 `94ed07fe0a851d40a9110fef9567d97f7c7a9528af18faee9aa3ac77fd83e836`；main/store 按工作区源码隔离编译并覆盖在 run 内，不能将源 ASAR 的散列说成包含本次修复。

冻结源码副本位于 `local-build/spark233/notes-storage-isolation/lazy-source-freeze/`。main SHA-256 为 `ed833e614f2fb61a8f7d222045735745f1974636bca2e803a4add055613b9395`；store 在 green 时为 `35ca623415953ac499be0fccb4da818b120ebed2e7633476af9be7c0d91b8cab`。随后为 engine 内存配置注入，将 store 的 hostConfig 参数与字段类型改为 `Pick<HostConfigStore, 'value' | 'save'>`，冻结源码 SHA 为 `53b556d32bfedac71c97ebf98ae9394105704518271fed4aeda4e381f3038cbb`；前后 emitted `store.js` SHA 均为 `0136240d3641bd8f9893c0a1d470366d7467ae36eb3c9a74ef67cb894bd0563c`，该调整不改变运行字节。

首轮探针准备 `bf972190-35f7-4566-bbb2-fc81378d1bdd` 因 Windows 短暂 EPERM 无法重命名私有 fixture，在启动宿主前失败；加入仅针对该受控重命名的短暂重试后得到 red。第一轮 green `05a5740d-3f22-4781-b5f2-1b897641f2be` 的直接 launcher 查询与 renderer 初始查询竞争，取得被 production generation 取消的空页；改用真实 `translation_action/search` 验证无关业务可用，未为此修改产品。两轮报告保留。

## 实际剩余边界

此中间态仍在 host 创建 NoteStore，便签搜索、Markdown/metadata/附件读写、布局和提醒仍通过 host callback 执行；它只解决 disabled notes 存储不可用拖垮宿主的问题。`PluginBackupService` 对 notes 根目录的特殊挂载和恢复协作也仍然存在。这些属于尚未完成的源码边界，不是只剩人工验收；完整抽取状态以 `spark233-notes-boundary-followup.md` 和后续真实 engine 证据为准。

复现：先选定项目工具链，再运行 `node local-build/spark233/functional-integration/notes-storage-isolation.mjs`。`--expect-startup-failure` 仅适用于冻结的修复前源码；不要对修复后源码期待同一 red。每次均产生独立 profile 与报告，不覆盖旧数据。

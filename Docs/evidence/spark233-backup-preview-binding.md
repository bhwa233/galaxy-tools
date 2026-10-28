# 备份预览身份绑定与重新选择修复

2026-10-27 最新补证：[集中代码包及功能测试](spark233-source-restore-functional-tests.md)已通过 42 文件/192 项测试、lint 和含 typecheck 的 build；未新增 UI/Windows 验收，本文旧报告仍保留原范围。

日期：2026-10-25。分支：`codex/spark233-refactor`。范围：P6.14 的恢复预览合同和重新选择状态。源码修复后已补一条真实 renderer/host 的自动回归，见末节；没有 Windows 点选或真实用户数据操作。

2026-10-27续作：旧Main完整备份UI恢复及重启另有独立代表证据，见`local-build/spark233/restore-main/original-main-summary.json`。它不覆盖当前新增的文档级预览令牌撤销及恢复后宿主管理状态刷新；这两处按[剩余实施基线](../archive/2026-10/spark233-remaining-implementation-2026-10-27.md)先补文档、集中实现、最后统一验证。

## 已修复的两个缺口

原宿主 opaque selection 只记录备份目录与选择时间。预览 A 后，如果确认前该路径被替换为另一份完整、有效的 B，原恢复服务会重新校验 B 的自洽散列并恢复 B，没有比较用户曾预览的快照身份。原有“只修改 payload 而未更新 manifest”的篡改检查无法保护这个完整替换场景。

当前 `PluginBackupService.inspect` 在完成全部文件/插件状态校验后，返回已验证 manifest 的 SHA-256 指纹；它由经过既有 schema 校验的整个 manifest JSON 生成，覆盖挂载、条目散列、插件版本、授予能力和数据版本等内容。`electron/main.ts` 将该指纹与 canonical 目录、选择时间保存在宿主 selection 中，只向 renderer 返回预览与不可猜测 selectionId；指纹不显示在产品流程中，也不由 renderer 提供。

`restore` 现在要求预览指纹，并且只读取一次作为本次恢复依据的 manifest。在完整文件核对、`pauseHost`、页面保存、插件停机、journal 或 staging 写入之前，先比较该 manifest 与预览身份，不相同则返回 `backupSelectionChanged`，要求重新选择并验证。文件/插件验证与恢复 staging 使用同一个 manifest 对象，保留原有 staged entries 与该对象的逐项比较；不会在校验后重读另一个 manifest 作为恢复依据。

另一个缺口是新一次 inspect 失败或 picker 取消后，旧 selection 仍留在界面。`BackupDialog` 现在在新 inspect 开始时清除旧 selection；新选择失败/取消后不再保留旧确认卡。`backupSelectionChanged` 表示原预览身份已经失效，界面也清除该 selection，按当前语言显示 `backup.selectionChanged`，要求重新预览；zh-CN 和 en-US 均有对应提示。其他错误保留原有处理，保存拒绝等恢复失败仍保留当前 selection，宿主也只在成功后消费 token，便于解除保存阻塞后重试。

实际产品改动仅为：

- `electron/main.ts`：backupSelections 类型与 backup inspect/restore 接线；未修改其他 main 业务逻辑。
- `electron/plugins/backup.ts`：返回内部指纹、复用已有校验过程、恢复前比较并固定同一 manifest。
- `src/features/backup/BackupDialog.tsx`：新 inspect 开始时清旧 selection；只对 `backupSelectionChanged` 映射两语提示并撤销失效预览。
- `src/locales/zh-CN/translation.json`、`src/locales/en-US/translation.json`：在既有 backup 段补 `selectionChanged`，没有扩展其他旧错误的翻译重构。

没有改 frontend backup types/API，没有新依赖、通用工具或测试框架。既有 backup snapshot 格式与恢复日志 schema 不变。

## 现有最小 probe 的实际回归

仅加强原 `local-build/spark233/backup-functional/driver.mjs`，增加一项真实有效快照替换场景，没有新测试文件。runner 可通过 `SPARK233_BACKUP_COMPILED_ROOT` 指向本次独立编译结果。

报告：`local-build/spark233/backup-functional/runs/f8f409a8-0217-4ab3-9a6e-63161fa53058/report.json`，**`ok: true`，九项通过**（保留原八项，新增一项）。新增的 `valid-backup-replacement-rejected-before-pause-with-live-data-and-instances-intact` 实际执行：

1. 用原有 Notes/SQLite/插件安装链创建并校验 A，复制到选定目录并取得预览指纹。
2. 修改私有合成便签、历史和设置，创建 B；B 自身完整校验成功，指纹与 A 不同。
3. 保留 A 副本，把完整 B 复制到原选择路径；该路径下的 B 再次校验成功，证明不是靠坏散列触发拒绝。
4. 使用 A 指纹确认该路径，生产服务返回 `backupSelectionChanged`。
5. 拒绝前后 host pause/生命周期 events 没有新增、manager instance IDs 和状态文件相同，当前便签与 SQLite raw 资源逐字节保持；没有生成恢复 active journal。管理器仍能接收 activate，runner 继续完成正常恢复、回滚与数据保护并退出 0。

报告中的 `previewBinding` 明确记录 `bothSnapshotsValidated`、`replacementAtSelectedPathValidated`、`rejectedBeforeHostPause`、`liveInstancesPreserved` 全为 true，Node 进程 PID 为 26320。该既有 probe 使用进程内受管理 fixture runtime 和真实存储，不新建 Electron 窗口或 utilityProcess；不会把实例保持误写成外部进程生命周期验收。

原保存拒绝、Markdown/附件/SQLite 一致快照、匹配的数据版本、恢复前新增数据保护、坏 payload 拒绝、reload 失败回滚及目录切换中断恢复继续通过。

## 门禁与产物界限

项目 runtime 通过 `scripts/use-toolchain.ps1` 选择，Node **26.12.1** / npm **12.2.1**。本轮通过完整 `npm run typecheck`、产品三文件的聚焦 oxlint/oxfmt 检查和现有 runner 的 Node 语法检查。最小 probe 使用：

```powershell
. ./scripts/use-toolchain.ps1
node node_modules/typescript/bin/tsc `
  -p local-build/spark233/backup-functional/tsconfig.json `
  --outDir local-build/spark233/backup-preview-binding/compiled
$env:SPARK233_BACKUP_COMPILED_ROOT = Join-Path (Get-Location) 'local-build/spark233/backup-preview-binding/compiled'
node local-build/spark233/backup-functional/driver.mjs
```

末次两语补齐后重新通过完整 `npm run typecheck`、BackupDialog 的聚焦 oxlint，以及该组件/两份 locale 的格式检查；该阶段没有新增测试或重跑整条 probe。服务与 main 绑定字节未变，前述九项报告继续证明相同后端输入。后续另补失效卡片自动 renderer 回归如下，没有重复执行 A/B 身份边界。

`local-build/spark233/backup-preview-binding/core-source-hashes.json` 保留九项 probe 当时的三个产品输入和 driver 散列；`source-hashes.json` 更新为当前五个产品文件与 driver 的 SHA-256。没有写根 dist、生成官方包或 Windows 分发；当前 `pin-keyboard-followup` 冻结包尚不包含本次新增字节。统一 gates、下一包的实际备份 UI/文件选择器/取消与活动页面保存由主线程执行，本报告不能用于提前勾选 P6.14。所有新样本、快照、状态和恢复文件均在新 local-build run，没有系统剪贴板读写或真实便签访问。

## 真实 BackupDialog 的自动重新选择回归

按用户要求切换为自动测试，复用同一 `local-build/spark233/backup-functional/driver.mjs` 的新增 `--ui` 模式。TypeScript 将真实宿主编译到 `local-build/spark233/backup-preview-ui/dist-electron/`，Vite 将真实产品 renderer/BackupDialog 编译到同目录 `dist/`；没有写共享输出，没有修改 product main、smoke 或冻结 UI 源。

运行的 app metadata 版本为 1.2.0，使用新的私有 profile；七插件代码从既有合成 profile 的不可变版本目录复制，只有 notes 启用，clipboard 在启动前持久禁用，其他插件也不激活。没有复制原便签或历史数据。wrapper **仅替换 `dialog.showOpenDialog` 的 OS picker**，依次返回私有备份目的地、已创建快照、无效目录、同一有效快照和取消；真实 BackupDialog、desktop IPC、当前宿主 handler、PluginBackupService、页面保存与插件停机链均照常执行。

最终报告：`local-build/spark233/backup-preview-ui/runs/d13d1b6a-df12-4c26-9777-ddf5fb9ac93d/report.json`，**`ok: true`**。这是一条连续场景，检查：

- 点击真实“Create backup”，服务实际生成 manifest/files，界面显示成功及生成路径。
- 点击真实“Choose and verify backup”，实际服务完成验证，界面出现来源路径和确认卡。
- 再次选择无效目录，服务返回错误，旧“Restore this backup”卡和“Confirm restore”按钮均撤下。
- 重新成功选择同一备份后再次选择并取消，旧确认卡和按钮同样撤下。
- picker 调用序列准确，宿主 PID 40044 经产品 `--exit` 正常退出，最终 clipboard 仍禁用。

同目录 `created.json`、`valid-preview.json`、`invalid-selection.json`、`canceled-selection.json` 保存每阶段实际 DOM 文本及可见确认按钮状态，`picker-calls.json` 保存原生 picker 的唯一替换点。自动操作通过宿主自己 renderer 的本地 CDP 执行真实按钮事件，没有 Windows 鼠标/键盘点选，也没有 stub React 状态或备份业务返回值。

这条回归能抓住旧实现：旧代码在 inspect 返回失败或取消时仍保留先前 selection，所以确认卡和按钮继续渲染；`newInspectFailureWithdrawsOldConfirmation` / `pickerCancelWithdrawsOldConfirmation` 同时要求对应标题和按钮消失，会明确失败。没有为了此边界再加 Vitest 文件、框架、状态矩阵或重复 A/B 恢复验证。

目标入口为 `node local-build/spark233/backup-functional/driver.mjs --ui`，默认使用上述独立构建目录；`SPARK233_BACKUP_UI_PROJECT` 可显式指定另一套相同布局。宿主 TypeScript 编译、独立 Vite renderer 构建和 runner Node 语法检查通过；`input-hashes.json` 位于 `backup-preview-ui/`。harness 准备期间的版本缺失导致兼容拒绝、全局 status 等待条件过宽两类失败保留在较早 run；前者通过正常 package metadata 修正，后者收窄为备份对话框内部状态，未据此修改产品或将旧失败改写为成功。

这是当前源码的自动交互证明，不是 NSIS/物理文件选择器操作、实际恢复确认或活动编辑器拒绝保存的完整最终验收。后端 A/B 九项和这里的创建/重新选择各证明自己的边界，当前包的统一分发与 smoke 仍由主线程完成。

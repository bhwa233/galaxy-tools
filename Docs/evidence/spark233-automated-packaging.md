# spark233 自动回归集成：最终独立 Windows 候选

日期：2026-10-25；冻结标签：`automated-regressions-followup`。输出固定为 `local-build/spark233/automated-followup/release/`，与所有历史候选分离。

最终流水线已通过。`artifact-report.json` 为 `ok: true`、`artifactIntegrity: true`，并明确绑定本候选自己的 packaged smoke 和真实 Renderer 文本目标回归。本轮复用现有 lint/test/build/pack、发行包与 ASAR 审计、14 个 native 依赖审计；默认完整 smoke 已包含启动器维护错误回归，没有重复运行快模式。

冻结输入：`Launcher.tsx` 为 `31f0343ef0461fa4823a0348f8a180ef1b812b78d8bc0c8013585907fded5bea`，`electron/smoke.ts` 为 `61fdae5d771dc67536778d7f8f26cc450f058d614245de2262c197f22d06cd3e`，`electron/main.ts` 为 `420fff1cdd5cd55ef3e728b446f3923ab94132f065276a16950f4e81294ffaf2`。manager/backup 和其他业务输入保持原独立回归身份，审计将比较编译字节。

全部 smoke、profile、插件安装、历史、便签与索引仅放在本 lane 下。桌面已由主任务释放；本轮不执行 Windows 点击、截图框选、安装器、UAC 或真实用户资料操作。旧 `lifecycle-ui-followup` 的 pending smoke 状态不改写。

## 本候选实际执行的门禁

选定工具链 Node **26.12.1** / npm **12.2.1**；Electron **45.0.0**。

- `npm run lint` 通过；`npm test` 仅执行一次，**32 文件 / 162 项通过**。
- `npm run pack:win -- --config.directories.output=local-build/spark233/automated-followup/release` 通过，包含完整 typecheck、Vite renderer、官方插件构建、Electron TypeScript 与资源复制。日志为 `pack-win.log`。
- 对该 `win-unpacked` 使用 electron-builder `--prepackaged` 生成 NSIS，通过；没有为安装包重新运行一遍产品 build。日志为 `nsis.log`。
- `source-inputs-before.json` / `source-inputs-after.json` 的 **349 份输入完全一致**，`source-input-consistency.json` 为 `ok: true`。
- 七包 catalog、归档 SRI、生产 bounded extraction、manifest API、member inventory、逐文件 SHA-256、共享字体与 OCR app-local runtime/license 全部通过；`latest-distribution.json` 指向该次新报告。
- 14 个 native payload 重新执行 dumpbin dependents 和散列检查；依赖 imports 无变化，未解析外部依赖 **0**。报告为 `native-dependencies.json`。
- ASAR 对根 dist/dist-electron、外置 MCP、宿主命令匹配器与七包资源逐字节核对通过；ASAR 中没有本项目测试源码、依赖 `.test.*` 文件或 exe/dll。字体只保留宿主单份。

`pack:win`、NSIS、完整 packaged smoke 的执行 session 分别为 **83250**、**72556**、**54524**，均退出 0。生成安装包时发生的 Electron 目录 rename retry 已由 builder 自动恢复，最终包及 ASAR 审计成功。

## 本候选的真实运行结果

默认完整 packaged smoke 位于 `smoke-1792929973665/report.json`，实际宿主 PID **40864** 正常退出，`runtime.packaged: true`、`ok: true`、`checks.errors: []`。没有启用远程调试或 Windows 人工点选。

既有便签保存/关闭/拒绝保存保护、图像协议与权限拒绝、胶囊/便签表面、原生置顶检查等完整 runner 路径通过。`checks.launcherMaintenance` 在这份最终包里额外实际证明：维护期间 state read 允许、query 拒绝并显示错误，维护结束命令恢复且 `afterRecovery=[]`、暂态查询错误消失；随后独立业务动作错误仍被保留。七个布尔检查均为 true。

`verify-fixture.mjs` 随后通过：固定样本 Markdown/PNG 源和副本散列、原便签 ID 保持；clipboard `paused=true` 且 `entries=0`；七个官方包全部启用、安装失败 **0**；notes/clipboard 的数据版本账本均正确。相应 JSON 均在该 smoke 目录。

现有 `inspect-renderer.mjs --text-target-regression` 随后通过 `SPARK233_TEXT_TARGET_ASAR` 显式加载本候选 ASAR，报告为 `local-build/spark233/functional-integration/text-target-runs/c27efb87-4dff-4def-88db-f47565d03736/report.json`。真实启动器/剪贴板组件的启用→停用→恢复连续场景 **9 项通过**，文本与 `[17,37)` 选区保持、translation 停用时两个按钮禁用且不发送 IPC、notes 保存选中片段，实际历史仍暂停且原记录不变；受控官方 backend 的 utility PID 全退出。入口也保留真实旧 ASAR 成功启用基线及两个按预期失败断言，没有以不兼容挂载冒充 red。`text-target-run.json` 固定该次报告，最终 artifact 审计比较报告内 ASAR SHA-256 与本候选相同。

## 经字节核查复用的结果

manager/backup 的当前编译模块与独立回归模块逐字节相同，最终审计明确绑定已有 **16 / 14 / 6 / 9** 项实际官方并发、manager/migration/rollback、命令依赖和 backup 结果，没有重复执行这些 suites。对应路径保存在 `artifact-report.json.lifecycleEvidence`。

BackupDialog 创建/有效预览/再次选择无效目录/取消撤下旧确认卡的真实 renderer+host 报告，复用 `local-build/spark233/backup-preview-ui/runs/d13d1b6a-df12-4c26-9777-ddf5fb9ac93d/report.json`。审计核对当时 main、backup 服务、BackupDialog、中英文 locale **5 份当前产品输入散列相同**，明确标记 `reused: true`。没有重新制造备份 UI 流程。SDK 的 **8 份输入**与此前通过 sdk build 的输入一致，同样明确复用。

## 最终可识别产物

| 项目                 | 本次确切身份                                                       |
| -------------------- | ------------------------------------------------------------------ |
| NSIS 安装包          | `release/spark233-1.2.0-x64.exe`；210,071,895 字节；未签名         |
| 安装包 SHA-256       | `43e2d1524045e5e57b58115cc226b045f7d6ad6bb06300cdd26e4d45af92f818` |
| ASAR                 | 36,625,332 字节；1,492 members                                     |
| ASAR SHA-256         | `20dc4cb726d33889b94bfc4b374d94f74ad44e9458e76fc182f0b5918779988c` |
| win-unpacked 目录    | 119 文件；491,866,330 字节                                         |
| 包含的七个归档       | 67,858,198 字节                                                    |
| 七包展开代码         | 152,824,186 字节                                                   |
| 首次部署代码体积估计 | 644,690,516 字节，约 614.8 MiB                                     |

体积是文件字节和，不含 NTFS cluster allocation、Chromium profile、便签/历史、缓存、索引、服务副本或旧回滚版本。安装包旁生成 `.blockmap`（222,076 字节）和 `.sha256`。

总报告为 `local-build/spark233/automated-followup/artifact-report.json`；静态阶段报告保留原 `ok:null` 的历史时点，不改写成另一条运行结果。安装器未执行，不代表干净 Windows 安装、UAC/服务生命周期、多屏 DPI 或物理截图框选已经验收；smoke 的 `fullscreenAvoidanceObserved` / cold-restore 未观察项仍不解释为通过。这一轮没有将旧 21 项业务代表报告迁移到新字节上。

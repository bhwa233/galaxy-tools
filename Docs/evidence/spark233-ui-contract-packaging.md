# spark233 UI 合同跟进：独立 Windows 候选

日期：2026-10-25；标签 `ui-contract-followup`。输出仅使用 `local-build/spark233/ui-contract-followup/release/`。旧 automated 候选及其证据保持原样。

收到 root 的“UI冻结可构建”后，统一流水线已完成；最终 `artifact-report.json` 为 **`ok:true`、`artifactIntegrity:true`**。本轮实际执行一次 lint、现有测试、含 typecheck/build 的 pack:win、基于同一目录的 NSIS、fresh 默认完整 packaged smoke、fixture 保留、七包/ASAR 审计，以及绑定本轮 ASAR 的 text-target 与真实 translation-host 回归。

Native 和 SDK 没有重复执行旧检查：`verify-reused-inputs.mjs` 已确认 automated 基线的 **8 份 SDK 输入、14 份 native 源输入和 14 个 native payload 散列全部相同**。本 lane 的 native 报告写明原 dumpbin 报告与散列、原检查时间、本次 hash 核查时间及 `reused:true`，没有将原依赖扫描改写为本次新扫描。原始报告不变。

SearchServicePanel 的真实组件红绿回归已按源散列复用；备份 UI 同样核对五份产品输入。manager/backup 的本次编译字节与既有独立模块相同，明确复用 16/14/6/9 项报告。UI 包和 renderer 元数据与本次真实包版本及兼容范围核对通过；translation 的真实完整 main 已针对新候选重新运行代表链，没有把旧包身份直接改绑。

本 lane 的全部 profile、插件安装、便签、剪贴板历史、索引和报告均位于 local-build。剪贴板保持暂停，不执行 Windows 点选、UAC 或安装器。

## 实际门禁与输入稳定性

选定 Node **26.12.1** / npm **12.2.1**，Electron **45.0.0**。`lint.log` 通过；`test.log` 为 **32 文件 / 162 项通过**，只运行一次。`pack-win.log` 包含完整 typecheck、Vite renderer、UI package、七个官方插件、Electron TypeScript、资源复制和 Windows 目录封装，退出 0（session 46677）。NSIS 直接对该目录 `--prepackaged`，退出 0（session 20235），没有再执行一遍完整产品 build。

`source-inputs-before.json` / `source-inputs-after.json` 的 **354 份输入完全一致**，`source-input-consistency.json` 为 `ok:true`。相对 automated 的变更列于 `changes-from-automated.json`：SearchServicePanel 错误分离、UI 包及编译/样式/别名接线，main、smoke、Launcher 和 SDK/native 源保持相同。没有修改快照以掩盖漂移。

七包审计重新执行生产 bounded extraction、SRI、manifest/API、catalog metadata、全部 member inventory 和逐文件散列，OCR app-local runtime/license 与共享字体核对通过。ASAR 对本次 root dist/dist-electron、外置 MCP、宿主 matcher 和官方档案资源逐字节核对通过；ASAR 无本项目/依赖测试源码或 exe/dll。

## UI 包真实版本合同

宿主 ASAR 的 `dist/spark233-ui.json` 和四个业务 renderer 的 `spark233-ui.json`、`spark233-shared-ui.json.uiPackage` 完全一致：

| 字段                  | 当前实际值                                                         |
| --------------------- | ------------------------------------------------------------------ |
| name / version        | `@spark233/ui` / `0.2.0`                                           |
| SDK 兼容              | `>=0.2.0 <0.3.0`，实际 SDK `0.2.0` 满足                            |
| 宿主 API 兼容         | `^1.1.0`，实际 `1.1.0` 满足                                        |
| 主题协议兼容          | `^1.0.0`，实际 `1.0.0` 满足                                        |
| componentsEntry       | `@spark233/ui/components`                                          |
| componentSourceSha256 | `b4e4e28203dfffc988868e69037c34fe42566579f3cec6e33b003bfbf5529706` |

四个 renderer 是 notes、clipboard、ocr、translation。元数据同时与源 `packages/ui/package.json` 和组件入口源码散列核对，不把字体 `version:1` 冒充 UI 包版本。官方 ClipboardWorkspace 确实经该包入口消费组件；外部独立 `.tgz` 消费及源码编译宿主的主题传播证据见 `spark233-theme-ui-contract.md`，后者不宣称已经在本 ASAR 重放全部主题过程。

## 这份最终包的真实运行

完整默认 packaged smoke 位于 `smoke-1792932333706/report.json`，session **21603** 退出 0，宿主 PID **21016**；`runtime.packaged:true`、`ok:true`、`checks.errors:[]`。维护回归七个布尔项全部 true，真实维护期间查询拒绝可见，恢复命令后 `afterRecovery:[]`，读取错误消失，独立业务动作错误保留；没有重复执行维护快模式。

`verify-fixture.mjs` 通过：固定 Markdown/PNG 源和副本散列、便签 ID 保持；clipboard **paused=true、entries=0**；七包全部启用、安装失败 **0**；notes/clipboard 数据版本账本正确。结果 JSON 均在该 smoke 目录。

随后绑定本次 ASAR 的两条代表回归均通过：

| 回归                   | 确切报告及证明                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 真实文本目标组件       | `functional-integration/text-target-runs/984ab34a-38da-47bd-bd92-503f294d3f09/report.json`，9 项全 true，选中文本与选区在翻译启停/恢复后保持、独立 notes 真正保存选中片段、paused 合成历史原记录保持。旧 UI 的成功启用基线和两个预期失败仍保留。session 73138 exit 0。                                              |
| 完整真实 main/IPC 翻译 | `functional-integration/translation-host-runs/44fcf59e-9da9-4574-bbf1-08cd59f6a888/report.json`，5 项全 true；复制完整本次 win-unpacked、fresh paused profile，真实查询/执行打开 AI provider 请求为 0，点击实际翻译按钮后 loopback 请求恰 1 次并收到结果；真实历史保持暂停/空，进程正常退出。session 32256 exit 0。 |

表中回归路径均位于 `local-build/spark233/` 下。总 artifact 审计要求两报告中的 ASAR SHA-256 等于最终包，拒绝错绑。翻译仅调用本地受控 provider，没有使用外部付费模型或真实密钥。

## 明确复用的边界

`reused-inputs.json` 固定复用依据。SearchServicePanel 源 `425a56f17ecadab591fe95a44107b799f23567363b30b3f2b7057df877e06ae5` 的 5 项绿报告复用：它仅证明真实组件对受控服务 IPC 的读取恢复与业务错误保留，不声称 SYSTEM 服务恢复。原报告的“no UI clicks”具体指没有 Windows 点选，执行过真实 DOM 按钮事件；freeze 与最终 artifact 已附明确澄清。

Backup UI 的七项旧报告复用，main/backup/BackupDialog/中英文 locale 五份产品输入全部一致。translation mode 的十项旧报告仅对 Workspace、Launcher、controller、backend/provider/dictionary 六份相同行为源码复用；本次真实 main 打开/点击门禁另有上表的新包报告。manager/backup 的 16/14/6/9 项结果按编译模块一致性绑定，没有重复跑相同后端链。

SDK 8 输入与旧 sdk-build 一致；native 14 源输入和 14 payload 一致，所以原依赖审计的未解析外部 imports **0** 结论复用。没有新 dumpbin/runtime-load/native selftest，也不宣称实测了新 Windows 系统运行时环境。

## 最终产物

| 项目             | 本次确切身份                                                       |
| ---------------- | ------------------------------------------------------------------ |
| 安装包           | `release/spark233-1.2.0-x64.exe`，210,070,753 字节，未签名         |
| 安装包 SHA-256   | `80e05bcaf0eec530684af59773b8f27b57540640381d87886b0c8123c1fb1efe` |
| ASAR             | 36,625,927 字节，1,493 members                                     |
| ASAR SHA-256     | `94ed07fe0a851d40a9110fef9567d97f7c7a9528af18faee9aa3ac77fd83e836` |
| win-unpacked     | 119 文件，491,870,034 字节                                         |
| 七包归档         | 67,858,999 字节                                                    |
| 七包展开代码     | 152,826,854 字节                                                   |
| 首次部署代码估计 | 644,696,888 字节，约 614.8 MiB                                     |

体积按文件字节和，不含 cluster allocation、Chromium profile、用户数据、索引、缓存、服务副本或旧回滚版本。安装包旁有 221,950 字节的 blockmap 与 SHA-256 文件。最终总报告 `local-build/spark233/ui-contract-followup/artifact-report.json` 的通过仅绑定本候选实际运行，不修改旧 automated 或 lifecycle-ui 报告。

未执行安装器、UAC/SYSTEM 生命周期、干净 Windows 物理断网首装、截图遮罩框选、多屏 DPI、全部主题/缩放/辅助技术。既有 smoke 的未观察 fullscreen/cold-restore 字段不解释为验收通过。上述边界继续保留，不为了统一打包而额外扩大或缩小原任务。

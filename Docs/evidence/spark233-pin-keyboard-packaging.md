# spark233 置顶与模式工具栏键盘跟进：独立 Windows 包

日期：2026-10-25；输入标签：`pin-keyboard-followup`。

本候选已经完成测试、完整 build/目录包、NSIS、独立数据及产物审计，**新的固定样本 packaged smoke 通过**。[artifact-report.json](../../local-build/spark233/pin-keyboard-followup/artifact-report.json) 为 `ok: true`、`artifactIntegrity: true`。上一 [parallel 候选](spark233-parallel-packaging.md) 和它的失败 smoke 保持原样，没有修改为通过，也没有绑定旧 21 项测量。

所有本轮产物、日志和 profile 在 `local-build/spark233/pin-keyboard-followup/`，Windows 输出为 `release/`。本 lane 收到源码冻结和 source smoke 退出通知后才启动构建；没有产品源编辑、依赖升级、提交或 reset，没有触碰此前 UI-error 目录/profile，也没有操作物理截图遮罩、真实用户便签/剪贴板、UAC 或 SYSTEM 服务。主线程负责最后的目标 UI 验证。

## 当前实现与验证范围

Windows 的便签和 capsule 现在明确使用 Electron 公开的 `pop-up-menu` 置顶层级；其他平台继续使用 `floating`。全屏阻止判定仍保留，show/remember 会重新计算实际层级。这是公开层级语义的调整，不是绕过全屏保护。曾探索的默认 floating 失败后条件重试策略未进入当前冻结源。

Launcher 模式工具栏对 Enter/Space 停止事件传播，避免工具栏按键被外层启动器当作执行候选处理。该修改已进入本轮 Vite/独立 renderer 构建并通过类型、现有测试和完整构建；本 lane 未执行界面操作；主线程随后已完成 13 项 Windows 模式键盘实际检查，见[模式键盘验收](spark233-launcher-mode-keyboard.md)，artifact 报告的 targetedModeUi 记录对应报告入口。

宿主 API `1.1.0`、SDK `0.2.0`、截图包 `0.1.1` / API `^1.1.0` 保持；实际解包 manifest 的截图 OCR 命令仍声明 `requiresPlugins: ['spark233.ocr']`。宿主通用命令依赖与原生截图工具栏显隐的先前改动也正确进入当前包，真实物理遮罩范围仍按 [OCR 停用跟进](spark233-ocr-disable-followup.md) 区分。

## 本轮门禁与输入

项目运行时由 `scripts/use-toolchain.ps1` 选择，Node `26.12.1` / npm `12.2.1`；Electron `45.0.0`、electron-builder `26.18.0`、Windows x64。

| Gate           | 当前证据                                                                                                                                                                                                                       |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 现有测试       | `test.log`：仅运行一次 `npm test`，32 文件/162 项全部通过                                                                                                                                                                      |
| 完整目录包     | `pack-win.log`：session 56648 退出 0；`npm.cmd run pack:win -- --config.directories.output=local-build/spark233/pin-keyboard-followup/release` 自身完成 typecheck、Vite、七插件、Electron 和 builder，没有另跑重复的完整 build |
| 输入冻结       | `source-inputs-before.json`、`source-inputs-after.json` 与 `source-input-consistency.json`：349 个源码/构建/包输入的字节数和 SHA 一致                                                                                          |
| SDK gate       | SDK 的 8 个输入与上一轮已成功的 `parallel-followup/sdk-build.log` 输入逐一一致，明确复用该 SDK 构建；没有冒称本轮重跑 SDK 或复用旧 smoke                                                                                       |
| 七包           | `distribution-4jorXo/report.json`：恰好七身份、生产有界解包/兼容、SHA-512 SRI、成员清单与逐文件 SHA、catalog 元数据绑定、共享字体及 OCR runtime/许可全部通过                                                                   |
| Native         | `native-dependencies.json` 与 `native-dependents/`：14 个模块全部重算散列、重新 dumpbin `/dependents`，无导入变化、`unresolvedExternalImports: []`                                                                             |
| NSIS           | `nsis.log`：session 75221 退出 0，直接从本轮冻结目录 `--prepackaged` 构建                                                                                                                                                      |
| Packaged smoke | `smoke.log`：新 profile 的 session 28388 退出 0，详见下一节                                                                                                                                                                    |
| 精确产物       | `artifact-inspection.log`：全部 dist 71 文件、dist-electron 68 文件逐字节一致；ASAR 没有 native EXE/DLL、自有或依赖测试源码；外部七包/installer、共享字体、MCP 三入口和 host matcher 全树一致                                  |

## 本轮真实 packaged smoke

运行前通知了根任务暂停桌面操作；[新报告](../../local-build/spark233/pin-keyboard-followup/smoke-1792922587099/report.json) 属于独立 `smoke-1792922587099/`，`ok: true`、`runtime.packaged: true`、renderer `errors: []`。真实 packaged 根 PID 38468 已正常退出，stderr 为空，没有强杀或重跑；smoke 结束后已通知根任务可恢复桌面验证。

本轮 `unifiedList.nativePinOnOpen: true`，此前失败的“打开置顶偏好便签应用原生窗口层级”断言直接通过；同组的不开窗置顶、列表内排序、列表/纸张双向同步、持久化、复用窗口、桌面转移及脏输入保留也为 true。报告的 `fullscreenAvoidanceObserved: false` 表示本次没有观察到全屏避让条件，不能把 smoke 成功扩大为实际全屏场景已验收。保存失败保留窗口、窗口释放/恢复、相对图片、capsule 指针/预览等既有链路同样完成。

profile 从固定 P0 样本复制，notes/clipboard 真业务数据有准确 schemaVersion 和 npm 包身份/业务版本 ledger，剪贴板预先暂停，不使用远程调试端口。`fixture-preservation.log` 和 profile 内四份独立报告证明：

- 原始冻结 Markdown 和运行副本均为 SHA-256 `d0e5d4bca6279060a8db4ea6805e4d941944774e1f800bb61841d9e0d51ef312`。
- 原始冻结 PNG 和副本均为 SHA-256 `2d3d07c380eeed5071af4aca0278cd005caa7181309eca073c7c9f24cb50b472`。
- 便签 ID `ff73f860-0c00-4d9c-9cd0-eab04d918a33` 保留。
- 剪贴板暂停、全部历史记录数为 0；七插件均安装启用，无 lastError 或 bundled 安装失败。
- notes/clipboard packageName、数据版本 1、插件版本 0.1.0 正确。

这些数据报告分别为 `fixed-data-preservation.json`、`clipboard-isolation.json`、`bundled-installation.json`、`data-version-ledger.json`，均属于本轮 profile。原 frozen 没有修改。

## 当前字节与空间

| 产物             | 当前字节与身份                                                                                               |
| ---------------- | ------------------------------------------------------------------------------------------------------------ |
| 安装器           | `local-build/spark233/pin-keyboard-followup/release/spark233-1.2.0-x64.exe`，210,067,026 字节，约 200.34 MiB |
| 安装器 SHA-256   | `066dda2bc266e16c0935c2a0a83a2b0e515fb2d7ec0b10fad0f74bddfd0533f1`                                           |
| 校验文件         | 同目录 `spark233-1.2.0-x64.exe.sha256`                                                                       |
| 签名 / blockmap  | `signature.json`：`NotSigned`；blockmap 221,702 字节                                                         |
| 目录包           | `release/win-unpacked/`，119 文件、491,848,316 字节，约 469.06 MiB                                           |
| 目录 exe SHA-256 | `4056b412b67270f4ecbec7c169b89e1eec49dcc18e0f9cfadf3f577319c18b43`                                           |
| ASAR             | 36,608,900 字节，SHA-256 `856dceba3f1bd17101ee4acaa098ffdb711fd17e15a82e2e2dba4abfa5ba867f`                  |
| 七个 archive     | 67,856,616 字节                                                                                              |
| 七插件展开       | 152,815,658 字节，约 145.74 MiB                                                                              |
| 首装代码估算     | 644,663,974 字节，约 614.80 MiB                                                                              |

首装代码估算是应用目录加七插件展开的文件字节和；应用目录已包含 `.tgz`。不含磁盘簇分配、Chromium profile、业务数据、缓存、索引、服务副本或回滚版本。

| 插件               | archive 字节数 |  展开字节数 |
| ------------------ | -------------: | ----------: |
| applications 1.0.0 |        244,639 |     555,557 |
| clipboard 0.1.0    |      1,554,133 |   3,235,971 |
| notes 0.1.0        |      1,316,315 |   2,640,227 |
| OCR 0.1.0          |     14,317,342 |  27,669,875 |
| screenshot 0.1.1   |        599,890 |   1,286,321 |
| search 0.1.0       |      6,449,753 |  12,663,873 |
| translation 0.1.0  |     43,374,544 | 104,763,834 |
| 合计               |     67,856,616 | 152,815,658 |

ScreenCapture 仍为 SHA-256 `6280d49f553defe5a85521da6f32cb27adf96b3e140310d99e71be6150eae146`；ImageReader 仍为 `4348f8ff4727655da548fb2f0d4cc2fcd64f74057b0781fa8aea7161b66b5ddd`。原生文件和其导入均未因置顶/键盘宿主修复变化。

## 保留边界

当前只把本轮新 smoke 绑定到当前产物。之前的 parallel failed smoke、source smoke 和旧 21 项业务测量各保留其原始输入范围，不混成一个报告。命令依赖 manager 6 项、ACL 24 项仍见各自 [命令依赖记录](spark233-command-dependencies-followup.md) 与 [ACL 记录](spark233-search-acl-followup.md)。[剪贴板隔离记录](spark233-clipboard-isolation-followup.md) 仍是 metadata-only 权限阻塞，paused/0 不代表真实监听成功。

本轮没有执行安装器、UAC、真实服务、全卷 MFT/USN 或物理断网首装，没有操作物理截图遮罩；工具栏键盘的局部验收已由主线程完成；全屏实机条件及其余人工 UI 仍分别保留。本地包未签名、未发布或提交，旧候选字节与报告没有覆写。

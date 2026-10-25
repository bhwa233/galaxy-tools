# spark233 命令依赖跟进：独立构建与 Windows 包

日期：2026-10-25；分支：`codex/spark233-refactor`；输入标签：`parallel-command-availability`。

本轮构建与产物完整性检查通过，**新的真实 packaged smoke 未通过**。当前 [artifact-report.json](../../local-build/spark233/parallel-followup/artifact-report.json) 明确记录 `artifactIntegrity: true`、整体 `ok: false`，失败门禁为打开置顶偏好便签后的原生窗口层级。产物字节已经冻结，未重跑 smoke，未将此前 21 项报告绑定到这批新字节。根任务继续诊断窗口层级判定并执行自己的独立目标验证。

## 独立范围与输入

所有本轮日志、报告、smoke profile 和产物位于 `local-build/spark233/parallel-followup/`；Windows 输出为其下 `release/`。没有覆写 `local-build/spark233/ui-error-followup/release/`，没有修改该 UI 实例的 profile、Hello Web 插件或剪贴板历史。本 lane 不改产品源码、不升级依赖、不提交、不 reset，也没有操作截图遮罩、真实用户便签/剪贴板、UAC 或 SYSTEM 服务。

当前包包含宿主 API `1.1.0`、SDK npm 包 `0.2.0`、命令 `requiresPlugins` 合同及共同可用性门禁，以及错误详情 UI 的此前修复。实际解包后的截图插件为 `spark233.screenshot@0.1.1`、`api: ^1.1.0`，其 `ocr` 命令的 `requiresPlugins` 为 `['spark233.ocr']`；基础 `capture` 不带该依赖。

`source-inputs-before.json` 与 `source-inputs-after.json` 保存 349 个 rg 可见源码、构建和包输入的字节数/SHA-256；`source-input-consistency.json` 为 `ok: true`。这些不代替 native 字节审计；后者单独记录全部 14 个实际 payload。

## 实际执行的 gate

项目运行时通过 `scripts/use-toolchain.ps1` 选择 Node `26.12.1` / npm `12.2.1`。

| Gate                | 结果与证据                                                                                                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| SDK 构建            | `npm run sdk:build` 退出 0，`sdk-build.log`                                                                                                                                                                                                 |
| 现有 Vitest         | 仅运行一次 `npm test`，32 文件/162 项通过，`test.log`                                                                                                                                                                                       |
| 完整目录包          | `npm.cmd run pack:win -- --config.directories.output=local-build/spark233/parallel-followup/release`，session 11806 退出 0，`pack-win.log`；脚本自身完成 typecheck、Vite、独立 renderer/七包、Electron 和 builder，没有另跑重复的完整 build |
| 分发检查            | `distribution-fgg8cR/report.json` 为 true：恰好七身份、catalog 名称/翻译与实际 archive manifest 绑定、生产有界解包/兼容校验、SHA-512 SRI、精确成员清单及逐文件 SHA-256、共享字体、OCR runtime/许可                                          |
| NSIS                | 从该稳定目录 `--prepackaged` 构建，session 72432 退出 0，`nsis.log`                                                                                                                                                                         |
| 原生依赖            | `native-dependencies.json`：14 模块全部重算散列并重新 dumpbin `/dependents`，原始日志在 `native-dependents/`；导入无变化，`unresolvedExternalImports: []`                                                                                   |
| ASAR/外部资源       | `artifact-inspection.log`：全部 `dist` 71 文件和 `dist-electron` 68 文件与冻结输入逐字节一致，ASAR 没有 native EXE/DLL 或自有/依赖测试源码；外部七包/installer、共享字体、MCP 三入口及 host matcher 全树一致                                |
| 真实 packaged smoke | **失败**，session 65793 退出 1，详见下一节；未重跑                                                                                                                                                                                          |

本轮第一次 npm PowerShell 入口将 output 参数误作 npm 自身配置，未进入产品 build；记录保存在 `pack-win-cli-config-error.log`，随后用 `npm.cmd` 明确透传。第一次实际完整构建因新 ScreenCapture 与旧 `resources.json` 不一致而拒绝，保存在 `pack-win-native-resource-error.log`。主线程通过正式 `node packages/official/screenshot/build.mjs --native-build-dir local-build/spark233/native-capture-p4/build` staging 更新资源记录后重新冻结；本 lane 从该冻结点继续 pack，没有手改 manifest 或放宽校验。SDK 与测试没有重复运行。

## 新 smoke 的失败和数据检查

运行前已通知根任务暂停桌面操作。smoke 使用独立 `smoke-1792920722664/`，从固定 P0 原件复制业务样本；notes/clipboard 预置真实业务数据有 schemaVersion 1 和包含 packageName/dataVersion/pluginVersion 的准确 ledger。剪贴板预先暂停，没有远程调试端口；进程记录在 `process.json`，运行的 packaged exe 为本轮 `release/win-unpacked/spark233.exe`，PID 52032。该进程已退出，没有强杀、重跑或扩大到其他 profile。

[失败报告](../../local-build/spark233/parallel-followup/smoke-1792920722664/report.json) 的决定性错误为：

```text
Error: Opening a pinned preference did not apply the expected native window level
at verifyUnifiedNoteList (.../dist-electron/electron/smoke-note-list.js:63:5)
```

报告在便签模式及提醒部分已记录多项 true，但未走完整条 smoke。全局 `runtime.packaged` 和最终 renderer errors 字段尚未写入，因此 artifact 报告将这些字段保留为 null，不能将部分无错误扩大为完整成功，也不在原因未明时宣称是时序或平台噪声。

失败后仅运行数据/包完整性检查，`fixture-preservation.log`、profile 中的 `fixed-data-preservation.json`、`clipboard-isolation.json`、`bundled-installation.json`、`data-version-ledger.json` 证明：

- 原始冻结 Markdown 和运行副本 SHA-256 都为 `d0e5d4bca6279060a8db4ea6805e4d941944774e1f800bb61841d9e0d51ef312`。
- 原始冻结 PNG 和副本 SHA-256 都为 `2d3d07c380eeed5071af4aca0278cd005caa7181309eca073c7c9f24cb50b472`。
- 便签 ID `ff73f860-0c00-4d9c-9cd0-eab04d918a33` 保留。
- 剪贴板为 paused，所有历史记录数为 0；七个插件均安装启用，无 lastError 或 bundled 安装失败。
- notes/clipboard npm 身份、业务版本 1、插件版本 0.1.0 均正确。

这些是失败运行后的独立数据检查，不改变 smoke 的失败结果。

## 当前冻结产物

| 项目             | 字节数与身份                                                                                             |
| ---------------- | -------------------------------------------------------------------------------------------------------- |
| NSIS 安装器      | `local-build/spark233/parallel-followup/release/spark233-1.2.0-x64.exe`，210,067,074 字节，约 200.34 MiB |
| 安装器 SHA-256   | `da18bd2038af3755f9cae513f466f3fa465cf4c311a8e957220fb40b184e19ca`                                       |
| 校验文件         | 同目录 `spark233-1.2.0-x64.exe.sha256`                                                                   |
| blockmap         | 222,115 字节                                                                                             |
| 签名             | `signature.json` 的 Authenticode 状态为 `NotSigned`；本地构建，未发布                                    |
| 目录包           | `release/win-unpacked/`，119 文件、491,847,257 字节，约 469.06 MiB                                       |
| 目录 exe SHA-256 | `f8dfe34970e29f967be04253fe56b8a7e0f3db9689fee1aaf8b0f2057972f4ee`                                       |
| ASAR             | 36,607,855 字节，SHA-256 `9e7d6f2f43a8c272f1c4992cb61d4aa0c24ef4323435342fbc9a05f90cac2682`              |
| 七 archive       | 67,856,602 字节                                                                                          |
| 七插件展开       | 152,815,390 字节，约 145.74 MiB                                                                          |
| 首装代码估算     | 644,662,647 字节，约 614.80 MiB                                                                          |

首装估算为应用目录加七插件展开的文件字节和，应用目录本身已经包含 `.tgz`。不含磁盘簇分配、Chromium profile、用户数据、缓存、索引、受保护服务副本或回滚版本。

| 插件               | archive 字节数 |  展开字节数 |
| ------------------ | -------------: | ----------: |
| applications 1.0.0 |        244,639 |     555,557 |
| clipboard 0.1.0    |      1,554,133 |   3,235,904 |
| notes 0.1.0        |      1,316,309 |   2,640,160 |
| OCR 0.1.0          |     14,317,338 |  27,669,808 |
| screenshot 0.1.1   |        599,890 |   1,286,321 |
| search 0.1.0       |      6,449,753 |  12,663,873 |
| translation 0.1.0  |     43,374,540 | 104,763,767 |
| 合计               |     67,856,602 | 152,815,390 |

新 ScreenCapture 为 1,277,952 字节，SHA-256 `6280d49f553defe5a85521da6f32cb27adf96b3e140310d99e71be6150eae146`；ImageReader 保持 SHA-256 `4348f8ff4727655da548fb2f0d4cc2fcd64f74057b0781fa8aea7161b66b5ddd`。正式截图按钮动态显隐的固定适配/编译范围见 [OCR 停用跟进](spark233-ocr-disable-followup.md)，本 lane 没有操作物理遮罩。

## 仍需区分的证明范围

[命令依赖真实管理器 6 项](spark233-command-dependencies-followup.md)、[调用者 ACL 24 项](spark233-search-acl-followup.md) 属于各自固定输入与隔离探针证据；本轮只把它们涉及的当前源及 native 正确打入新包，没有把这些报告改写成最后 UI 验收。[剪贴板隔离跟进](spark233-clipboard-isolation-followup.md) 仍是 metadata-only 权限阻塞记录，paused/0 不代表真实监听成功。

当前包未执行安装器/UAC、真实 SYSTEM 服务或物理断网首装；真实截图按钮显隐、全卷 MFT/USN、人工界面及私有窗口站剪贴板监听仍按原范围单独验收。此前 `87818` 的成功 smoke/21 项代表链仅保留历史；当前 artifact 明确不绑定旧报告，整体门禁保持未通过。

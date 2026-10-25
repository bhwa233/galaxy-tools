# spark233 离线插件与 Windows 分发记录

2026-10-25 无障碍续测后另生成界面修复候选 `ui-error-details-followup`，放在独立的 `local-build/spark233/ui-error-followup/release/`；原 release-electron 基线保留。新候选已完成构建、归档、字节核对和修改管理页的 10 项 Windows 局部实际检查；具体散列及证据范围见[续测与修复记录](spark233-ui-followup.md)。下文 `87818-final-offline-catalog` 的 21 项仅属于原基线，不作为新候选的完整运行回归。

本记录对应 `codex/spark233-refactor`。遵循 MVP 验证约束：先完成真实分发功能，再做界面验收；本阶段只构建、检查产物和复用必要的隔离链路，不启动真实桌面剪贴板监听，不执行 SYSTEM 服务安装、升级或卸载。

## 实现

`npm run build` 先构建宿主/便签渲染资源，再由 `scripts/build-official-plugins.mjs` 生成七个独立 npm 布局的 `.tgz`：便签、截图、OCR、词典与翻译、剪贴板、应用和文件搜索。正式安装资源为 `dist-plugins/index.json`、每个 archive 的 SHA-512 SRI，以及 `resources.json` 中逐文件字节数与 SHA-256。目录包和 NSIS 通过 `extraResources` 把这些文件放在 ASAR 外的 `resources/plugins`。

打包采用各插件的 `files` 白名单，自动保留许可证/README，拒绝测试或 integration 源码、源路径中的符号链接及最终资源树中的链接。每包携带宿主自有代码的 MIT 声明；便签、剪贴板、词典/翻译和 OCR 包携带独立渲染代码与两套字体原许可。两套大字体引用稳定的宿主 `spark233://shared/ui/v1/…` 接口，插件 archive 不重复复制这些字体字节；每个独立 renderer 的 `spark233-shared-ui.json` 记录 v1 依赖。KaTeX 等其余资源继续随插件精确版本目录加载，不能依赖用户侧 npm 安装脚本或编译。

单包入口为 `node scripts/build-official-plugins.mjs --plugin <spark233.id> [--output <dir>]`。默认写入独立的 `local-build/spark233/plugin-artifacts/<id>/`，不会把标准离线 `dist-plugins/index.json` 改成残缺的一包。完整离线构建仍要求恰好七包。开发步骤见 `packages/official/README.md`；源码目录中的 npm pack 不会自动生成 renderer，分发使用完整组装出的 `.tgz`。

资源缺失时，词典使用固定 ECDICT 来源和散列重建 SQLite；原生程序使用正式协议构建入口。截图/OCR 选择 `native-capture-p4/build`，剪贴板选择 `native-clipboard-p6/build`，应用拼音选择 `native-applications/build/bin`，不会回退到 P1V probe。Search、应用拼音和剪贴板的资源记录包含本仓适配源码散列，发生变化会先增量重建；原生资源的实际字节与 manifest 散列必须一致。

完整默认构建另外生成 `dist-host/command-matcher`，复用应用插件既有 `pinyin.mjs`、固定的 `spark233.ApplicationMatcher.exe`、资源散列和许可证，保留相对目录布局。它作为宿主资源独立复制到 ASAR 外的 `resources/command-matcher`；应用插件禁用/卸载后，启动器通用命令仍可按需使用拼音匹配。单插件构建不改这个宿主资源。

最终目录包中的该资源已真实从 `release-electron/win-unpacked/resources/command-matcher/pinyin.mjs` 加载并启动同目录相对 native helper，`sswj` 命中“搜索文件”，进程退出码 0；测试缓存全部在 `local-build/`。报告 `local-build/spark233/packaging/packaged-command-match.json` 证明重定位后的 wrapper/native 路径可运行，不依赖已安装的应用插件。

`scripts/build-windows-local.ps1` 使用项目便携 Node/npm。UNC 来源进入独立的 Windows 本地 staging；运行 robocopy `/MIR` 前验证完整目标位于专用 staging 子目录，且现有祖先没有目录联接或符号链接。开发入口同样准备七个离线包，再启动 Vite/Electron。

## OCR app-local 运行库修复

依赖审计发现预构建 `onnxruntime.dll` 需要四个 VC V14 运行库 DLL，Electron 自身没有提供它们。本机已有系统运行库会掩盖这一离线首装缺口，因此正式 OCR 包新增 app-local `MSVCP140.dll`、`MSVCP140_1.dll`、`VCRUNTIME140.dll` 和 `VCRUNTIME140_1.dll`，总计 908,008 字节；用户端不执行运行库安装器。

固定来源为 Microsoft 官方 Visual Studio 2026 catalog 的 `Microsoft.VC.14.51.CRT.Redist.X64.base@14.51.36247`，VSIX SHA-256 为 `24a1c8dba0376d9b008ac2ba430d13c06664fc6f163511fd7866485030e289af`。只提取 release CRT 的四个白名单文件，逐文件 SHA-256 也固定于 `scripts/native-capture/sources.lock.json`；不复制 System32、debug_nonredist 或编译器 bin 的未知副本。`prepare-vc-runtime.ps1` 负责验证/准备，OCR 的独立 `build.mjs` 会自动调用并复制资源。

官方同版本 redistributable bootstrapper 的许可链接指向 `https://aka.ms/VCRedistLicense`，固定原始 DOCX 的 SHA-256 为 `08651651a7602fc7c0e2763de0fde1ff9f868df2780597cd1775ee9d6441c783`。原始许可、便于阅读的文本副本和来源记录随 OCR 包的 `legal/` 分发，不把 VC runtime 宣称为 MIT。

实际验证使用全新 `/MT` 静态 CRT 检查进程，通过 `LoadLibraryEx` 加载 ORT 和 provider，再枚举已加载模块。四个 VC DLL 的实际路径全部位于 OCR 包内；检查进程自身没有动态 VC runtime 依赖。报告为 `local-build/spark233/packaging/runtime-load-report.json`，校验进程源和二进制均只在 `local-build/`，没有建设新测试框架。

另以 `dumpbin /dependents` 审计当前 14 个原生 EXE/DLL，导入清单与每个文件的实际散列记录在 `local-build/spark233/packaging/native-dependencies.json`。未发现未满足的额外第三方动态依赖，其余导入为 Windows Win32/WinRT、Media Foundation、DirectX 和 UCRT API sets。这证明当前机器上的 app-local 加载和静态依赖范围，不代替在全新 Windows 安装上的最终验收。

## 搜索服务的安装、升级和卸载

NSIS 的 `customInstall` 通过固定的 `spark233.Search.exe --install-service` 请求 Windows 管理员确认。服务从新建的受保护 Program Files 版本目录运行；升级先正常停止旧服务，再切换 SCM，失败保留原版本并恢复原服务配置。已有相同 payload 时不重复请求管理员权限。取消授权不阻断桌面应用安装。

普通查询只读比较当前插件与受保护服务的 Index/Document/PDFium payload。版本不同时返回 `service-update-required`，显示更新动作；用户执行该动作后仍走宿主确认和 UAC，不在查询时自动替换服务。

NSIS 的 `customUnInstall` 在普通交互卸载时调用固定的 `--uninstall-service`；Electron-builder 的应用升级卸载阶段跳过删除服务。提权卸载只允许固定 SCM 名称 `spark233Index`，要求 SYSTEM 服务账户、正确命令行、Program Files 下直接版本目录、有效 GUID、产品归属 marker、管理员/系统所有者和受保护 DACL；普通用户不能在清理过程中替换目录内容。拒绝 reparse points 和非归属对象。先正常停服务、删除服务配置，再清理带 marker 的受保护版本目录；索引和用户业务数据保留。

取消或失败时保留尚未移除的机器资源并给出实际结果。静默安装/卸载跳过交互提权；因此此前已安装的机器服务可能在静默卸载后保留，需要后续交互授权清理。停用搜索插件只取消本实例的查询/客户端，不为日常启停反复请求 UAC 删除机器服务；最终资源度量必须把该 SYSTEM 服务单独计算。

## 当前 Windows 产物：87818-final-offline-catalog（2026-10-25）

当前冻结标签为 `final-offline-catalog`。完整 `npm run build` session 87818 退出 0，日志为 `local-build/spark233/packaging/build-final-offline-catalog.log`；本轮重新构建宿主、独立 renderer、七个 archive 和含中英文目录名称的 index 元数据，包含此前已冻结的 OCR/迁移/文件身份/真正 fresh 空树修复。项目 Node 26.12.1 / npm 12.2.1；Electron-builder 26.18.0 / Electron 45.0.0 / Windows x64。目录构建 session 11830 和基于 `--prepackaged` 的 NSIS session 18678 均退出 0，日志为 `directory-build-final.log`、`nsis-build-final.log`。目录冻结后未再写入。

此前 `measurement-1792907563522` 真实 fresh 空目录首启失败，暴露空 notes 目录被当作未知旧 payload。manager 现仅将文件、链接或特殊项视为 payload，允许纯空目录树；main 在构造 capsule 后立即停用，避免插件启动前 display 事件先写空 metadata。新增真实 guard 报告 `local-build/evidence/plugins-manager/runs/a4e3a969-752f-4ffa-b597-a238adf83644/report.json` 实证无 notes marker 的嵌套空树可安装，零字节真实文件仍拒绝未知版本且不运行业务 factory。未通过 seed notes marker 掩盖 fresh 首启，带真业务样本仍要求 ledger。

本轮增加七个官方离线目录条目、prepare_bundled 经既有预览确认与显式信任安装、保留数据卸载后离线重装，并包含 OCR 后台任务/引擎复用、明确的数据版本与隔离迁移、Instant 真实文件身份和版本、官方 startupCheckOnly 安全短路，以及既有开发目录/native-only 导入、便签窗口归属/保存导航保护、服务管理/结果动作/应用发现、剪贴板保护、设置分组、官方更新来源和 reduced-motion 样式。具体修复与当前直接证据：

- OCR：`local-build/spark233/ocr-result-functional/runs/107ca14b-2df8-4589-96d6-47e8eafc7a8f/report.json` 21 项，后台取消退出与冷暖复用直接证明见 [OCR 记录](spark233-ocr-worker.md)。
- 数据迁移：`local-build/evidence/plugins-manager/runs/3f7a0ef5-5dde-4b36-bd05-f016d7ce1dd1/report.json` 13 项；一致备份 `local-build/spark233/backup-functional/runs/8063c683-d8a1-4fcb-9112-b02cedc5c9c1/report.json` 8 项；详情见 [管理器记录](spark233-plugin-manager.md)。
- 搜索：当前 adaptation 7，正式 `local-build/evidence/search-production/a9a8a308-2c90-473a-9e8f-f117e8433e96/report.json` 20 项，通过真实 read 后发布前修改和相同 size/mtime 不同 file ID 替换拒绝；当前 native 与实际报告输入绑定在同目录 `current-native-binding.json`，见 [十项审计映射](spark233-search-completion-audit.md)。
- npm metadata/archive 显式配置 retries/factor/min/max；Windows 发布目录 rename 对 EPERM/EACCES/EBUSY 最多八次尝试，总等待上限 2.75 秒，逐次核验目标和取消。真实文件锁证据 `local-build/spark233/plugin-packages/runs/2026-10-25T05-02-55-385Z/windows-rename-lock.json` 记录四次 OS EPERM、第五次约 801ms 后成功。

安装器：`C:/own/code/galaxy-tools/release-electron/spark233-1.2.0-x64.exe`。

- 210,065,819 字节，约 200.33 MiB。
- SHA-256：`3caccc9619b2c2d717fd8e37d033c857c9f7541be1539a44806c271aec748d55`。
- 校验文件：`release-electron/spark233-1.2.0-x64.exe.sha256`。
- blockmap：221,830 字节。
- Authenticode 状态：`NotSigned`，本地构建，未发布。
- 目录入口：`C:/own/code/galaxy-tools/release-electron/win-unpacked/spark233.exe`。

精确报告 `local-build/spark233/packaging/windows-package-final.json` 为 `ok: true`、`buildInput: "87818-final-offline-catalog"`：全部 `dist` 71 文件及 `dist-electron` 68 文件与冻结输入逐字节一致；ASAR 没有 native EXE/DLL 或自有/依赖测试源码；七 archive 的 SHA-512 SRI、SHA-256、成员清单及外部 installer 全树一致。七个 updateSource 均为 npm registry/latest。两套共享字体各一份、MCP 三入口正确解包；host command matcher 8 文件/526,769 字节与输入全树一致。

ASAR：36,605,902 字节，SHA-256 `6147d097965907261e226eda7a70538ff797dbd2d000308cd1321651eca2a587`。目录 `spark233.exe` SHA-256 `f540d102cc9b16ab5f13c7454dbac52d2d0cb59cba279be0f4bf54fe35f2277f`。

## 打包版 smoke、数据保留与版本记录

成功运行使用新 profile `local-build/spark233/functional-integration/packaged-1792909699509`。真实目录包 smoke session 6297 退出 0，`report.json` 为 `ok: true`、`runtime.packaged: true`、renderer `errors: []`；没有远程调试端口，进程正常退出。运行前仅复制冻结样本，notes/clipboard 的预置业务数据明确 seed 顶层 schemaVersion 1、npm packageName、dataVersion 1 和 pluginVersion 0.1.0，fresh plugins 为空；未改 frozen 原件。

同 profile 的 `fixed-data-preservation.json`、`clipboard-isolation.json`、`bundled-installation.json`、`data-version-ledger.json` 实证：

- 原始冻结 Markdown 和副本 SHA-256 均为 `d0e5d4bca6279060a8db4ea6805e4d941944774e1f800bb61841d9e0d51ef312`。
- 原始冻结 PNG 和副本 SHA-256 均为 `2d3d07c380eeed5071af4aca0278cd005caa7181309eca073c7c9f24cb50b472`。
- 便签 ID `ff73f860-0c00-4d9c-9cd0-eab04d918a33` 保留。
- 剪贴板暂停、历史记录数为 0。
- 七个默认插件全部安装并启用，无 lastError，无 bundled 安装失败。
- notes 与 clipboard 的 npm 包身份、数据版本和插件版本均符合预置合同。

首个 profile `packaged-1792907376114` 因本地准备 helper 漏写 schemaVersion 1，被 PluginManager 正确拒绝，report 为 false。它的失败报告/stderr 和 `packaged-smoke-invalid-fixture-state.log` 保留；仅修 ignored helper，核对命令行后清理该失败 profile 的 PID 20600，并从 frozen 重新复制为上述成功 profile。没有修改产品合同或绕过未知版本拒绝。

## 真正 fresh 首启、官方离线重装与最后代表链

最新 `local-build/spark233/functional-integration/measurement-1792909805347/report.json` 为 `packaged: true`、`ok: true`、`mainExited: true`，21 项检查全部通过。该 profile 仅为预置暂停剪贴板写入 clip ledger，notes 是没有版本 marker 的真正全新空目录；七默认插件正常启用，没有自动创建便签。此前 16 项范围继续通过：reduced-motion 媒体样式、三次离线词典、两次真实 OCR、便签管理器/桌面动作、冷管理器保留显式目标、真实阻断保存拒绝导航及恢复保存、registry 进程内关闭代理确实阻断、无 NaN 重试计时器，以及初次自动更新检查完成后的同步。

新增五项使用真实官方剪贴板插件和隔离人工 PNG：目录恰有七个官方条目；卸载后离线条目仍可选择；prepare 只生成待确认项，未擅自安装；实际 trust=false 确认返回 pluginTrustRequired 且插件仍未安装；trust=true 后从同一 bundled 文件来源重装官方 clipboard，原 synthetic PNG 的 entry ID 与资源、paused 状态、native 清单与 updateSource 都保留。结束再次停用 clipboard，未运行真实用户历史或系统剪贴板复制。这条产品链与早期 Hello 包的 9 项 host fixture 分别记录，不能互相替代。

两次打包版 OCR 原生 proof 继续为同一 PID/workerSessionId、engineInitializations 1、processed 1/2，worker 退出码 0，最终无残留；独立 21 项 OCR 报告补充相同输入冷暖/空闲退出与取消范围。本次 launcher 就绪约 7564ms；初轮自动检查剩余等待约 6800ms，待 checking=false 与页面稳定后，三次综合词查询为 2563/238/282ms，两次连续 OCR 为 1057/567ms。不同输入的连续调用不能作为同输入冷暖性能比较。

四个时点 private bytes 分别为：首 idle 12 进程 590,508,032；查询后 12 进程 593,440,768；OCR warm 14 进程 800,841,728；停用 OCR/clipboard 后 9 进程 643,055,616。这些是同机暖 OS 缓存和并行打包/开发负载下的代表快照，不是峰值、P95 或完整服务索引资源预算；关闭进程内代理不等于物理断网首装。

上一轮 `measurement-1792908279968` 的 16 项只保留作历史，不作为本轮目录重装证据。更早 `measurement-1792908077704` 第一词查询未存 page，可能与页面自身可用性查询取消交错有关，无法确定原因；runner 等待初轮 checking=false 与页面稳定并保存 pages 后通过，没有为此旧失败修改产品或宣称产品缺陷已修。它与确实暴露空目录准入缺陷的 `measurement-1792907563522` 分别保留。

## 当前七包与空间

生产有界解包、manifest 兼容、成员 SHA-256、archive SRI、独立 renderer/shared fonts、目录名称/翻译与实际 archive manifest 绑定、OCR app-local runtime/许可报告为 `local-build/spark233/packaging/distribution-DLMF34/report.json`，`ok: true`。

| 插件               | archive 字节数 |  展开字节数 |
| ------------------ | -------------: | ----------: |
| applications 1.0.0 |        244,639 |     555,557 |
| clipboard 0.1.0    |      1,554,004 |   3,235,261 |
| notes 0.1.0        |      1,316,161 |   2,639,517 |
| OCR 0.1.0          |     14,317,114 |  27,669,165 |
| screenshot 0.1.0   |        600,145 |   1,285,744 |
| search 0.1.0       |      6,449,753 |  12,663,873 |
| translation 0.1.0  |     43,374,334 | 104,763,124 |
| 合计               |     67,856,150 | 152,812,241 |

| 体积项目                     |  文件字节数 |    MiB |
| ---------------------------- | ----------: | -----: |
| Windows 应用目录（119 文件） | 491,844,852 | 469.06 |
| 七插件首启解包               | 152,812,241 | 145.73 |
| 首装代码估算合计             | 644,657,093 | 614.79 |
| NSIS 安装器                  | 210,065,819 | 200.33 |

应用目录已包含七个 `.tgz`，首启展开的精确版本另占应用数据目录。上表为文件字节总和，不含磁盘簇分配、Chromium profile、业务数据、缓存、搜索索引、受保护目录服务副本及回滚版本。

## 当前 native 依赖与未完成的验收

`native-dependencies.json` 已在完整构建轮重算所有 14 个 payload 的散列，并全部重新执行 dumpbin /dependents；本次所有 native 散列与既有冻结输入一致，原始日志在 `local-build/spark233/packaging/native-dependents-current/`。导入清单无变化，`unresolvedExternalImports: []`；app-local DLL 实际存在，其余导入为 Windows System32/API sets。关键当前字节为：

| 文件                |    字节数 | SHA-256                                                            |
| ------------------- | --------: | ------------------------------------------------------------------ |
| ImageReader.exe     | 9,506,304 | `4348f8ff4727655da548fb2f0d4cc2fcd64f74057b0781fa8aea7161b66b5ddd` |
| spark233.Search.exe | 1,518,592 | `80299ce859bb3b3500f287cbf4718809fc8631ae92ff2a16717b103ce73dd521` |
| spark233.Index.exe  | 3,389,952 | `32ca4bd14e1633264b19386b9d317494866bf6c00e57759d3763310042fdf614` |

OCR 四个 VC DLL 与固定官方来源未变，既有静态 CRT 加载进程的 app-local 实际加载证明继续适用于这些相同 DLL；当前 archive 再次核对 runtime 和许可散列。新 OCR worker 的真实冷暖复用/停机证据引用上文 21 项报告，不能再把每次 fresh process 当作当前设计。

本轮未执行安装器/UAC，未启动或修改真实 SYSTEM 搜索服务，未发布/提交。真实服务安装升级卸载、服务范围修改/重建、全卷 MFT/USN/卷覆盖、完整索引资源预算、全新 Windows、物理断网首装和人工界面操作仍保留最后实机验收。剪贴板私有窗口站原生运行权限错误 5 的既有限制保留，没有改用用户真实剪贴板补测。所有 profile、插件版本、样例、缓存和原生配置都在 local-build 或明确临时目录。

旧 `d01e054a…`、`36d45d…`、`46269+note-window-ownership` / `048671…` 安装器以及更早候选只用于历史追溯，当前文件已被本节 `87818-final-offline-catalog` 产物替换；上一轮精确报告另存 `windows-package-candidate-40596-fresh-data-payload.json`。名为 final 的旧报告不自动代表当前源码；当前身份与散列以本节和精确报告为准。

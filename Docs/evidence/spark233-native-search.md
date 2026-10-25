# spark233 Pulse 独立后端前置验证

验证日期：2026-10-24（Asia/Hong_Kong）。分支：`codex/spark233-refactor`。

已在真实 Windows 上从固定源码构建独立文件名宿主和 Instant 正文代理，跑通少量真实查询、调用者权限过滤、一次正文订阅取消/替换及进程退出。没有安装或启动 SYSTEM 服务，没有全盘索引，没有接入正式 Electron 插件。这里记录 P1V 的隔离技术证据，不代表 P1、整个 P1V 或 P5 已完成。

## 固定来源与复现入口

- 上游：<https://github.com/jimmgreen/pulse>
- 固定提交：`c4fe01ed82fe091f495f531972a854aa32caac2b`
- 原始 Git 导出 tar SHA-256：`CD158FCB689324DF5065FECCCD5DB0147B86BFCC7B06A4FFB9B160427E096634`
- 本仓入口：[native/search/CMakeLists.txt](../../native/search/CMakeLists.txt)、[probe.cpp](../../native/search/probe.cpp)、[build.ps1](../../scripts/native-search/build.ps1)、[smoke.ps1](../../scripts/native-search/smoke.ps1)。
- 本地来源清单：`local-build/spark233/native-search/source-manifest.json`，记录上游提交、tar 哈希和修改文件。原审阅源码目录 `C:/tmp/galaxyer-pulse-review-20261024` 未修改。

```powershell
pwsh -NoProfile -File scripts/native-search/build.ps1
pwsh -NoProfile -File scripts/native-search/smoke.ps1
```

默认所有源码导出、构建、文件样本、profile、索引、锁、日志和报告均位于 `local-build/spark233/native-search/`。其他隔离目录通过 `-BuildRoot` 显式指定；工具链可通过 `-ToolchainSetup`、`-CMakeExecutable`、`-NinjaExecutable` 指定。

本机共享便携工具链位于 `%LOCALAPPDATA%/spark233/toolchains/`，无需安装系统服务或修改全机 Visual Studio：

| 工具        | 实际版本 / 位置                                                   |
| ----------- | ----------------------------------------------------------------- |
| MSVC        | `19.51.36260.0`，工具目录 `vs2026/msvc/VC/Tools/MSVC/14.51.36231` |
| Windows SDK | `10.0.28000`，由截图原生任务统一准备                              |
| CMake       | `4.4.4`，`cmake-4.4.4-windows-x86_64/bin/cmake.exe`               |
| Ninja       | `1.13.2`，`ninja-1.13.2/ninja.exe`                                |

CMake ZIP SHA-256 为 `bace36e94b31c68ab6fa295f26dfa11219e0701cf7c94b0284a7d1cb13dac536`；Ninja ZIP 为 `07fc8261b42b20e71d1720b39068c2e14ffcee6396b76fb7a795fb460b78dc65`。两者均从官方 GitHub Release 下载并按其 release digest 实算校验，版本命令已实际运行。

## 已实现的原生边界

构建复用上游 CMake 依赖图，仅指定搜索目标；不构建和启动 Pulse 文件管理 UI。客户端复用上游 `ContentSearchClient` 和进程 Job 管理，明确以 `ContentAgentMode::Instant` 启动用户态代理，不以 FTS5 或后台正文写库替代 Instant。

隔离导出适配版本为 `3`：

1. 运行时 exe、服务、命名管道、互斥锁、数据根目录和环境变量统一采用 spark233 命名空间。例如 `spark233.Index.exe`、`spark233Index`、`spark233ContentSearch`、`SPARK233_*`。C++ `pulse` 命名空间及编译宏仍用于上游实现。
2. 原生 `SHGetFolderPath` 不遵循单纯的 `LOCALAPPDATA` 环境覆盖，因此加入明确的 `SPARK233_SEARCH_PROFILE_ROOT` / `SPARK233_SEARCH_MACHINE_ROOT` 数据根覆盖。smoke 同时设置文档解析锁和耗时日志的隔离路径。
3. 上游根工程的 generated 资源/头文件引用改为子工程自己的 binary directory，使其可以通过 `add_subdirectory` 独立构建。

Apache-2.0 原始 LICENSE、拼音数据 MIT 声明及来源已随构建复制到 `bin/licenses/Pulse/`；PDFium 原始声明按上游构建规则保留。没有改写原始 LICENSE。

源码保留默认固定/移动 NTFS 卷、系统排除规则及调用者可见性逻辑。当前只实际运行显式 fixture 根目录；这不构成全盘默认行为的运行证明。

## 实际构建和运行结果

首轮干净构建完成 69 个 Ninja 编译/链接步骤。后续入口重跑能够按依赖增量重建。日志：`local-build/spark233/native-search/build.log`、`build-final.log`。上游 SQLite 源码的 `/W4` 与其 `/W0` 覆盖产生 D9025 命令行提示；本次 probe 未产生新增 C++ 告警。

最终成功报告：`local-build/spark233/native-search/runs/20261024-183651-720/report.json`。

| 实际行为         | 观察结果                                                                                                                                 |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 文件名查询       | 从专用 `spark233Index.Test.*` 管道返回三个创建的 txt / md / ts 文件；上游 fixture 索引还包含匹配名称的祖先目录项                         |
| 文件名宿主退出   | PID `41552` 按 shutdown 请求以 exit 0 退出                                                                                               |
| 权限边界         | 复用上游 restricted-token / NTFS ACL fixture，13 个 PASS；宿主用户可见 5 项，受限调用者仅见 3 项；精确搜索不可见目录中的文件仍不返回结果 |
| 中文 Instant     | 查询“中文”命中 Markdown 第 2 行和文本第 1 行，单次完成 63 ms，error 0                                                                    |
| 代码符号 Instant | 查询 `needle::code_symbols` 命中 TypeScript / 文本文件，单次完成 187 ms，error 0                                                         |
| 取消与替换       | 取消活动订阅后使用同一 session 新 generation 查询不存在的内容，未发布旧 generation 或旧命中；替换完成 63 ms                              |
| 代理资源释放     | 两次查询实际观察到代理子进程，停止后均在 47 ms 内清理；结束后的进程盘点无本次 Index / Document / probe / 权限 fixture 残留               |
| Instant 写入范围 | 没有创建持久化 `content-v1.sqlite` 正文库，配置 sidecar 和必要日志位于隔离目录                                                           |

以上耗时是小样本单次观察，包含本机当时并行构建状态，**不是性能预算、分位数或全盘搜索性能证明**。权限 fixture 提示 folder-size 分支在 fixture 模式没有可用大小，大小过滤检查是单向拒绝证明；不把它称为完整大小服务验收。

最终产物（Windows x64 Release）：

| 文件                            |      字节 |
| ------------------------------- | --------: |
| `spark233.Index.exe`            | 3,334,144 |
| `spark233.Document.exe`         |   239,616 |
| `pdfium.dll`                    | 7,370,752 |
| P1V `spark233_search_probe.exe` | 1,383,424 |
| 上游权限 fixture exe            |   365,568 |

搜索宿主、文档辅助进程及 PDFium 合计 10,944,512 字节（约 10.44 MiB），不含许可证、probe 和验证程序。当前上游依赖图仍构建文档辅助程序；一期未因此新增 PDF/Office 功能承诺。后续插件包只选择必需产物，验证程序不进入发布包。

最终 Index SHA-256：`E6D7EBC2BA9AD2F93DCD1BBB8A08F7D801D59C7E6518440B570B5117C577502E`。

最终 probe SHA-256：`D8DE0DED85CF2C1D8BB184B2224CBFDAD7981C7558D4986FF9702D04255C9459`。

## P1V.5 小样本初始回归参考

2026-10-24 19:12（Asia/Hong_Kong）复用上述成功 fixture 和同一 probe，仅额外运行一次中文、一次代码 Instant 查询；没有重跑完整 smoke、权限 fixture 或新建通用性能脚本。原始记录：`local-build/spark233/native-search/raw/instant-sample-20261024-191207-131/report.json`，两次 stdout / stderr 同目录保存。

固定机器为 AMD Ryzen 7 PRO 8845HS，8 核 / 16 逻辑处理器，Windows `10.0.26300` x64。数据固定为 `20261024-183651-720/files/` 下三个文件：

| 样例                 |        实际 UTF-8 字节 |
| -------------------- | ---------------------: |
| `spark233-读我.txt`  |                     40 |
| `spark233-note.md`   |                     48 |
| `spark233-worker.ts` |                     52 |
| 合计                 | **3 个文件，140 字节** |

报告保留每个文件的 SHA-256。每次使用独立新 profile 和新代理进程；操作系统文件缓存未清理，因此不能将其称为真实磁盘冷启动。采样时机器还有其他开发任务，完整进程 wall time 包括测量包装与退出等待。

| 查询                   | 命中 | probe 报告完成时间 | 代理停止时间 | 启动至退出 wall time |      采到的进程树工作集最大和 |
| ---------------------- | ---: | -----------------: | -----------: | -------------------: | ----------------------------: |
| `中文`                 |    2 |             125 ms |        78 ms |               372 ms | 17,903,616 字节，约 17.07 MiB |
| `needle::code_symbols` |    2 |              94 ms |        62 ms |               262 ms | 19,394,560 字节，约 18.50 MiB |

工作集按实际父 PID 匹配 probe 与其 `spark233.Index` 子进程采样，保留 PID、父 PID、工作集和 private bytes。两次分别取得 4 / 5 个样本；退出边界的进程字段可能为空，已原样保留。表中数值是**观察到的采样最大和，不是精确峰值**；共享页也未去重。该文本样本没有生成 Document 子进程，也不包含 Electron、UI 或其他插件。最终进程盘点没有遗留本次查询进程。

供后续同机、同二进制和相同 140 字节样本手动对照的初始建议为：查询完成不超过 **500 ms**，停止代理不超过 **500 ms**，观察到的 probe + Index 工作集和不超过 **64 MiB**；同时保持正确命中、error 0 和停止后无残留。它们有意留出当前开发环境噪声余量，超过时先核查日志、机器负载和同条件复现，不直接将一次噪声判定为发布失败。

这些只是微小格式样例的初始回归参考，**不适用于全卷、真实大文件、文档解析、长期订阅、整个应用进程树或最终 P7 性能验收**，也没有计算 p95。真实卷范围的预算仍需在正式服务 / 插件链路上测量；本次不为取得预算而扩展数据或测试设施。

## 发现与修复

初次 configure 失败于上游 generated 资源引用根目录而实际输出在子目录，已通过上述子工程路径适配解决；没有修改上游业务引擎以绕过编译。

首轮 smoke 通过后，收口复验在 `20261024-183441-332` 中发现新连接仅写 shutdown 就立即关闭时，宿主未在 10 秒内退出；smoke 确实报失败并终止了该隔离进程。probe 已改为先完成一次 STATUS 请求/响应往返，确保服务端接纳连接，再发送 shutdown。随后最终 smoke 全链路通过。失败记录保留在同名 runs 目录，未将失败隐去或提高超时掩盖。

源码检查显示新管道连接的调用者令牌捕获先于请求派发，立刻关闭连接会形成接纳阶段的竞态；当前修改针对这一调用顺序。尚未以线程跟踪证明该次失败的每一个底层调度细节。

## 后续正式接入仍需完成

- npm 搜索插件、Electron 任务适配、协议版本握手、结果分页、选择项稳定与 UI。
- 经过管理员授权安装独立 spark233 服务，以及实际 SYSTEM MFT/USN 全卷枚举、索引变化、服务升级/卸载和崩溃恢复。
- 普通用户通过正式服务的权限过滤验收；当前已证明同一上游过滤代码在受限令牌 named-pipe fixture 中有效，不能把它扩大成实际 SYSTEM 服务已验收。
- 正文与文件名服务卷范围同步、用户排除与撤权、文件名订阅取消的正式宿主路径。
- 在固定机器和代表数据规模上测量多次样本，形成可用于发布的性能预算。

本次未增加 Vitest 用例或新测试框架；复用现有上游权限 fixture，以最短真实构建/查询/取消/退出链路提供 MVP 工程证据。

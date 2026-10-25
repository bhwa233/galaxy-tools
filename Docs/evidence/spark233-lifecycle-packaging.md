# spark233 生命周期边界跟进：独立 Windows 包

日期：2026-10-25；分支：`codex/spark233-refactor`；冻结标签：`lifecycle-boundaries-followup`。

本轮现有测试、完整目录构建、NSIS、七包/原生/ASAR 审计与新的固定样本 packaged smoke 全部通过。[artifact-report.json](../../local-build/spark233/lifecycle-followup/artifact-report.json) 为 `ok: true`、`artifactIntegrity: true`。这份报告仅绑定本轮新 smoke，不把旧包的 21 项测量改绑为当前产物。

## 冻结输入与独立范围

本包包含独立更新调度边界、异步数据复制、备份预览内容身份绑定，以及目标能力不可用时的 UI 降级；保留上一轮 Windows 公开 pop-up-menu 置顶层级、全屏阻止判定、Launcher 工具栏键盘和命令 requiresPlugins 修复。最后目标 UI 由主线程分别记录，本 lane 不用打包成功替代人工交互验收。

输出仅为 `local-build/spark233/lifecycle-followup/release/`，旧 pin-keyboard/parallel 候选与失败日志没有覆写。该 base 下根任务的 `prepare-ui.mjs` 和 UI profile 没有被本 lane 替换。构建在根确认全部产品源冻结、共享输出释放后才开始；运行可见 smoke 前后均通知根任务协调桌面。

项目运行时为 Node 26.12.1 / npm 12.2.1，Electron 45.0.0、electron-builder 26.18.0、Windows x64。宿主 API 1.1.0、SDK 0.2.0；实际 archive 的截图插件为 0.1.1、API ^1.1.0，OCR 命令 requiresPlugins 为 `['spark233.ocr']`。

## 实际门禁

| 门禁             | 当前结果                                                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 现有测试         | `test.log`：只运行一次 npm test，32 文件/162 项通过                                                                                                                      |
| 完整构建及目录包 | `pack-win.log`：session 9998 退出 0；pack:win 自身执行 typecheck、Vite、独立 renderer/七插件、Electron 与 builder，没有另跑重复的完整 build                              |
| 源码一致性       | before/after 和 `source-input-consistency.json`：349 个源码/构建/包输入的字节数与 SHA 保持一致                                                                           |
| SDK              | 8 个 SDK 输入与上一轮成功构建完全一致，报告明确复用 `parallel-followup/sdk-build.log`，没有声称本轮重跑 SDK                                                              |
| 七包             | `distribution-021BQf/report.json`：七身份、生产有界解包/兼容、SHA-512 SRI、成员清单及逐文件 SHA、catalog 名称/翻译绑定、共享字体和 OCR runtime/许可均通过                |
| 原生             | `native-dependencies.json`：14 模块重算散列并重新 dumpbin /dependents；`native-dependents/` 保存原始日志，导入无变化，未满足外部依赖为 0                                 |
| NSIS             | `nsis.log`：session 63339 退出 0，使用本轮稳定目录的 --prepackaged 输入                                                                                                  |
| Packaged smoke   | session 67136 退出 0；新报告 ok、runtime.packaged 为 true，renderer errors 为空                                                                                          |
| 精确产物审计     | dist 71 文件、dist-electron 68 文件与 ASAR 逐字节一致；没有 native EXE/DLL、自有或依赖测试源码泄入 ASAR；外部七包/installer、共享字体、MCP 三入口、host matcher 全树一致 |

关键并发、回滚和预览保护不是仅凭源码存在：当前 manager 的源码 SHA 与独立回归输入一致；当前打包的 `manager.js`、`backup.js` 又与该回归的独立编译模块逐字节一致。artifact 报告绑定了以下通过报告：

- [官方独立更新 16 项](../../local-build/evidence/plugins-manager/runs/5461c44d-6901-4696-8a61-f481b755fe70/report.json)：真实截图 0.1.0→0.1.1；受控 prepare gate 释放前，真实 notes backend/NoteStore 和暂停合成 clipboard data backend 可用，无关冷启动可用且去重；旧调用拒绝、故障 owner、循环启动、维护独占和通知恢复通过。
- [管理器/迁移 14 项](../../local-build/evidence/plugins-manager/runs/01692e0c-da6c-4562-a783-9368d5006b42/report.json)：事务持久化失败、live/restart 回滚、增量保护、迁移、保留身份/版本和 fresh 数据保护继续成立。
- [命令依赖 6 项](../../local-build/evidence/plugins-manager/runs/fa82b5ae-d6fd-492a-b0b8-f9c27005ce26/report.json)：提供者启停、过期调用不启动 runtime、独立命令和恢复继续成立。
- [备份 9 项](../../local-build/spark233/backup-functional/runs/f519b443-bcc9-4d18-bd36-dadceed0e9ef/report.json)：预览后替换为另一份有效备份也会在保存/停机之前拒绝，原有正文、附件、SQLite、版本、恢复和 journal 保护继续成立。

完整并发输入、runner、进程清理及 headless 限制见 [独立更新记录](spark233-independent-update-concurrency.md)。这些报告没有启动活动截图选区或 clipboard listener。

## 本轮 packaged smoke 与样本保护

[本轮报告](../../local-build/spark233/lifecycle-followup/smoke-1792926128905/report.json) 位于新的 `smoke-1792926128905/`，使用本轮实际目录 exe，无远程调试端口。根 PID 43328 正常退出；没有强杀或重跑，也没有使用其他 UI profile。

便签、图片、提醒、窗口关闭/保存/恢复、capsule 等现有链路完成。`unifiedList.nativePinOnOpen: true`，列表/纸张置顶同步及持久化、复用窗口、桌面转移、脏输入保持均通过；`fullscreenAvoidanceObserved: false`，因此本次没有声称观察到实际全屏避让条件。

运行前从固定 P0 样本复制，notes/clipboard 真业务数据预置准确 schemaVersion、packageName、dataVersion 与 pluginVersion ledger，剪贴板暂停。`fixture-preservation.log` 与 profile 中 `fixed-data-preservation.json`、`clipboard-isolation.json`、`bundled-installation.json`、`data-version-ledger.json` 证明：

- 原始 Markdown 和副本 SHA-256 都为 `d0e5d4bca6279060a8db4ea6805e4d941944774e1f800bb61841d9e0d51ef312`。
- 原始 PNG 和副本 SHA-256 都为 `2d3d07c380eeed5071af4aca0278cd005caa7181309eca073c7c9f24cb50b472`。
- 原便签 ID `ff73f860-0c00-4d9c-9cd0-eab04d918a33` 保留。
- 剪贴板暂停、全部历史记录数为 0；七插件全部安装启用，无 lastError 或 bundled 安装失败。
- notes/clipboard 的 npm 身份、业务版本 1 与插件版本 0.1.0 正确。原 frozen 未修改。

## 当前产物字节

| 项目             | 当前产物                                                                                                  |
| ---------------- | --------------------------------------------------------------------------------------------------------- |
| 安装器           | `local-build/spark233/lifecycle-followup/release/spark233-1.2.0-x64.exe`，210,071,978 字节，约 200.34 MiB |
| 安装器 SHA-256   | `133357749fbed14dd94a2a5d79f876cf16d4e103f3bd9315b94c48e87f1f3cfb`                                        |
| 校验文件         | 同目录 `spark233-1.2.0-x64.exe.sha256`                                                                    |
| 签名 / blockmap  | `signature.json`：NotSigned；blockmap 222,093 字节                                                        |
| 目录包           | 119 文件、491,862,194 字节，约 469.08 MiB                                                                 |
| 目录 exe SHA-256 | `f79565be9428e0a8b4d589b9dd8fa3ba0ad8911025971c1bb9a81e866123350c`                                        |
| ASAR             | 36,620,328 字节，SHA-256 `c33cfe1e9288a40123e5ae279f7956a3e8fa9eaf261215c816c901997475ba37`               |
| 七 archive 合计  | 67,859,066 字节                                                                                           |
| 七插件展开       | 152,823,586 字节，约 145.74 MiB                                                                           |
| 首装代码估算     | 644,685,780 字节，约 614.82 MiB                                                                           |

首装估算是应用目录加七插件展开的文件字节和；应用目录本身已含 `.tgz`。不含磁盘簇分配、Chromium profile、用户业务数据、缓存、搜索索引、机器服务副本或回滚版本。

| 插件               | archive 字节数 |  展开字节数 |
| ------------------ | -------------: | ----------: |
| applications 1.0.0 |        244,639 |     555,557 |
| clipboard 0.1.0    |      1,554,788 |   3,237,953 |
| notes 0.1.0        |      1,316,833 |   2,642,209 |
| OCR 0.1.0          |     14,318,055 |  27,671,857 |
| screenshot 0.1.1   |        599,890 |   1,286,321 |
| search 0.1.0       |      6,449,753 |  12,663,873 |
| translation 0.1.0  |     43,375,108 | 104,765,816 |
| 合计               |     67,859,066 | 152,823,586 |

原生 ScreenCapture 仍为 SHA-256 `6280d49f553defe5a85521da6f32cb27adf96b3e140310d99e71be6150eae146`，ImageReader 为 `4348f8ff4727655da548fb2f0d4cc2fcd64f74057b0781fa8aea7161b66b5ddd`；本轮生命周期/备份/UI 修改未改变 native 字节或导入。

本 lane 未执行安装器、UAC、SYSTEM 服务、全卷 MFT/USN 或物理断网首装，未操作物理截图遮罩及真实用户便签/剪贴板。暂停历史为 0 不代表私有窗口站 listener 已成功；metadata-only 权限阻塞仍按 [剪贴板隔离记录](spark233-clipboard-isolation-followup.md) 保留。最后 UI 和真实活动选区更新由根任务另行记录，未将这些人工或系统边界勾满。包未签名、未发布或提交。

# P3.6 同名应用与离线词典共存证据

日期：2026-10-25。结论：最新 `ui-contract-followup` Windows 候选中的真实 `LauncherController`、`PluginManager` 和两个官方 backend/provider，在默认查询 `hello` 时同时返回精确同名的应用与实际 ECDICT 词条；两者的 opaque selection ID 均可独立解析。待执行 AI 命令同时保留，但查询与这两次本地选择均未发起 AI 请求。没有修改生产源码、共享 dispatcher、候选产物或总 TODO。

本轮先检查了既有 `translation-mode-regression.mjs` 和 `applications/verify-custom.mjs`：前者证明离线词典与 AI 门禁，后者证明实际自定义应用 provider，但两者没有同一次查询的同名共存证据。因此仅增加一个独占本地 runner，不重复 P6.7 整链，不新增 Vitest、框架或测试矩阵。

## 实际执行和冻结输入

Runner 为 `local-build/spark233/functional-integration/launcher-coexistence.mjs`，由同目录的专属 `launcher-coexistence.cjs` 启动 Electron，不改动现有 `inspect-renderer.mjs`。使用项目选定 Node 26.12.1，Electron utility backend 使用其内嵌运行时。ASAR 与两个真实官方 `.tgz` 复制到本次 run 的 `input/` 后加载，归档 SHA-512 与候选 `resources/plugins/index.json` 分别核对通过。

| 输入                                                           | SHA-256                                                            |
| -------------------------------------------------------------- | ------------------------------------------------------------------ |
| `ui-contract-followup/release/win-unpacked/resources/app.asar` | `94ed07fe0a851d40a9110fef9567d97f7c7a9528af18faee9aa3ac77fd83e836` |
| 官方 applications 归档                                         | `76667e97e50abfdc6630b41a442b27f30cdc491e629eb215deb1abd51be0bf22` |
| 官方 translation 归档                                          | `9c0a8c1f2ed80235e48f45eab6c48c228ab45d45bd8ece1f50c610c035547116` |
| `launcher-coexistence.mjs`                                     | `e785326fcfe629b2a5dd4cfb8ede16a4f3232096549b92ed23f2deffe84837c8` |

机器报告：`local-build/spark233/functional-integration/launcher-coexistence-runs/d5f9e460-75ea-4d5f-8b13-4f159bbb35d6/report.json`，`ok=true`，9 项检查通过，`providerRequests=[]`。报告同时记录实际调用和返回值、打包后 launcher/manager/backend JS 散列、两个归档的完整性以及清理结果。

1. 使用生产 `settings/save` 命令保存自定义入口 `hello`，目标为本次隔离目录中的 `hello.url`。该文件仅包含 `https://example.invalid/never-opened`，从未调用 shell 或启动程序。
2. 由真实 `LauncherController.query({query:'hello', sessionId})` 经生产 `PluginManager.query` 分别调用官方 applications 和 translation 的 `search` provider。没有手造搜索结果、替换词库、stub provider 或注入候选。
3. 返回的同一页中，精确标题 `hello` 同时属于 `application` 与 `dictionary`，另有待执行 `translate` 命令。两个精确结果的宿主 opaque ID 不同；应用命令为 `launch`，词条命令为 `detail`。
4. 分别通过真实 `LauncherController.execute` 使用当页的两个 ID。词典返回 `dictionary-entry`，词为 `hello`，实际释义为 `interj. 喂, 嘿`，`networkUsed=false`；应用返回官方 backend 从私有 inventory 解析的 `launchApplication/custom` 目标，路径恰为隔离的 `hello.url`。未调用主进程的 OS 启动函数。
5. AI 配置指向本次 run 的 loopback 监听端点，查询、两次选择及清理期间请求总数为 0，调用记录中也没有 `translate` activation。应用、词库 utility PID `46808`、`55532` 经正常 shutdown 后均确认退出。

所有 profile、应用设置、开始菜单路径、缓存、归档副本和报告均隔离在本次 `local-build` run；没有启动剪贴板采集、访问真实便签或修改真实用户配置。Windows 注册应用查询是官方 provider 原有的只读发现逻辑，未替换为合成列表。

## 范围和探针首轮修正

本轮证明“单词查词不吞同名应用”、真实 provider 合并、两个候选的独立选择解析和未执行 AI 零请求。没有新增截图、Windows 点选、键盘导航或真正启动应用的验收，也没有重跑 P6.7 的工作区选择和主动翻译；这些交互范围应与既有对应证据分别判断。

首次 `0b239fbb-97ca-4085-b621-51ea3c4da7c2` 在收集输入散列时错误地用 `original-fs` 读取 ASAR 内部成员，因此在安装插件或查询前失败，失败报告保留。第二次 `471d0f47-b996-4c5f-9c6d-73d7ff127499` 将读取全改为 Electron ASAR-aware `fs`，又在读取外层 ASAR 文件时失败，在创建 report 前退出；其 input 副本保留，错误摘要记录在 `launcher-coexistence-evidence.json`。最终仅修正 runner 的散列读取：外层 `.asar` 用 `original-fs`，内部成员用 Electron `fs`。生产源码和冻结候选始终未改动。

复现命令：

```powershell
. ./scripts/use-toolchain.ps1
node local-build/spark233/functional-integration/launcher-coexistence.mjs
```

可用 `SPARK233_COEXISTENCE_PACKAGE` 指向另一份完整 `win-unpacked` 目录；每次都会生成新的隔离 run，不覆盖旧报告。

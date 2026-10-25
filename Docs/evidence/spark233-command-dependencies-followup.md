# spark233 跨插件命令可用性回归

日期：2026-10-25（Asia/Hong_Kong）。分支：`codex/spark233-refactor`。

实际界面检查发现：停用 OCR 后，属于截图插件的 OCR 命令仍可列出和调用。本轮主线程为命令增加 `requiresPlugins`，并在管理器命令列表和派发前复查提供者的启用状态、错误与依赖版本范围；本记录证明该行为通过真实管理器/后台的隔离回归，不替代最后的启动器/管理页交互验收。

## 已运行的最小回归

复用既有 `local-build/evidence/plugins-manager/app/main.cjs`，增加 `--command-dependencies-only` 模式。使用原有 staging、清单校验、`PluginManager`、`createTrustedBackend` 和 Electron utilityProcess，没有新测试文件、框架或 mock 管理器。运行实例和两个无害样本包均在：

`local-build/evidence/plugins-manager/runs/0f867eee-be81-40ed-98ca-5350498ba1eb/`

该目录 `report.json` 的 `ok: true`，以下六项全部为 `true`：

| 行为       | 实际证明                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 提供者启用 | 消费者的依赖命令可列出，真实后台收到命令并返回                                                                                                                  |
| 提供者停用 | 依赖命令从 `manager.commands()` 撤下；已有后台收到的过期调用被拒绝且没有执行记录；消费者停用后重新启用，再调用过期命令仍在启动后台之前拒绝，新增 runtime 数为零 |
| 独立命令   | 同一消费者的独立 capture 命令正常执行，提供者保持停用且无 runtime，没有自动启用提供者                                                                           |
| 恢复提供者 | 重新启用后，依赖命令再次列出并执行                                                                                                                              |
| 非法清单   | 命令声明了未在插件 `dependencies` / `optionalDependencies` 中声明的提供者，生产校验返回 `invalidPlugin`                                                         |
| 生命周期   | 三个真实 utilityProcess PID（15380、15940、20388）全部退出，`alivePids: []`                                                                                     |

两次过期调用均返回 `pluginDependencyUnavailable`。验证使用一个包含独立命令与依赖命令的消费者，以及一个可选提供者，没有扩展缺失/错误/版本组合矩阵。消费者声明 `api: ^1.1.0`，提供者保留 `api: ^1.0.0`；宿主环境来自生产 `defaultHostEnvironment`，因此同时证明新版宿主接受此次较旧协议范围的提供者。

## 输入与范围

项目运行时通过 `scripts/use-toolchain.ps1` 选择，实测 Node `26.12.1` / npm `12.2.1`。使用 `local-build/spark233/command-dependencies-followup/tsconfig.json` 从当前源码编译必需管理器/后台/安装器/迁移模块及其依赖，TypeScript 编译成功；输出位于该目录 `compiled/`。runner 的 `SPARK233_MANAGER_PROBE_COMPILED` 显式指向该次输出，没有复用旧的 migration 编译结果。

`local-build/spark233/command-dependencies-followup/input-hashes.json` 保存运行后相应产品输入和 runner 的 SHA-256；`latest-report.txt` 指向上述完整报告。runner 在项目 Node 下的语法检查通过。

本回归只调用无害的 fixture 后台，它们向私有业务目录写入 commandId/PID 执行记录。没有启动官方截图/OCR/剪贴板 native 程序，没有创建窗口、访问桌面剪贴板或真实便签，没有改动正在使用的隔离 UI profile。

本 lane 仅修改已有 local-build runner、增加隔离编译配置与本证据文档，没有修改产品源文件、生成 root dist、官方插件 archive 或 Windows 分发。全仓 typecheck/lint/test/build、实际截图包版本和 API 升级及最后 UI 检查由主线程统一完成。

## 仍需区分的验收项

本次证明管理器列表/真实派发与 manifest 边界，未声称已经完成桌面管理页或启动器 DOM 验收，也未声称原生截图取字已完成一次真实框选。主线程对实际截图命令声明、管理页列表共用同一可用性判定的接线及 UI 恢复行为继续负责；不能仅用本报告将整个截图/OCR 交互条目勾选。

# spark233 文档

从 [当前架构](architecture.md) 了解实现与职责；[当前 TODO](launcher-todo.md) 跟踪已确认但尚未完成的工作。2026-10-30 的[功能优化计划](functional-improvement-plan-2026-10-30.md)及历史报告对应各自输入，不表示当前工作区通过了设备或发布验收。

| 主题                     | 入口                                                                                                                                                      |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 当前架构与目录           | [architecture.md](architecture.md)、[pnpm monorepo](pnpm-monorepo.md)                                                                                     |
| 插件与信任边界           | [SDK](../packages/sdk/README.md)、[原生协议](native-plugin-protocol.md)、[官方插件](../packages/official/README.md)                                       |
| MCP                      | [配置、工具与权限](mcp.md)                                                                                                                                |
| 快捷键与托盘菜单         | [实现与验证](evidence/spark233-shortcuts-tray-management.md)、[插件声明合同](../packages/sdk/README.md#global-shortcuts-and-system-tray-actions)          |
| Windows 窗口与胶囊       | [胶囊行为](edge-capsules.md)、[桌面窗口层设计](desktop-widget-layer.md)、[迁移背景](electron-migration.md)                                                |
| 启动器与插件窗口框架     | [产品方案（2026-11-10）](plugin-display-and-card-desktop.md)、[代码改动与技术方案](plugin-window-framework-tech-design.md)、[实施 TODO](launcher-todo.md) |
| 启动器可用性与全插件接入 | [架构审查、九项确认决定与后续验收方案（2026-11-17，尚未开始代码实施）](launcher-availability-and-plugin-integration.md)                                   |
| 开发、测试与打包         | [项目 README](../README.md)、[PR 检查](../.github/workflows/pulls.yml)、[独立打包](../.github/workflows/build-artifacts.yml)                              |
| 应用内更新与发行         | [实现记录](evidence/update-0.0.1-2026-10-31.md)、[v0.1.0 发行说明](release-note/0.1.0.md)、[v0.0.1 发行说明](release-note/0.0.1.md)                       |
| 本轮功能优化             | [确认范围与实施顺序（2026-10-30）](functional-improvement-plan-2026-10-30.md)                                                                             |
| 2026-10-28 修复          | [审查清单及落实记录](optimization-review-2026-10-28.md)                                                                                                   |
| 历史方案和验收记录       | [2026-10 归档](archive/2026-10/)、[证据记录](evidence/)、[上游文档](upstream/)                                                                            |

Windows 打包通过 `scripts/prepare-windows-resources.ps1` 准备锁定来源的 native 与词典资源，再运行 `pnpm pack:win` 或 `pnpm dist:win`。PR 检查不依赖开发机器中被忽略的资源。

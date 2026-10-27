# pnpm monorepo

项目使用 Node.js 26.12.1、pnpm 12.15.0。版本分别固定在根目录 `.node-version` 和 `package.json`，所有 workspace 共用 `pnpm-lock.yaml`。Windows 工具链准备步骤见 [README 开发说明](../README.md#开发)。

## 目录与依赖

| 位置                                              | 职责                                                    |
| ------------------------------------------------- | ------------------------------------------------------- |
| `apps/desktop`                                    | Electron 主进程、预加载、React 界面、桌面配置和打包入口 |
| `packages/sdk`                                    | 插件协议、校验和浏览器 SDK                              |
| `packages/ui`                                     | 共享主题、组件及工具函数；不引用桌面源码                |
| `packages/official/*`                             | 七个官方插件，各自声明依赖和构建入口                    |
| `examples/plugins/*`                              | 插件示例                                                |
| `native/capture`、`native/applications`           | 跨插件或宿主共用的原生源码                              |
| `packages/official/{clipboard,search}/native-src` | 插件专用原生源码                                        |
| `scripts`                                         | 全仓构建、校验、原生准备及 Windows 工具链               |

依赖声明放在使用它的包中。内部包使用 `workspace:*`，公共开发工具由根目录管理。保持 pnpm 默认的隔离依赖布局；桌面打包已验证可以收集 SDK 及其生产依赖，不需要全局提升依赖。

共享 UI 的组件源码位于 `packages/ui/src/components`，桌面原路径只保留重导出。桌面 Tailwind 显式扫描共享组件源码。官方插件仍按原协议组装独立离线归档，插件安装不依赖开发机器上的 workspace 链接。

## 常用命令

以下命令从仓库根目录执行：

| 命令                             | 用途                                              |
| -------------------------------- | ------------------------------------------------- |
| `pnpm install --frozen-lockfile` | 按统一锁文件安装全部 workspace                    |
| `pnpm dev`                       | 编译 SDK，启动桌面开发环境                        |
| `pnpm typecheck`                 | 编译 SDK，按依赖顺序检查各包类型                  |
| `pnpm lint`                      | 全仓静态检查                                      |
| `pnpm test`                      | SDK 准备后运行桌面和插件 Node 测试                |
| `pnpm test:ui`                   | 单独运行浏览器交互测试                            |
| `pnpm build`                     | 类型检查、共享 UI、桌面界面、离线插件和主进程构建 |
| `pnpm pack:win --publish never`  | 完整构建并生成 Windows 目录包                     |
| `pnpm dist:win --publish never`  | 完整构建并生成 NSIS 安装包                        |
| `pnpm fmt --check`               | 全仓格式检查                                      |

单包任务使用 `pnpm --filter <包名> <任务>`。直接执行桌面单包命令前，需要先运行 `pnpm sdk:build`；根目录命令会处理这个前置步骤。新增依赖使用 `pnpm --filter <包名> add <依赖>`，仅全仓工具使用 `pnpm add -Dw <依赖>`。

桌面产物为 `apps/desktop/dist` 和 `apps/desktop/dist-electron`。共享离线插件、宿主原生资源、Windows 包分别位于根目录 `dist-plugins`、`dist-host`、`release-electron`；本地验收记录位于 `local-build`。

## 本次本机验收

2026-10-27，在 Windows 上使用上述固定版本，旧 npm `node_modules` 已移到 `local-build/npm-node-modules-before-pnpm` 后重新安装验证：

- 冻结锁文件安装和离线冻结安装通过。
- 全部 workspace 类型检查和 lint 通过。
- Node 测试 53 个文件、219 个用例通过，包含官方插件用例。
- 浏览器测试 5 个文件、5 个用例通过。
- 共享 SDK、UI 和插件示例独立构建通过，SDK/UI 本地打包通过。
- `pnpm pack:win --publish never` 通过，七个官方离线插件和宿主原生匹配器完整生成。
- NSIS 安装包生成通过：`release-electron/spark233-1.2.0-x64.exe`；未执行安装程序。
- ASAR 收集到 53 个生产依赖包，逐包检查缺失数为 0，没有外部 workspace 链接；MCP 解包文件完整。
- 源码产物和打包产物分别在隔离数据目录完成现有 Windows 集成冒烟，进程均退出 0；剪贴板记录在启动前暂停。
- 迁移范围格式检查通过。全仓格式检查仍报告并发编辑中的 `Docs/launcher-todo.md` 和 `Docs/screenshot-enhancement-todo.md`，保留其内容。

运行记录：`local-build/pnpm-monorepo-pack-verified.log`、`local-build/pnpm-monorepo-installer.log`、`local-build/review-asar.json`。Windows 集成报告分别位于 `local-build/electron-smoke/ea202597-0a69-4db4-8b85-8ea74439fc87/report.json`（源码产物）和 `local-build/electron-smoke/a9a6bdb5-d639-4fb9-a6e2-07a0efa7c5a6/report.json`（打包产物）。

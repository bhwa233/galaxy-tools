# spark233

Windows 11 x64 桌面启动器与插件工具集，提供便签、截图、OCR、翻译与离线词典、剪贴板历史、应用入口和文件搜索。界面支持简体中文和英文。

项目使用 Electron 45、React 19、TypeScript、Vite 和 pnpm workspace。架构、协议、待办与历史验证记录从 [文档索引](Docs/README.md) 进入。[English](README_en-US.md)

## 开发

工具链固定为 **Node.js 26.12.1 / pnpm 12.15.0**，以 `.node-version` 和 `package.json` 为准。Electron 内嵌的 Node 与开发工具链分别管理。

安装对应版本后，从仓库根目录运行。Windows 已准备便携工具链时，在 Git Bash 中执行 `source scripts/use-toolchain.sh`；PowerShell 使用 `. ./scripts/use-toolchain.ps1`。选择脚本只影响当前终端，在另一个终端运行不会改变当前 Git Bash 的环境。

```sh
pnpm install --frozen-lockfile
pnpm dev
```

需要准备 pnpm 时，可使用官方 Node 的 npm 安装到项目工具链目录。npm 12 需要批准并重建 pnpm 自身的安装脚本：

```powershell
npm.cmd install --prefix "$env:LOCALAPPDATA/spark233/toolchains/pnpm-v12.15.0" --save-exact --no-package-lock pnpm@12.15.0
npm.cmd --prefix "$env:LOCALAPPDATA/spark233/toolchains/pnpm-v12.15.0" install-scripts approve pnpm
npm.cmd --prefix "$env:LOCALAPPDATA/spark233/toolchains/pnpm-v12.15.0" rebuild pnpm
. ./scripts/use-toolchain.ps1
```

`pnpm dev` 准备 SDK、Electron 和官方资源，再启动桌面应用。`pnpm dev:web` 仅启动前端，桌面功能需要 preload 桥接。源码可放在 WSL，但 Windows GUI 使用 Windows Node/Electron；两种系统的 `node_modules` 分开管理。

## 验证

依次运行检查，避免同时启动多个重任务：

```sh
pnpm typecheck
pnpm lint
pnpm fmt --check
pnpm test
pnpm --filter @spark233/desktop exec playwright install chromium --only-shell
pnpm test:ui
```

Node 测试与 Chromium UI 测试分别运行。测试通过、构建成功、真实设备行为和安装包验收是不同证据；当前物理鼠标、IME、多屏和 SYSTEM 服务等验收项见 [实施清单](Docs/launcher-todo.md)。

## Windows 构建

打包需要 CMake、Ninja、Python 3.12 和锁定的原生构建依赖。在 Windows PowerShell 7（`pwsh`）中执行：

```powershell
./scripts/prepare-windows-resources.ps1
pnpm pack:win
# 或 pnpm dist:win
```

准备脚本复用各插件的来源锁、下载校验与构建脚本。`pnpm build` 生成桌面资源与七个离线插件；`pack:win` 生成 `release-electron/win-unpacked/`，`dist:win` 生成 NSIS 安装包。便携版必须整体分发，用户端不需要临时编译或运行 npm 脚本。

[PR 流水线](.github/workflows/pulls.yml) 运行质量检查；[独立打包流水线](.github/workflows/build-artifacts.yml) 显式准备 native 与词典。完整来源与许可证见 [官方插件](packages/official/README.md) 和 [第三方声明](THIRD_PARTY_NOTICES.md)。

## 数据与权限

宿主设置、插件安装状态和插件业务数据分别管理。外部文件需经文件选择器、拖放或命令行授权；笔记页不能修改 MCP、开机启动或宿主管理设置。保存失败会保留当前草稿并阻止切换。备份不能静默增加插件权限或执行代码信任。

MCP 默认关闭，启用方式和权限见 [MCP 文档](Docs/mcp.md)。应用身份为 `spark233` / `com.spark233.desktop`，未配置数字签名。长期设计、历史方案与当前待办见 [文档索引](Docs/README.md)。

项目演进自 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)，保留其授权和来源说明。上游发布材料位于 [Docs/upstream](Docs/upstream/)，当前开发不使用 Tauri。

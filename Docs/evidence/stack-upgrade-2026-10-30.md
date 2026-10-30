# 技术栈升级记录 · 2026-10-30

本次升级针对工作区 npm 直接依赖和开发运行工具链。依赖清单、锁文件、Node 版本文件与中英文开发说明同步更新。

| 项目             | 当前版本 |
| ---------------- | -------- |
| 开发 Node.js     | 26.13.0  |
| pnpm             | 12.16.1  |
| Electron         | 45.1.0   |
| React            | 19.3.1   |
| TypeScript       | 7.0.2    |
| Vite             | 8.3.5    |
| Vitest           | 5.0.5    |
| Tailwind CSS     | 4.3.3    |
| shadcn           | 4.23.0   |
| Base UI          | 1.9.0    |
| electron-builder | 26.18.0  |

## 版本选择与来源

- Node 使用 nvm 管理并已执行 `nvm use 26.13.0`。Windows Node 共享链接解析到 `C:\Users\40417\AppData\Roaming\nvm\v26.13.0\node.exe`。
- 本机 nvm 1.1.12 的镜像版本查询未识别目标版本；使用 npm registry 的 `node-win-x64@26.13.0`，校验 npm integrity 后导入 nvm 目录，再由 nvm 切换。该导入路径与普通 nvm 下载路径不同。
- `scripts/use-toolchain.sh` 和 PowerShell 对应脚本优先选择 nvm 的 Node，并核验固定版本；pnpm 复用本机准备好的固定版本目录。
- Electron 从镜像下载，使用 Electron npm 包携带的官方校验和验证。真实进程确认 Electron 45.1.0；其内嵌 Node 为 24.22.1，与开发 Node 分别管理。
- 检查时工作区 npm 直接依赖没有可升级的稳定版本，记录为 `local-build/stack-outdated-final.json`。该结论不包含原生 CMake/Ninja/MSVC、词库及模型资源，也不表示所有间接依赖均为最新版。

## 验证

本轮实现快照串行完成类型检查、lint、288 项 Node 测试、33 项浏览器测试与完整构建；构建生成桌面资源及七个独立官方插件归档。真实 Electron 窗口验证另见 [通知与 Base UI 记录](toast-base-ui-2026-10-30.md)。末尾复查时另一个功能任务正在同一工作区修改 OCR/翻译代码；当前混合工作区的最终全仓类型检查未通过，不能套用先前快照的通过结论，详情与日志见该记录。

全仓格式检查存在原有的 OCR VC Runtime 来源文件格式问题：`packages/official/ocr/legal/Microsoft-VC-Runtime-provenance.json`。本次没有修改该签名来源文件来清除提示。本次实现文件在并发功能修改前单独格式检查通过。最后的 `current-work-format-full.log` 还包含并发修改中的翻译界面与 provider 文件，未对该任务的进行中代码批量格式化。

本轮未运行 NSIS 打包、远端 CI 或发布。日志保存在 `local-build/current-work-*.log`；依赖变更和运行时来源记录保存在 `local-build/stack-package-changes.json` 与 `local-build/stack-toolchain-install.json`。

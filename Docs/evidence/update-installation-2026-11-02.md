# 更新检查阻塞修复与 Windows 安装升级验收

日期：2026-11-02。基于 `3bb59db` 及本工作区修复，产品版本仍为 `0.0.1`。

## 修复

- quicklinks 显式声明已有的开发依赖 `electron@45.1.0`，供其 Electron 类型检查使用。
- traffic 显式声明已有的 `lucide-react@1.64.0`，同步 `pnpm-lock.yaml`。
- 用仓库格式化器修复 `apps/desktop/scripts/dev-electron.mjs` 和 `scripts/native-traffic/smoke.cjs`。
- 流量原生项目显式声明锁文件中已有的 `Microsoft.NETFramework.ReferenceAssemblies@1.0.3`，避免已安装开发包的 Windows 与其他环境产生不同的隐式引用。
- `scripts/use-toolchain.sh` 在系统只有 .NET 运行时时，选择已安装的便携 SDK；不修改系统 PATH，也不自动下载 SDK。

本次便携 SDK 为 .NET 10.0.403，下载自 Microsoft 官方源并通过发布元数据中的 SHA-512 校验。NuGet 大包的普通下载超时后，按 HTTP Range 从官方源下载至临时离线源，再由 `--locked-mode` 还原。28 个包的 NuGet 内容哈希与提交的锁文件一致；未更新原生依赖版本或放宽锁定模式。签名压缩包的传输哈希与 NuGet 锁定内容哈希分别记录。

## 检查与构建

工具链：Node 26.13.0、pnpm 12.16.1，Windows Git Bash。

| 检查                          | 结果                                            |
| ----------------------------- | ----------------------------------------------- |
| `pnpm typecheck`              | 全工作区通过                                    |
| `pnpm lint`                   | 通过，保留既有 warning                          |
| `pnpm fmt --check`            | 全工作区通过                                    |
| `pnpm test --maxWorkers=4`    | 81 个文件、335 个用例通过                       |
| `pnpm test:ui --maxWorkers=1` | 16 个文件、39 个用例通过                        |
| 流量原生构建                  | 四个项目通过，零警告、零错误；37 个执行闭包文件 |
| `pnpm pack:win`               | 通过，包含 9 个官方插件                         |

日志位于 `local-build/update-remediation/`。常规可执行产物为 `release-electron/win-unpacked/spark233.exe`。

## 真实 NSIS 安装与应用内升级

最终报告：[`report.json`](../../local-build/update-remediation/install-afb37907-5ed0-4761-8e2d-46ecdf9b0018/report.json)，`ok: true`。

使用当前打包代码构建两个验收版本 `0.0.2`、`0.0.3`，采用独立 appId、产品名、安装目录和数据目录。验收包关闭快捷方式和文件关联注册；剪贴板录制和流量采集暂停，不安装系统服务。版本号覆盖仅用于验收包，没有修改仓库产品版本。

已验证：

- 真正执行 NSIS 静默安装，检查每用户卸载注册信息和安装后的 Electron 窗口、桥接、9 个官方插件。
- 通过已安装应用的真实 IPC、UpdateService 和 electron-updater 查询、下载真实 NSIS 文件。
- 拒绝较旧版本；篡改更新清单 SHA-512 后，真实安装包下载被校验拒绝。
- 同包再次检查保留已下载状态；更新源返回 HTTP 503 后仍保留安装入口。
- 在真实 quicklinks 窗口制造未保存草稿，安装请求被实际宿主保存屏障拒绝；窗口、草稿和待安装包保留。
- 放弃验收草稿后，应用内安装真正启动 NSIS，旧进程正常退出，新版本自动重启，确认运行版本为 `0.0.3`。
- 通过真实便签后台创建的文档、更新偏好在升级后保持一致。
- 升级后的应用正常退出；静默卸载移除验收可执行文件和注册项，没有强制终止运行中的业务进程。

`before-upgrade.json`、`after-upgrade.json`、两次正常退出记录、HTTP 请求记录和截图保存在报告同目录。测试入口已从常规构建输入目录移除。

## 验收范围

更新源使用本机 HTTP 服务和真实 NSIS 资产，验收入口只负责指定隔离配置、驱动已有 IPC，并在保存拒绝对话框中选择“保留应用”。业务宿主、保存协调器、插件和更新器均使用实际打包代码。

这是 Windows 上真实安装、下载、校验、升级、重启和卸载的集成验收；不等同于 GitHub 发布验收或人工鼠标操作验收。本轮没有发布 GitHub Release，也没有覆盖日常安装及数据。

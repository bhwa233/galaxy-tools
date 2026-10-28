# 后续优化与 Windows 验收记录（2026-10-28）

本记录对应 [优化审查](../optimization-review-2026-10-28.md) 第 10 节。所有 `local-build` 路径均为本机隔离报告，不随 Git 自动提交。远程 CI 使用独立源码快照分支，不改变当前工作分支和暂存区。

## 已实施

主进程采用入口、组合根、领域宿主和领域 IPC 分层；笔记窗口采用会话与文档 hooks、展示组件和独立菜单/提醒/外部文件监听。命令参数 schema 覆盖全部注册命令，验证在排入写队列之前进行；命令/返回值/事件契约由 preload 与渲染封装共享，移除调用点通用返回类型强转。分派内部不再使用通用 `Record<string, any>`。

注册表回归保护非法写入不得触发业务分派、队列快照不随调用方后续修改漂移、二进制内容保持。原有保存拒绝/超时不得强制终止业务进程的约束保留。

## 本机已执行

| 项目              | 实际结果与证据                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型/静态检查     | `pnpm typecheck`、`pnpm lint`、`pnpm fmt --check` 通过；日志 `local-build/optimization-followup/final-*.log`。lint 仍有历史警告，不能视为零警告。                                                         |
| Node / 浏览器测试 | 60 文件、247 项 / 9 文件、15 项通过。                                                                                                                                                                     |
| 启动器维护        | `electron-smoke/ffef6bad-e5b7-4d20-9549-e35c87882114/report.json` 成功。模式查询等待覆盖原生 RPC 预算；隔离配置关闭全局快捷键并暂停剪贴板记录。                                                           |
| 笔记              | `spark233/notes-backend-probe/run-nJQgth/report.json` 成功；独立进程 CRUD、拒绝删除/保存保持数据、停止/恢复与重启持久化。                                                                                 |
| 文件搜索          | `evidence/search-production/5894308e-ab46-4ecd-bafe-fe0889e2f434/report.json` 成功；中文/代码内容、ACL 撤权、文件替换、过滤策略、并发取消和停止清理。此探针使用受控 index test-host。                     |
| 应用搜索          | `spark233/application-icons-probe/run-bIUFNf/report.json` 成功；真实快捷方式图标、缓存撤销；独立业务探针另验证受控 Windows Node 程序及参数确实执行。                                                      |
| 翻译/词典         | 独立包探针验证离线查词、详情、设置持久化和未配置时拒绝翻译；没有调用外部 AI 服务。                                                                                                                        |
| 剪贴板数据        | 独立包探针使用受控多格式快照格式验证数据捕获、搜索、草稿与收藏；没有读取用户交互剪贴板。                                                                                                                  |
| OCR               | 独立包原生 ImageReader 实际识别生成图片，得到 `SPARK233 HELLO WORLD`。                                                                                                                                    |
| 独立包业务报告    | `evidence/plugin-business/9ead93cb-0e5b-4b20-8b19-515d6c1c3228/report.json` 成功；报告含版本和包 integrity，探针核对 archive SHA-512。                                                                    |
| 截图              | `optimization-followup/capture-pin.log` 两种场景通过：选区贴图、置顶、右键恢复、Esc 退出；批注渲染及贴图后保留。探针未保存屏幕像素。                                                                      |
| NSIS              | `installer-acceptance/b53b148e-b2bb-482c-9646-972ba9fe78fe/report.json` 成功；静默每用户安装、登记路径、已安装应用冒烟、卸载和默认文件关联保持。静默安装主动跳过服务提权。                                |
| 已安装应用        | `electron-smoke/55962796-c167-490a-ba6e-fa85034978ab/report.json` 成功，exit 0，72.971 秒。                                                                                                               |
| SYSTEM 服务       | `evidence/search-system-service/6e541276-a0d9-4bca-91d7-84cfcf2cf951/report.json` 成功；从需要升级的已有服务经产品 UAC 助手升级，账户 LocalSystem、生产协议连接与受控文件查询通过。保留已有服务，不卸载。 |

## 运行方式

在 Git Bash 执行 `source scripts/use-toolchain.sh` 后，依次运行现有检查；重型检查串行。

- `pnpm typecheck`、`pnpm lint`、`pnpm fmt --check`、`pnpm test`、`pnpm test:ui`。
- `pnpm dist:win --publish never` 生成 NSIS 和目录包。
- PowerShell 7 执行 `scripts/verify-windows-installer.ps1`。遇到已有安装或运行中的 spark233 会拒绝，避免安装器影响用户工作。
- 选定 Electron 执行 `scripts/verify-plugin-business.cjs`；环境变量 `SPARK233_ACCEPTANCE_NODE` 指向选定的 Windows `node.exe`。
- 选定 Electron 执行 `scripts/native-search/production-smoke.cjs`；PATH 需包含 PowerShell 7。
- 选定 Electron 执行 `scripts/native-search/verify-service.cjs`：干净机器走真实安装/验证/卸载；已有服务使用 `--use-existing` 做只读验收，明确需要升级时使用 `--upgrade-existing`，由产品助手执行 UAC 并保留升级后的服务。
- `node scripts/native-clipboard/probe-service.mjs` 使用私有窗口站和实际服务；可用 `SPARK233_CLIPBOARD_BOUNDARY` 指定已构建 boundary。隔离失败直接失败，不回退到交互剪贴板。

## 仍需实机配合

| 项目           | 当前条件与验收步骤                                                                                                                                                                                               |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 多屏           | 系统仅枚举 DISPLAY1，1920×1080。连接第二屏，覆盖不同 DPI、负坐标、跨屏拖动、移除副屏后的窗口恢复和全屏避让；记录两屏边界/DPI与实际窗口位置。单屏模拟不能代替。                                                   |
| 物理 IME       | 使用真实键盘和 Windows 中文输入法，在启动器输入拼音、选词、退格、切换中英文；组合期间不得执行结果或提前失焦，确认后查询正常。浏览器合成组合事件只能证明逻辑。                                                    |
| 真实注销       | 先保存其他应用工作。打开本应用未保存笔记和插件草稿，触发真实 Windows 注销；拒绝/超时保存须取消退出并保持业务进程；允许保存后完成注销，再登录检查持久化及日志。不能用模拟 WM 消息替代，也不自动注销当前用户桌面。 |
| 剪贴板原生监听 | `evidence/clipboard-service/c380cee4-1b2f-4e79-abff-674250701132/launcher.json` 记录创建窗口站失败 `AccessDenied (5)`。在允许私有窗口站的交互会话重跑服务探针，成功前不将监听/回放标为验收通过。                 |
| 实际 AI 翻译   | 在产品设置中配置服务后验证真实请求、流式响应、取消、历史和失败恢复；不从用户其他配置读取密钥，不以本地 mock 结果充当外部服务成功。                                                                               |

## 远程 CI

待记录本轮源码快照的提交、工作流运行编号与最终结果。旧远端提交的成功不能代表本轮源码。

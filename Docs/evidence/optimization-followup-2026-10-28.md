# 后续优化与 Windows 验收记录（2026-10-28）

本记录对应 [优化审查](../optimization-review-2026-10-28.md) 第 10 节。所有 `local-build` 路径均为本机隔离报告，不随 Git 自动提交。远程 CI 使用独立源码快照分支，不改变当前工作分支和暂存区。

## 已实施

主进程采用入口、组合根、领域宿主和领域 IPC 分层；笔记窗口采用会话与文档 hooks、展示组件和独立菜单/提醒/外部文件监听。命令参数 schema 覆盖全部注册命令，验证在排入写队列之前进行；命令/返回值/事件契约由 preload 与渲染封装共享，移除调用点通用返回类型强转。分派内部不再使用通用 `Record<string, any>`。

注册表回归保护非法写入不得触发业务分派、队列快照不随调用方后续修改漂移、二进制内容保持。原有保存拒绝/超时不得强制终止业务进程的约束保留。

## 本机已执行

| 项目              | 实际结果与证据                                                                                                                                                                                                                                          |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 类型/静态检查     | `pnpm typecheck`、`pnpm lint`、`pnpm fmt --check` 通过；日志 `local-build/optimization-followup/final-*.log`。lint 仍有历史警告，不能视为零警告。                                                                                                       |
| Node / 浏览器测试 | 快照代码 62 文件、264 项 / 10 文件、18 项通过；后续工作区 62 文件、265 项 / 10 文件、20 项通过，见 `current-test.log`、`current-ui.log`。后续工作区类型、lint、格式检查亦通过；8.3 短路径 TEMP 下完整 62 文件、265 项通过，日志 `short-temp-full.log`。 |
| 启动器维护        | `electron-smoke/d8b82912-818e-4301-bf45-60c357a64dc1/report.json` 成功。模式查询等待覆盖原生 RPC 预算；隔离配置关闭全局快捷键并暂停剪贴板记录。                                                                                                         |
| 笔记              | `spark233/notes-backend-probe/run-nJQgth/report.json` 成功；独立进程 CRUD、拒绝删除/保存保持数据、停止/恢复与重启持久化。                                                                                                                               |
| 文件搜索          | `evidence/search-production/46ddc024-f531-4c78-b5dd-7129f92e9820/report.json` 成功；中文/代码内容、ACL 撤权、文件替换、过滤策略、并发取消和停止清理。此探针使用受控 index test-host。                                                                   |
| 应用搜索          | `spark233/application-icons-probe/run-bIUFNf/report.json` 成功；真实快捷方式图标、缓存撤销；独立业务探针另验证受控 Windows Node 程序及参数确实执行。                                                                                                    |
| 翻译/词典         | 独立包探针验证离线查词、详情、设置持久化和未配置时拒绝翻译；没有调用外部 AI 服务。                                                                                                                                                                      |
| 剪贴板数据        | 独立包探针使用受控多格式快照格式验证数据捕获、搜索、草稿与收藏；没有读取用户交互剪贴板。                                                                                                                                                                |
| OCR               | 独立包原生 ImageReader 实际识别生成图片，得到 `SPARK233 HELLO WORLD`。                                                                                                                                                                                  |
| 独立包业务报告    | `evidence/plugin-business/f05d383b-7cd9-4222-b8ea-fb84ca3d7ae9/report.json` 成功；报告含版本和包 integrity，探针核对 archive SHA-512。                                                                                                                  |
| 截图              | `optimization-followup/capture-pin.log` 两种场景通过：选区贴图、置顶、右键恢复、Esc 退出；批注渲染及贴图后保留。探针未保存屏幕像素。                                                                                                                    |
| NSIS              | `installer-acceptance/226f97bb-bf71-4dc6-824c-4afc1de66e5b/report.json` 成功；静默每用户安装、登记路径、已安装应用冒烟、卸载和默认文件关联保持。静默安装主动跳过服务提权。                                                                              |
| 已安装应用        | `electron-smoke/1d0998f3-4b5b-48f2-9c8a-4659120ad82a/report.json` 成功，exit 0，80.365 秒。                                                                                                                                                             |
| SYSTEM 服务       | `evidence/search-system-service/6e541276-a0d9-4bca-91d7-84cfcf2cf951/report.json` 成功；从需要升级的已有服务经产品 UAC 助手升级，账户 LocalSystem、生产协议连接与受控文件查询通过。保留已有服务，不卸载。                                               |

普通进程创建剪贴板私有窗口站曾返回 `AccessDenied (5)`；随后通过提权隔离执行，`evidence/clipboard-service/4a941d16-58c2-49f6-aec4-5c8b87367097/report.json` 验证真实原生监听、多格式快照、回放与正常退出，未访问用户交互剪贴板。

服务探针与文件搜索生产探针均从 `dist-plugins/index.json` 选择完整独立包，复用生产 `stageLocalPluginPackage` 校验 SHA-512 与清单，避免源码目录缺少 renderer。服务升级后等待命名管道就绪最多 45 秒，仅重试启动期 `service-unavailable`。最新只读服务验收为 `evidence/search-system-service/f765593c-c3ab-41b6-b687-28bd1058b8b7/report.json`，确认当前运行服务和受控内容查询；保留原先存在的服务。文件搜索生产探针发现已有机器服务时明确跳过“服务未安装”分支，不能把该分支计为本轮通过，也不会为制造条件而卸载已有服务。

启动器维护专项 `electron-smoke/d8b82912-818e-4301-bf45-60c357a64dc1/report.json` 通过。填充索引后，独立原生搜索可能仍处于查询中；探针等待所需的可执行命令行就绪，继续验证维护拒绝、恢复与业务错误保留。

七个插件分别由上表的业务探针、Node/浏览器边界回归和安装应用集成检查覆盖。结果只证明列出的场景，不能宣称每个按钮、文件格式、硬件组合或外部服务都已完成验收。

## 运行方式

在 Git Bash 执行 `source scripts/use-toolchain.sh` 后，依次运行现有检查；重型检查串行。

- `pnpm typecheck`、`pnpm lint`、`pnpm fmt --check`、`pnpm test`、`pnpm test:ui`。
- `pnpm dist:win --publish never` 生成 NSIS 和目录包。
- PowerShell 7 执行 `scripts/verify-windows-installer.ps1 -Installer <安装包路径> -PluginBusiness`，同时验收已安装目录中的独立插件包。遇到已有安装或运行中的 spark233 会拒绝，避免安装器影响用户工作。
- 选定 Electron 执行 `scripts/verify-plugin-business.cjs`；环境变量 `SPARK233_ACCEPTANCE_NODE` 指向选定的 Windows `node.exe`；`SPARK233_ACCEPTANCE_PACKAGE_DIR` 可指定待验收包目录，默认 `dist-plugins`，安装探针使用已安装应用的 `resources/plugins`。
- 选定 Electron 执行 `scripts/native-search/production-smoke.cjs`；PATH 需包含 PowerShell 7。
- 选定 Electron 执行 `scripts/native-search/verify-service.cjs`：干净机器走真实安装/验证/卸载；已有服务使用 `--use-existing` 做只读验收，明确需要升级时使用 `--upgrade-existing`，由产品助手执行 UAC 并保留升级后的服务。
- `node scripts/native-clipboard/probe-service.mjs` 使用私有窗口站和实际服务；可用 `SPARK233_CLIPBOARD_BOUNDARY` 指定已构建 boundary。隔离失败直接失败，不回退到交互剪贴板。

本地最终安装包 SHA-256：`244EEF8CE3E0EDB702463222BE094102C7579E421EDD1A64FCAF63C3AD432950`。目录包完整冒烟 `electron-smoke/35e5c4ce-5f47-4665-9e60-127e06a1467f/report.json` 通过（exit 0，92.257 秒）。

## 仍需实机配合

| 项目         | 当前条件与验收步骤                                                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 多屏         | 系统仅枚举 DISPLAY1，1920×1080。连接第二屏，覆盖不同 DPI、负坐标、跨屏拖动、移除副屏后的窗口恢复和全屏避让；记录两屏边界/DPI与实际窗口位置。单屏模拟不能代替。                                                   |
| 物理 IME     | 使用真实键盘和 Windows 中文输入法，在启动器输入拼音、选词、退格、切换中英文；组合期间不得执行结果或提前失焦，确认后查询正常。浏览器合成组合事件只能证明逻辑。                                                    |
| 真实注销     | 先保存其他应用工作。打开本应用未保存笔记和插件草稿，触发真实 Windows 注销；拒绝/超时保存须取消退出并保持业务进程；允许保存后完成注销，再登录检查持久化及日志。不能用模拟 WM 消息替代，也不自动注销当前用户桌面。 |
| 实际 AI 翻译 | 在产品设置中配置服务后验证真实请求、流式响应、取消、历史和失败恢复；不从用户其他配置读取密钥，不以本地 mock 结果充当外部服务成功。                                                                               |

## 远程 CI

验证分支为 `codex/optimization-validation-20261028`。独立 Git index 与快照提交不改变用户工作分支和真实暂存区。

首轮快照 `ce1d7e1998314d92f0c398452bb2ba09a6e24d51` 的检查 `40659172983`、安装构建 `40659179021` 失败，后续复跑继续定位环境差异，修复如下：

- Windows TEMP 的 8.3 短路径与长路径身份不一致：现存路径使用 `fs.realpathSync.native`；备份根和相对目录计算使用一致的规范身份，未放宽链接或越界保护。
- 英文 Windows 的系统 `tar.exe` 解压 Git archive 后中文文件名不一致：适配层改用仓库已安装的 `tar` 包解压，并给嵌入语言资源提供 ASCII 别名，保留资源 ID 和 JSON 原字节。`/c65001` 保留用于资源文本解码，单独添加该标志不能解决解压文件名问题。本机全新适配、载荷哈希比较及实际 RC 编译/链接通过。
- 浏览器用例使用当前 Vitest 支持的定位和文本轮询 API；计数断言覆盖带总数及选中数量的实际文案。
- 干净资源准备在组装插件前缺少宿主 UI 契约：准备脚本在 SDK 之后调用已有 `build:assets`，由其先执行 Vite，再组装插件及 Electron 资源。

源码快照 `aac62a9888dbefc544d8396ca8f9fef8f71bc489`：Electron Checks `40667161289` 与 Electron Windows Installer `40667167100` 均已成功完成，远程干净环境的检查、原生资源准备、测试与 NSIS 构建通过。此前包含 Unicode 解压修复的运行 `40665606493` 已编译通过原生资源，并在缺失 UI 契约处失败；相关顺序问题纳入本次快照。

远程产物 `spark233-installer-x64` 已下载至 `local-build/optimization-followup/remote-installer-40667167100/spark233-1.2.0-x64.exe`，ZIP 完整性检查通过。安装包 SHA-256：`3AF1323971A122746B9D48FE05D422AADFC18FAE4D73901E5E44BED56E8C39B4`。

| 远程产物本机验收 | 实际结果与证据                                                                                                                                                                   |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NSIS 完整流程    | `installer-acceptance/2f168492-13de-4ebe-9a6e-e675998070e8/report.json`，`ok: true`；安装与登记、已安装应用冒烟、安装目录插件业务、卸载、默认文件关联保持，共五项通过。          |
| 已安装应用       | `electron-smoke/be6ee151-e4fd-4399-b354-fc1c7ba2d82f/report.json`，`ok: true`；进程退出码 0，73.194 秒，无超时。                                                                 |
| 安装目录插件业务 | `evidence/plugin-business/66bbfac7-f326-4601-9b9b-12d59fd435d6/report.json`，`ok: true`；11 项检查通过，包含离线词典、设置持久化、受控剪贴板数据、真实程序启动与参数、原生 OCR。 |

插件业务探针校验已安装 `resources/plugins` 内归档的 SHA-512，并记录包版本；实际 OCR 输出为 `SPARK233 HELLO WORLD`。探针使用本地选定 Electron 和已构建宿主适配器运行安装包内插件；已安装宿主本身由上表的集成冒烟验证。此处没有调用外部 AI 服务，也没有访问用户交互剪贴板。安装流程主动跳过服务提权，UAC/SYSTEM 验收使用前文独立服务报告。

工作区后续并行变更不自动继承上述快照或安装包的验收结果；本地报告也只能证明其记录的版本与哈希。

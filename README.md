# spark233

基于 floral-notepaper 演进的 Windows 桌面启动器与插件工具集，使用 **Electron 45 + TypeScript + React 19 + Vite 8**，目标平台为 **Windows 11 x64**。MVP 已完成本轮实现与逐项证据审计，最后人工验收待安排；界面语言为简体中文和英文。

默认入口为 uTools 式启动器，使用 Rubick 式关键词与插件模式、React + shadcn/ui 和竹绿色主题。首次展示启动器引导，不自动新建空便签；后续启动恢复便签布局并驻留托盘，默认 `Alt+Space` 呼出启动器，新建便签是独立命令。

七个官方业务插件为便签、截图、OCR、词典与翻译、剪贴板、应用搜索、文件与正文搜索；按独立 npm 包组织、默认启用，按需启动后台，剪贴板从启动起记录。插件管理支持官方离线目录选择、registry、本地 `.tgz` 和预构建开发目录导入，经过版本与能力确认后安装，支持启停及卸载；开发目录以审阅时的固定快照运行。更新自动检查，由用户确认安装。第三方 Node/native 后台需显式信任，拥有当前用户权限；纯原生扩展使用[宿主管理协议](Docs/native-plugin-protocol.md)。npm scope 尚待账号归属确认，尚未执行真实 npm 发布。

截图与 OCR 使用 ScreenCapture + ImageReader，查词使用离线 ECDICT 基础词库；AI 翻译需主动执行并配置 OpenAI 兼容服务。应用搜索接入拼音匹配，文件搜索沿用 Pulse 文件名服务与 Instant 按需正文模式，服务安装需 Windows 管理员授权。剪贴板参考 QcClip，包含多格式历史、收藏标签、编辑、批量合并、图库、便捷小窗与主动清理；一致备份恢复由宿主协调。

架构与完整一期范围见 [架构设计](Docs/launcher-architecture.md)，当前实现及证据边界见 [实施清单](Docs/launcher-todo.md)。技术栈、插件底座、业务链路、Windows 目录包与 NSIS 已完成本轮自动检查，固定样本正文/附件保留及七插件不可用网络代表链通过。安装包约 200.33 MiB，应用目录加首启展开插件的代码文件约 614.79 MiB，用户数据与索引另计；精确散列和口径见[分发记录](Docs/evidence/spark233-packaging.md)。真实界面/IME/多屏、截图标注、剪贴板回贴、UAC/SYSTEM 搜索服务与全卷、干净 Windows 物理断网首装仍待最后人工验收；当前安装器未签名、未执行。MVP 复用现有门禁与少量代表链路，没有新增大规模测试套件。

保留便签列表、分类、Markdown/文本磁贴、图片、主题与背景设置，使用原有文本编辑器和 Markdown 预览组件。正文仍是独立 `.md` 文件，图片仍存放在 `images/`；桌面 API 通过受限预加载桥接调用主进程。

纸片默认普通浮动，可单张置顶。原关闭按钮现为折叠按钮（Ctrl+W）：先保存，再折叠成左侧、右侧或顶部贴边胶囊并释放编辑窗口。左右队列纵向排列，顶部队列横向排列、首次默认居中，可拖到顶部或通过胶囊右键“移到顶部”停靠。胶囊支持拖离悬浮、跨屏换边和重排，主胶囊可整队收放、沿边调整位置和整队迁移；顶部溢出时横向滚动，主胶囊固定可用。悬停预览不抢焦点，顶部预览向下展开，点击恢复便签；展开后保留边缘入口。真正隐藏便签使用右键菜单“隐藏到托盘”，可从托盘找回。退出前保存所有编辑器，保存失败则取消关闭。不会提前创建隐藏窗口池。

便签管理窗口为“便签列表”，与桌面便签使用相同 ID 和 `.md` 正文。右键列表中的便签，选择“贴到桌面”即可打开当前样式的桌面窗口；重复操作会找回现有窗口并保留其显示模式。列表中正在编辑的目标会先保存，保存失败时不打开旧内容。两处保存后的更新会同步到未修改的窗口，正在输入或保存失败的内容不会被自动刷新覆盖。

便签小窗默认文本模式，可直接输入 Markdown 源码并粘贴截图；右上角切换「MD / 文本」，MD 模式显示图片、排版和可勾选的待办。标题输入框位于左上角，最多输入 12 个字。每张便签独立记忆选择，磁贴与胶囊预览跟随。主窗口只保留「编辑 / 分栏」：编辑显示源码，分栏为左侧源码与右侧实时预览，支持调整宽度和双向同步滚动。正文仍保存为 `.md`，切换模式本身不会重写正文。

列表会标记置顶和桌面状态。置顶便签排在原分类内最前面，列表与桌面窗口的置顶操作互相同步；列表置顶不会自动打开窗口，之后贴到桌面时自动置顶。

便签支持定时提醒。主窗口编辑区、桌面便签小窗和磁贴右上角的铃铛可设置、修改或取消整张便签的提醒，提供预设（15/30/60/180 分钟、当天 18:00、次日 9:00）和自定义分钟；列表右键「设置提醒」与纸片菜单也可快捷设置，列表行显示 ⏰ 剩余时间徽章。原有任务级提醒保留，可在便签提醒面板查看和取消。到期弹托盘通知，点击定位便签并滚动高亮对应任务行（任务文本被改写时退化为仅打开便签）。提醒存于数据目录 `reminders.json`，重启后补发过期提醒（迟超一天的静默丢弃），便签删除时级联取消。

图片增强：尺寸语法 `![](images/xx/yy.png){width=75%}`（也支持 `{width=600px}`，写在路径括号外，不影响图片清理与导出）；粘贴/拖入的大图自动压缩（超过 8MB 或长边超 2048 时降采样重编码，GIF/SVG/BMP 与窗口级拖入除外）；预览图片显示三档设置（直接显示 / 点击加载 / 不显示）。

命令行快捷指令：`--new`（新建便签）、`--show` / `--hide` / `--toggle`（显示/隐藏全部含胶囊）、`--list`（打开便签列表）、`--exit`（保存后退出）。已运行时经单实例通道秒级转发，未运行时先启动再执行；带指令的二次启动不再强制弹出主窗口，文件参数打开行为不变，可接 Stream Deck / PowerShell 等启动器。

内置本地 MCP 接口（默认关闭）：设置中开启并选择权限（只读 / 追加写入 / 完全控制）后，AI 客户端以 `<安装路径> --mcp` 接入，可列出、搜索、读写便签与设置提醒；未运行时自动拉起主应用。通信为本机命名管道 + 随机 token 双重校验，详见 [MCP 接入说明](Docs/mcp.md)。

## 开发

项目开发环境固定为 **Node.js 26.12.1 / npm 12.2.1**，版本分别记录在 `.node-version` 和 `package.json`，CI 使用相同版本。Electron 内嵌 Node 24 与开发工具链分开管理，主进程类型仍匹配其实际运行时。

Windows 已准备项目专用便携运行时时，在 PowerShell 中执行 `. ./scripts/use-toolchain.ps1` 为当前终端选择工具链，再运行下述 npm 命令；脚本不会替换全局 Node。便携版位于 `%LOCALAPPDATA%/spark233/toolchains/node-v26.12.1-win-x64`，也可自行安装 `.node-version` 对应的官方 Node 并使用 npm 12.2.1。

源代码也可保留在 WSL；Windows GUI 运行及打包仍应使用 Windows Node/Electron。不要在 Windows 和 Linux 之间共用同一个 `node_modules`。源代码放在 WSL 时，可从 Windows PowerShell 执行 `scripts/build-windows-local.ps1 -Installer`，脚本使用独立 Windows 构建缓存，并把产物复制回仓库。Windows 沙箱子进程不支持本机测试中的 WSL UNC 可执行文件路径，运行应用时请复制整个 win-unpacked 到 C:/D: 本地目录，或使用安装包。

```sh
npm ci
npm run dev
```

`dev` 会安装匹配平台的 Electron 运行时，编译主进程/预加载并启动 Vite 和 Electron。修改 React 界面会热更新；修改 `electron/` 后重启 `npm run dev`。

```sh
npm run typecheck
npm run lint
npm test
npm run build
npm start
```

`dev:web` / `preview` 只服务前端资源，桌面功能需要 Electron 预加载桥接。常规构建不访问 GitHub；贡献者名单可选执行 `npm run contributors:update` 更新。

## Windows 构建

```sh
npm run pack:win  # release-electron/win-unpacked/，整个目录一起分发
npm run dist:win  # release-electron/ 下的 NSIS 安装包
```

应用名和安装包身份为 `spark233` / `com.spark233.desktop`，整体使用新身份，不提供旧版花笺别名、自动发现或自动迁移。未配置数字签名；上游 Tauri 更新和 Mirror酱入口已停用。插件更新独立管理，自动检查后由用户确认安装；开机启动仅在安装后的版本中设置。

`npm run build` 同时组装七个离线插件到 `dist-plugins/`，打包时放入 ASAR 外的 `resources/plugins/`；单个插件的完整构建见 [官方插件构建说明](packages/official/README.md)。源码目录直接 `npm pack` 不会准备完整原生、词库和渲染资源。缺少原生资源时，构建入口会调用对应 Windows C++ 构建链；这些要求只针对开发者，用户端不运行 npm 安装脚本或临时编译。当前完整离线安装包及首启展开插件的文件字节已实测，详见[分发记录](Docs/evidence/spark233-packaging.md)；规划预算和 `.tgz` 合计不代表安装占用，用户数据、缓存、索引及服务副本另计。

## 数据与验证

- 默认配置根：`%APPDATA%/spark233/`；宿主配置为 `host/config.json`，首次引导状态为 `host/launcher.json`。
- 默认便签数据：`文档/spark233`；后续使用 spark233 配置中保存的 `dataDir`。
- 正文与元数据：`notes/<分类>/<id>_<标题>.md`、`metadata.json`；图片与背景：`images/`、`backgrounds/`。
- Electron 窗口布局：数据目录中的 `electron-layout.json`；Chromium profile 独立于正文数据。
- 插件精确版本、状态、业务数据及缓存位于配置根的 `plugins/`，Chromium profile 位于 `electron-profile/`。一致备份覆盖宿主配置、插件状态和便签/插件业务数据，恢复前保留当前数据副本。
- 首次启动展示启动器引导，不自动创建便签；之后恢复显隐、位置、纸片/编辑模式和置顶状态并驻留托盘。
- 测试或并行开发请设置独立 `SPARK233_CONFIG_DIR` / `SPARK233_DATA_DIR`，全部样本与 profile 放在 `local-build/` 或明确的临时目录。Windows smoke 还需 `SPARK233_SMOKE=1` 显式启用；可复用 `pwsh -File scripts/smoke-windows.ps1`。不得使用真实便签或剪贴板历史。
- 删除便签使用系统回收站，保留图片以便恢复正文；删除分类将笔记移到未分类。迁移数据目录采用复制后切换配置，保留来源副本供恢复。

迁移范围、实现细节和验证记录见 [Electron 迁移说明](Docs/electron-migration.md)，剩余验收项见 [TODO](Docs/electron-todo.md)。胶囊交互、Windows 全屏适配与验证边界见 [胶囊说明](Docs/edge-capsules.md)。胶囊原生拖动、多屏混合 DPI 和真实全屏应用仍需手动验收。

`src-tauri/`、`scripts/legacy-tauri/`、`.github/legacy-tauri/` 仅为历史参考，不参与现行开发、构建或发布。原项目文档已归档到 `Docs/upstream/`。

基于 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)，遵循 [MIT](LICENSE)；保留原项目、字体及第三方许可证声明。

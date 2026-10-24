# 花笺 · Electron 迁移版

在 floral-notepaper 原项目上将 Tauri/Rust 桌面后端迁移为 **Electron 45 + TypeScript + React 19 + Vite 8**。首版目标是 **Windows 11 x64**。

保留便签列表、分类、Markdown/文本磁贴、图片、主题与背景设置，使用原有文本编辑器和 Markdown 预览组件。正文仍是独立 `.md` 文件，图片仍存放在 `images/`；桌面 API 通过受限预加载桥接调用主进程。

纸片默认普通浮动，可单张置顶。原关闭按钮现为折叠按钮（Ctrl+W）：先保存，再折叠成左侧、右侧或顶部贴边胶囊并释放编辑窗口。左右队列纵向排列，顶部队列横向排列、首次默认居中，可拖到顶部或通过胶囊右键“移到顶部”停靠。胶囊支持拖离悬浮、跨屏换边和重排，主胶囊可整队收放、沿边调整位置和整队迁移；顶部溢出时横向滚动，主胶囊固定可用。悬停预览不抢焦点，顶部预览向下展开，点击恢复便签；展开后保留边缘入口。真正隐藏便签使用右键菜单“隐藏到托盘”，可从托盘找回。退出前保存所有编辑器，保存失败则取消关闭。不会提前创建隐藏窗口池。

主窗口统一为“便签列表”，与桌面便签使用相同 ID 和 `.md` 正文。右键列表中的便签，选择“贴到桌面”即可打开当前样式的桌面窗口；重复操作会找回现有窗口并保留其显示模式。列表中正在编辑的目标会先保存，保存失败时不打开旧内容。两处保存后的更新会同步到未修改的窗口，正在输入或保存失败的内容不会被自动刷新覆盖。

便签小窗默认文本模式，可直接输入 Markdown 源码并粘贴截图；右上角切换「MD / 文本」，MD 模式显示图片、排版和可勾选的待办。标题输入框位于左上角，最多输入 12 个字。每张便签独立记忆选择，磁贴与胶囊预览跟随。主窗口只保留「编辑 / 分栏」：编辑显示源码，分栏为左侧源码与右侧实时预览，支持调整宽度和双向同步滚动。正文仍保存为 `.md`，切换模式本身不会重写正文。

列表会标记置顶和桌面状态。置顶便签排在原分类内最前面，列表与桌面窗口的置顶操作互相同步；列表置顶不会自动打开窗口，之后贴到桌面时自动置顶。

便签支持定时提醒。主窗口编辑区、桌面便签小窗和磁贴右上角的铃铛可设置、修改或取消整张便签的提醒，提供预设（15/30/60/180 分钟、当天 18:00、次日 9:00）和自定义分钟；列表右键「设置提醒」与纸片菜单也可快捷设置，列表行显示 ⏰ 剩余时间徽章。原有任务级提醒保留，可在便签提醒面板查看和取消。到期弹托盘通知，点击定位便签并滚动高亮对应任务行（任务文本被改写时退化为仅打开便签）。提醒存于数据目录 `reminders.json`，重启后补发过期提醒（迟超一天的静默丢弃），便签删除时级联取消。

图片增强：尺寸语法 `![](images/xx/yy.png){width=75%}`（也支持 `{width=600px}`，写在路径括号外，不影响图片清理与导出）；粘贴/拖入的大图自动压缩（超过 8MB 或长边超 2048 时降采样重编码，GIF/SVG/BMP 与窗口级拖入除外）；预览图片显示三档设置（直接显示 / 点击加载 / 不显示）。

## 开发

建议在 Windows 本地工作目录使用 **Node.js 24 LTS**。源代码也可保留在 WSL；Windows GUI 运行及打包仍应使用 Windows Node/Electron。不要在 Windows 和 Linux 之间共用同一个 `node_modules`。源代码放在 WSL 时，可从 Windows PowerShell 执行 `scripts/build-windows-local.ps1 -Installer`，脚本使用独立 Windows 构建缓存，并把产物复制回仓库。Windows 沙箱子进程不支持本机测试中的 WSL UNC 可执行文件路径，运行应用时请复制整个 win-unpacked 到 C:/D: 本地目录，或使用安装包。

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

安装包身份为 `com.floral-notepaper.electron`，与上游安装包分开。未配置数字签名；自动更新和 Mirror酱入口已停用，不会下载安装上游 Tauri 包。开机启动仅在安装后的版本中设置。

## 数据与验证

- 默认配置：`%APPDATA%/floral-notepaper/config.json`，兼容当前上游配置字段。
- 默认数据：`文档/花笺`，优先沿用已有配置的 `dataDir`（兼容 `notesDir`）。
- 正文与元数据：`notes/<分类>/<id>_<标题>.md`、`metadata.json`；图片与背景：`images/`、`backgrounds/`。
- Electron 窗口布局：数据目录中的 `electron-layout.json`；Chromium profile 独立于正文数据。
- 首次启动且没有已有笔记时新建一张空白便签；之后恢复显隐、位置、纸片/编辑模式和置顶状态。
- 测试或并行开发请设置独立 `FLORAL_NOTEPAPER_CONFIG_DIR` / `FLORAL_NOTEPAPER_DATA_DIR`。不要让新旧后端同时写同一份数据，切换前备份整个数据目录。
- 删除便签使用系统回收站，保留图片以便恢复正文；删除分类将笔记移到未分类。迁移数据目录采用复制后切换配置，保留来源副本供恢复。

迁移范围、实现细节和验证记录见 [Electron 迁移说明](Docs/electron-migration.md)，剩余验收项见 [TODO](Docs/electron-todo.md)。胶囊交互、Windows 全屏适配与验证边界见 [胶囊说明](Docs/edge-capsules.md)。胶囊原生拖动、多屏混合 DPI 和真实全屏应用仍需手动验收。

`src-tauri/`、`scripts/legacy-tauri/`、`.github/legacy-tauri/` 仅为历史参考，不参与现行开发、构建或发布。原项目文档已归档到 `Docs/upstream/`。

基于 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)，遵循 [MIT](LICENSE)；保留原项目、字体及第三方许可证声明。

# 花笺 · Electron 迁移版

在 floral-notepaper 原项目上将 Tauri/Rust 桌面后端迁移为 **Electron 45 + TypeScript + React 19 + Vite 8**。首版目标是 **Windows 11 x64**。

保留原界面、笔记管理、分类、源码编辑、Markdown/纯文本磁贴、图片、主题与背景设置。正文仍是独立 `.md` 文件，图片仍存放在 `images/`；桌面 API 通过受限预加载桥接调用主进程。

纸片默认普通浮动，可单张置顶。点击 × 时先保存，再隐藏便签并销毁对应窗口；在托盘“找回便签”中重开，恢复内容和窗口位置。退出前保存所有编辑器，保存失败则取消关闭。不会提前创建隐藏窗口池。

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

迁移范围、实现细节和验证记录见 [Electron 迁移说明](Docs/electron-migration.md)，剩余验收项见 [TODO](Docs/electron-todo.md)。边缘胶囊、无焦点悬停预览和标题栏折叠属于后续便签交互，尚未实现。

`src-tauri/`、`scripts/legacy-tauri/`、`.github/legacy-tauri/` 仅为历史参考，不参与现行开发、构建或发布。原项目文档已归档到 `Docs/upstream/`。

基于 [Achilng/floral-notepaper](https://github.com/Achilng/floral-notepaper)，遵循 [MIT](LICENSE)；保留原项目、字体及第三方许可证声明。

# Electron 框架迁移

## 决策与范围

直接修改 floral-notepaper 原仓库，保留 React UI 和当前 Markdown 数据协议，将桌面运行时改成 Electron。首版只面向 Windows 11 x64，前端开发者可用 TypeScript 维护桌面业务。用户已确认停用上游 Tauri 自动更新/Mirror酱入口，待独立发布地址确定后重接。

本次完成框架和已有本地功能迁移；标题栏折叠、边缘胶囊和不抢焦点的悬停预览属于后续功能，不把上游“磁贴”当作这些交互已经实现的证明。

## 运行边界

```text
React / Markdown / 编辑器
        ↓ src/platform/desktop.ts
contextBridge（sandbox + contextIsolation）
        ↓ 固定 IPC 通道，主框架来源校验、命令白名单
Electron main
  ├─ NoteStore：Markdown / 元数据 / 分类 / 图片 / 配置
  ├─ BrowserWindow：纸片、管理窗口、位置与显隐恢复
  ├─ Tray / globalShortcut / dialog / clipboard / shell
  └─ floral://：前端资源和授权本地图片
```

渲染进程没有 Node/require/fs/ipcRenderer。主进程校验消息来自本应用顶层 frame；外部导航、新窗口和 webview 均禁止。外部链接只允许 HTTP/HTTPS，通过系统浏览器打开。

外部文件读写必须来自原生对话框、真实拖放 File 或命令行文件参数授权。图片资源只允许数据目录中的 images/backgrounds 或已有配置背景；路径同时检查规范化结果与真实文件系统祖先，拒绝 `..`、符号链接/目录联接逃逸。新增背景路径不能靠修改配置绕过图片目录限制。

复用现有 Markdown sanitize 链。CSP 限制脚本、资源和连接来源，明确允许 `floral://asset` 图片；不关闭 webSecurity，不使用 `--no-sandbox` 或关闭 Chromium 安全隔离。

## 桌面行为

| 原 Tauri 功能      | Electron 实现                                                                                                                      |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Rust invoke 命令   | 主进程白名单派发；错误统一返回 code/message/details                                                                                |
| 多窗口与原生控制   | BrowserWindow；主窗口使用 app-region 原生标题拖动，纸片编辑标题亦使用原生拖动区域；磁贴正文拖动/自定义缩放握柄使用 pointer capture |
| Markdown 与元数据  | Node fs；临时文件写入、fsync 后 rename；主进程串行化存储读改写                                                                     |
| 窗口池             | 取消启动预热和空白池；保存确认后直接销毁关闭的窗口                                                                                 |
| 关闭/退出          | 请求各编辑器完成保存；成功后才回收/退出；失败或超时保留窗口                                                                        |
| 托盘找回           | 托盘列出已保存便签，点击重开；内容、位置、显示模式和置顶状态独立于窗口                                                             |
| 全局快捷键         | Electron globalShortcut；录制时临时注销应用快捷键，使用窗口键盘事件                                                                |
| 对话框/剪贴板/外链 | Electron dialog / clipboard / shell，通过 preload 桥接                                                                             |
| 开机启动           | 已安装版本使用 setLoginItemSettings；开发版本禁止将原始 Electron 注册为启动项                                                      |
| 文件关联/单实例    | 安装包注册 md/markdown/txt 能力；同一 profile 的第二实例将文件参数交给第一实例                                                     |
| 更新与旧发布链     | 显式停用；旧工作流移出 workflows，保留历史参考                                                                                     |

窗口坐标统一使用 Electron DIP；不再把 Tauri PhysicalPosition 的物理坐标直接搬过来。恢复时将窗口限制在当前可用屏幕工作区内，避免卸掉显示器后无法找回。

纸片默认非置顶，可逐张切换“置顶”。本轮胶囊扩展将原关闭按钮改为“折叠成胶囊”，隐藏移到右键菜单；删除是独立操作。详见 [胶囊说明](edge-capsules.md)。应用没有展开窗口数量硬限制；通常展开 3–5 张，其余折叠后使用共用边缘胶囊窗口，正文只保留磁盘数据与布局描述，不能据此承诺 20 张全部展开时的内存。快捷键临时隐藏当前窗口不会清空编辑器状态。

关闭后重开会新建编辑器，撤销栈不跨窗口销毁保留。同一窗口的编辑/磁贴切换保留 React 正文状态；浏览器原生撤销栈跨编辑 DOM 卸载的保留仍需专门验收。

## Windows GPU 启动适配

本机 AMD Radeon 780M（驱动 32.0.13032.11）的 D3D11 初始化在进程继承 WSL UNC 工作目录时会抛出未处理 C++ 异常，随后以 `0xC0000409 / FAST_FAIL_FATAL_APP_EXIT` 退出。原生调试器栈定位到 `amdxx64.dll`；Electron 44 对比也可复现。中文 exe 名、ASAR 开关、D3D11/GL 后端和视频加速开关均不能单独消除问题。

同一份 exe 只把 WorkingDirectory 改成 `C:\Windows` 后，功能检查通过且 GPU stderr 归零。`apps/desktop/electron/windows-runtime.ts` 因此在 Windows 启动阶段将进程工作目录切到本地 Electron 可执行文件所在目录。所有业务存储仍通过明确的绝对路径管理。

GPU 硬件加速保持开启；不关闭 GPU sandbox，不使用 `--no-sandbox`，不更改系统显卡设置或驱动。运行探针同时检查 GPU 崩溃次数、`gpu_compositing=enabled` 与沙箱开关，避免把软件回退时“界面能打开”当作修复证明。

## 数据兼容与恢复

兼容当前 1.2.0 的 `config.json`、`metadata.json`、`notes/<分类>/*.md` 与 `images/<noteId>/`。保留 noteId、createdAt、正文原文和图片相对路径；正文不转换成 SQLite 或编辑器私有格式。

配置优先读取 `%APPDATA%/floral-notepaper/config.json` 中的 dataDir，兼容 notesDir；未配置时使用“文档/花笺”。测试覆盖当前上游格式；没有承诺覆盖所有历史版本自定义目录的自动搬迁。旧版特殊目录应先备份再明确导入。

metadata 损坏时先备份，再从 Markdown 文件重建。损坏的配置不会静默覆盖。正文写入成功但元数据提交失败仍向 UI 报错，取消关闭；不要把单个文件的原子替换误认为多文件数据库事务。

删除便签调用系统回收站，图片保留用于恢复；删除分类把正文移至未分类。数据目录迁移先复制 notes/images/backgrounds/metadata/布局，再切换配置，来源副本保留，拒绝新旧目录互相包含或覆盖非空目标。

新旧应用没有共享跨语言进程锁，不能同时写同一数据目录。真实使用前备份整个目录；本轮运行检查全部使用隔离目录，没有读取或修改用户真实便签。

## 依赖选择

- `electron@45.0.0`：替换 Tauri 的实际桌面运行时；已装 React/Vite 不提供原生窗口、托盘、文件对话框或主进程隔离。官方 Electron 项目持续维护，版本沿用本机前序实测版本。
- `electron-builder@26.15.3`：生成 Windows 应用目录和 NSIS；已有 Tauri/MSIX 脚本不适用于 Electron。采用正在维护的 electron-userland 项目，本轮核对 npm 发布元数据和安装包实现。
- `@types/node@24`：主进程类型检查，与开发 Node 24 对齐。

React、Tailwind、Markdown、KaTeX、i18next、现有 UI 控件均复用。不新装编辑器、组件库、状态库或数据库。前端库随 Vite 编译，放在 devDependencies；主进程只使用 Node/Electron 内置 API，发布包不携带开发 node_modules。

原插件、Tauri CLI 和 Rust 构建依赖已从 npm 入口移除。当前仓库已移除 `src-tauri/`；历史材料保存在 `Docs/upstream/`，现行命令不需要 Rust。

## 验证与运行限制

2026-10-23 本机验证：

- `pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`。
- Vitest：24 个文件、100 项测试通过。新增用例只覆盖真实持久化与路径信任边界；旧更新面板的 305 行交互测试随停用逻辑移除，沿用现有 runner。
- Windows 11 原生 Electron 及 ASAR 打包版：中文 Markdown 读写、关闭前立即修改保存、回收 renderer 后重开、窗口程序化移动、1×1 本地 PNG 解码、拒绝未授权读取与资源越界均通过。
- 真实文件系统写入失败：保留窗口和未保存正文，关闭被拒绝。不是只用 mock 模拟的成功链路。
- GPU 修复后两轮专门复测与最终验收均从 UNC 工作目录启动，硬件合成 enabled、GPU 崩溃 0、沙箱启用，stderr 均为空。检查证据见 `Docs/evidence/electron-windows-smoke.json`；脚本可用 `scripts/smoke-windows.ps1` 在独立目录复跑。

当前会话 Windows Computer Use 启动失败，报错 `sandboxCwd is not a local file URI`。因此上述运行证据来自 Electron 自身 API 与实际 renderer/文件系统，不能视为鼠标拖动、系统托盘点击、IME 候选窗或多屏 DPI 的人工交互验收。具体待办见 electron-todo.md。

本机 WSL 没有 Wine，不能直接完成跨平台 NSIS 全流程；Windows 构建器在本会话通过 PowerShell 扫描 npm 依赖也遇到空输出。最终应用目录由 Windows electron-builder 生成；临时验证构建目录使用其内置 traversal 收集模式，随后用官方 `--prepackaged` 方式生成 NSIS，没有修改框架或依赖源码。发布运行代码只使用 Node/Electron 内置模块。

普通 Windows/CI 构建入口已配置，远程 CI 尚未运行。`scripts/build-windows-local.ps1 -Installer` 提供独立 Windows 缓存构建与产物复制逻辑，避免混用 node_modules；两个 PowerShell 辅助脚本通过了 Windows 语法解析，完整辅助构建流程仍待在干净 Windows 环境验收。构建摘要及产物 SHA-256 见 `Docs/evidence/electron-build-manifest.json`。

直接从 `\\wsl.localhost` 启动打包后的 exe 会在本机触发 Chromium 子进程 `launch-failed` / GPU error_code=18，不能靠关闭沙箱规避；应复制完整应用目录到 Windows 本地路径再运行，或安装 NSIS 包。本轮开发态运行使用 Windows 本地 Electron 运行时。

本次没有重新完成 3/5/20 张真实应用的内存基准；不能直接引用前序最小演示程序的数字作为迁移后的实测结果。回收策略已有实际窗口销毁证据，资源占用仍应按最终界面复测。

## 开发与产物

入口、命令和数据目录见根 README。构建产物位于 `release-electron/`；未签名，尚未执行安装/卸载验收和正式发布。常规开发命令会显式执行 Electron 45 的运行时安装入口，避免 npm ci 后运行时尚未下载的问题。

官方参考：

- [Electron 安全边界](https://www.electronjs.org/docs/latest/tutorial/security)
- [Electron 自定义协议](https://www.electronjs.org/docs/latest/api/protocol)
- [Electron 可拖动区域](https://www.electronjs.org/docs/latest/tutorial/custom-window-interactions)
- [electron-builder NSIS](https://www.electron.build/nsis.html)

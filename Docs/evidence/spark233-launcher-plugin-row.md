# 插件入口横向展示与 Lucide 图标

日期：2026-10-27。用户在上一轮设置与启动器交付后，追加要求插件入口也放入横向区，并先使用项目已有的 `lucide-react` 展示插件图标。本记录是新输入，不改写上一份 ZIP 的内容或验证身份。

## 修改范围

- 横向区同时展示宿主返回的应用结果和插件命令/模式入口，保留原排序、不可用固定入口、模式进入及执行检查。文件、目录、词典释义和其他信息结果留在纵向区，不重复展示。
- 七个官方插件使用语义图标：应用 AppWindow、剪贴板 ClipboardList、便签 StickyNote、翻译 Languages、搜索 Search、截图 ScanLine、OCR ScanText；其他插件使用 Puzzle。映射集中在 `src/features/plugins/PluginIcon.tsx`，不接受插件提供的任意 SVG 代码，不新增依赖。
- 插件管理列表与详情复用同一图标映射；实际应用仍优先展示其原生 PNG 图标，缺失时使用 AppWindow。
- 本次改变启动器入口呈现，插件打开后的业务工作区保留各自布局。

## 统一验证

使用 Node 26.12.1 / npm 12.2.1：

- `npm test`：53 文件、219 项通过。
- `npm run test:ui`：5 文件、5 项通过。
- `npm run lint`：退出 0，无诊断。
- `npm run build`：退出 0，包含完整 typecheck、Vite、七个插件构建与 Electron 编译/资源复制。

强化既有浏览器用例：验证插件入口同一行的真实几何位置、文件和词典结果在下方纵向排列、图标渲染、Tab 焦点及左右/上下键选择后执行准确目标；现有模式用例验证插件模式入口进入/返回，停用用例验证横向入口仍拒绝旧选择。没有为图标映射逐个增加常量快照用例。

浏览器合成样本截图：`local-build/browser-ui/screenshots/launcher-plugin-row.png`。日志位于 `local-build/spark233/plugin-horizontal-20261027/`。截图已人工查看，非 Windows 实机截图。

## Windows 交付

既有 `scripts/build-windows-local.ps1` Windows 目录包构建退出 0。包内宿主编译模块、全部前端 JS/CSS 与构建结果一致，七个插件包的版本/SRI 检查通过。免安装 ZIP 创建及 7-Zip CRC 检查均退出 0，另核对清单、隔离数据路径及 SHA-256。

- 新 ZIP：`/mnt/c/Users/40417/Downloads/spark233-1.2.0-win-x64-portable-20261027T080426Z.zip`。
- 大小：247,497,663 字节。
- SHA-256：`1e101a806761784217918781da72b3d385eab82238b256bd0b205bd6d153686c`，同名 `.sha256` 文件已生成。
- 日志与源码摘要：`local-build/spark233/windows-plugin-row-20261027T080426Z/`；交付记录：`local-build/spark233/plugin-horizontal-20261027/delivery.json`。

旧的 `20261027T074301Z` ZIP、NSIS 和用户解压目录保留原输入。本次只更新目录包及免安装 ZIP，不重新构建或执行 NSIS，不运行整套烟测。实际 Windows 界面仍由用户手动确认。

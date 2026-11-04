# 常用 uTools 插件兼容：实现与验证

日期：2026-11-03。按用户明确授权实施；计划见 [TODO](../utools-compatibility-todo.md)。本轮未增加框架或第三方依赖，未改用户现有插件安装与业务数据。

## 已实现

宿主 API 升为 1.6.0。兼容包声明独立的 compatibility 元数据，保留原始 payload，导入使用现有有界目录快照/归档校验及插件事务。稳定身份取清单 name、包名或 pluginName，缺失时明确拒绝；内容指纹加入兼容版本，更新不复用代码目录。兼容类型即使没有 preload 也要求完整代码信任。预览不执行第三方代码。

兼容运行器在主入口的单例宿主启动前分派，按需创建独立 Electron 进程，以私有 IPC 和 PID/随机令牌握手。主进程只持有描述、资源句柄和有界选择凭据；第三方 preload 和页面在兼容进程内运行。主搜索通过声明的兼容查询提供方进入同一会话/取消/owner 检查，不根据插件 ID 前缀授予执行能力。

窗口使用共享 WindowTitleBar、Input、Button、主题 CSS 和独立 WebContentsView。支持 ready/enter/out、子输入、后台驻留、旧 window.exports list/none、F12。列表输入带修订号，迟到回调不能覆盖新列表。

Node 自带 SQLite 提供本地持久化。dbStorage 与 db 共享文档，包含 value 包装、_rev 冲突、删除/批量、附件及 db.promises；超过 1 MB 的文档拒写并保留旧值，附件上限 20 MB。正常退出 checkpoint/close。同步系统 API 的等待限制在兼容进程，Electron 45 的异步剪贴板由该进程适配。正则匹配共享一个工作线程并有超时；候选不保存重复的 Base64 图片，选择时重新解析有效句柄。

停机准备阶段只确认和 checkpoint，不提前发送不可逆的 out(true)。原插件没有统一保存确认协议；显示过界面的实例由原生提示要求用户先保存，再允许停止。所有资源同意后才发送最终 out 并退出；恢复准备不会把已关闭事件伪装成可恢复状态。独立进程不是 OS 权限沙箱，Node 插件仍以当前用户权限运行。

## 工程检查

- 全仓 typecheck 与完整 `pnpm build` 通过，仍构建 9 个独立官方插件。
- `pnpm lint` 通过，保留其他已有 warning。
- `CI=1 pnpm test`：81 个文件、332 项全部通过。
- 新增的两个最低层回归覆盖数据/附件持久化、共享文档语义、版本冲突、拒写保留旧值，以及真实目录快照不执行 preload、路径拒绝与安装信任边界。
- 在既有来源/路由用例中增加回归，验证兼容提供方可以收到声明的文件上下文，普通旧 SDK 提供方仍保留原本的参数行为。

日志：`local-build/utools-final-build.log`、`local-build/utools-final-lint.log`、`local-build/utools-final-tests.log`。

## 真实 Electron 代表验证

最终报告：`local-build/utools-validation/runs/1aa03367-ce4a-4b8d-8dd5-c09736f036e1/report.json`。32 项检查通过，report.errors 为 0；令牌重放、主动取消与异常正则的拒绝诊断单独记录为 expectedDiagnostics。

隔离 fixture 经生产 DesktopPluginHost 的目录导入、预览、拒绝缺失信任、确认安装、manager 激活/查询、停用、重新启用、本地重新导入升级和保留数据卸载。重新导入时身份保持、生成不同的不可变代码版本，升级后既有数据库仍在。验证 CommonJS require、window.services、异步 ready 顺序、同步存储、异步附件、子输入、动态功能、mainPush 选择、文件/图片上下文及旧列表模式。异常正则达到约 500 ms 预算后被终止，主进程计时器继续运行；取消的旧查询不能替代新结果。停用后检查实际进程已退出。

最后另外经过真实 LauncherController 验证 mainPush 候选发布、owner 绑定后的选择执行，以及没有输入文字时的文件匹配。发现并修复原 providerContext 只投影来源/窗口协议、没有把文件传给兼容提供方的接线缺口；新分支只对明确声明的兼容提供方开放，旧 SDK 行为有回归保护。

测试使用隐藏窗口。目录选择器固定到隔离样本，停止确认由测试驱动自动接受；这不等于原生选择器和保存确认的人工验收。早期隐藏 WebContentsView 的窗口合成截图曾返回 UnknownVizError，关闭阶段也出现过 Chromium GPU state 提示；这些历史日志没有被算成“GPU 无错误”或真实视频/显示验收。截图尝试不作为原插件画面质量证据，DOM、实际编辑保存和重启恢复分别验证。

## 公开插件样本

两个样本从公开源码构建，安装脚本被禁用，产物及依赖均在 local-build 内；没有修改业务源码。Markdown 的构建目录补入其原始 package.json 和 LICENSE，提供稳定包名。

| 样本                                                                                   | 已验证行为                                                                                                            | 边界                                              |
| -------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [utools-vue3-markdown-editor](https://github.com/wangerzi/utools-vue3-markdown-editor) | 原文件规则匹配隔离 .md；原 Vue 页面加载正文；编辑文本后点击原保存按钮，原 preload 写回隔离文件                        | 未操作真实用户文档；未逐项验证另存为/系统快捷键   |
| [utools-excalidraw](https://github.com/FoundTheWOUT/utools-excalidraw)                 | 原页面和 Canvas 加载；点击原“新增画布”按钮；原 dbStorage 写入可被 db 查询；原 onMainPush 找到画布；进程重启后画布恢复 | AI 平台功能不提供；未穷举绘图、导出和所有图片格式 |

源码归档 SHA-256：

- Excalidraw：`de964325020e1b2e8bde3851bd5c0bdd1c3bb264bfc2b7be93dc2fabccdb85c0`。
- Markdown：`8a77cf0dab7db6f2f9c84d6160d2815d9b30241d6e100f5c11104a8108c6bf4e`。

构建日志在 `local-build/utools-validation/sources/{excalidraw,markdown}-build.log`。样本 UI、数据和测试配置均使用独立 profile；没有访问真实便签、剪贴板历史、现有浏览器 profile 或系统流量历史。最终测试运行器及自有窗口均已退出。

## 真实宿主界面补充验证（22:19—22:41）

按用户“你自己测”的要求，使用已安装的 Playwright 启动正常 runtime 和原始兼容运行器，在独立 `local-build/utools-ui-validation` profile 中完成 28 项功能检查；没有使用真实用户便签、剪贴板历史或修改用户现有插件安装。实际宿主版本与项目一致，为 0.0.1。原项目实例继续运行。

- 设置按钮进入插件市场、目录导入显示真实预览、未确认代码信任时安装按钮禁用，确认后两个公开样本成功安装。
- 启动器搜索并打开白板，点击原版新增画布按钮、重命名，通过鼠标拖动绘制 200 × 140 的矩形。实际数据库保存场景和元素，原版 mainPush 能在启动器搜索到该画布。界面停用结束进程，重新启用后名称和矩形数据恢复，并检查了实际页面截图。
- 未经授权直接传文件路径被宿主拒绝；授权后，空搜索显示原版 Markdown 文件规则。原版页面加载隔离 `.md` 文件，填写中文及英文内容、点击原保存按钮，磁盘正文精确匹配。
- 共享标题栏最大化、还原、隐藏工作正常。完整退出并重启宿主后，已安装的 Markdown 插件仍可通过文件匹配打开，重新加载刚才保存的正文。
- F12 用 Electron `sendInputEvent` 验证，记录了 `before-input-event`、`devtools-opened` 和 `devtools-closed`。CDP keyboard 不经过该原生输入路径，早期仅按 CDP target 数量判断的失败尝试不作为产品故障结论。

最终报告：`local-build/utools-ui-validation/runs/2026-11-03T14-19-09-345Z/final-report.json`。原始 `report.json` 保留了 9 次自动化尝试错误，包括定位歧义、未授权路径、隐藏启动器取消查询和连接尚未就绪的进程；最终流程验证通过，不能把它表述成整个过程零错误。截图包括 `excalidraw-reopened.png`、`markdown-saved.png` 和 `markdown-reopened.png`。进程及记录的调试端口清理结果见同目录 `cleanup.json`。

原生 Windows 自动化服务不可用，本次没有物理点击系统对话框：目录选择在验证入口中返回已知测试目录，停止保存确认由驱动返回“已保存并停止”。隔离配置默认 Alt+Space 与已有程序冲突；重启测试出现 Chromium 磁盘缓存拒绝访问提示。实际加载、编辑和持久化检查通过，不延伸为系统快捷键无冲突、GPU/视频、物理鼠标或 DPI 验收。本轮没有修改业务实现或新增依赖。

## 兼容边界

本轮为 Windows x64、Electron 45.1.0 / Node 24.22.1。uTools 当前官方文档列出的运行时为 Electron 34.5.8 / Node 20.19.1，因此不承诺依赖旧 Electron 行为或原生 .node 的插件直接可用。账号、购买授权、云同步、ubrowser、AI Agent 工具、自定义多窗口与完整窗口匹配不属于首版。

主搜索框内嵌布局、NSIS 安装包内实际分派、物理输入/多屏 DPI 与所有系统 API 的目标机组合仍是独立验收；本轮不把自动化结果扩展成这些检查已经完成。

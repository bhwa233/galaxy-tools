# 快捷搜索与参数化快开实现与验证

日期：2026-11-01，Asia/Hong_Kong。实现目录：`packages/official/quicklinks/`，官方插件 ID：`spark233.quicklinks`，首版 `0.1.0`。

## 已完成的使用路径

- 在启动器输入 `bd 深圳天气`、`gh electron`、`bili 烹饪教程`，选择结果后回车打开。网站名称也可用于发现入口，缺少参数时进入填写界面。
- 管理页支持新增、编辑、启停、删除、网站预设和打开预览。默认配置百度、必应、Google、哔哩哔哩、GitHub、知乎；另有高德地图、GitHub 仓库和 Obsidian 预设。
- URL 模板支持 `{query}` 和命名字段，协议、域名固定，变量逐项 URL 编码。支持 HTTP、HTTPS、vscode、vscode-insiders、obsidian、notion、zotero、mailto。
- 程序使用固定 EXE、可选工作目录与逐项 argv 模板；选择程序复用原生文件对话框，实际启动复用现有应用执行器。
- 快捷入口配置在插件自己的 `dataDir/quicklinks.json`，最多 200 个入口、总大小不超过 192 KiB。使用原子保存、版本冲突检查和旧搜索结果失效检查，损坏的配置原样保留。
- 切换管理页中的条目不重新读取配置。未保存修改阻止关闭和停用，用户可保存或放弃修改。
- 加入官方离线目录、默认安装、托盘、插件管理和启动器搜索。搜索只启用独立后台，管理或补参数时才创建沙箱窗口。

## 宿主接入

新增的官方适配器绑定插件 ID 和 npm 包身份，使用现有生命周期、capability broker、窗口和主题广播。普通搜索和后台预览没有外部打开副作用；执行时重新读取保存的入口并校验版本，URL 或程序路径不能直接来自搜索结果页面。

窗口复用共享 UI、自定义标题栏和主题。插件管理的功能按钮过滤 `launcher.role=hidden` 的后台命令。沙箱插件保留包内字体，并补充 TTF 的正确 MIME，保持现有 CSP 和同源限制。

后台配置通道增加宿主指定的可选容量限制；quicklinks 使用 256 KiB / 16384 节点 / 单字符串 32768。原有插件通道和桌面卡片 JSON 校验的默认限制保持原值。配置文件限制为 192 KiB，给外层协议和预设列表留出空间。

## 验证结果

环境：Windows x64、Node 26.13.0、pnpm 12.16.1、Electron 45.1.0。所有安装、配置、缓存、探针输出和浏览器 profile 均使用隔离临时目录；没有测试真实便签或剪贴板数据。

| 验证                                                                  | 结果                                                   |
| --------------------------------------------------------------------- | ------------------------------------------------------ |
| `pnpm typecheck`                                                      | 通过，包含新插件和 renderer                            |
| `pnpm lint`                                                           | 通过；保留仓库其他文件已有 warning，新插件无 lint 错误 |
| `pnpm test`                                                           | 78 个文件、324 项通过                                  |
| 最后相关回归：quicklinks、capabilities-context、presentation-contract | 3 个文件、12 项通过                                    |
| `pnpm build`                                                          | 通过，生成 9 个独立官方插件及桌面构建                  |
| 字体 MIME 最后修改后的宿主 TypeScript 编译和定向 lint                 | 通过                                                   |
| `git diff --check`                                                    | 通过                                                   |
| 真实 Electron 安装包 smoke                                            | 17 项通过，退出码 0，控制台无错误                      |

后台的 4 项测试覆盖 URL 查询编码和固定目标、命名参数与 argv 字面传递、并发及外部修改冲突、停止时保存、旧选择失效和损坏文件保留。

## 真实 Electron 证据

最终报告：[report.json](../../local-build/quicklinks-validation/smoke/runs/800ffffc-ed9b-4db5-abf8-68c1295d725e/report.json)。

截图：[浅色管理页](../../local-build/quicklinks-validation/smoke/runs/800ffffc-ed9b-4db5-abf8-68c1295d725e/management-light.png)、[命名参数表单](../../local-build/quicklinks-validation/smoke/runs/800ffffc-ed9b-4db5-abf8-68c1295d725e/named-parameters.png)、[深色管理页](../../local-build/quicklinks-validation/smoke/runs/800ffffc-ed9b-4db5-abf8-68c1295d725e/management-dark.png)。已目视检查管理页和参数页，无横向溢出。

- 通过真实 `DesktopPluginHost` 安装并运行最终 tgz，验证搜索不会创建 renderer，不匹配的输入不触发网页搜索。
- 执行 `bd 中文 天气 &next=https://evil.example/#fragment`，最终 URL 保留固定百度域名，所有输入作为一个查询值。
- 在真实页面中添加和保存 GitHub 仓库预设，从网站预设页接收缺参数激活，填写字段后执行并核对最终编码 URL。
- 真实启动 Node EXE，将 `中文 a file.txt" & calc.exe` 作为一个 argv 接收，工作目录正确。
- 200 条入口经真实 renderer capability broker 保存与读取，请求 77404 B、响应 79070 B，完整保留，随后恢复此前测试配置。
- 验证未保存配置阻止停用、放弃修改不影响已保存配置、关闭重开和停用重新启用后配置仍在。
- 验证浅色／深色及强调色广播，HarmonyOS Sans SC 显式加载成功，停用后窗口、后台进程和主题订阅全部释放。

最终包：`dist-plugins/quicklinks-0.1.0.tgz`，15089066 bytes，SHA-256：`0e6406a60e921d1f8394d192b3e7a4b713461becae645f12060fb2eb62443a8e`。

验证边界：URL 执行在测试 harness 中拦截最终 `shell.openExternal`，核对传给系统的完整链接，没有打开真实用户浏览器；EXE 参数验证使用真实进程。没有逐一登录或请求各网站，也没有实际启动 Obsidian、Notion 等外部应用来验证其自身协议行为。没有执行 Windows 安装器打包。

当前构建已包含新插件。已运行的旧宿主实例需重启后加载新宿主接线；开发启动会按现有流程构建和安装官方插件。

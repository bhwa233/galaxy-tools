# 插件声明与独立窗口实施验证

日期：2026-10-30。宿主/API 1.3.0，Electron 45.0.0；Windows 本地验证。

## 实现范围

7 个官方插件在各自 `package.json` 声明图标和启动器展示角色。6 个带页面的插件拥有各自 renderer 入口及构建产物，构建阶段检查模块依赖，禁止导入启动器或宿主 App 路由。宿主只消费声明和激活结果。

窗口标题、图标、尺寸、复用及任务栏身份读取插件声明；设置窗口使用宿主声明。搜索、词典与翻译、剪贴板的静态导航/筛选默认值归各插件 `config/ui.json` 所有，用户历史、凭据和偏好保留现有私有存储。旧官方窗口标识及几何状态可迁移。

实现位置与合同见 [方案](../plugin-declaration-and-launcher-decoupling.md)、[SDK 文档](../../packages/sdk/README.md)。

## 自动检查

| 检查                               | 结果                                | 工作区日志                                                                             |
| ---------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `pnpm typecheck`                   | 通过                                | `local-build/plugin-decoupling-typecheck.log`                                          |
| `pnpm lint`                        | 通过，保留已有 warning              | `local-build/plugin-decoupling-lint.log`                                               |
| `pnpm test --maxWorkers=4`         | 71 文件、288 测试通过               | `local-build/plugin-decoupling-node-tests.log`                                         |
| `pnpm test:ui`                     | 11 文件、31 测试通过                | `local-build/plugin-decoupling-ui-tests.log`                                           |
| 宿主 Vite、Electron 编译和资源复制 | 通过                                | `local-build/plugin-decoupling-host-build.log`、`plugin-decoupling-electron-build.log` |
| `pnpm plugins:build`               | 7 个独立插件归档通过                | `local-build/plugin-decoupling-plugin-build.log`                                       |
| Hello Web build                    | 通过                                | `local-build/plugin-decoupling-example-build.log`                                      |
| 改动文件格式 / `git diff --check`  | 通过                                | `local-build/plugin-decoupling-format-scoped.log`                                      |
| 全仓 `pnpm fmt --check`            | 未通过：已有 OCR 来源记录 JSON 格式 | `local-build/plugin-decoupling-format.log`                                             |

全仓格式检查唯一报告为 `packages/official/ocr/legal/Microsoft-VC-Runtime-provenance.json`，保留任务开始前的内容及格式，不以重排来源记录来隐藏失败。

Node 测试限制 4 个 worker，避免大量持久化 fsync 测试并发触发默认超时，没有放宽断言或测试超时。旧词典模式的 AI 按钮测试随已删除的启动器词典容器移除；明确触发 AI 的行为继续由现有翻译工作区用例覆盖。OCR 取消失败及快捷键保存失败的用例保留，并按新的声明与分组入口执行。

## 真实 Windows 与构建产物

使用隔离配置及数据目录启动 Electron，省略开发服务器 URL，加载新生成的 `dist-plugins`。因此页面来自 `spark233://workspace/<plugin>/index.html` 或便签自身 origin，而非启动器容器。

最终运行报告：`local-build/plugin-decoupling-native-1793332043912/report.json`；汇总日志 `local-build/plugin-decoupling-native.log`。

- 打开文件搜索、词典与翻译、剪贴板历史、快捷剪贴板、截图历史、便签管理、OCR 结果及宿主设置。
- 用 Win32 读取实际 HWND 标题、Windows 属性存储中的 AppUserModelID/图标资源路径，以及原生图标的像素散列，确认标题与图标对应各插件、插件分组稳定且不同图标可区分。
- 修改 HTML `document.title` 后原生标题保持插件名称。普通 Hello Web 的 HTML 标题也未覆盖声明。
- 启动器输入带入搜索窗口并自动搜索；用户修改窗口内查询后，再以相同启动器关键词打开，可恢复关键词并重新查询。
- 离线查词直接展示 apple 释义；未发起 AI 翻译请求。
- 搜索输入及 OCR 编辑草稿在最大化/还原后保留；切换语言刷新原生和可见标题，查询文本保留。
- 所有官方插件页面均未调用 `launcher_*` IPC。`closeToTray:false` 时关闭搜索窗口，宿主继续响应。
- 检查独立构建 CSS 的实际效果：标题栏高 48px、窗口按钮位于右侧，普通插件窗口具有不透明主题背景。补齐 Tailwind 的共享源码扫描，修正透明外壳误用。
- 用生成的 Hello world PNG 运行真实 OCR，确认识别结果，再编辑、最大化及还原。这是受控图片识别，不代表桌面选区、多屏截图验收。
- Hello Web 通过普通目录导入和存储权限安装，从声明生成的启动器入口打开；关闭重开后私有数据保留，无启动器代码注册。

截图：同目录 `search.png`、`dictionary.png`、`ocr.png`，均已人工查看。

## 保存与本地实例

`local-build/plugin-decoupling-save-refusal.log`：模拟保存失败后，真实原生确认对话框保持打开，父窗口可见，宿主仍可查询；取消确认后正常退出，未选择强制退出。

复用仓库 `--smoke-notes-final-save`，报告 `local-build/plugin-decoupling-notes-1793332489027/report.json`：便签页面管理权限拒绝、设置增量写入、停用前最后一次正文保存全部通过；停用再启用后从存储读取最终文本。

现有开发实例已刷新到 1.3.0，沿用原配置和数据目录、Vite 56277 及新生成的开发插件归档。`local-build/plugin-decoupling-live-verification.json` 确认 7 个插件没有加载错误，文件搜索独立窗口可见且标题栏实际渲染。检查结束后移除临时 Inspector 连接。

重启辅助脚本曾在旧实例已退出后多发一次退出启动，触发超时终止；随后改为检查旧进程并异步请求退出，移除超时终止路径。当前实例完成恢复和插件加载检查。

## 尚未覆盖的发布验收

本次完成插件归档构建及真实 Windows 源码宿主加载，没有制作 NSIS/目录安装包、发布 npm 包或执行远程 CI。任务栏证据来自实际 Win32/Shell 属性读取，未执行任务栏鼠标悬停的人工验收。多屏 DPI、输入法、系统注销及配置真实 AI 服务不在本次验证范围。

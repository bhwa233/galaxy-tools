# UI 交互测试实施

日期：2026-10-27。用户确认在已完成的功能回归之外，采用 Vitest Browser Mode 增加少量 UI 交互用例，随后明确收窄为“先只做启动器相关的 UI 测试”。本轮只覆盖启动器主界面，顺序为先文档、集中接线与编写用例、最后统一验证；不执行 PowerShell、Windows 打包或整套烟测。

## 范围与选型

保留现有 Node Vitest 功能测试入口，新增独立 `test:ui` 入口，以无头 Chromium 运行真实 React 组件、现有 shadcn 原语、CSS 和浏览器事件。测试只控制桌面 bridge 的系统边界，组件与实际 feature API 保持生产实现；不启动 Electron 主进程，不借用用户数据或系统剪贴板。

新增开发依赖 `@vitest/browser-playwright@5.0.5`、`vitest-browser-react@2.3.0` 和 provider 所需的 `playwright@1.64.1`：现有 Vitest 只有 Node/静态 HTML 渲染，不能执行真实 DOM 交互；前两者为官方维护的 provider 及文档推荐的 React 挂载适配，Playwright 提供真实 Chromium 驱动。已核对 registry 发布与 peer 范围，分别兼容本仓 Vitest 5.0.5/React 19；使用精确版本及锁文件，不新增独立 Playwright Test runner、jsdom 或 testing-library 套件。浏览器安装只取本轮需要的 Chromium headless shell，不安装额外浏览器或 Windows 依赖。

## 三个启动器代表用例

| 范围           | 交互与判据                                                                                                         |
| -------------- | ------------------------------------------------------------------------------------------------------------------ |
| 搜索与键盘执行 | 在真实搜索框输入，等对应结果，通过上下键选择并回车执行；验证实际选择的入口与发出的桌面请求，不断言组件私有 state。 |
| 模式进入与返回 | 通过真实启动器入口进入一个模式、输入查询并返回普通模式；检查界面与实际查询的模式身份，避免旧模式残留。             |
| 插件可用性     | 启动器接收插件停用变化后，对应候选撤下或不可选，旧项不能继续执行，其他入口仍可用。                                 |

选择的风险分别为键盘选择与异步结果、模式切换状态及动态候选可用性。一个风险只写一个代表场景，不建立截图矩阵或逐控件文案快照。备份、入口设置及翻译工作区用例已撤出本轮。

## 接线与验证

浏览器用例采用 `*.browser.test.tsx`，默认 `npm test` 排除它们，`test:ui` 只发现此类文件。共用最小桌面 bridge fixture，未知命令明确失败；事件订阅可发出实际 feature 事件，所有状态与监听在用例间清理。复用真实 i18n 初始化与项目样式，避免测试组件副本。

默认无头运行，失败保留截图及浏览器诊断到忽略的产物目录；提供单文件运行方式，不在每次修改后执行全仓或安装包构建。收齐三个启动器用例后统一运行 Node 功能测试、UI 用例、lint、typecheck/build，发现问题只补必要修复和受影响复验。

本轮证明浏览器组件交互。现有 Electron smoke 保留原入口，后续有真实 preload/IPC/窗口接线变化时再按影响范围复用；IME、系统选择器、托盘、UIPI、真实剪贴板及多屏不由本轮组件测试代替。

## 执行入口

使用项目固定的 Node/npm，首次安装开发依赖与对应浏览器：

```bash
npm ci
npx playwright install chromium --only-shell
```

日常只运行启动器组件套件，或指定其中一个文件：

```bash
npm run test:ui
npm run test:ui -- src/features/launcher/Launcher.browser.test.tsx
```

`npm test` 继续运行原 Node 功能套件。自动失败截图位于 `local-build/browser-ui/attachments/failure-screenshots/`，主动截图目录为 `local-build/browser-ui/screenshots/`；失败轨迹保存在 `local-build/browser-ui/traces/`，可查看断言前的 DOM 与交互，成功用例不保留最终轨迹压缩包。不提交测试浏览器缓存或生成产物。

## 完成记录

三个启动器用例已完成，均直接挂载真实 `Launcher`，只控制桌面 bridge：

- `src/features/launcher/Launcher.browser.test.tsx`：真实搜索输入、上下键切换候选、回车执行正确 opaque 入口。
- `src/features/launcher/LauncherMode.browser.test.tsx`：选择入口进入模式、模式内查询、Escape 返回，后续请求不残留旧 mode。
- `src/features/launcher/LauncherAvailability.browser.test.tsx`：接收插件停用事件后，旧候选不可执行，其他入口仍可执行；特意保留受控旧结果，验证界面自己的可用性守卫。

最终 `npm run test:ui` 为 **3 文件/3 用例通过，退出码 0，本机本次 4.08 秒**。该数是一次本机运行耗时，不是性能承诺。原 `npm test` 仍为 **46 文件/202 项通过**；lint、typecheck、build 通过。构建后仅调整 UI 测试定位及测试配置，最终再验证 UI 全组、typecheck 和 lint，没有重复执行产品构建或 Windows 烟测。

首轮模式用例通过，另两条因测试选择器精确匹配候选名称而失败：实际可访问名称包含回车提示“↵”。修正定位后，两条定向复验通过，再以最终配置运行三个用例全部通过；没有修改启动器业务代码，也没有延长超时掩盖问题。原失败日志、截图和交互轨迹保留，未将失败改写为通过。

结果、工具版本、当前源码/配置及日志 SHA-256 见 `local-build/spark233/browser-ui-2026-10-27/summary.json`；同目录保留最终 `ui-final.log`、原 `ui-before-locator-fix.log`、功能测试及各门禁日志。失败截图首轮按工具默认路径保留在 `.vitest/attachments/`，后续自动附件统一写入 `local-build/browser-ui/attachments/`。

本轮只含启动器主界面。备份、入口设置、翻译工作区的测试文件已撤出，未扩写其他 UI，也未执行 Electron 主进程、Windows 或原生界面验收。

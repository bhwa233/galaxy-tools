# UPXS 修复后的插件运行兼容性回测

2026-11-05。继续验证此前解除安装阻塞的 7 个官方原包，使用 0.1.0 宿主、当前 UPXS 修复和生产 Electron 兼容运行器。结果为：**4 个已测核心路径通过，1 个部分可用，2 个初始化或必要能力受阻**。样本按功能选择，不能代表整个商店的兼容率。

## 逐插件结果

| 插件                    | 版本  | 结果           | 实际验证                                                                                                                                                                      |
| ----------------------- | ----- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| JSON 编辑器             | 1.7.1 | 已测功能通过   | 原 JSON 规则匹配；嵌套中文对象进入原编辑器；原格式化按钮保持对象内容；文件规则读取隔离 JSON；新文本送达同一原页面；进程关闭重开后接受新 JSON                                  |
| 简易计算器              | 1.1.3 | 已测功能通过   | 原算式规则匹配并进入旧列表模板；`1+2=3`、子输入 `0.1+0.2=0.3`；选择「带入结果」后继续 `0.3*10=3`；真实进程重开后 `6*7=42`                                                     |
| 计算器                  | 1.0.1 | 已测功能通过   | 原算式匹配和旧列表显示 `1+2=3`；子输入小数运算正确；真实进程重开后 `6*7=42`                                                                                                   |
| 加解密-编码工具 encoder | 0.0.6 | 已测功能通过   | 原 BASE64 按钮完成「银河 Galaxy」中文往返；原 SHA-256 按钮输出 `abc` 的已知摘要；进程重开后再次计算正确                                                                       |
| 编码小助手              | 2.1.1 | 部分可用       | 普通 Hash 入口的原输入框正确输出 `abc` 的 MD5、SHA-256；重开后 `xyz` 摘要正确；冷启动文件 Hash 正常。Base64 被 `Buffer is not defined` 阻塞；同一 Hash 页面连续切换文件未刷新 |
| 正则编辑器              | 1.1.3 | 初始化受阻     | 激活报 `ShellJSInternalError: process is not defined`，原页面仅加载部分框架，未得到可操作的完整编辑器                                                                         |
| 正则表达式测试工具      | 0.0.1 | 必要能力未支持 | 原入口调用 `window.utools.ubrowser.goto(...)`，激活报 `TypeError: window.utools.ubrowser.goto is not a function`；当前未提供 ubrowser                                         |

## 新定位的问题

### CommonJS 环境中的全局变量

编码小助手的原 preload 在 Base64 转换中直接调用 `Buffer.from(...)`，实际触发 `ReferenceError: Buffer is not defined`。同一插件通过 `require('crypto')` 计算字符串和文件摘要可以工作。

正则编辑器的原 preload 包含 ShellJS，调用 `process` 时失败。当前 `utools-preload.cts` 通过 VM 执行 CommonJS 包装，仅显式传入 `require/module/exports/__filename/__dirname`。应优先核对并补齐 preload 执行环境中的 `process/Buffer`，保持既有完整代码信任与独立进程边界。

### 同一功能的新文件到达了回调，旧组件未刷新

编码小助手冷启动后匹配 `hash.txt`，MD5 正确为 `98ed0c6702d70380987ecee515e1676a`。随后在同一 Hash 页面选择 `sample.json`：附加的只读观察回调确认原 `onPluginEnter` 已收到 `type: files` 和正确的 `sample.json` 路径，但原页面继续显示 `hash.txt` 及旧摘要；新文件期望 MD5 为 `3d8ea2ebecd436cbdd1a379adbaf930b`。

原插件的 Hash 组件只在 `componentDidMount` 消费文件 payload。这里需要进一步核对重复激活的生命周期适配；不能再简单归因为宿主吞掉了输入，也不能通过无条件重载页面牺牲原编辑状态。

### 复核中排除的误判

- 编码小助手首次将 `abc` 作为 Hash 激活 payload，该组件将 payload 当作摘要算法名处理。改用普通 Hash 入口，再向原输入框填写 `abc`，MD5 和 SHA-256 均正确。最初的失败报告保留，最终结论采用正常入口结果。
- 简易计算器首次在点击「带入结果」后立即断言输入值，早于异步状态送达。等待原输入框完成回填后，再继续运算，均通过。
- 旧计算器首次普通窗口测试出现过 `i is not defined`。针对性隐窗回测记录的输入仅为指定算式，运算正确；尚未把首次异常归因于兼容层。

## 验证方式与证据

样本代码从 [UPXS 安装回测](utools-upxs-layout-2026-11-05.md) 的真实商店安装目录复制到新的隔离根目录，未修改原包业务代码。继续使用生产管理器、运行器、原页面、原 preload、原输入框和按钮。

规则匹配和选择走真实 `manager.query` 及其不透明选择凭据。文件测试由宿主的资源解析接口只映射两个隔离文件，不接受任意外部路径；未操作用户文档。进程重开走生产停用／启用路径，部分用例核对了实际浏览器进程 ID 已改变。测试停止确认由隔离驱动明确选择。

首次使用普通兼容窗口；针对性复核使用既有 `ensureWidgetOwner` 隐窗启动方式，以控制桌面输入干扰。没有给原插件补 `process`、`Buffer` 或 `ubrowser`，也没有以替代 API 让失败样本通过。隐窗结果不代表物理焦点、快捷键或多屏行为已经验收。

证据根目录：`local-build/utools-compatibility-20261105/13bfe623-fd86-4c8a-984f-6ef1c631cdb4/`。

- `staging-report.json`：原清单、版本、来源 SRI、实际测试代码目录。
- `smoke-report.json`：全部 7 个样本的启动、页面和激活错误。
- `functional-report.json`：首轮原界面功能及重开结果，含待复核的首次失败。
- `followup-report.json`：Hash 正常入口、Base64 缺失变量、两个计算器小数和回填的针对性复核。
- `file-hash-report.json`：冷启动文件 Hash 正确结果。
- `file-hash-reentry-report.json`：文件 A → B 的真实新激活记录与旧页面结果。
- `runs/`：逐次运行的日志、页面 HTML 和截图。JSON 编辑器、encoder 和旧列表计算器的功能截图已检查。

入口脚本为 `local-build/utools-upxs-runtime-{stage,smoke,functional,followup,file-hash}.mjs`，共用既有 `utools-broad-harness.mjs` 和 `utools-broad-main.cjs`。日志为 `local-build/utools-upxs-runtime-{stage,smoke,functional,followup,file-hash,file-reentry}.log`。

两个启动受阻样本的截图另有超时；其阻塞结论来自激活错误和运行日志，不依赖截图。部分 Chromium GPU 缓存日志仍存在，不据此宣称图形系统无错误。

## 范围

结论只覆盖表中列出的功能，未覆盖所有算法、PHP 求解器、系统剪贴板复制、真实启动器拖拽、桌面固定组合、物理快捷键及 NSIS 安装。本轮补充真实运行验证和记录，没有新增生产兼容实现，未重复全量单元、浏览器回归及此前受原生搜索构建阻塞的完整构建。

合并 2026-11-04 和本轮记录，14 个样本中共有 6 个已测核心路径通过、3 个部分可用、5 个初始化或必要能力受阻；其中 11 月 4 日的其余样本未在本轮重跑。

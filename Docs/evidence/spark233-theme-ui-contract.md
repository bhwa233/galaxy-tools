# 独立页面主题传播与版本化 UI 包

日期：2026-10-25；分支：`codex/spark233-refactor`。范围：P2.12 的真实宿主主题变化、独立插件更新和 UI 包实际消费；不执行 Windows 点选或公开发布。

## 原缺口与最小补齐

原 `packages/ui@0.1.0` 已通过 `src/App.css` 的真实 import 提供主题 token，因此原主题资源并非未使用。缺口是包内只有主题 CSS/helper，没有原要求的 shadcn 组件入口；兼容说明仍为 SDK 0.1.x，官方 renderer 的共享记录也只写字体协议。

当前 UI 包为 **`@spark233/ui@0.2.0`**，元数据 `spark233Ui` 明确记录 SDK `>=0.2.0 <0.3.0`、宿主 API `^1.1.0`、主题协议 `^1.0.0`。框架无关的 theme CSS/helper 继续可独立使用；React 组件是可选子入口，消费者提供已声明的 React/Radix/cva/cn/lucide peers，没有新增项目依赖。

`src/components/ui/` 中现有 shadcn 组件仍是唯一源，未搬走或重写。`packages/ui/src/components.ts` 导出 Button、Alert、Badge、Card、Input、Textarea、Spinner 家族；UI build 使用现有 Vite/TypeScript/Tailwind 生成独立 JS、声明和组件 CSS。声明中的源相对入口被变成包内声明引用，运行时只导入声明的第三方 peers。原 App.css 的语义颜色/圆角映射提取为 UI 包共享 CSS，宿主和包构建复用同一份映射；没有复制组件实现。

代表官方 `ClipboardWorkspace` 的 Button/Input/Textarea/Badge/Alert 真实改从 `@spark233/ui/components` 入口导入，Vite 与 TypeScript 仅增加必要的开发解析。Vite 在确实解析到该入口时生成 `spark233-ui.json`；不使用该入口的辅助 preview 不生成此记录，不会因此破坏独立服务面板 runner。正式官方插件组装仍严格检查记录的包版本、兼容范围、入口及入口源码 SHA。

`renderer/spark233-shared-ui.json` 保留字体协议 `version: 1` 和 `fonts`，新增 `uiPackage`，包含 `name`、`version`、`compatibility`、`componentsEntry`、`componentSourceSha256`。UI 包版本和字体/主题协议分别版本化；不是只加 metadata，已有实际 workspace 消费、独立包运行和官方 archive 装配证据。

## 真实宿主主题与独立更新

复用 `local-build/spark233/web-plugin/integration.mjs --host-theme`，报告：

`local-build/spark233/web-plugin/host-theme-runs/0864f83a-1240-4a29-89f2-88d5262bb9b3/report.json`

**六项全部通过，`ok: true`、实际宿主 PID 47040 exit 0。** 这次调用真实 `config_save`，由 HostConfigStore 持久化后经过 `publishPluginTheme`、WebRuntime、SDK onTheme 到已经打开的独立 Hello Web 页面，没有替换主题源或手动发主题事件：

| 实际阶段                      | 页面身份与观察                                                              |
| ----------------------------- | --------------------------------------------------------------------------- |
| 首次打开                      | `hello-web@0.1.0`，light，背景 `rgb(247, 250, 247)`                         |
| 宿主改为 dark                 | 同一 instance，无 reload，背景变为 `rgb(20, 27, 22)`；宿主配置文件也为 dark |
| 正式本地导入/确认更新至 0.1.1 | 新 instance，初始主题为宿主当前 dark；原私有存储仍在                        |
| 宿主再改为 light              | 新版本同一 instance 收到变化，背景恢复 light                                |

唯一替换点是 OS picker 返回受控本地归档；安装预览/确认、管理器更新、页面保存释放和 SDK 都运行产品代码。私有 profile 中 clipboard 在启动前禁用，未启动其 listener；没有读取真实便签、历史或凭据。

**输入边界：该报告使用 `backup-preview-ui/dist-electron` 的独立源码编译宿主，不是新 packaged ASAR。** 同目录 `compiled-inputs.json` 保存实际运行 main、web-host、desktop-host、SDK browser/index、plugin preload 及 runner 的完整路径和 SHA-256，准确绑定当次编译输入。它替代此前仅用局部 theme 变量驱动 WebRuntime 的较窄证明，不把旧报告改名为新包验收。

## 工作区外的 UI 归档消费

独立构建：`node packages/ui/build.mjs --output local-build/spark233/ui-package-proof/package`，再用真实 `npm pack --ignore-scripts` 生成 `spark233-ui-0.2.0.tgz`。归档含自有 JS、声明、预编译 CSS、主题与许可；没有宿主源码运行时依赖。

`local-build/spark233/ui-package-proof/consumer-report.json` 为 **`ok: true`**。归档解包到工作区外临时 consumer，`configFile: false`，没有宿主 alias，也没有 App.css：

- strict TypeScript 检查实际包导出和声明成功。
- 真实隐藏 Electron renderer 从归档构建的页面渲染现有组件，Button 的真实 click 回调计数为 1。
- 仅加载包内预编译 CSS，按钮圆角为 10px；light 背景 `rgb(45, 90, 61)`，切换后为 dark `rgb(79, 170, 112)`。probe 等待组件已有颜色过渡完成后读取计算样式，没有为测试修改产品 CSS。
- consumer 的既有 React/Radix 等声明 peers 通过 node_modules junction 供给；这证明 UI 包自身不依赖宿主源码路径，不声称已经联网全新解析安装全部 peers。

这是 UI 包自身 helper/CSS 的独立消费证明；真实宿主主题传播由上一节单独证明。没有新增 Vitest 文件、控件实现、测试框架或状态矩阵。

## 正常 renderer 与官方单包装配

完整当前 renderer 独立构建到 `ui-package-proof/renderer/`，然后用正式组装器的 `--plugin spark233.clipboard --renderer <独立目录> --output <独立目录>` 创建单包。`official-assembly-report.json` 为 **`ok: true`**：实际 `.tgz` 解包后的 `spark233-ui.json` 与 `spark233-shared-ui.json.uiPackage` 完全一致，版本及三个兼容范围匹配源 package metadata。默认正式组装路径仍是项目 `dist/`；新增 renderer 参数只允许显式选择构建输入，不绕过记录校验。

项目 Node 26.12.1 / npm 12.2.1 下，完整 typecheck、所改产品文件聚焦 lint/格式、UI 包构建、独立声明消费、独立 renderer 和正式单包组装均通过。`packages/ui/dist/` 已精确忽略，避免构建产物改变源码 snapshot 输入集合。最终新候选的七包、ASAR、NSIS 和综合 smoke 由主线程/package lane 统一运行，本 lane 没有重复构建完整安装器。

P2.12 的功能合同现有上述代表证据；物理视觉、全部工作区主题/缩放/辅助技术仍归 P7.8。此处不修改总 TODO/审计，也不将受控本地更新写成公网发布或所有 P7.2 范围已完成。

# spark233 技术栈升级与 UI 基础记录

日期：2026-10-24。当前 P1 工程检查、组件预览、最终 Windows 目录包 smoke、开发启动链及完整进程树记录已完成；本记录不代表启动器或插件宿主已实现。

## 运行时与依赖

升级前文件已冻结到 `C:/tmp/spark233-refactor/p0-2026-10-24T09-57-20-895Z`，原工作区修改没有清空或重置。执行时重新查询 npm registry 与 Node 官方发布索引，原始元数据在 [latest-versions.json](../../local-build/spark233/p0/latest-versions.json)。

项目开发工具链使用官方 Node 26.12.1 Windows x64 ZIP（SHA-256 `b3efd5c70cba3308ed46e7e699a9b8aac075bbc6b027fcb39c84c31acc25e2b4`，已与官方 SHASUMS256.txt 核对），在项目专属便携目录安装 npm 12.2.1。`.node-version`、`packageManager`、engines 和 CI 同步，PowerShell 使用 `. ./scripts/use-toolchain.ps1` 选择当前终端工具链。没有替换机器全局 Node；Electron 45 内嵌 Node 24.22.0，主进程 `@types/node` 保持在匹配运行时的 24.19.2 分支。

React/react-dom 19.3.1、TypeScript 7.0.2、Vite 8.3.5、Vitest 5.0.5、Tailwind 4.3.3、electron-builder 26.18.0 及其他直接依赖按执行时稳定版锁定，具体版本以 package.json/lockfile 为准。TypeScript 使用其公开 CLI 元数据，开发脚本不再假设编译器内部路径；类型检查同时覆盖前端、Vite 配置和 Electron 三份 tsconfig。图片粘贴的 Uint8Array 声明适配新的泛型类型检查，未改变图像保存流程。

Vite 采用 rolldownOptions / codeSplitting.groups，保留 Markdown 懒加载和公共 vendor 分块。rehype-katex 7.0.1 仍依赖旧 KaTeX，因此通过 Vite 的明确 dedupe 将实际渲染器统一到直接固定的 KaTeX 0.19.1，CSS 使用同一个根包，更新了已改名的 newline 选择器；没有使用强制 npm 全局 override。生成 JS 仅观察到 0.19.1 版本串，代表公式在真实浏览器中显示正常。

## shadcn 与共享主题

使用 shadcn 4.22.1 官方 CLI，选择 Radix / Nova、lucide 图标和 `@/` 别名。先读取当前 CLI 文档和官方组件文档，再由 `@shadcn` registry 生成 Button、Input、Separator、Card、Dialog、Command 及其 InputGroup/Textarea 依赖。未手写第二套命令面板、模态、焦点管理或 class 合并工具。

现有组件没有覆盖这套可访问交互原语；新增 radix-ui、cmdk、cn、class-variance-authority、lucide-react、tw-animate-css 和 shadcn 来自当前官方 registry 依赖选择与实际发布版本。cn 经 src/lib/utils 统一使用，业务通过共享 UI 原语接入。它们只服务前端构建，放入 devDependencies，避免 electron-builder 把构建 CLI 和完整前端依赖树再作为 Node 运行依赖打包；现有中文 HarmonyOS Sans SC 字体继续复用，移除了 CLI 默认添加但不需要的 Geist 字体包。

共享语义颜色映射到现有竹绿色变量，dark variant 使用应用已有的 data-theme 协议；透明 Electron body 保留，原便签个性化设置未改写。CommandDialog 的标题/描述位于实际 DialogContent 内，Command 输入关联 InputGroup 的焦点样式。新组件及样式源代码已阅读，完整相关许可文本追加到 THIRD_PARTY_NOTICES.md。

## 已执行的最小验证

- [npm ci](../../local-build/spark233/p1/npm-ci.log) 从当前 lockfile 重新安装成功，随后执行既有 electron:install。
- 初次 ci 因 VS Code Vitest Explorer 的四个后台 worker 占用本仓 Rolldown 原生模块而失败；定位具体模块持有者并仅结束这些 worker 后重试成功，未关闭编辑器或结束其他项目进程。
- [三份配置类型检查](../../local-build/spark233/p1/typecheck.log)、[lint](../../local-build/spark233/p1/lint.log) 和 [构建](../../local-build/spark233/p1/build.log) 通过。
- [既有 Vitest](../../local-build/spark233/p1/tests.log) 为 62 个文件、307 项通过，没有新增测试用例或框架。
- 一次性组件预览位于 local-build，不加入正式产品路由和测试套件。真实浏览器中文输入“截图”过滤到“截图取字”，回车后选择结果正确，方向键切换结果和输入焦点边框/3px ring 均已观察。
- [浅色截图](../../local-build/spark233/p1/ui-light.png) 与 [深色截图](../../local-build/spark233/p1/ui-dark.png) 显示实际共享组件和行内/块公式；这不是已完成的启动器截图。
- [实测样式](../../local-build/spark233/p1/ui-styles.json)：浅色主按钮背景 rgb(45,90,61) / 白字，对比度约 7.95:1；深色背景 rgb(79,170,112) / rgb(16,32,22) 字，对比度约 5.90:1。主按钮高度 32px，使用现有中文字体栈。

组件预览浏览器页和其专属 Vite 进程已关闭。预览只验证代表组件和主题，不证明真实 Windows IME 组合输入、所有弹层、跨窗口主题同步或 SDK 主题协议；后者在相应正式阶段验收。npm 提示 electron-winstaller 的可选安装脚本未获执行，本阶段使用 NSIS/目录包路径，不为消除提示任意放开安装脚本。

## Windows 阶段门槛

升级后的目录包、固定数据样本对照与 CLI/MCP 证据由 [Windows 升级验收](spark233-upgrade-windows.md) 记录。首次目录包 smoke 在置顶便签原生窗口级别检查失败，失败报告保留在 `local-build/electron-smoke/72e7424f-568e-4448-9417-523c038f7269/report.json`。保持原等待时间和断言的诊断副本、随后未改业务代码的最终原样包均通过；首次失败原因尚未确定，保留为已知间歇问题，不宣称已经修复，也不以单测和构建通过替代真实 Windows 证据。

开发启动链已实际完成编译、Vite 与 Electron 拉起及初始化后的正常退出，并记录完整进程树。发现 Vite 误监听隔离 Chromium Cookies 的 EBUSY 后，排除 local-build 和 release-electron；真实 watcher 仍监视 39 个源码目录且不包含 local-build，未产生 watcher 错误，配置的 typecheck/lint 通过。相关日志、单次内存快照和验证限制见上述 Windows 记录；新增 TypeScript 构建信息文件通过既有忽略规则统一排除。

P1 按现有功能升级回归标准收口，已知间歇故障及未测交互继续保留；P1V 原生集成、插件宿主、完整离线包和重构后的 spark233 安装身份仍未完成。

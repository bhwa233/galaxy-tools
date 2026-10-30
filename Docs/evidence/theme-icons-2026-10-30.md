# 内置图标主题色 · 2026-10-30

启动器和内置插件的 SVG 使用主题主色。SVG 源文件改用 `--primary` / `--primary-foreground`，保留单独打开时的默认颜色；生成原生 PNG/ICO 时复用 electron-builder 的现有转换器并解析显式回退色。托盘分别生成适合浅色、深色系统的主题绿色图标。

插件声明新增可选 `ui.icon.monochrome`，七个官方插件均开启。宿主仍只解码并传递包内 PNG，界面通过安全的 PNG 透明遮罩使用当前 `--primary`，不注入插件 SVG 源码。启动器、插件市场和快捷键配置共用同一个 PluginIcon。第三方图标默认保留原色；插件可以显式选择单色。此字段不影响原有窗口路径限制和原生图标加载。

## 验证

- 类型检查、lint、294 项 Node 测试通过；本轮修改源码格式检查和 `git diff --check` 通过。
- 现有 `pnpm dev` 流程成功重新生成七个插件并重载 Electron。
- 实际启动器确认七个官方插件都声明单色。11 个可见插件入口/操作图标在浅色界面为 `rgb(45, 90, 61)`，深色界面为 `rgb(79, 170, 112)`。
- 临时把主色变量设为紫色后，11 个图标均立即变为 `rgb(130, 87, 204)`。诊断完成后还原界面主题和变量，没有写入用户配置。这证明变量接线有效，不表示已有产品中的主题色选择入口。
- 浅色和深色截图为 `local-build/theme-icons-light.png`、`local-build/theme-icons-dark.png`。运行报告及检查日志保存在 `local-build/theme-icons-*.log` 和 `local-build/theme-icons-live-report.json`。

用户随后提出“主题色可以切换”的方向。此前本轮只完成图标变量接线，后续已在常规设置加入独立的五种预设主题色入口，见 [主题色切换验证](theme-accent-2026-10-30.md)。

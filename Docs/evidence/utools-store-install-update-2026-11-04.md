# uTools 商店安装、更新与桌面修复

2026-11-04。本轮实现用户要求的两项桌面修复，以及商店安装、来源绑定和更新；没有新增文件／图片上下文跨程序重启恢复。

## 使用

设置 → 插件市场 → 发现 → uTools →「下载并检查」。沿用现有任务进度、取消、安装预览、完整代码信任确认和已安装管理。官方页面仍可用于查看完整详情。

「导入本地插件包」接受 `.tgz/.upx/.upxs`。没有支持的公开离线包、包格式不支持、平台不符或身份不一致时展示具体失败原因，不执行包代码、不覆盖旧插件。浏览目录与安装成功不产生兼容性「已验证」标记。

已安装的本地插件只有在下载检查后实际清单身份一致，且用户确认时才绑定商店来源。代码相同的预览显示「绑定更新来源」，仅提交来源元数据，保留当前进程、页面和数据；代码不同则走原安装更新事务。名称相同不自动绑定。复用不可变版本时，比较目录类型、路径、文件长度与内容；跨文件移动字节不能混淆为相同代码。

现有「检查更新」处理已绑定插件的上游语义版本。内容指纹仅标识不可变代码，不用其字典顺序判断新旧。同版本内容变化由用户主动「下载并检查」后显示单独确认说明；不为检测这种情况后台下载所有插件包。缺少可比较版本时说明需手动检查。

来源记录包括目录 ID、详情页、实际下载 URL、实际上游版本、原始包 SHA-512 SRI 和检查时间。安装记录、准备预览、更新基线、备份恢复使用同一来源 schema，兼容旧 registry 准备记录。确认时重新检查旧版本、来源及内容基线，迟到候选不能接管已变化的安装。

## 两项桌面修复

- 仅无新输入的普通启动器入口可只唤起固定窗口；匹配文本、文件 B 或图片等新的 activation 必须进入原插件回调。私有唤起标记不传给插件。
- 取消固定先等待原窗口确认恢复，成功后才移除持久化记录。恢复失败或布局写入失败时重放桌面状态，保留原身份和重试入口；窗口投影按顺序执行，避免超时的旧操作覆盖恢复结果。

已有 `desktop-layer.test.ts` 覆盖失败恢复和布局写入失败。隔离真实窗口报告：`local-build/utools-desktop-validation/e30c299b-53fb-45e3-921f-52431f4baef3/report.json`。普通唤起不重复 enter，新文本／文件／图片完整送达；失败取消固定保留卡片并能重试，原 PID、窗口及未保存文字保持。

## 真实安装与升级

报告：`local-build/utools-market-live/edffc8ea-ca7c-42e6-b902-01dbbe854be5/report.json`。使用生产 DesktopPluginHost、安装器、管理器和兼容子进程，配置、代码和数据完全在该隔离目录。

1. 导入 GitHub release 0.20.2 的原始 Excalidraw UPX。其清单无版本字段，实际规范化版本为 `0.0.0-utools.h190ef8f1587ca8d7`。
2. 激活原页面，操作原画布名称输入框，提交「商店升级验证画布」，确认原插件数据库已收到；同时通过原页面数据库 API 写入隔离中文测试记录。
3. 经真实官方索引、详情和下载取得 Excalidraw 0.21.0 UPXS，进入实际预览。拒绝完整代码信任时不能提交安装。
4. 驱动返回「取消停止」后，旧代码、旧页面、旧进程及数据保持。
5. 驱动确认已保存后，走真实备份和切换事务，升级至 `0.21.0-utools.h7d26e22fe5d6ce80`，来源变为 `utools`。新进程读取到原画布名称和中文测试记录。
6. 再次检查相同商店产物，仅提交来源元数据，PID 与 DOM 不变。
7. 完整关闭并重新启动宿主及兼容进程，来源和数据保留；原页面截图为同目录 `original-store-plugin.png`。

格式检查另包含 Markdown 真实 UPXS 和 Excalidraw 真实 UPX，见 [格式与来源](../utools-package-format.md)。Markdown 的解包通过不代表其所有运行 API 已兼容。

回归扩展已有用例，覆盖 UPX/UPXS 无执行导入、元数据篡改、ASAR 路径／链接／包外文件／体积拒绝、非目录来源拒绝、显式信任、无重启来源绑定、宿主重开后的来源读取、更新拒绝保存、数据保留、同版本内容变化，以及插件工作区不能准备商店安装。浏览器回归覆盖目录按钮经现有桥进入任务流程。

## 验证边界

停止确认由隔离驱动选择，未物理操作 Windows 原生对话框。真实原插件页面的 DOM 输入和数据库确认已验证，未扩展为所有编辑／导出功能、所有商店条目、混合 DPI 或 NSIS 安装器均已通过。早期脚本正文长度判断误把以图标为主的白板当成未加载，后改为检查实际组件并提交原界面编辑；原始失败报告保留在同级旧运行目录。

## 最终工程检查

- `pnpm typecheck`、`pnpm lint`、`pnpm fmt --check` 通过；lint 仍包含仓库原有警告。
- `CI=1 pnpm test`：84 个文件、352 项通过。
- `pnpm test:ui`：19 个文件、43 项通过。
- `pnpm build`：通过，包含 9 个独立官方插件包。
- `pnpm pack:win --config.electronDist=D:/code/galaxy-tools/apps/desktop/node_modules/electron/dist`：通过，使用本地同版本 Electron 45.1.0 生成 Windows 目录包。首次默认下载运行时的打包停滞后被主动中止，不把该次视为成功。
- 直接用生成的 `release-electron/win-unpacked/spark233.exe`，以 Node 模式从其 `resources/app.asar` 导入生产安装器，成功解包真实 Excalidraw UPX 与 Markdown UPXS，确认生产依赖实际随包可用。报告：`local-build/utools-packaged-package-proof/1bef1ed3-71be-4cab-9338-9e763dbb5c9f/report.json`。这项检查不执行第三方插件代码，也不代表 NSIS 安装验收。
- `git diff --check` 通过。

最终日志为 `local-build/utools-store-typecheck.log`、`utools-store-lint.log`、`utools-store-format-check.log`、`utools-store-tests.log`、`utools-store-ui.log`、`utools-store-build.log`、`utools-store-pack-win-local-electron.log` 和 `utools-packaged-package-proof.log`。

收尾扩展现有来源绑定用例，模拟文件边界被改动但拼接字节流不变的情况。修复前错误接受预览，修复后拒绝并保留原进程及来源；修复前后结果分别保留于 `local-build/utools-source-boundary-before.log` 和 `local-build/utools-source-boundary-after.log`。

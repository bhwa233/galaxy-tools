# spark233 截图插件

固定 ScreenCapture 2.5.15 源码，由宿主按任务启动；基础框选、标注、复制和保存沿用原生程序。复制、保存、图钉、长截图和取字都会把当前选区原子发布到该任务的独立目录（`capture.json` 的 `action` 说明是哪种完成方式，一次会话只发布一次），宿主核对会话、动作与实际 PID 后据此记录历史、或转交独立 OCR 插件；宿主不观察系统剪贴板作为结果。

构建前运行仓库 `scripts/native-capture` 的准备、适配与 CMake 构建，再执行 `node packages/official/screenshot/build.mjs --native-build-dir <CMake构建目录>`。脚本复制构建产物到包内 `native/win32-x64/` 并记录 SHA-256，包清单和运行时代码均不引用临时绝对路径。

`build.ps1` 会根据当前适配脚本、会话头文件与源码锁生成独立的适配源码目录，避免继续编译旧适配结果。单独构建截图不需要 OpenCV；加 `-WithOcr` 时会准备固定版本的 OCR 依赖，并从实际安装目录定位 OpenCV 的 CMake 配置。`pnpm dev` 在启动及原生源码变化时复用此流程，随后更新本地插件包。

`history` 是插件入口，打开截图历史工作区（保留最近 50 条，可复制、保存、重新取字、删除）；`capture` 打开原生工作面；`ocr` 选择当前图像后直接取字；`cancel` 明确取消本次任务。历史在宿主侧保存于插件数据目录的 `history/`，超出上限先删最旧图片。OCR 停用时不启用替代后端，基础截图与历史继续工作。活动标注会话会拒绝停用或更新，需用户先完成或明确取消。

框选和标注工具栏均提供图钉按钮。点击后保留截图和标注并收起工具栏；右键贴图可重新显示工具栏。

宿主适配器为 `apps/desktop/electron/plugins/official/capture.ts`。原生正常取消使用绑定 session/PID 的 `cancel.request`，退出前确认 `cancel.json`；尚未退出的任务继续被资源 scope 登记，不以强杀冒充保存成功。

完整原生界面、部分选字、多屏 DPI 与正式安装包验收仍由实施计划记录，构建和协议验证不代表这些交互已验收。

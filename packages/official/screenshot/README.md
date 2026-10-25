# spark233 截图插件

固定 ScreenCapture 2.5.15 源码，由宿主按任务启动；基础框选、标注、复制和保存沿用原生程序。取字动作把当前选区原子发布到该任务的独立目录，宿主核对会话、动作与实际 PID 后调用独立 OCR 插件，不观察系统剪贴板作为结果。

构建前运行仓库 `scripts/native-capture` 的准备、适配与 CMake 构建，再执行 `node packages/official/screenshot/build.mjs --native-build-dir <CMake构建目录>`。脚本复制构建产物到包内 `native/win32-x64/` 并记录 SHA-256，包清单和运行时代码均不引用临时绝对路径。

`capture` 打开原生工作面；`ocr` 选择当前图像后直接取字；`cancel` 明确取消本次任务。OCR 停用时不启用替代后端，基础截图继续工作。活动标注会话会拒绝停用或更新，需用户先完成或明确取消。

宿主适配器为 `electron/plugins/official/capture.ts`。原生正常取消使用绑定 session/PID 的 `cancel.request`，退出前确认 `cancel.json`；尚未退出的任务继续被资源 scope 登记，不以强杀冒充保存成功。

完整原生界面、部分选字、多屏 DPI 与正式安装包验收仍由实施计划记录，构建和协议验证不代表这些交互已验收。

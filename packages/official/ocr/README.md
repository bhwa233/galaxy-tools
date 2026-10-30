# spark233 图片取字插件

固定 ImageReader 1.0.2 与 TinyOCR 源码，内嵌中英文 OCR 模型。当前宿主适配以独立原生 batch 进程运行，输入必须是宿主解析的受信图像资源；每次任务复制到独立私有缓存，结果核对 session/PID 与图像尺寸后持久化到插件私有 data 目录。

运行 `node packages/official/ocr/build.mjs --native-build-dir <CMake构建目录>`，将 ImageReader.exe 与两项 ONNX Runtime DLL 从真实构建目录复制到相对 `native/win32-x64/`，并生成 SHA-256 清单。无需 Python 或在线模型下载。

OCR worker 在有界空闲期内复用同一个 TinyOCR 引擎，空闲后退出并释放模型，不创建无限驻留的识别服务。显式取消及停用通过会话控制文件请求正常退出，晚到结果不交付消费者；同步原生推理允许先结束当前计算再退出，宿主界面不等待在 UI 线程中。超过取消期限的进程仍被追踪，停用报告失败而非伪报已完成。

当前返回全文、行文本、置信度、四点框及 TinyOCR 实际字符框。宿主 OCR 工作区支持图片缩放、平移、字符拖选、Shift 跨行扩选和 Ctrl+A。旧结果或手工修订的行保留按行定位，不推算字符位置；文字区继续支持精确选择与复制。

原图、识别结果及修订稿共同保存在插件私有 `workspace-sessions/<sessionId>/`，随统一备份保留。「最近识别」可重新打开；保留最近 20 份未修订结果，修订稿保留至显式删除。自动保存和关闭前刷新复用宿主保存协调；保存失败阻止正常关闭/停止，不静默覆盖草稿。此处为实现说明，真实桌面截图到 OCR 再到翻译/便签的完整实机链路不属于本轮验收。

## App-local Microsoft runtime

The prebuilt CPU ONNX Runtime requires four Microsoft VC V14 runtime DLLs.
`build.mjs` prepares the pinned official x64 release files with
`scripts/native-capture/prepare-vc-runtime.ps1` and includes them beside
`ImageReader.exe`; the end user does not install a runtime or toolchain.
Use `--vc-runtime-dir <prepared-root>` to reuse another explicitly prepared
cache. The original Microsoft license, a reading copy and exact source/hash
records are included in `legal/`. No System32, debug runtime or compiler-only
files are copied into the plugin.

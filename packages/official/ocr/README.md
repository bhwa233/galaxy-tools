# spark233 图片取字插件

固定 ImageReader 1.0.2 与 TinyOCR 源码，内嵌中英文 OCR 模型。当前宿主适配以独立原生 batch 进程运行，输入必须是宿主解析的受信图像资源；每次任务复制到独立私有缓存，结果核对 session/PID 与图像尺寸后持久化到插件私有 data 目录。

运行 `node packages/official/ocr/build.mjs --native-build-dir <CMake构建目录>`，将 ImageReader.exe 与两项 ONNX Runtime DLL 从真实构建目录复制到相对 `native/win32-x64/`，并生成 SHA-256 清单。无需 Python 或在线模型下载。

OCR 进程结束后释放模型，不创建常驻识别后台。显式取消及停用通过会话控制文件请求正常退出，晚到结果不交付消费者；同步原生推理允许先结束当前计算再退出，宿主界面不等待在 UI 线程中。超过取消期限的进程仍被追踪，停用报告失败而非伪报已完成。

当前返回全文、行文本、置信度和四点框供宿主展示；完整 ImageReader 交互窗口、选字复制和图文定位尚需后续宿主界面接入与实际验收。此包不因运行时可用而声称这些界面已完成。

## App-local Microsoft runtime

The prebuilt CPU ONNX Runtime requires four Microsoft VC V14 runtime DLLs.
`build.mjs` prepares the pinned official x64 release files with
`scripts/native-capture/prepare-vc-runtime.ps1` and includes them beside
`ImageReader.exe`; the end user does not install a runtime or toolchain.
Use `--vc-runtime-dir <prepared-root>` to reuse another explicitly prepared
cache. The original Microsoft license, a reading copy and exact source/hash
records are included in `legal/`. No System32, debug runtime or compiler-only
files are copied into the plugin.

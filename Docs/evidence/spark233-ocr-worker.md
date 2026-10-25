# OCR 引擎复用与有限驻留

日期：2026-10-25。对应一期 P4.11/P4.12 和 P7.7 的引擎复用部分。此前每次识别启动一个 batch ImageReader 的产物是本次修复前候选，不能用其“两次新进程”报告证明已经复用模型。

## 实现与归属

原生入口位于 [OcrWorker.h](../../native/capture/OcrWorker.h)，由 [adapt.ps1](../../scripts/native-capture/adapt.ps1) 接入固定 ImageReader 源码；[CMakeLists.txt](../../native/capture/CMakeLists.txt) 仅为 ImageReader 定义 worker 条件编译。普通 ImageReader UI 和 ScreenCapture 的协议保持原入口。复用现成 TinyOCR、WIC、Windows.Data.Json 及 SessionResult，不增加运行依赖或新的推理实现。

首次识别按需启动一个无原生结果窗口的 ImageReader worker，TinyOcr 及其 detector/recognizer/ONNX session 在请求循环外构造一次。后续识别复用同一对象。React 结果窗口和宿主事件循环不运行同步推理；原生 worker 在自身进程执行推理，独立 control watcher 处理协作退出。

宿主 [capture.ts](../../electron/plugins/official/capture.ts) 的 OCR 控制器拥有该进程资源域。正常连续任务保留引擎，默认空闲 **30 秒**后协作退出；native 自身还有 **35 秒**的空闲兜底及宿主进程句柄存活检查。取消当前任务和插件停用/更新会请求整个 worker 正常退出，取消后的下一次识别可重建引擎。不会为普通正常任务无条件重新初始化，也不会把强杀当作保存或正常退出。

worker 控制会话和每次识别任务分别使用随机身份。任务入口仅接受宿主固定私有任务根下的 32 位十六进制 ID；不传入待执行路径或 shell 参数。每个任务仍将 `selection.png`、`ocr.json` 和 worker 证明写入独立目录，结果包含实际 worker PID；宿主同时核对 worker/session/PID。取消和准备停止后的结果不会进入新任务。完成后原图与结果按旧合同先持久化到 OCR 数据域，继续只保留当前和上一结果；关闭输入来源插件不使 OCR 自有图片失效。

原生 task 结果写入 `dataDir/sessions/` 的受限诊断记录，worker 真实退出由可信 native controller 的 `onExit` 记录至 `dataDir/workers/`；该回调不绕过原有 `waitForExit` 的过期身份拒绝。已完成的任务不提前冒称 worker 已退出。业务输出与模型生命周期分别管理，空闲回收不删除正在使用的 OCR 自有结果图片。

## 实际验证

沿用现有 OCR 结果隔离探针，最终报告为：

`local-build/spark233/ocr-result-functional/runs/107ca14b-2df8-4589-96d6-47e8eafc7a8f/report.json`

`ok: true`，21 条检查记录通过，没有新增 Vitest 文件、依赖、测试框架或格式/平台矩阵。使用真实 Electron 45、production OCR adapter、实际离线 ImageReader 及人工 PNG，不操作真实剪贴板、截图遮罩、UAC 或用户便签。

- 完整图片与裁切图片使用同一 PID **48308**、同一 workerSessionId；两份原生证明均为 `engineInitializations: 1`，`processed` 分别为 1、2，返回不同文本、任务 ID 和图片资源。
- 同一完整样例的新引擎调用约 **783 ms**，同一引擎后续调用约 **315 ms**。另一次裁切图片约 977 ms，输入不同，不能当作同图冷暖比较。OS 缓存未清空，这里的“新引擎”不是物理机器冷启动，也不是 P95。
- 复用后的时点工作集 **58,269,696 字节**，私有内存 **31,535,104 字节**。它是任务完成后的 resident 快照，不是模型初始化或推理期间峰值，也不与旧 GUI 新进程的峰值混为同一指标。
- 原有数据边界继续通过：图片/JSON 先落盘才发布、独立 OCR 图片归属、输入消费清理、当前/上一份保留、第三份淘汰最旧、实际存储失败保留当前输出、busy 拒绝及取消不发布结果。
- 空闲机制用同一生产控制器的短 host policy **300 ms**作代表验证，等待实际进程退出和 cache 清理均完成；下一任务使用新 PID 和 `processed: 1`，没有误收旧结果。这证明空闲回收机制，不将 300 ms 写成产品默认值，也不声称已计时验证默认 30 秒。
- 停用/退出后的三个实际 worker PID **48308、40756、27260** 均由原生 close 回调记录退出码 **0**，`aliveNativePids: []`，最后所有资源域清空；CIM 复核没有 ImageReader 进程残留。

首轮报告 `8742f022-ec16-4f55-bd50-1871fc3bbdbb` 在空闲回收检查上失败：探针先看到进程退出，尚未等待异步 cache 删除完成。没有据此删除产品断言；最新检查同时等待两个完成条件。后续报告 `5ce08648-0bba-43df-979f-87137781c5f8` 已通过，最终报告另补实际 PID/exit 诊断与发布前身份守卫。

最终只读核对另外发现首轮失败探针的 Electron 宿主 PID 40280 及其 GPU/network 子进程仍在；命令行和 profile 明确属于上述隔离 run。已按核实的进程身份清理该组宿主和子进程，之后工作区应用进程数为 0。这是失败 runner 的清理，不将其计为 OCR 原生 worker 退出的新成功证据。

## 构建与可重复性

正式原生构建目录为 `local-build/spark233/native-capture-p4/build`，不是早期 P1V 的 `native-capture/build`。本次 `worker-build.log` 的 MSVC/CMake 增量构建成功。ImageReader 为 **9,506,304 字节**，SHA-256：

`4348f8ff4727655da548fb2f0d4cc2fcd64f74057b0781fa8aea7161b66b5ddd`

已通过官方 `packages/official/ocr/build.mjs` 更新 native payload 和资源散列。ONNX Runtime 和四个 app-local VC runtime DLL 未改变。后续完整输入 `87818-final-offline-catalog` 已统一重建插件归档和 Windows 包，完成成员逐字节、SRI 与当前 14 个原生文件的依赖复核，见[分发记录](spark233-packaging.md)。

为证明改动不只存在于忽略的 adapted 副本，已从固定 git 源重新运行正式 adapt 脚本。`local-build/spark233/native-capture-p4/worker-adapt-replay.json` 证明重放生成的 `main.cpp`、`OcrWorker.h`、`SessionResult.h` 与实际编译输入逐字节 SHA 一致。另修正 build.ps1 将 OpenCV/ORT 的相对参数规范化为绝对路径，现有文档中的相对路径命令可正确配置 CMake。

五个类型边界的 typecheck、修改 TypeScript 的 lint 及隔离 Electron 编译通过，日志为 `local-build/spark233/ocr-result-functional/worker-typecheck.log`、`worker-lint.log`。完整仓库 build、打包版回归与安装体积已在最终输入统一收口；最终 `measurement-1792909805347` 的两次真实 OCR 记录同一 PID/workerSessionId、一次引擎初始化及退出码 0。最后人工界面验收仍待进行，本次 adapter 代表链和打包检查不能替代它。

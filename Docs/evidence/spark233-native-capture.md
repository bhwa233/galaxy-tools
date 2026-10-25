# spark233 原生截图与 OCR 前置验证

日期：2026-10-24。阶段：P1V 技术准备，尚未接入宿主插件。采用 MVP 验证方式，只执行固定样例、真实构建和必要进程生命周期检查，不新增功能矩阵测试。

此处“尚未接入宿主插件”及下述摘要描述 P1V 当时快照；2026-10-25 正式 adapter、OCR 自有资源和失败清理的最新功能集成证据见 [本轮功能记录](spark233-functional-integration.md)。最新 OCR 报告 `local-build/spark233/ocr-result-functional/runs/a6c895ae-612a-437c-88c7-9239c795d499/report.json` 使用真实 ImageReader 和两张人工图片，16 条检查记录通过、五个原生进程退出码 0、无残留；原图/文本前端选区交互、最新完整构建和真实主宿主 UI 仍待验收，不用新增底层证据勾选全部 P4。

## 已证实

- ScreenCapture 2.5.15 源码固定在 `00f6d2b86670a3aa7cebee32515cf5cc6e965bd5`，ImageReader 1.0.2 固定在 `896830aad60f574a39fdbd9f7967177eb149cb0b`。
- 官方发布 EXE 已实际下载并重新计算 SHA-256，与 GitHub 发布元数据一致；具体大小、URL、摘要在 [sources.lock.json](../../scripts/native-capture/sources.lock.json)。
- Ling 固定 `2ae45005b2863b004b4432bfe85d6e63d7ee44ca`，TinyOCR 固定 `1a8516a055328bd15c7d428f29ffdf2893b047ec`；上游未提供与两工具发行版绑定的依赖锁，故这两个提交属于本次适配选定版本，不能冒称上游发布时的精确依赖。
- 免管理员 MSVC 14.51.36231（编译器 19.51.36260.0）与 Windows SDK 10.0.28000.0 已在本机下载、校验并解包，实际通过 CMake 编译器探测。
- ScreenCapture + Ling + Yoga，以及 ImageReader + TinyOCR + Clipper2，均已从固定源码完整编译并链接成功。最终构建日志：`local-build/spark233/native-capture/build-reader.log`；二进制摘要清单：同目录 `binaries-manifest.json`。
- OpenCV 4.14.0（`0654a42e19215ef25b1d367d822f3c630447e7c7`）的 `core` 和 `imgproc` 已按静态 CRT 精简编译成功；ONNX Runtime 1.23.2 官方 Windows x64 CPU 发布包已下载并验摘要。其 PDB 和其他开发文件不属于运行分发内容。

## 构建入口和隔离

```powershell
pwsh -File scripts/native-capture/prepare-toolchain.ps1
pwsh -File scripts/native-capture/prepare.ps1
pwsh -File scripts/native-capture/adapt.ps1
pwsh -File scripts/native-capture/build.ps1
pwsh -File scripts/native-capture/prepare-ocr-deps.ps1
pwsh -File scripts/native-capture/build.ps1 -OpenCVDirectory "$PWD/local-build/spark233/native-capture/deps/opencv/x64/vc18/staticlib" -OnnxRuntimeRoot "$PWD/local-build/spark233/native-capture/deps/onnxruntime-win-x64-1.23.2"
pwsh -File scripts/native-capture/invoke-session.ps1 -ImagePath "$PWD/local-build/spark233/native-capture/ocr-sample.png"
```

`prepare.ps1` 拒绝覆盖脏的上游源码和不一致 origin，核对固定提交和发布物摘要。`adapt.ps1` 导出全新的固定源码目录再做有明确锚点的适配，拒绝覆盖已存在的适配目录。重新验证适配时应选择新的 `OutputRoot`，保留旧证据。

最终适配脚本已在 `replay-observed` 全新导出目录重放；全部 `.c`、`.cpp`、`.h`、`.hpp` 摘要与实际编译的源文件一致，没有只存在于临时构建目录中的手动修复。

默认工作目录为仓库 `local-build/spark233/native-capture`，包含上游源码、导出源码、构建、样例及会话；不读取真实便签、用户剪贴板历史或用户 ScreenCapture 配置。共享构建工具放在 `%LOCALAPPDATA%/spark233/toolchains`。

MSVC 下载复用经审读的 [mmozeiko portable-msvc.py](https://gist.github.com/mmozeiko/7f3162ec2988e81e56d5c4e22cde9977)，固定 gist 修订及 SHA-256；其未声明代码分发许可，因此本仓不收录下载器源码。实际负载来自微软 stable manifest，并逐个验 SHA-256。上游 `msiexec /a` 的相对 MSI 路径在 Codex Store 虚拟 AppData 下返回 1619，本入口改用绝对路径，仍只解包到任务工具链目录，不安装全机 Visual Studio。另补齐固定摘要的官方 ATL 头和 x64 库。

## 对上游的适配

- CMake 取代作者 `D:/project`、`D:/sdk` 绝对路径，显式链接 Windows 系统库；缩短 MSVC 对象目录，避免长路径构建失败。
- GIF/录屏非一期承诺。构建复用上游已内置的 `cgif` 编码实现，解除外部 Rust/gifski 静态库依赖；不改变截图、标注和 OCR 选择。
- 指定 `--spark233-session` 和 `--spark233-session-dir` 时，ScreenCapture 的配置和选区 PNG 位于主进程预先建立的专属会话目录。点击取字后，当前选区保存为 `selection.png`，发布 `capture.json`，不再自行启动无法追踪的 OCR 子进程。
- ImageReader 将实际 TinyOCR 结果导出为 `ocr.json`，包括会话 ID、原生 PID、原图尺寸、行文本、置信度、行四点框及检测/识别耗时；`--spark233-batch=true` 支持完成后退出，普通交互模式保留上游窗口和部分选择。
- 批处理模式不显示 ImageReader 窗口，供宿主管理结果。其 WinRT JSON 数组需要明确引入 Collections 头，Ling 文件版本函数需要链接 `version.lib`；两项均已通过实际编译链接定位并修正。
- 结果 JSON 复用上游已使用的 Windows.Data.Json。先独占创建 `.partial`，写完并 flush 后原子改名；不覆盖已有结果。桥接不使用剪贴板。
- 最小主进程调用入口 [invoke-session.ps1](../../scripts/native-capture/invoke-session.ps1) 创建唯一目录，逐个核对协议、会话和 PID，管理退出、超时、显式终止及 finally 回收。强制终止的证据仅证明进程回收，不能作为原生业务取消协议通过的证据。
- 会话模式仅将启动、初始化、截图窗口创建/关闭及 Escape/右键取消等生命周期事件写入专属目录的 `native-lifecycle.log`，供区分正常等待框选、用户取消和结果生成；不记录其他键盘输入。保留上游 `WS_EX_TOOLWINDOW`，没有为了自动化增加任务栏或 AltTab 入口。

## 实际运行证据

最终本机构建物（非正式分发包）：

| 文件                             |       字节 | SHA-256                                                            |
| -------------------------------- | ---------: | ------------------------------------------------------------------ |
| ScreenCapture.exe                |  1,263,616 | `a17a8089f33308375f6994074fcbe97b3ba8ac4252c450b9d1a7d7c0639b6925` |
| ImageReader.exe                  |  9,470,464 | `7e69f6555a771571c3a3a86d13886b84041e1211111768991f36cf545d7cfc92` |
| onnxruntime.dll                  | 14,186,016 | `dec964ab1ee36cc9b0ae247d13b376627992fc57dec0454354017ab8fd84f1ea` |
| onnxruntime_providers_shared.dll |     22,088 | `a2b3a50956aa75a9879c8472bc7df4f7a8072bcd2db19a1b7d988e7688f293ef` |

固定 PNG `ocr-sample.png` 为 1280×340，仅包含人工生成的英文、中文、代码、小字，SHA-256 为 `e69b27a2f26384b201eae9165c6d065ed23a6130023df1f255b3b355b75543c3`。它不含桌面截图或用户数据。

真实调用会话 `799fbaca921e4df6b1b8de7908d6bfe2`：ImageReader PID 7608，退出码 0；host 总耗时 1,498 ms，原生检测 523.3831 ms、识别 60.8549 ms，协议/会话/PID 校验通过。输出四行如下，最后一行的斜杠后空格被识别器合并；这些是本次样例结果，不代表总体准确率或性能预算。

```text
spark233 OCR native session
离线截图识别：你好，世界。
const answer = 233; // local OCR
Small text 0123456789 /小字样例
```

原始 JSON、四点框和主进程结束记录均在 `local-build/spark233/native-capture/sessions/799fbaca921e4df6b1b8de7908d6bfe2/`，摘要日志为 `ocr-sample-result.log`。

主进程强制取消会话 `fcd415c6e7394a66b2cf768948d84938`：设置 500 ms 取消，实际结束 720 ms，ScreenCapture PID 31040 已退出（强制结束码 -1）。这证明主进程可回收原生任务，不证明原生 Escape/取消协议通过。

早期截图链尝试 `ad699ad99e634ef7b14929297a655c45`：以 `--auto-quit=true --enter=ocr` 启动后，ScreenCapture PID 30884 在 2,586 ms 以 0 退出，没有产出 `capture.json`，主进程正确拒绝把它当成功。保留 `capture-ocr-result.log` 和对应 `host-session.json`，不将失败降级为剪贴板回读或更换截图后端。

后续定位证实参数语义正确：`--auto-quit=true` 进入独立任务路径，绕过驻留工具的单实例互斥；`--enter=ocr` 在鼠标选区完成后才触发，释放鼠标即继续，不需要 Enter。新增日志的会话 `70751faec2ec4287a4c033951a97a703` 证明截图进程可正常持续等待，并非必定在 2.6 秒自退。早期退出的具体用户输入未被记录，不能事后断言是 Escape、右键或内部错误。

自动化边界：当前 Computer Use 的 `sky.list_windows`、`sky.list_apps` 不返回这类 TOOLWINDOW 遮罩；`sky.drag` 又要求由其返回的窗口对象。按照工具规则不猜 HWND、不另造鼠标注入通道。未经受控步骤的一次会话 `a8f5ac3dcce9464b9017bb8955e628e8` 得到 2558×1390 桌面选区，已删除其 PNG，仅保存摘要和协议元数据，也没有对该图做 OCR。一次过小选区 `6be35ded2f27482dbf3e17aa3b819291` 为 37×27、识别为空，保留为前期操作记录。

**用户手动框选 + 自动后续 OCR 的完整链路已通过。** 用户明确选择“现在方便，我来框选”后，先将同一人工 PNG 展示窗口置前，再启动完整调用入口（600 秒上限、可追踪 pwsh PID 41256）。用户只执行拖选，后续动作由入口自动完成：

- 会话：`ca411343f4f34b418c9701a9326a5191`。
- ScreenCapture PID 54148 将当前 **810×485** 选区保存为 `selection.png`，写出绑定同一会话/PID的 `capture.json` 后以 0 退出。
- 主进程校验成功后启动 ImageReader PID 43044，传入刚才的同一 PNG，没有二次框选；实际得到与固定 PNG 一致的四行文本、行框与置信度。
- OCR 检测 126.2307 ms、识别 42.4813 ms；主进程含人工框选总计 3,992 ms。人工耗时不能作为 OCR 或启动器延迟预算。
- ImageReader 以 0 退出，`host-session.json` 为 `completed`，两个子进程均 `exited: true`；后台 pwsh 已退出。

原始 PNG、`capture.json`、`ocr.json`、`host-session.json`、`native-lifecycle.log` 在该会话目录中。PNG 只包含固定样例的白色背景和四行人工文字。完整控制台输出保留在 `capture-user-live.stdout.log`，错误流为空。

已关闭隔离 PNG 展示窗口，并通过实际进程列表确认无 ScreenCapture、ImageReader 或该样例 Electron 残留；未执行截图复制或 OCR 复制操作，未改写用户剪贴板。没有新增自动化测试文件或测试矩阵。

## 初始 OCR 性能与资源依据

同一 1280×340 固定 PNG 的两个后续独立进程 batch 样本，原始数据为 `ocr-native-resource-samples.json`。在已存在磁盘缓存的机器上逐次启动新 ImageReader，按约 25 ms 间隔读取已持有的 .NET Process 对象计数；不是同一个常驻模型的暖调用，也没有模拟全机冷启动。

| 样本会话                           | 原生进程总耗时 |       检测 / 识别 | 峰值工作集 | 观测峰值私有内存 | 观测 CPU 时间 |
| ---------------------------------- | -------------: | ----------------: | ---------: | ---------------: | ------------: |
| `ae95c59d567e42b7bb7dd13032853239` |         882 ms | 338.34 / 53.77 ms | 264.65 MiB |       214.23 MiB |   3,531.25 ms |
| `27aba6166c024cefa172521a93878d00` |         883 ms | 334.34 / 71.48 ms | 264.48 MiB |       204.75 MiB |   3,625.00 ms |

CPU 为多线程累计时间，可以大于墙钟时间。两次均输出四行，协议/会话/PID校验通过、退出码 0。较早一次完整主进程调用样本为 1,498 ms，因此当前 MVP 可先用**此固定样例新进程 2 秒内完成、原生进程峰值工作集 350 MiB 内**作为暂定警戒线；它是本机样例的工程初值，不是通用性能承诺。真实样例链也证实 OCR 完成后可直接释放整个原生进程，当前不需要常驻 265 MiB 工作集。

先前外部观察 pwsh 子进程的资源记录 `ocr-resource-samples.json` 中，有一次 ImageReader 在观察器绑定前退出；其内存/CPU记录已明确改为 `null` 并写明缺测，不能将 0 当作实测值。上述表采用直接持有原生 Process 对象的两次完整采样。

## 待验证与限制

- ImageReader 完整源码链接、实际 PNG 识别、真实当前选区到 OCR 的绑定会话和进程退出已通过。P1V.1/P1V.2 可引用本记录核对；正式插件集成与 P4 验收尚未完成。
- 当前采用官方 ONNX Runtime 动态 CPU 库进行前置验证，正式平台资源需带齐依赖并实测离线安装。上游预编译 EXE 为静态库路线，两者产物体积不能混用。
- `ImgViewer::readImg` 的上游同步识别仍在独立原生进程内执行。宿主可以取消整个进程，但交互式取消、模型常驻复用、UI 错误展示和正式 SDK 任务协议留待实际集成。
- 尚未验证多屏/DPI、标注后的坐标映射、全部与部分复制、OCR 停用、崩溃恢复或最终安装包，P4/P7 相关任务不标记完成。
- 本次只使用一个人工数据样例和少量重复采样，未建立冷暖分位数、完整宿主进程树内存或广泛质量预算；上述样例警戒线不能单独支持 P1V.5 全部完成。
- 依赖和上游许可文件保留于导出源码中。授权沿用用户已明确确认的方案，本记录不重新设置授权门槛；正式分发仍需归集必要声明。

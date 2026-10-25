# OCR 停用后的动作降级补齐

日期：2026-10-25。范围：P2.6 / P4.8 的宿主入口审查、原生截图工具栏实时显隐、固定源码重放与原生编译。没有操作 Windows 桌面，没有打开截图遮罩，没有读写真实剪贴板或用户笔记。

## 审查结果与修复

截图插件的独立命令是 `spark233.screenshot` / `ocr`，其可选依赖是 `spark233.ocr`，兼容范围 `^0.1.0`。原实现的 `PluginManager.commands()` 仅按命令所属插件启停过滤，管理页也直接展示 manifest 的公开命令，因此停用 OCR 后，截图插件自己的“截图取字”入口仍可能可点击。已将这条真实缺口交给本轮主任务统一处理，避免在通用宿主中写死截图业务 ID；该宿主改动与门禁结果由主任务记录。

原生链原本已有以下保护，已核对当前源文件与固定构建输入：

- `electron/plugins/official/capture.ts` 在直接 OCR 激活前检查 availability；停用时不会创建截图会话或启用其他识别后端。基本 `capture` 不要求 OCR 可用。
- 截图会话目录中的 `ocr.disabled` 由宿主每 250 ms 同步；宿主接收选区后还会再次检查 OCR 状态。
- `native/capture/SessionResult.h` 的 `ocrAllowed()` 同时检查启动参数与会话停用标志；原生 `WinCap::startOcr()` 在执行前拒绝不可用 OCR，并用中英文提示基础截图和标注仍可使用，检查发生在上游识别或下载回退之前。
- 原有 toolbar 只在创建时隐藏 OCR：会话进行中停用 OCR 后，已创建按钮尚未刷新外观，虽然点击会被动作检查拒绝。

本轮在正式适配源 `scripts/native-capture/adapt.ps1` 补上最后一项：`ToolCap` 复用 Ling 已有的窗口计时器、`Node.hide()/show()` 与 `WinCap::layoutTool()`，每 250 ms 核对 availability，仅显隐 OCR 节点并重算工具栏尺寸与位置，同时关闭该节点的悬停提示。其他工具节点与选区/标注对象不重建，窗口销毁时释放计时器。原有动作检查继续保留；发生状态变化时会写入 `capture-ocr-button-hidden` / `capture-ocr-button-restored` 会话日志。

启动时已禁用 OCR 的会话继续遵守 `--spark233-ocr-enabled=false`，即使随后移除标志也不自行开放识别；用户启用 OCR 后可重新打开截图。启动时允许 OCR 的会话可随宿主停用标志隐藏按钮，用户重新启用后恢复按钮；上述恢复仅反映宿主状态，不启用任何插件。

## 实际执行的验证

完整机器报告：[report.json](../../local-build/spark233/ocr-disable-followup/report.json)。详细日志：同目录 `adapt.log`、`build.log`、`availability-build.log`、`availability-true.json` 与 `availability-false.json`。

1. 从 `sources.lock.json` 的四个固定 Git revision 重新执行 `scripts/native-capture/adapt.ps1`，独立输出到 `local-build/spark233/ocr-disable-followup/adapted`，四个源仓 revision 与 lock 相同。
2. 将正式重放生成的 `ToolCap.cpp`、`ToolCap.h`、`WinCap.cpp` 和截图端 `SessionResult.h` 用于现有 P4 原生构建，并逐文件比较 SHA256，均与重放字节相同。初次严格比较发现旧生成目录的 `WinCap.cpp` 换行和 `SessionResult.h` 的 worker 条件编译段较旧，已同步正式重放后重建，没有只修改忽略目录来代替正式适配源。
3. 执行 `scripts/native-capture/build.ps1`，使用已有本地 MSVC/CMake/Ninja、OpenCV 与 ONNX Runtime，成功链接 ScreenCapture。日志保留上游已有的 C4244 数值转换警告；没有编译错误。
4. 在隔离目录编译并执行一个不创建窗口的 C++ probe，直接包含生产 `native/capture/SessionResult.h`：运行中创建 `ocr.disabled` 会撤销 availability，移除后仅恢复启动时已允许的会话，启动时禁用的会话始终不可用。两次进程均返回 0，没有启动 ScreenCapture 或 ImageReader。probe 仅是 `local-build/` 下的一次性验证文件，没有新增测试套件或依赖。
5. 将新 ScreenCapture 复制到官方截图包的 native 输入路径，并核对包内输入与构建散列相同；ImageReader 散列没有变化。本分工没有重建插件 tgz、`dist` 或 Windows 安装包，统一产物构建由主任务完成。

正式原生构建命令：

```powershell
./scripts/native-capture/build.ps1 `
  -OutputRoot local-build/spark233/native-capture-p4 `
  -OpenCVDirectory local-build/spark233/native-capture/deps/opencv/x64/vc18/staticlib `
  -OnnxRuntimeRoot local-build/spark233/native-capture/deps/onnxruntime-win-x64-1.23.2
```

| 原生输入                                                          | SHA256                                                             |
| ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| `local-build/spark233/native-capture-p4/build/ScreenCapture.exe`  | `6280D49F553DEFE5A85521DA6F32CB27ADF96B3E140310D99E71BE6150EAE146` |
| `packages/official/screenshot/native/win32-x64/ScreenCapture.exe` | `6280D49F553DEFE5A85521DA6F32CB27ADF96B3E140310D99E71BE6150EAE146` |
| `local-build/spark233/native-capture-p4/build/ImageReader.exe`    | `4348F8FF4727655DA548FB2F0D4CC2FCD64F74057B0781FA8AEA7161B66B5DDD` |

## 保留的验收边界

这次证明固定源码适配可重放、完整原生程序可编译、生产 availability 检查会随停用标志变化，不能将它写成已完成物理遮罩验收。按用户安排，最后仍需使用隔离配置人工验证：已开始的选区中停用 OCR 后取字按钮隐藏、旧位置点击不触发识别或下载、基础标注/复制/保存仍可用、在允许恢复的会话重新启用时按钮出现，以及多屏 DPI 下工具栏不移出可视范围。宿主 250 ms 同步与 native 250 ms 轮询属于正常调度下约两个采样周期的传播机制，不是实测延迟上限。

P2.6 / P4.8 是混合实现及真实交互条目，本报告不单独将整项勾选。宿主共享改动由主任务运行项目选定 Node/npm 下的 typecheck、lint、测试及最终构建；本分工实际执行的是上述原生重放、编译与无窗口代表检查。

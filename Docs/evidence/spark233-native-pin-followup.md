# 原生置顶失败诊断与状态重算补齐

日期：2026-10-25。结论：新打包 smoke 的 pinned native level 失败已经用三次独立源码运行复现；补上显示和几何变化后的重算后仍然失败，时序诊断进一步证明宿主请求 true 后立即读取仍为 false。当前不能宣称 Windows smoke 通过或问题已解决。没有放宽断言、增加测试套件或修改 C# watcher。

## 实际失败

初始打包报告为 `local-build/spark233/parallel-followup/smoke-1792920722664/report.json`，在既有 `verifyUnifiedNoteList()` 的 “Opening a pinned preference did not apply the expected native window level” 断言超时。此前报告只有错误，没有记录 actual / expected，因此先补充最小诊断。

`electron/smoke-note-list.ts` 保持原有相交公式、成功条件和 80 次、每次 50 ms 的等待不变，仅在该 `until()` 超时后的 catch 中附加 actual、expected、layout、bounds、fullscreenRects、visible、minimized、focused；没有给产品增加调试日志。

两个全新独立配置分别运行现有完整 Windows smoke：

| 执行                              | 报告                                                                  | 结果           |
| --------------------------------- | --------------------------------------------------------------------- | -------------- |
| 仅增强诊断                        | `local-build/spark233/pin-diagnostic/smoke-1792921150645/report.json` | 同一断言失败   |
| 按授权补齐 show / remember 重算后 | `local-build/spark233/pin-diagnostic/smoke-1792921301372/report.json` | 同一断言仍失败 |

两次诊断值完全同方向：

```json
{
  "actual": false,
  "expected": true,
  "layout": { "topmost": true, "visible": true, "everOpened": true },
  "bounds": { "x": 3481, "y": 1075, "width": 360, "height": 420 },
  "fullscreenRects": [{ "x": 0, "y": 0, "width": 2560, "height": 1440 }],
  "visible": true,
  "minimized": false,
  "focused": true
}
```

逻辑 pin 没有丢失，当前窗口与报告的 fullscreen 矩形不相交，runner 应要求 native topmost 为 true，实际却为 false。窗口并非隐藏或最小化。两次先行的胶囊、编辑模式与提醒代表检查通过，但完整 smoke 在此终止，不能由先行局部结果推导完整通过。

## 代码判定与本轮最小产品改动

`electron/main.ts` 的 `applyNoteTopmost()` 与 runner 的 `fullscreenSuppressed()` 四边相交条件相同；宿主没有额外 visible、minimized 或 focus 分支。也已从本轮 release 的 `app.asar` 内存读取宿主函数，确认打包代码使用同一公式。

核对发现的确定事件缺口是：新窗口创建时应用一次 native topmost，之后 `remember()` 的移动/缩放持久化路径、窗口 show 事件没有按最新几何位置重新应用；watcher 只在 fullscreen 观察结果改变时回调，因此稳定 fullscreen 下的跨边界移动可能留下旧 native 状态。按主任务授权，仅在 `remember()` 更新 bounds 后，以及 `win.on("show")` 内，各复用一次已有 `applyNoteTopmost()`。没有新增 helper 或依赖，没有改变 pin 偏好持久化。

这两行补齐没有消除本次观察到的 false / true 失败，尚未证明其对跨边界行为的实机效果，不能把它描述成已验证的故障修复。改动和诊断保留，由主任务决定后续处置；本分工在第二次失败后没有进行第二轮推测改动。

另一个待诊断写入者是 `electron/assets/FullscreenWatcher.cs`：它每 650 ms 对 nearest monitor 与外部 fullscreen 相同的 managed HWND 调用 `SetWindowPos()`，而 JS 侧按矩形相交判断。`electron/windows.ts` 的 managed handle 列表只排除 destroyed，C# 每轮持续写 Z 序，但只在 `rect` / `none` 变化时输出给 JS。该双写机制是后续检查对象，现有报告没有 native watcher 每次写入记录或 raw native style，不能据此断言它就是根因。本轮没有删除或修改此逻辑。

## 验证环境与隔离

- 使用项目选定 Node `26.12.1` / npm `12.2.1`。
- `npm run typecheck` 通过；`npm exec -- oxlint electron/main.ts electron/smoke-note-list.ts` 通过。
- `tsc -p electron/tsconfig.json --outDir local-build/spark233/pin-diagnostic/app/dist-electron` 通过，独立编译输出没有覆盖根目录 `dist-electron`。
- 源码 app 复用现有前端 `dist`、`dist-plugins`、`dist-host` 与已安装 `node_modules` 输入；复制现有 Electron assets。没有重新构建插件 tgz、原生程序或 Windows 安装包。
- 复用 `parallel-followup/prepare-smoke.mjs` 和 `run-smoke.ps1` 的隔离逻辑，放在 `local-build/spark233/pin-diagnostic/` 下，仅将启动方式切换为已安装 Electron 加独立源码 app，检查运行环境为源码模式。现有业务 smoke 断言未变，这些结果属于源码运行，不是新的打包验收。
- 冻结样本仅复制到每次新运行目录；两次结束后核对冻结源和运行副本的固定 Markdown、图片 SHA256 均保留。
- 两个隔离剪贴板库分别以 SQLite 只读连接检查，均 `paused=true`、entries 为 0；没有读取实际用户剪贴板。
- 诊断 PID `7708` 和重算补齐后 PID `52900` 均已退出，桌面已释放。

机器汇总为 `local-build/spark233/pin-diagnostic/validation.json`；编译与类型日志分别为同目录 `compile.log`、`compile-fixed.log`、`typecheck-fixed.log`，每次运行目录各保留 `run.json`、`process.json`、`report.json`、stdout/stderr 和现有 smoke 截图。

## 后续最小诊断

先确定 native false 是在哪个应用时点出现：观察创建、show 后立即读取的 native topmost，与外部 watcher 后续 SetWindowPos 的时序；如果需要进一步运行，应继续使用新隔离 profile。现有报告只提供超时快照，不能用它区分 Electron 原生窗口层级应用失败、后续 native 重排或其他 OS 状态变化。不要放宽当前 false / true 断言，也不要在缺乏因果证据时删除 fullscreen 避让逻辑。

## 第三轮受控时序诊断

按主任务追加授权，仅在同时满足 `SPARK233_SMOKE=1` 和 `--smoke-output=...` 参数时输出 JSON 时序日志：`main.ts` 记录每次 `applyNoteTopmost()` 的时间、label、bounds、逻辑 pin、blocked、requested 与同步 actual-before / actual-after；`windows.ts` 记录 watcher 原始 line、原有 `screenToDipRect()` 结果与显示器 bounds / scaleFactor。正常产品路径不会执行这些日志及额外读取，没有改变 C# 观察/重排逻辑或 smoke 业务断言。

第三次 fresh profile 为 `local-build/spark233/pin-diagnostic/smoke-1792921474849`，`report.json` 仍在相同断言失败；完整时序在 `stdout.log`，抽取及隔离核查为 `local-build/spark233/pin-diagnostic/timeline-validation.json`。本轮独立源码编译和三文件 oxlint 均通过。

关键证据：

- watcher 原始 `rect 0 0 2560 1440` 转成 DIP 后完全相同；显示器 1 为 `{x:0,y:0,width:2560,height:1440,scaleFactor:1}`，显示器 2 为 `{x:2560,y:346,width:2560,height:1440,scaleFactor:1}`，这次失败没有 DPI 坐标变换分歧。
- 目标 note `d8b5b75f-1dc0-4f49-b755-0b9bc8138bb9` 在显示器 2，bounds `{x:2744,y:572,width:360,height:420}`。日志第 61–64 行记录创建/显示阶段的四次调用，全部为 `logicalPin=true,blocked=false,requested=true,actualBefore=false,actualAfter=false`。最后两次退出清理中的重算第 68、71 行也同样如此。
- 因此不是宿主在这几次调用中请求了 false，也不是仅在稍后才观察到 native false；同步 `setAlwaysOnTop(true)` 后紧接 getter 就返回 false。当前优先排查 Electron API/native window 层级应用与底层原生属性，不能继续将 watcher 覆盖当作已证实原因。
- 诊断 PID `14564` 已退出；第三次剪贴板库仍 paused、零 entries；冻结源及运行副本的固定 Markdown 和图片 SHA256 保留，桌面已释放。

本轮没有进一步产品策略修复，未重建 Windows 包。两个几何重算补齐保留供主任务评审；完成下述独立 runtime probe 后，`main.ts` / `windows.ts` 的临时时序 console 已全部移除，仅保留原 smoke 超时消息增强。

## 独立 Electron 45 runtime 边界对照与冻结

按主任务授权，在 `local-build/spark233/pin-runtime-probe/9654c1f4-a700-4b1f-a679-32baf29a1253/` 创建一次性独立 Electron app，使用私有 userData，不加载产品宿主、watcher、插件或剪贴板。`report.json` 记录完整运行版本、argv、窗口参数、显示器信息及每个时点；`main.mjs` 是可复核的一次性 probe 源码。

实际 runtime 是 Electron `45.0.0`、Chrome `156.0.8078.48`，其内嵌 Node 为 `24.22.0`；这与运行源码编译命令所选的 Node `26.12.1` 是两个不同运行时，均按实际值记录。两种小窗口分别使用普通 `frame=true,transparent=false,skipTaskbar=false`，以及产品相同组合 `frame=false,transparent=true,skipTaskbar=true`，共享 sandbox/contextIsolation 启用、nodeIntegration 关闭的设置；创建后 show，再调用 `setAlwaysOnTop(true)`，立即、250 ms 和 1000 ms 读取均为 false，随后 `setAlwaysOnTop(false)` 读取也为 false。

这个对照证明相同 API 读数失败可以在产品逻辑以外出现，因此不应通过重写 native helper 或放宽 smoke 断言绕过。它还不能定位具体 OS、Electron 或窗口系统原因：普通 frame 样本在 `show()` 后的 `isVisible()` 为 false、`isFocused()` 为 true，产品组合为 visible/focused 均 true，报告保留这些异常读数而没有将“show 已调用”写成普通窗口物理可见已确认。启动沿用 Windows `Start-Process -WindowStyle Hidden`，这也是解释普通窗口可见性读数时必须保留的环境条件。

成功执行轮的两窗口均调用 close，随后 `app.quit()` 正常退出。最初一次 probe 采用顶层 `await app.whenReady()`，未推进 ready、未生成结果；仅该已核对身份的隔离 PID `11424` 被停止，改为仓库现有集成脚本相同的 `app.whenReady().then(async ...)` 后才得到上述成功执行报告。这个 bootstrap 问题单独保存在 `bootstrap-note.json`，不作为产品故障证据。

最后清理后重新执行独立源码编译、项目 `npm run typecheck` 和三文件 oxlint，均通过，日志为 `compile-frozen.log`、`typecheck-frozen.log`。没有再次启动已明确失败的 smoke，也没有重打 Windows 包或覆盖根目录 dist。冻结源码哈希与范围见 `local-build/spark233/pin-diagnostic/source-freeze.json`。现有原包仍对应最初 overall 失败；两处几何重算补齐和失败消息增强属于后续源码，不在该冻结包内。

主线程收口：临时时序日志移除并冻结后，项目选定 Node 26.12.1 / npm 12.2.1 下的最终完整 npm run build（含五边界 typecheck、前端/七包/宿主编译）返回 0；日志为 local-build/spark233/pin-diagnostic/final-build.log。未再次运行已知失败的 native smoke，也未将该后续源码打成新的 Windows 候选。

后续进展：正常可见启动与明确 Windows 层级对照已进一步定位默认 floating 的任务栏后排路径；最终明确层级已有完整源码 smoke 成功，独立打包验收继续进行。最新修复、失败策略与证据边界见 [Windows 置顶续修](spark233-native-pin-repair.md)。本页原失败报告和历史结论不改绑。

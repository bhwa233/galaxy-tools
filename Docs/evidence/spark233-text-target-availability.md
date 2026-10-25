# P6.8 跨插件动作目标可用性补齐

日期：2026-10-25。本轮完成生产 UI 接线与静态门禁，尚未执行共享 build、Windows 打包或 UI 操作。实际窗口中的启停、选区保持和多语言检查由最后集成验收补充，不以本报告整体勾选 P6.8。

## 真实缺口与当前行为

原剪贴板 wrapper 无条件提供文本发送和图片 OCR 回调，工作区按钮只检查 busy、内容和回调是否存在。OCR 结果页和翻译结果页的保存便签按钮也没有目标状态。停用翻译、便签或 OCR 后，原入口仍可点击，直到宿主 manager 拒绝请求才显示错误。

本轮在现有 Launcher 读取已过滤的 `LauncherState.commands`，逐个按插件 ID、命令 ID 和 `enabled` 判断目标可用性；通过既有工作区 props 传递，不增加 store、轮询、第三方依赖或公共 helper 框架。

| 用户动作         | 精确目标命令                         |
| ---------------- | ------------------------------------ |
| 发送/保存便签    | `spark233.notes` / `new`             |
| 发送文字查词     | `spark233.translation` / `search`    |
| 发送文字 AI 翻译 | `spark233.translation` / `translate` |
| 剪贴板图片取字   | `spark233.ocr` / `ocr`               |

命令尚未载入、被停用、运行错误或所需命令缺失时，对应按钮禁用；鼠标提示和旁边可读状态文字说明“目标动作不可用，请在插件管理中启用或恢复对应插件。”英文为 “This action is unavailable. Enable or recover the corresponding plugin in plugin management.” 只新增一个中英文公共 locale key，没有复制到各工作区语言表。其他可用目标继续使用，复制等不依赖这些目标的动作保留。

修改涉及：

- `src/features/launcher/Launcher.tsx`：根据准确命令推导目标状态并传给工作区。已有初始化 `refreshState()`、`plugins-changed` 与 `launcher-status-changed` 监听无条件发生在工作区返回之前，包含独立插件窗口，不只覆盖主启动器。
- `src/features/launcher/ClipboardPanel.tsx`：把目标状态和原因传入 ClipboardWorkspace；发送文本和图片 OCR 的 wrapper 也先检查当前 props，避免组件内部或客户端旧动作继续调用不可用目标。
- `src/features/clipboard/ClipboardWorkspace.tsx`：文本目标按钮与图片 OCR 按钮按目标状态禁用并解释原因，文本发送函数也检查目标。
- `src/features/ocr/OcrWorkspace.tsx`：查词、AI 翻译和保存便签按各自目标状态禁用，发送函数保留相同前置检查。可用性 props 更新不会替换结果 session 或重置编辑状态。
- `src/features/translation/TranslationWorkspace.tsx`：离线词条和 AI 译文的两个保存便签入口均检查 `notes/new`；导出函数也拒绝不可用便签目标，复制不受影响。

宿主 `text_action`、`clipboard_image_ocr` 与 manager 的启停/错误/命令检查没有修改。UI 与启停事件之间可能存在异步窗口，实际 dispatch 仍由宿主拒绝，前端状态不构成权限或生命周期授权。

## 实际验证

使用项目选定 Node `26.12.1` / npm `12.2.1`：

- `npm run typecheck` 通过，覆盖项目现有五个 TypeScript 边界。
- 对五个修改的 TSX 文件执行 `npm exec -- oxlint ...`，通过。
- 仅对五个 TSX 与两份公共 locale 文件执行 `oxfmt --write`，随后 `oxfmt --check` 通过。
- 源码与 manifest 核对：四个目标命令均为真实公开命令；Launcher 已有插件状态事件会更新主窗口与独立工作区实例。

没有新增或修改测试文件，没有启动任何程序/桌面、截图或真实剪贴板，没有写入运行配置、插件状态、笔记或历史数据。本分工没有执行共享 build、重建插件档案或 Windows 包。源文件散列与检查范围记录在 `local-build/spark233/text-target-availability/source-freeze.json`。

## 根任务可执行的代表 UI 验收

使用 `local-build/` 下 clipboard paused 的合成 profile，保持一个独立剪贴板工作区与插件管理窗口：

1. 选择合成文字，停用翻译插件，确认查词和 AI 翻译禁用且显示原因；发送便签在便签插件启用时仍可用。启用翻译后两动作恢复，选择片段后查词只使用该片段。无需为验证启停降级配置 AI 网络服务。
2. 停用便签插件，确认剪贴板“发送便签”、已有 OCR 结果页“保存便签”、离线词条及已有 AI 译文的两个“保存便签”入口禁用；恢复后恢复可用。复制动作保持可用，但不需要实际操作真实剪贴板来验按钮状态。
3. 选择受控图片条目，停用 OCR 插件，确认“图片取字”禁用且显示原因；不启动截图遮罩。
4. 保持工作区窗口打开，在另一窗口切换目标插件，确认无需关闭重开就更新按钮，同时未提交编辑和文字选区按既有交互规则保持；主启动器内工作区也检查一个代表。
5. 简体中文与英文分别确认原因文字正常；可直接复用同一组代表目标状态，不铺设逐动作/逐语言完整矩阵。

上述是待执行验收步骤，不是本轮已完成操作。P6.9–P6.12 的草稿、合并、图库与剪贴板原始格式逻辑未在此改动。

## 备份维护后的状态读取错误残留

同日主任务实际 Windows UI 验收报告：`backup_create` 成功、关闭对话框且命令列表已恢复后，主启动器仍显示“暂时无法完成操作 / 正在备份或恢复，请稍后重试”。后续自动回归确认：维护允许 `launcher_state`，实际被拒绝的是 `launcher_query`，其失败曾与业务动作共用 `error`；后续成功查询没有清除这次暂态读取失败。此前仅分离 `stateError` 没有完整覆盖该实际故障。

`Launcher.tsx` 最终分别使用 `stateError`、`queryError` 和业务动作 `error`，既有 generation 与 mounted 守卫保持不变。同代状态读取/查询成功只清除自己的读取错误，不清除业务动作错误；模式返回、切换、新输入和进入工作区按语义清理旧查询错误。主启动器和工作区按 `error ?? stateError ?? queryError` 展示，业务动作错误优先。

早期 `stateError` 静态修复散列保留于 `local-build/spark233/lifecycle-followup/launcher-state-error-source-freeze.json`；最终修复与自动回归散列见下文。没有修改 manager 或 BackupDialog，main 仅在既有 `runSmoke` context 注入真实 `showLauncher` / `pauseForBackup` 回调，没有增加生产 IPC 或替换宿主行为。

## 真实维护错误的自动红绿回归

按用户要求，在现有 `electron/smoke.ts` 加入一条代表回归，使用真实 renderer、现有事件、真实维护 gate 与 DOM，不 mock transport、plugin manager 或返回值，不新增测试套件/依赖。注释记录了已观察故障。同一局部检查函数既用于 `--smoke-launcher-maintenance` 快速模式，也在默认完整 smoke 成功报告前执行，避免复制两套断言。

该回归等待真实命令列表完成初始查询，再调用实际 `pauseForBackup()`。实际 `launcher_state` 继续成功，`launcher_query` 返回 `maintenance`；发出已有 `plugins-changed` 事件使 renderer 刷新状态并执行真实查询，观察到维护错误。解除维护并再次刷新后，等待命令重新查询成功，断言原维护横幅消失。随后在维护期间通过真实 renderer 选择既有 `notes/search` 模式，使 `recordLauncherMode()` 产生实际业务动作错误；恢复后成功后台查询必须保留这次业务错误。没有 Windows 点击或截图，也没有新增业务 fixture。

实际结果：

| 输入                                             | 报告                                                                                 | 结果                                                                                                                      |
| ------------------------------------------------ | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 已有 `stateError`、尚无 `queryError` 的 renderer | `local-build/spark233/launcher-maintenance-regression/run-1792929044924/report.json` | 按预期失败：命令已恢复，`afterRecovery` 仍含维护错误；决定性错误 `Recovered launcher retained its maintenance read error` |
| 修复后的 renderer 与当前同一检查                 | `local-build/spark233/launcher-maintenance-regression/run-1792929431142/report.json` | 通过：维护拒绝确实显示、命令恢复、`afterRecovery=[]`、暂态错误自动消失、业务动作错误保留                                  |

红基线源码保存在 `Launcher-before-query-error.tsx`，renderer 在 `red-dist/`；测试/构建与两个 fresh profile 均位于 `local-build/spark233/launcher-maintenance-regression/`。旧源码把 query catch 写到业务 `error`，不会由成功查询清理，因此恢复后的横幅断言会失败。恢复该旧 renderer 到隔离 app 的 dist 后，可用同一 `--smoke-launcher-maintenance` 入口重放，不能覆盖工作区源码或共享 dist。

选定 Node `26.12.1` / npm `12.2.1` 下，完整 typecheck、smoke/main/Launcher 定向 oxlint、格式检查及隔离 Electron 编译/renderer build 均通过。成功自动运行使用 Electron `45.0.0` 源码模式；这是定点 renderer 回归通过，不等同于最终 Windows 包或完整 smoke 通过。完整 smoke 的集成执行由根任务统一产物完成。最终源散列、两次退出状态、暂停剪贴板和固定样本散列核查写入同目录 `source-freeze.json` / `isolation-report.json`。

## 剪贴板文本目标启停的自动红绿回归

同日增加一条跨插件代表回归，复用现有 `local-build/spark233/functional-integration/inspect-renderer.mjs --text-target-regression` 入口。使用隐藏 Electron Chromium 加载实际打包 `dist/index.html?view=launcher&workspace=clipboard`，运行真实 `App → Launcher → ClipboardPanel → ClipboardWorkspace`；没有替换 React 组件、hook 或状态机，也没有新增测试依赖、产品 IPC、产品源码修改或共享构建。

受控 preload 只承接本场景需要的 desktop bridge，`launcher_state` 返回实际 `LauncherController.state()`，数据来自实际 `PluginManager` 和已验证 SRI 的官方 notes/clipboard/translation 包。切换调用真正的 `manager.setEnabled()`，然后通过既有 `plugins-changed` 事件让真实 Launcher 刷新。旧、新 UI 共用当前同一宿主，因而红绿差异定位在真实 Renderer 中，不能据此推断旧版完整宿主的行为。

所有配置、插件安装、SQLite 历史、Markdown 便签和 Chromium profile 都位于 fresh run 目录。仅通过真实 `ClipboardHistory` 显式捕获一条合成文字，设置 `paused=true` 后关闭 seed 实例；随后由官方 clipboard backend 读取这份实际历史，没有启动 clipboard native listener。便签按钮走实际 notes backend、`createNotesRuntime` 与 `NoteStore`，写入隔离 Markdown。受控 bridge 拒绝所有非 notes 的 `text_action`；因此旧版错误发送的 dictionary/translate IPC 被记录但没有执行查询或网络请求。没有访问 Windows 剪贴板、截图遮罩、UAC 或用户资料。

同一场景为翻译启用 → 停用 → 恢复。基线选择 `Selected Spark233 中文`，DOM 实际选区为 `[17,37)`。停用后要求两个翻译动作禁用而便签可用、文本和选区不丢失；点击被禁用按钮不得发送 IPC；独立便签动作必须真正保存选中片段。恢复后两个翻译按钮重新可用，并继续保留文本及选区。最后核对实际 clipboard 仍暂停、原记录 ID/原文和单条数量不变。

| 实际 Renderer 输入                                              | ASAR SHA-256                                                       | 结果                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| `ui-error-followup/release/win-unpacked/resources/app.asar`     | `24ffc934d2a8a01ab7166ef6e61638d13c5fb45007a6d8a2d4a16e8575ef1d0f` | 启用基线成功；真实 manager 已撤下翻译命令，两个按钮仍未禁用，实际发出 dictionary/translate IPC，2 项按预期失败 |
| `lifecycle-ui-followup/release/win-unpacked/resources/app.asar` | `0f671b2e94353681c07e6dc8ba714379e1fa3cf15c8e4b4d15f0948c5167848e` | 同一组 9 项检查全部通过                                                                                        |

报告为 `local-build/spark233/functional-integration/text-target-runs/1057bcd0-765a-4aad-8ab9-3a8f0321bd46/report.json`，含原始 DOM、过滤后的 command state、桥接调用、5 份输入散列、官方档案 SRI 和 3 个 utility PID。全部 utility PID（52008、50460、33628）退出。历史开发中两次 harness 启动问题分别是 Electron ASAR 根文件读取消歧义和 ESM ready 等待，不是被测产品失败；最终报告来自修正后的同一有效回归。

复现：在项目根目录先 `. ./scripts/use-toolchain.ps1`，再执行 `node local-build/spark233/functional-integration/inspect-renderer.mjs --text-target-regression`。默认保留上述旧、新包身份；新候选可通过绝对路径环境变量 `SPARK233_TEXT_TARGET_ASAR` 指定，旁边必须有该候选的官方 `plugins/` 目录。`SPARK233_TEXT_TARGET_OLD_ASAR` 可显式指定真实旧基线。每次使用新的 run 目录，不覆盖历史报告。

该结果仅验收上述代表 Renderer 行为，不是最后完整 Windows 包 smoke、视觉排版、多语言、便签停用或 OCR 图片目标的矩阵验收。它不把 `lifecycle-ui-followup/artifact-static-report.json` 中尚未执行的 packaged smoke 改为成功；后续候选仍须绑定自己的构建、静态检查与 smoke 结果。

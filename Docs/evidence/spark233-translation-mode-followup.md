# P6.7 默认动作与手动词典 / AI 切换集成证据

日期：2026-10-25。结论：原 P6.7 的代表功能链已经通过真实隐藏 renderer 集成验证，并补齐完整候选主进程的显式 AI 门禁，没有发现需要修改的生产功能缺口。建议根任务结合下述两层证据勾选 P6.7；本分工不修改总 TODO 或完成审计。

## 原始要求与现有实现

TODO P6.7 要求“自动判定词典/AI 默认动作并保留手动切换，不随每个按键或剪贴板变化发送 AI 请求”。架构 10.5 补充：英文单词/词形与收录短语优先本地词典，句子和未收录输入提供待执行 AI 入口，用户可手动纠正默认动作，不能仅用字符长度决定。

默认动作由生产 `LauncherController` 和 manifest 的 `search: word` / 显式 `translate` 命令共同决定。默认查找只调用本地 provider；AI 命令本身没有自动 search 策略。`TranslationWorkspace` 始终保留本地搜索与 AI 两个通道，选择本地词条将词填入 AI 原文，AI 请求只从显式按钮进入；输入变化只更新/取消当前状态。

既有 `translation/verify-translation.mjs` 已证明实际词库、词形/短语、流式、缓存、取消、provider 错误和回收。本轮不重复这组底层边界，仅补之前缺少的真实 renderer 默认动作与人工选择路径。

## 本轮实际运行

复用现有 `functional-integration/inspect-renderer.mjs` dispatcher、`text-target-preload.cjs` 控制桥和 PluginManager/LauncherController/official backend 入口，增加一个 `--translation-mode-regression` 本地验证分支。没有新增 Vitest、测试框架、公共 helper 或生产测试 API。

机器报告：`local-build/spark233/functional-integration/translation-mode-runs/8d8a534d-2b48-4447-bc05-ae9fd727e93b/report.json`，`ok=true`，10 项检查均通过。

1. 在实际 Launcher 输入控件连续输入 `h` → `he` → `hel` → `hell` → `hello`。真实默认查询返回 `hello` 离线词典条目，同时保留 AI 命令；provider 请求数为 0。
2. 选择实际 `hello` 结果，TranslationWorkspace 的离线词条及 AI 原文都为 `hello`；仍无 provider 请求。主动按“按默认方向翻译”后，才产生第 1 次 HTTP 请求，实际 UI 显示受控返回值。
3. 在同一工作区主动查询并选择 `take off`，实际离线词条显示该短语；provider 请求数保持 1，证明 AI 后可返回本地通道。
4. 返回 Launcher，输入 `Please explain this example sentence.`。出现待执行 AI，默认列表没有伪造本地释义，provider 请求数仍为 1。打开 AI 工作区只移交原文；发送一次合成 `clipboard-changed` 事件后，请求数不变。主动按翻译按钮后才产生第 2 次请求。
5. 返回 Launcher，主动选择本地词典模式，再输入同一句子。实际 `launcher_enter_mode` / `launcher_query` 携带 `spark233.translation:dictionary`，强制走本地模式；provider 请求数仍为 2。

本地受控服务只收到以下两次 `/v1/chat/completions` 请求：

| 原文                                    | 触发                           |
| --------------------------------------- | ------------------------------ |
| `hello`                                 | 用户从本地词条主动选择 AI 翻译 |
| `Please explain this example sentence.` | 用户打开待执行 AI 后主动按翻译 |

服务监听临时 `127.0.0.1` 端口，不调用外部模型，配置和缓存写入本轮独立 translation 数据目录。runner 不加载原生 clipboard、截图或 watcher，不读写 OS 剪贴板。控件行为通过隐藏 Chromium 的真实 React 事件和真实 backend 完成，没有 Windows 点击、截图或物理焦点验收。

## 固定输入与归属边界

本轮从 `automated-followup` 候选读取输入，并先复制到本次 `run/input/` 固定，未修改共享包或源码：

| 输入                    | SHA256                                                             |
| ----------------------- | ------------------------------------------------------------------ |
| `app.asar`              | `20dc4cb726d33889b94bfc4b374d94f74ad44e9458e76fc182f0b5918779988c` |
| `translation-0.1.0.tgz` | `97d6f94073a0058ca05bfbe6e3facfe41eadb67032286b8a8df19ae00c2a5c11` |

翻译归档同时通过 packaged index 的 SHA512 SRI。manager 将实际官方包安装进本轮私有 versions/data/cache，utility PID `49312` 在停机后已确认退出，`allUtilityPidsExited=true`；隐藏窗口和 loopback 服务已关闭。

renderer 与 host-controller / manager / backend 均来自上述实际候选包。控制桥只转发本轮允许的 desktop IPC；官方主进程中“打开 AI 只传入文本，detail 打开工作区”的窗口呈现规则在 harness 中以返回 workspace envelope 表达。该报告单独只能证明实际 React 控件、控制器和业务 backend 的集成，不能单独当作完整 `main.ts` 的显式 AI 门禁证据；为此实际追加下节独立完整宿主运行。

## 完整候选主进程的显式 AI 门禁

复用现有 packaged measurement 的 CDP / production bridge 方法，`translation-host-gate.mjs` 将整个 `win-unpacked` 复制到 fresh `local-build/` 运行目录，使用真实 `spark233.exe`，不锁定或修改共享候选目录。该轮没有手写 factory、presentation 或 translation_action 路由，全部经过候选 `main.ts`、生产 IPC 与实际独立翻译窗口。

通过报告：`local-build/spark233/functional-integration/translation-host-runs/a5951e4e-fd5c-4bfe-983e-0e7193cf8845/report.json`，`ok=true`。五项结果均通过：

- 校验 production `app_exec_path` 确实是本轮私有复制的 exe。
- 真实 `launcher_query` 返回句子的显式 AI 动作，provider 请求数为 0。
- 真实 `launcher_execute` 打开 AI 工作区并移交原文，等待实际输入与配置就绪后，provider 请求数仍为 0。
- 对实际 TranslationWorkspace 的 Translate 控件发送 renderer click 后，真实 production `translation_action` 只产生 1 次 loopback `/v1/chat/completions`，工作区显示相应返回值。
- 真实 `clipboard_action` 返回 persisted paused、零条历史，没有操作 OS 剪贴板。

完整宿主采用与上节一致的 `app.asar` SHA256 `20dc4cb726d33889b94bfc4b374d94f74ad44e9458e76fc182f0b5918779988c`，Browser.getVersion 记录 Electron `45.0.0` / Chrome `156.0.8078.48`。主进程 PID `50428` 通过同一隔离 profile 的正常 `--exit` 结束，`processExited=true`。模型服务仍是 loopback 受控服务，不能将此写成真实外部服务或物理 UI 结果。

初次完整宿主尝试 `0ec80c8f-551d-4ca5-ae22-6cb545ac4e2b` 的 CDP attach 早于 preload ready，读取 bridge 失败，尚未执行配置或翻译。这次报告保留失败及初始退出被未就绪窗口拒绝的事实；等待 bridge ready 后，另发正常 `--exit` 已确认 PID `39396` 退出。runner 已增加真实 bridge/输入控件就绪等待，随后全新 profile 得到上述通过报告，未修改产品行为来规避失败。

## 重放与完成范围

```powershell
. ./scripts/use-toolchain.ps1
node local-build/spark233/functional-integration/translation-mode-regression.mjs
```

对最终新候选重放完整宿主门禁时，复用同一个 runner：

```powershell
. ./scripts/use-toolchain.ps1
$env:SPARK233_TRANSLATION_HOST_PACKAGE = (Resolve-Path 'local-build/spark233/automated-followup/release/win-unpacked').Path
node local-build/spark233/functional-integration/translation-host-gate.mjs
```

`SPARK233_TRANSLATION_HOST_PACKAGE` 接受 `win-unpacked` **目录**，不是单个 ASAR；默认即上述 automated-followup 目录。runner 自动复制整套 exe/resources，并在报告中绑定复制后的 ASAR SHA256。若仅需重放隐藏 renderer/手动模式链，可设置 `SPARK233_TRANSLATION_MODE_ASAR` 为新候选 `resources/app.asar` 的绝对路径，该 runner 从同一 resources 的 `plugins/index.json` 选择并固定翻译归档。两者每次都创建新私有配置和数据，不附着已有用户 profile，不改原候选。最终 renderer 若发生 tree-shake 字节变化，重放会自然记录新输入 hash，不需要复制另一套验证方法。

选定 runtime 为 Node `26.12.1` / npm `12.2.1`，实际 renderer/backend 使用 Electron `45.0.0`。本轮 runner 静态语法检查及上述实际集成都通过；生产源码没有变化，因此没有重复共享 build、typecheck 或现有底层 suite。验证源、两层报告和输入散列另记在 `local-build/spark233/functional-integration/translation-mode-evidence.json`。

P6.7 的默认本地/待执行 AI、手动切换和不自动发送代表行为可据此完成。真实 OS 剪贴板监听/回贴、物理键盘/焦点、外部实际付费服务配置与请求质量、完整主题/IME/辅助技术仍属其他验收范围；没有将 loopback 服务当作真实外部 AI 服务验证，也没有将隐藏 renderer 当作物理 UI 验收。

本轮没有覆盖 P3.6 的同名应用与词典结果共存，不由该报告扩写相关完成结论。

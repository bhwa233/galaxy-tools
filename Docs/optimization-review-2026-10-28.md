# spark233 项目审查与优化清单（2026-10-28）

审查范围：`apps/desktop`（Electron 主进程 + React 渲染层）、`packages/*`、文档、构建与 CI。分支 `codex/spark233-refactor`，基于 `d1c5685` 加未提交的 launcher 改动。

> 第 0–8 节记录修复前审查快照；当前实施范围、校正说明和验证结果见第 9 节。

## 0. 修复前基线

在项目工具链（`scripts/use-toolchain.ps1`，Node 26.12.1 / pnpm 12.15.0）下：

| 检查                      | 结果                                                    |
| ------------------------- | ------------------------------------------------------- |
| `pnpm typecheck`          | 通过                                                    |
| `pnpm lint`               | 通过（oxlint 没有配置文件，只跑默认规则，参考价值有限） |
| `pnpm test`               | 通过，53 个文件、219 个用例                             |
| `pnpm test:ui`            | 通过，5 个用例                                          |
| `oxfmt --check`           | 通过                                                    |
| `pnpm build` / `pack:win` | 未运行（依赖 native C++ 构建和 ECDICT 下载）            |

**补审状态：** 主进程的权限、MCP、子进程生命周期和备份恢复已补审，结果见 2.1。native C++ 源码和 SDK 与宿主之间的协议也已补审，结果见第 8 节。

优先级定义：

- **P0**：会丢数据，或者阻塞交付。
- **P1**：功能错误、明显的架构负担，或文档误导。
- **P2**：性能、可维护性、体验问题。

---

## 1. P0：必须先修

### 1.1 笔记保存失败后，切换文档会静默丢失修改

以下文件路径均相对于 `apps/desktop/src/components/`。三个问题共用同一个根因：切换当前文档的入口有多个，但没有统一的“先保存，失败就中止”逻辑。

1. **保存失败后被当成“没有需要保存的内容”**：`MainWindow.tsx:1131`
   - 代码是 `if (!force && saveStateRef.current !== "dirty") return true;`。
   - 自动保存失败后状态变为 `"error"`。此后所有非强制保存都直接返回成功，自动保存的 effect 也只在 `"dirty"` 时触发，所以不会重试。
   - 场景：一次写入失败后，用户点开另一篇笔记，这次编辑就丢了。
2. **切换笔记时忽略保存结果**：`MainWindow.tsx:1343`（`handleSelectNote`）和 `:1358`（`handleSelectExternalFile`）
   - `await saveCurrentNote()` 之后，不管返回什么都会继续加载下一篇。
   - 导入、导出两条路径会检查返回值，这两处没有。
3. **打开外部文件前不保存当前笔记**：`MainWindow.tsx:677-718`（`loadExternalFile`）
   - 拖入文件、在资源管理器中双击打开 `.md`、启动时传入文件，都走这条路径。它直接覆盖当前的 ref 和 state，不先保存。

**修复：**

- 把 `"error"` 和 `"saving"` 都当作需要保存的状态。
- 新增统一的 `switchDocument(target)`，内部先 `if (!(await saveCurrentNote())) return;` 再加载目标。所有切换入口都改走它。
- 补测试：一次保存失败后切换笔记，内容仍然保留。

### 1.2 PR 流水线在干净的 runner 上跑不通

- `.github/workflows/pulls.yml:21` 运行 `pnpm pack:win`，`build-artifacts.yml:18` 运行 `pnpm dist:win`。两者都会进入 `scripts/build-official-plugins.mjs:193-232`。
- 截图和 OCR 插件需要预先准备好的 `local-build/spark233/native-capture-p4`（OpenCV、onnxruntime）。剪贴板、应用、搜索插件需要 pwsh、CMake 和 VS。翻译插件要用 Python 联网下载词典。
- 这些 native 产物和 sqlite 词典都在 gitignore 里，runner 上没有。

**修复：**

- PR job 只跑 `typecheck`、`lint`、`fmt --check`、`test`、`test:ui`。
- 打包放到独立 job，从缓存或 release 资产恢复预构建的 native 和词典产物，或者在 job 里显式执行各个 prepare 脚本。

---

## 2. P1：功能正确性

渲染层（路径相对 `apps/desktop/src/`）：

| #   | 位置                                                | 问题                                                                                                                                                                                                  | 修复                                                                      |
| --- | --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 1   | `components/MainWindow.tsx:1045-1070`               | 外部文件每秒轮询一次。发现 mtime 变化就直接覆盖内容并标记为已保存，不检查当前是否有未保存修改。异步回调放在 `setInterval` 里，多次调用会重叠。                                                        | 有未保存修改时跳过重载或提示冲突；加一个“请求进行中”标志。                |
| 2   | `components/MainWindow.tsx:1011-1025`               | 跳转到任务锚点时，`pendingTaskAnchorRef` 在找到目标行之前就被清空。预览是懒加载的，通常还没渲染，结果从提醒或搜索打开时不会滚动到目标。                                                               | 找到目标行后再清空 ref，并在 `deferredContent` 变化时重试。               |
| 3   | `components/MainWindow.tsx:363-371`                 | 任意配置变化（换主题、换语言）都会把视图模式重置为默认值。                                                                                                                                            | 只在 `defaultViewMode` 本身变化时才应用。                                 |
| 4   | `features/launcher/Launcher.tsx:551,577`            | 执行条目时递增 `queryGeneration`，导致同一会话后续的 `launcher-query-updated` 事件全部被丢弃。不关闭窗口的动作执行后，pending 分组会一直转圈。                                                        | 执行和查询各用一个独立的计数器。                                          |
| 5   | `features/launcher/Launcher.tsx:1283-1295`          | 应用网格是 `shrink-0`，没有高度上限，父容器又是 `overflow-hidden`。应用模式最多返回 100 项，超出窗口高度的部分被裁掉且无法滚动。未提交的改动没有覆盖这一点。                                          | 给网格加 `max-h` 和 `overflow-y-auto`；补一个约 80 项的测试。             |
| 6   | `features/launcher/Launcher.tsx:387-400`            | 每次按键在防抖之前就清空结果；IME 开始组字也会清空。中文用户输入时列表反复闪烁或变空。每次按键还会发一次多余的 cancel IPC。                                                                           | 新结果到达前保留旧结果；组字开始时不重新查询；没有在途请求时不发 cancel。 |
| 7   | `features/clipboard/ClipboardWorkspace.tsx:142-169` | 列表加载没有防过期响应的保护，慢的旧请求晚返回会覆盖新结果。emoji 列表同样有这个问题。                                                                                                                | 加一个请求代号 ref，参照 `PluginManagementDialog` 的 `refresh`。          |
| 8   | 多处                                                | 以下 key 在两份语言文件里都不存在，英文用户会看到中文的 `defaultValue`：`errors.closeSaveFailed`、`settings.fontNotice`、`launcher.resultActions`、`launcher.chooseAction`、`translation.noteSaved`。 | 补齐 key，删除按 `resolvedLanguage` 分支写的 `defaultValue`。             |

主进程（路径相对 `apps/desktop/electron/`）：

| #   | 位置                | 问题                                                                                                                                                           | 修复                                                                      |
| --- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 9   | `main.ts:3707-3711` | 写盘串行队列靠命令名前缀正则（`notes_`、`config_`……）判断。新增的写盘命令只要不匹配前缀，就会绕过串行化，出现读-改-写竞争。弹窗计数（`:3693`）也是同样的正则。 | 在命令注册表中给每个命令显式声明 `serialized` 和 `modal` 属性（见 3.1）。 |
| 10  | `main.ts:3738-3754` | `spark233:drop` 对最多 100 个路径同步调用 `fs.statSync`，阻塞主进程。文件不存在时抛出的是原始 ENOENT，不是 `AppError`。                                        | 改用异步 `stat`，并包装成 `AppError("permissionDenied")`。                |

### 2.1 主进程补审：权限、MCP、生命周期、备份恢复

这一节是后来补审的结果，没有发现 P0。#11 和 #13 已对照代码复核；其余条目来自子任务的审查，子任务说明每条都对照过代码，但我没有逐行复核。路径相对 `apps/desktop/electron/`。

| #   | 位置                                                                                                      | 问题                                                                                                                                                                                                                                                                                                          | 失败场景                                                                                                                                  | 修复                                                                                                                                                                                                                                 |
| --- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 11  | `main.ts:1466-1471`、`:1675`、`:2166-2168`                                                                | `isAdminView` 只要 `view === "main"` 就返回 true。但 `main` 窗口加载的是笔记插件包的渲染页 `spark233://notes`，不是宿主的 `spark233://app`。结果笔记页能调用 `plugins_*`（包括带 `trustNative: true` 的 `plugins_confirm_install`）、`backup_*`、`diagnostics_*`、`search_service_configure` 等宿主管理命令。 | 笔记渲染一旦出现 XSS（预览用了 `rehype-raw`，只有 sanitize 一道防线），或者笔记插件包更新有问题，就能静默安装插件并授予 native 信任。     | 只有 `launcher` 视图且 origin 是 `spark233://app` 才算 admin。笔记 `main` 视图改用显式白名单（`notes_*`、`categories_*`、`images_*`、`reminders_*`、`dialog_*`、`window_control` 等），参照 `main.ts:2559-2580` 中插件工作区的做法。 |
| 12  | `main.ts:3404`（`config_patch`）、`:3446`（`config_migrate_data_dir`）、`:3675`（`clipboard_read`）       | 这几个命令不检查窗口类型。任何笔记源窗口都能改 `mcpEnabled`、`mcpPermission: "full"`、开机自启和快捷键，也能静默读取剪贴板。                                                                                                                                                                                  | 笔记页被攻破后，可以打开 MCP 完全权限，本机任意 MCP 客户端随后就能删除笔记。                                                              | `config_patch` 限定为 admin 视图，或者禁止非 admin 窗口修改 `mcp*`、`autostart`、快捷键；`clipboard_read` 同样处理。                                                                                                                 |
| 13  | `mcp-protocol.ts:144-162`                                                                                 | `spark233_write_note` 只要求 `append` 权限，却接受 `mode: "replace"`。设置页把这一级叫“追加写入”。                                                                                                                                                                                                            | 被提示注入的客户端可以清空整篇笔记，用户还以为只有“完全权限”才能做破坏性修改。                                                            | `replace` 改为要求 `full`，或者拆成单独的工具。                                                                                                                                                                                      |
| 14  | `plugins/manager.ts:185-205`、`plugins/backup.ts:820-842`、`host-config.ts:138-140`                       | 备份快照只用自身的 SHA-256 校验，没有签名。恢复时直接信任备份里的插件授权，`config.json` 按 `{...defaults, ...saved}` 合并，不做 schema 校验。                                                                                                                                                                | 被篡改或别人分享的备份，可以恢复出一个带 `grant.native: true` 的第三方插件，下次激活就执行 native 代码。预览里只显示 id、版本和启用状态。 | 预览中显示授权内容；当前状态没有的授权要重新征得同意，或者降级；恢复的配置用完整 schema 解析。                                                                                                                                       |
| 15  | `plugins/native-runtime.ts:286-312,476-480`、`plugins/backend.ts:359-419`、`plugins/manager.ts:1406-1438` | 只有 `prepareStop` 回答 ok，`dispose()` 才会继续。10 秒超时也按“拒绝”处理，进程不会被杀掉。                                                                                                                                                                                                                   | 第三方插件死锁后，每次退出都报 `pluginSaveRefused`，备份和迁移数据目录也会失败，只能去任务管理器结束进程。                                | 区分超时和明确拒绝。超时或第二次退出时杀掉进程并等它退出，或者给用户“强制退出”的选项。                                                                                                                                               |
| 16  | `main.ts:1242-1248`、`host/shutdown.ts:72-79`、`plugins/desktop-host.ts:1337-1355`                        | `contextPanel.shutdown()`、`commandMatcher.stop()`、`diagnostics.shutdown()` 在插件全部关闭之后才执行。其中任一个抛错都会取消退出。                                                                                                                                                                           | 诊断模块遇到磁盘错误后，应用还开着，但插件已经全部停了，笔记窗口也已销毁，插件管理一直显示 busy。                                         | 插件关闭成功之后不再允许取消退出，后续步骤尽力执行，失败也继续提交退出。                                                                                                                                                             |
| 17  | `main.ts:2365-2396`、`host/shortcuts.ts:94-108`、`plugins/backup.ts:659-678,853-863`                      | 恢复备份时，快捷键注册失败会触发回滚。回滚本身再失败，`active.json` 就会留在磁盘上，之后每次启动都以 exit code 1 退出。回滚中的 rename 遇到 EBUSY 或 EPERM 失败后，仍然会恢复插件运行，导致插件在一半已交换的目录上重建空数据目录。                                                                           | 恢复一份快捷键在本机已被占用的备份，应用从此无法启动；或者杀毒软件锁住了文件，新写的笔记落进一个之后会被拒绝启动的目录。                  | 快捷键错误改为记录 `shortcutWarning`，参照 `main.ts:4062` 附近的做法；回滚出错时不要恢复插件；rename 加退避重试。                                                                                                                    |
| 18  | `security.ts:6-25`、`main.ts:3640-3663`                                                                   | 文件授权对所有窗口生效，整个会话都有效，而且递归覆盖整个目录。`dialog_open`、`dialog_save` 的参数不做校验。`assert()` 校验的是规范化之后的路径，返回的却是原始路径。                                                                                                                                          | 在笔记窗口里选过一次某个目录，之后任何窗口都能写这个目录下的任意 `.md` 或 `.txt` 文件。                                                   | 授权按窗口区分，并设置过期时间；`assert()` 返回规范化之后的路径。                                                                                                                                                                    |
| 19  | `mcp-server.ts:7,15-27,50-88`、`mcp-relay.ts:50-68`                                                       | MCP 命名管道有以下问题：读取一行没有长度上限，认证前也没有；管道名是固定的，relay 不校验对端是谁；首次运行时 app 和 relay 可能各自生成不同的 token；`this.server` 在 `listen` 回调里才赋值，快速连续 stop、start 后会留下一个关不掉的 server；relay 在 stdout 写完之前就调用 `process.exit`。                 | 同一用户下的任意进程可以通过不带换行的数据耗尽主进程内存，或者抢先创建同名管道，拿到 token 和所有笔记请求。                               | 限制缓冲区大小并加认证超时；管道名加入每个用户独有的值，relay 先校验服务端；token 文件用 `flag: "wx"` 创建；server 同步赋值，事件处理时核对是否为同一个实例；等 stdout drain 之后再退出。                                            |
| 20  | `plugins/native-runtime.ts:105,135-150,192-195,272-279,476-480`、`plugins/backend.ts:421-464,521,589`     | 子进程的健壮性问题：`error` 监听器用的是 `once`，stdio 管道上没有监听，第二次 error 会变成 uncaught exception；`dispose()` 遇到第一个失败就停下；违反协议的进程只标记为故障，不杀掉；启动失败后清理时出错，会覆盖原始错误，`release()` 也被跳过。                                                             | 主进程崩溃；进程泄漏；连带触发 #15。                                                                                                      | 改用 `on("error")` 并给管道加错误处理；`dispose()` 改用 `allSettled`；违反协议时直接杀进程；清理逻辑用 try/finally 并保留原始错误。                                                                                                  |
| 21  | `main.ts:3795-3800`、`host/shutdown.ts:56`、`launcher.ts:1057,1286-1305`、`backup.ts:787-800,862-869`     | 其他问题：注销 Windows 时没有处理 `session-end`，异步保存来不及完成；退出时对窗口隐藏用的是 `Promise.all`，之前一次隐藏失败就会让退出失败；command matcher 用 `.then(ok, err)`，`ok` 里抛出的错误会成为未处理的 rejection，分组一直 pending；回滚成功后没有删除 `active.json`；恢复前不检查剩余磁盘空间。     | 注销时丢失笔记；无法退出；结果一直转圈；之后的备份操作被阻塞。                                                                            | 分别处理：加短的同步保存路径、改用 `allSettled`、加 `.catch`、回滚后清理 `active.json`、恢复前检查磁盘空间。                                                                                                                         |

**补审确认没有问题的部分：**

- `sender()` 要求请求来自主 frame、已注册的窗口，并且 origin 完全匹配。
- 插件 web view 接触不到宿主命令：插件 preload 走独立的通道，只开放固定的几个操作。
- 主 preload 没有暴露原始的 `ipcRenderer`。
- 涉及外部文件的命令都会经过 `grants.assert`，并检查扩展名。
- `shell.openPath` 只能从搜索插件持有的选择项触发，打开前会重新检查排除目录和文件版本。
- launcher 会话的取消按 `sessionId` 和 `requestId` 过滤。
- MCP 权限在服务端每次请求时重新读取。
- 备份包会校验路径穿越、链接、重复条目、大小和哈希。
- 子进程使用 `shell: false`，不会自动重启。

---

## 3. P1：架构

### 3.1 主进程 `main.ts` 有 4169 行

- `handle()` 是一个包含约 94 个 `case` 的 switch，混在一起的有：窗口管理、笔记 IO、插件、备份、对话框、托盘、CLI、MCP、smoke 测试入口。
- 渲染端通过字符串调用命令，约 127 个，没有类型约束（见 3.3）。
- 建议拆分步骤：
  1. 建 `electron/ipc/registry.ts`，每个命令声明为 `{ name, schema（zod）, serialized, modal, handler }`。
  2. 按领域拆出 `ipc/notes.ts`、`ipc/plugins.ts`、`ipc/backup.ts`、`ipc/dialogs.ts` 等。
  3. `main.ts` 只保留启动流程、单实例锁和生命周期。
- 顺带处理：`electron/windows.ts` 和 `electron/host/windows.ts` 同名，前者实际放的是 GPU 工作目录修正和全屏观察器。改名为 `windows-runtime.ts` 或 `fullscreen-watcher.ts`。

### 3.2 渲染层巨型组件

- **`MainWindow.tsx`**（3308 行，41 个 useState、27 个 useRef、约 40 个 effect）。`content` 状态放在顶层，每次按键都会重渲染侧栏、菜单和工具栏。建议拆成：
  - `useNoteSession()`：保存队列、`loadEpoch`、`switchDocument`。这一步顺带修好 1.1。
  - `useExternalFileWatcher()`、`useSplitScrollSync()`、`useUpdateReminder()`。
  - `<NoteSidebar>`、`<NoteContextMenu>`、`<CategoryMenu>`、`<EditorPane>`，以及用 `memo` 包裹的 `<PreviewPane>`。
- **`NotePad.tsx`** 自己又实现了一套保存队列、`notes-changed` 同步和关闭前处理，语义与 MainWindow 不一致。应共用一个 `useNoteDocument`。
- **`Launcher.tsx`**（1490 行）里有四套状态机：launcher 状态、查询会话、上下文面板、工作区路由。条目菜单（757-928）和动作对话框（1385-1477）几乎逐行重复。另有 5 处直接调用 `invoke`，绕过了 `features/launcher/api.ts`。
- **目录归属：**
  - `components/` 下的 `MainWindow`、`NotePad`、`Tile` 应移到 `features/notes`。
  - `components/NotepadOpenPanel.tsx` 没有任何地方引用，可以删除。
  - `ClipboardWorkspace.tsx:18` 直接引用 `@spark233/ui/components`，绕过了 `@/components/ui`。

### 3.3 桥接层没有类型约束

- `platform/desktop.ts` 手工复制了一份 `preload.cts` 的类型。`invoke<T>(command: string)` 的返回值直接强转，事件名是任意字符串。
- 建议在共享位置（`packages/sdk` 或 `electron/shared`）定义 `Commands` 和 `Events` 两张映射表，preload、主进程注册表、渲染端共用。它和 3.1 的注册表是同一项工作。

### 3.4 两套样式体系并存

- `App.css`（844 行）里有旧的纸墨配色（`paper`、`ink`、`bamboo`），还在应用层覆盖共享 token 的暗色值。各 feature 用的是 `@spark233/ui` 的语义 token。
- 建议在 `packages/ui/theme.css` 中把旧 token 映射到语义 token，暗色覆盖也搬进 ui 包，然后逐步删除 `App.css` 中的重复部分。

### 3.5 `packages/official/notes/backend.mjs` 是提交进仓库的打包产物

- 这个文件有 6813 行，由 `build.mjs` 生成。源码是 `backend.ts`。
- 提交产物有两个风险：源码与产物可能不一致；review 时会看到大段噪音 diff。
- 写盘本身是安全的：先写临时文件，`fsync` 后 `rename`；`renameCategory` 失败时有回滚。
- 建议改为构建时生成并加入 gitignore。如果必须提交，就在 CI 中加一步“重新生成后 `git diff --exit-code`”。

---

## 4. P1：文档

1. **README 写成了进度日志**：`README.md:1-11` 是带日期的进度记录（“60/108 完成”、smoke 编号、测试数）。另外：
   - `README.md:89` 提到的 `preview` 脚本不存在。
   - `README.md:114`、`README_en-US.md:178`、`Docs/electron-migration.md:79` 引用了已删除的 `src-tauri/`。
2. **没有统一的架构入口**：信息分散在 `launcher-architecture.md`（749 行，方案和状态混写）、`electron-migration.md`、`pnpm-monorepo.md`、`edge-capsules.md`，以及 7 份带日期的 `spark233-*-2026-10-2x.md`。
   - 建议新增 `Docs/README.md` 作为索引，章节覆盖：当前架构、目录结构、插件协议、MCP、测试、发布。
3. **过期文档仍放在 `Docs/` 根目录**：
   - 7 份 `spark233-*-2026-10-2x.md` 中，有几份正文写着“本阶段只讨论和修改文档”，标题却写“已实现”，内容自相矛盾。
   - `RELEASE_WORKFLOW.md`、`MSSTORE_PUBLISH.md`、`signpath-configurations.md` 描述的是 Tauri/MSIX 发布链路，链接的 workflow 已经不存在。
   - 建议把它们分别移到 `Docs/archive/2026-10/` 和 `Docs/upstream/`，仍然有效的设计结论并入架构文档。
4. **TODO 文档重叠**：`electron-todo.md`、`launcher-todo.md`、`launcher-todo-archive.md`、`screenshot-enhancement-todo.md` 内容交叉。只保留一份 `launcher-todo.md`，其余归档。
5. **命令和路径过期**：
   - `Docs/electron-migration.md:85` 还在用 `npm run …`，`:55` 引用的 `electron/windows.ts` 已迁到 `apps/desktop/electron/host/windows.ts`。
   - `Docs/mcp.md:58` 用的是 `npx electron . --mcp`。
6. **断链**：
   - `launcher-architecture.md` 有 12 个链接指向本地的 `../tmp/rubick`、`../tmp/tinker`、`../tmp/PaperTodo`。
   - `launcher-todo-archive.md` 引用的是 monorepo 迁移前的路径。
7. **上游品牌残留**：
   - `Docs/CONTRIBUTING_*.md` 写的是 “Floral Notepaper”，链接指向 `Achilng/floral-notepaper`。
   - `.github/ISSUE_TEMPLATE/config.yml:5`、`.github/pull_request_template.md:47`（“花笺”）同样残留。
   - CI 产物名是 `floral-electron-*`。
   - 统一改为 spark233 和 `bhwa233/galaxy-tools`。

---

## 5. P2：工程与质量

### 测试

1. **测试覆盖分布不合理**：保存、切换、关闭流程（1.1 和 P1 #1-3 所在的位置）完全没有测试，`ClipboardWorkspace` 和 `PluginManagementDialog` 也没有。
2. **`Launcher.browser.test.tsx` 容易随环境抖动**：它是一个约 230 行的单个 `it`，依赖字体行数（`getClientRects().toHaveLength(2)`）和浮点坐标完全相等。应拆成多个聚焦的用例，坐标比较改为容差。
3. **语言文件一致性测试抓不到英文缺 key**：`locales/resources.test.ts:26-30` 比较的是合并了中文回退之后的结果。应改为比较原始的 en-US 文件，并新增“`t()` 中用到的 key 必须存在”的检查。
4. **Electron 侧测试不做类型检查**：`electron/tsconfig.json` 排除了 `*.test.ts`；applications、translation、search、ocr、screenshot 和 `hello-web` 没有 `typecheck` 脚本。
5. **CI 不跑 `test:ui`**：需要加上 `test:ui` 和 `playwright install chromium --only-shell`。

### Lint 与工具链

6. **lint 规则太少**：新增 `.oxlintrc.json`，启用 react、react-hooks、typescript、suspicious 规则；lint-staged 加 oxlint；CI 加 `fmt --check`。
7. **typecheck 重复执行**：根 `build` 和 desktop `build` 各跑一次 typecheck，在 PR CI 里一共跑三次。删掉 desktop `build` 里的那次。
8. **`.gitignore` 带着上游规则**：
   - 删掉 Tauri 条目，以及 .NET 规则（`**/[Pp]ackages/*`、`bin/`、`obj/`），后者可能让新加的源码目录被静默忽略。
   - `.playwright-mcp/console-*.log` 已被提交，应删除并加入忽略。
   - 根目录的 `dist/` 和 `dist-electron/` 是迁移前的旧产物，本地清理即可。
9. **默认 Git Bash 下 pnpm 不可用**：系统 Node 是 v24，加上 `engine-strict`，在 Git Bash 里直接执行 pnpm 会失败。README 应写明需要在 PowerShell 中先运行 `use-toolchain.ps1`，或者提供 bash 版本。
10. **遗留文件**：
    - `scripts/legacy-tauri/` 和 `.github/legacy-tauri/` 已经无法运行，可以删除，git 历史会保留它们。
    - issue 模板里的 macOS 选项也应删除。

### 性能

11. **Markdown 预览每次渲染都重新解析**：`MarkdownPreview` 没有用 `memo`，`onContentChange` 每次渲染都是新的内联函数。按键、悬停笔记列表都会触发 remark、rehype、KaTeX 全量解析，`useDeferredValue` 起不到作用。
12. **滚动同步的 `ResizeObserver` 每次按键都重建**：它依赖 `content`（`MainWindow.tsx:1724-1832`）。而且测量用的是 `content`，预览显示的是 `deferredContent`，两者对不上。
13. **Launcher 每次渲染都做重复计算**：对所有 command 做 `JSON.stringify`；`findCommand` 是线性查找；每次按方向键都会重新计算。用 `useMemo` 加 `Map` 解决。
14. **剪贴板草稿每次按键发一次保存 IPC**：`ClipboardWorkspace.tsx:128-140`。加约 300 ms 防抖，关闭前 flush。

### 可访问性与健壮性

15. **键盘导航**：
    - 每个结果都设了 `tabIndex={0}`（`Launcher.tsx:763`），用 Tab 要穿过上百项。改为只有选中项是 0，或者全部设为 -1。
    - `role="option"` 里嵌套了按钮。
    - `:1296` 的 `aria-label` 挂在没有 role 的 div 上，读屏软件会忽略它。
16. **硬编码文案**：`CapsuleHost.tsx`、`ContextMenu.tsx`、`NotePad.tsx`、`BackupDialog.tsx` 等文件里有未走 i18n 的文案。
    - `ClipboardWorkspace.tsx:119` 只在初始化时调用一次 `t("自定义")`，切换语言后不会更新。
    - `Launcher.tsx:101-108` 用正则匹配后端返回的中英文句子来剥离提示。后端应改为返回结构化字段。
17. **错误被吞或缺少检查**：
    - `platform/desktop.ts:124-126` 处理拖放的 Promise 没有 catch。
    - `Launcher.tsx:270-280` 的事件回调没有检查组件是否已卸载。

---

## 6. 已确认可以保持的部分

- 所有窗口都开启了 `sandbox`、`contextIsolation`、`webSecurity`，并关闭了 `nodeIntegration`（`host/windows.ts`、`capsules.ts`、`plugins/web-host.ts`）。
- `security.ts` 的 `externalUrl` 只放行 http/https，并拒绝 URL 中带用户名或密码。
- 插件包路径校验较为严格：SDK 的 `isPluginPackagePath` 拒绝 `..`、绝对路径和 Windows 保留名，安装器用 `realpath` 加 `relative` 防止目录穿越。
- Web 插件的能力调用要求同时“已声明”且“已授权”（`web-host.ts:217`）。
- smoke 入口需要同时满足显式环境变量和隔离的数据目录才会启动，不会在正式运行中误触发。
- Node、pnpm、TypeScript 的版本锁在各处一致，`.npmrc` 开启了 `engine-strict` 和 `save-exact`。

## 7. 建议执行顺序

1. **P0**：修复 1.1 并补测试；拆分 CI，先保证 PR 检查通过。
   - 同一批处理 2.1 的 #11、#12、#13（笔记页拿到 admin 权限、配置可被任意窗口修改、MCP append 可以整篇替换）。它们是 P1，但改动小，安全收益高。
2. **P1 正确性**：修复 Launcher 的 #4、#5、#6，以及 MainWindow 的 #1、#3。改动小，收益直接。
3. **文档整理**：新增 Docs 索引，归档过期文档，清理 README 和上游品牌残留。可以与第 2 步并行。
4. **架构重构**：先做主进程命令注册表和类型化桥接（3.1、3.3），再拆 MainWindow（3.2）。每拆一步都跑完整测试，这一步之前要先补上保存流程的测试。
5. **P2**：加强 lint、优化性能、补齐可访问性和 i18n。
6. **native 与协议**：第 8 节的 P1 #1（搜索 helper 无限等待）和 #4（一行杂散输出就让 native 入口永久失效）与插件稳定性直接相关，建议和第 2 步一起做。

## 8. 补审：native C++ 与 SDK/宿主协议

没有发现 P0，也没有确认到内存破坏或整数溢出。#1、#2、#7 已对照代码复核，其余来自子任务审查（子任务说明每条都对照过代码）。

### P1

| #   | 位置                                                                                       | 问题                                                                                                                                                                                                                                                           | 失败场景                                                                                                                                                       | 修复                                                                                                                                                                 |
| --- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `packages/official/search/native-src/search.cpp:396,460,674`                               | `Run`、`AuthorizeConfiguration`、`AuthorizeServiceAction` 都用 `WaitForSingleObject(..., INFINITE)`，等待期间不检查取消请求。`InstallProtected` 在 `Run()` 期间持有 `Global\spark233IndexConfiguration` 和 `Global\spark233HostServiceManagement` 两个互斥量。 | 被提权的子进程卡住后，helper 永远不退出。宿主 `search.ts:256-269` 的 `cancel()` 15 秒后放弃，插件无法停止；之后每次安装或配置都等 30 秒，然后报 `ERROR_BUSY`。 | 改为有上限的等待（例如 120 秒），等待之间检查 `request.Cancelled()`，并把子进程放进 kill-on-close 的 job。                                                           |
| 2   | `packages/sdk/src/browser.ts:162-168` 对比 `apps/desktop/electron/plugins/web-host.ts:339` | SDK 发送保存拒绝原因（`decision.reason`）时不截断，宿主只接受最长 1000 字符。                                                                                                                                                                                  | 保存处理函数抛出一条长错误信息，宿主解析失败，SDK 的 `.catch(()=>{})` 把错误吞掉，10 秒后宿主报 “Plugin save confirmation timed out”，真实原因丢失。           | 在 SDK 中截断到 1000 字符（查询路径在 `browser.ts:143` 已经这样做），并在 `PluginSaveDecision` 类型里写明这个上限。                                                  |
| 3   | `packages/sdk/src/index.ts:82-94` 对比 `web-host.ts:95-124,270`                            | SDK 的 `PluginLauncherPage` 类型没有任何限制。宿主要求：`icon` 只能是不超过 32768 字符的 `data:image/png;base64`，最多 100 项、每项最多 8 个动作，`kind` 不超过 40 字符，`title` 不超过 1000 字符，整个请求不超过 256 KiB。                                    | 只要有一项的 icon 是 SVG 或 https 链接，整页都会被拒；页面超过 256 KiB 时错误被吞掉，宿主 10 秒后报查询超时。                                                  | 把这些限制写进 SDK 类型，或者从 SDK 导出宿主的 zod schema 供插件在本地校验；序列化失败时返回 `error` 结果，不要静默。                                                |
| 4   | `apps/desktop/electron/plugins/native-runtime.ts:151-195`                                  | `receive()` 循环中的任何异常都会进入 `fail()`，包括一行非 JSON 输出、超长的 `error` 字段、宿主自己的 `onEvent` 回调抛出的异常。`fail()` 会清空缓冲区（同一块数据里后面的有效行也一起丢掉），并记下故障，但不杀进程、也不标记进程已结束。                       | 插件依赖的库往 stdout 打印一行日志后，这个入口就一直不可用：`call()` 永远抛出之前记下的故障，`processFor` 一直返回同一个进程，直到崩溃恢复把整个实例替换掉。   | 给 `onEvent` 单独加 try/catch；超长 `error` 截断或者只拒绝那一个请求；单行格式错误时记录诊断并丢弃这一行，否则就杀掉进程，让重启逻辑生效；继续处理同一块里剩下的行。 |

### P2

5. **协议文档与实现不一致**：`Docs/native-plugin-protocol.md:25` 写“新的默认 query 会取消旧 query”，但 `native-runtime.ts:448-462` 只在 `prepareStop` 时取消查询。要么在实现里补上取消逻辑，要么改文档。
6. **native 插件拿到文件句柄却打不开**：native 入口收到的 `context` 里只有 `{id, kind}` 形式的资源句柄，没有对应的解析途径（只有 Web 插件有 `resolveResource`）。要么为可信的 native 入口把句柄解析成宿主批准的路径，要么在校验 manifest 时拒绝 native 命令声明 `files` 或 `image` 输入。
7. **三个能力可以声明、授权，但调用必然失败**：`windows`、`search.index`、`clipboard.watch` 在 SDK 的枚举里（`manifest.ts:50-65`），也显示在授权页上，但 `capabilities.ts` 里没有实现它们，调用都会报“暂不支持此能力操作”。用户授权了实际没有效果的权限。在实现之前，从枚举中移除，或者在安装时拒绝。
8. **SDK 导出了没人用的类型**：`PluginSearchQuery`、`PluginSearchResult`、`PluginSearchPage`（`index.ts:58-80`）在宿主和官方插件里都没有用到。删除，或者标注为保留。
9. **SDK 放行宿主会拒绝的 native 入口**：SDK 的 `nativeSchema` 允许 darwin、linux 平台和任意路径，宿主要求必须是 `.exe`（`plugins/manifest.ts:120`）。在 SDK schema 中加上同样的规则。
10. **Web 调 native 跳过依赖检查**：`capabilities.ts:73-98` 没有执行 manager 的 `assertDispatch` 和 `requiresPlugins` 检查。影响限于插件自己的命令。在调用 `invokeNative` 之前补上同样的检查。
11. **冷启动后的第一次查询可能失败**：SDK 一启动就发送 `context.get`，宿主收到后即认为插件已就绪。如果插件在某个 `await` 之后才注册查询处理函数，第一次查询会收到 “Plugin query handler is not registered”。可以让 SDK 短暂排队未注册的查询，或者增加一个显式的 ready 操作。
12. **`command.register` 只做校验，没有实际作用**：`web-host.ts:330` 把 id 写进一个 Set，但这个 Set 从来没被读取过。要么删除，要么改为必须先注册才能收到查询。
13. **搜索时每次按键都逐字节比对服务端二进制**：`search.cpp:122-125` 调用 `CheckServiceVersion()`，它会把已安装和打包的 `spark233.Index.exe`、`spark233.Document.exe`、`pdfium.dll` 逐字节比较一遍，每次按键都要读几 MB。改为比较大小和修改时间，或者按 helper 版本缓存检查结果。
14. **应用匹配器每个名字都检查一次取消**：`native/applications/matcher.cpp:77-87` 对每个名字都调用一次 `fs::exists` 和 `WaitForSingleObject`，一次查询最多 2 万次。`pinyin.mjs:43` 写文件不是原子的，读到写了一半的文件时会抛错，取消变成 exit 2。改为每 256 次检查一次，读文件出错时当作“还没取消”。
15. **剪贴板服务在 UI 线程上等待图片转换**：`packages/official/clipboard/native-src/service.cpp:234` 在窗口过程线程上 join 上一次的 `imageWorker`。大图转换（最大 1 亿像素）期间，剪贴板变化通知和其他命令都会卡住。第二次 `convert-image` 应该拒绝或排队，不要在 UI 线程上 join。
16. **`InstallProtected` 有小的句柄泄漏**：`search.cpp:551` 和 `:554` 两条错误分支没有执行 `LocalFree(descriptor)`。进程存活时间很短，影响很小，可以用 RAII 包装。
17. **索引范围一直加载失败时可能继续执行（待确认）**：`search.cpp:131-139` 中，如果连接成功但 `GetScope` 直到 10 秒超时都失败，查询会在 `volumes` 和 `exclusions` 都为空的情况下继续。用户配置的排除目录会不会因此泄露，取决于上游 Pulse 代码的语义，子任务无法查看那部分代码。建议 `GetScope` 从未成功时直接返回 `service-unavailable`。
18. **SDK 包必须先构建才能用**：`packages/sdk/package.json` 只导出 `./dist/*`，而 `dist/` 不在 git 里。没有先运行 `pnpm sdk:build` 时，宿主导入 `@spark233/sdk` 会失败。可以加 `prepare` 依赖，或者增加一个指向 `src` 的 `development` 导出条件。

### 确认没有问题的部分

- **`native-runtime` 的限制与文档一致**：单行最大 1 MiB、最多 64 个在途请求、`error` 最长 4096 字符、默认超时 10 秒（上限 120 秒）、init 时校验 PID、先确认保存再停止、CRLF 换行和跨块的 UTF-8 都能正确处理。
- **请求类型一致**：宿主的 `rpc()` 请求类型与 SDK 的 `NativePluginRequest` 完全一致；`PluginWebEvent`、`PluginWebOperation` 以及 preload 的操作白名单也与 SDK 一致。
- **`search.cpp`**：UTF-8 与 UTF-16 互转使用了严格的无效字符检查，转成 `int` 之前先校验了长度；请求最大 1 MiB，响应最大 8 MiB，与宿主一致；SCM 句柄在所有路径上都会关闭；受保护目录检查了 ACL 和重解析点。
- **剪贴板快照**：分配内存前先检查长度，总长度不会溢出，HGLOBAL 的所有权处理正确。
- **OCR worker**：请求最大 4 KiB；task id 格式严格，并校验了父目录；分配内存前先检查图片尺寸；写结果不会覆盖已有文件。
- **Web host**：`lifecycle.result` 和 `query.result` 会丢弃过期的请求 id；查询结果中出现未声明的命令 id 会被拒绝。

## 9. 实施记录（2026-10-28）

用户授权后，按第 7 节顺序处理。上文保留为修复前审查快照，行号和旧路径不能作为当前源码定位。当前实现入口见 [架构说明](architecture.md)，历史状态见 [文档索引](README.md)。

| 批次          | 当前变更                                                                                                                                                                                                                                                                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0 与权限边界 | 笔记统一经过保存队列和文档切换门禁；保存失败、保存/加载期间继续编辑均保留当前草稿。拖入多个文本文件逐个打开，切换失败即停止。笔记页面撤销宿主管理权限，配置修改限宿主；剪贴板读取由 isolated preload 检查真实用户激活；MCP replace 要求 full。                                                                                                    |
| P1 正确性     | 外部文件重载防重入并保护未保存稿，写入检查磁盘冲突；任务锚点等待预览 DOM；默认视图仅随对应配置变化。Launcher 查询与执行分别计数，动作后保留增量查询；应用网格限高滚动、键盘导航到末项。剪贴板与 emoji 请求丢弃过期响应。                                                                                                                          |
| 主进程与恢复  | MCP 按配置目录隔离，双向挑战认证并限制连接、消息、队列与输出。文件授权按窗口隔离、目录授权过期、规范路径校验。恢复校验配置和授权，native 信任同时比较当前可信代码的实际文件树；回滚失败暂停写入，rename 重试，快捷键失败记录 warning。所有插件停止后的宿主清理尽力执行。保存拒绝/超时保留进程，仅原生确认框明确选择强退后才结束资源域拥有的进程。 |
| 文档          | 新增索引和当前架构，重写双语 README；旧日期文档、重复 TODO 和上游发布链路归档，保留有效设计及上游署名；修正当前命令、路径和模板品牌。                                                                                                                                                                                                             |
| 架构          | 新增共享命令策略、IPC 注册表及 notes/plugins/backup/dialogs 模块；共享桥接定义并为核心笔记 Commands/Events 提供类型约束。笔记组件移入 features/notes，共用 useNoteDocument，提取 useSplitScrollSync；Launcher 两处动作 UI 共用领域组件，调用集中到 API。旧配色映射与语义 token 集中到 UI 包。笔记 backend.mjs 改为构建产物。                      |
| P2 与工程     | 明确 lint 规则、原始语言键和静态 t() 检查；Electron 测试及可推导的 JS 插件加入类型检查。构建入口避免重复 typecheck，新增 Git Bash 工具链入口。预览增加 memo 边界与稳定回调，滚动测量与 deferred 内容一致，剪贴板草稿合并写入并在关闭前 flush。补充状态/并发/权限回归（包括剪贴板过期查询与关闭前草稿 flush）、无障碍与翻译。                      |
| native 与 SDK | 搜索管理子进程等待有上限、检查取消，受控子进程放入 kill-on-close job；修复 scope 检查和释放。native 坏行及回调异常隔离、stdio 监听与销毁收敛。SDK 错误长度受限、查询发送失败回报短错误，冷启动等待查询处理器；未实现能力在激活前拒绝。搜索完整代码比较保留，实例内缓存绑定文件身份。                                                              |
| CI            | PR 独立执行类型、lint、格式、Node 与浏览器测试。Windows 安装器工作流显式准备 native/词典/SDK 资源，提供 PythonExecutable 参数支持本机 Python 路径；远程 runner 尚未执行。                                                                                                                                                                         |

### 对原审查结论的校正与后续边界

- `useDeferredValue` 仍有调度价值；本轮保留它，并增加 memo 和稳定回调来减少重复解析。
- 根 build、desktop build 的重复类型检查原为两层；“PR 一共三次”描述不准确。本轮增加 build:assets，独立 desktop build 仍保留类型门禁。
- SDK 必须先构建才能解析包类型，这本身不是缺陷。search 是 C++ 插件，没有 TS 输入，不添加空 typecheck；使用 native 编译验证。
- 第 2.1 #15 的自动杀进程建议不采用。失败或超时保存确认继续阻止自动终止业务进程；强退必须用户在原生确认框明确选择。备份、迁移和普通停用没有自动强退分支。
- 主进程和笔记巨型组件完成首轮领域提取，尚未达到“main.ts 只剩启动与生命周期”或拆出所有侧栏/菜单/更新提醒的最终形态。旧 generic invoke 仍用于未迁移命令，其返回值并非全部具有精确映射；注册表为全部命令提供显式策略与基础对象验证，细化 schema 仍随领域迁移推进。这些是后续结构工作，不能表述为全面架构迁移完成。
- 浏览器测试覆盖真实组件与受控桌面传输，不能替代物理 IME、多屏、UAC/SYSTEM 搜索服务、真实注销或干净安装验收；远程 CI 通过状态也须另行取得证据。

### 本轮最终验证

验证日期：2026-10-28。本机使用仓库锁定的 Node 26.12.1、pnpm 12.15.0，Windows 脚本使用 PowerShell 7.5.4；各项重型检查串行执行。以下是本轮收尾时的工作区结果，包含当时已落入工作区的并行功能改动。

| 检查                                 | 结果                                                                      | 本机证据                                                                                                                                                                                       |
| ------------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck`                     | 通过，含 Electron 与 browser 测试文件                                     | `local-build/optimization-typecheck.log`                                                                                                                                                       |
| `pnpm lint`                          | 通过，0 errors、146 warnings；原始语言键和静态翻译调用检查通过            | `local-build/optimization-lint.log`                                                                                                                                                            |
| `pnpm fmt --check`                   | 通过                                                                      | `local-build/optimization-format.log`                                                                                                                                                          |
| `pnpm test`                          | 57 个文件、232 项通过                                                     | `local-build/optimization-tests.log`                                                                                                                                                           |
| `pnpm test:ui`                       | 8 个文件、11 项通过                                                       | `local-build/optimization-ui.log`                                                                                                                                                              |
| `pnpm pack:win`                      | 通过，生成 Windows x64 目录包及 7 个独立官方插件包                        | `local-build/optimization-pack.log`、`release-electron/win-unpacked/spark233.exe`                                                                                                              |
| Windows 目录包完整 smoke             | 通过，`ok: true`、`runtime.packaged: true`、exitCode 0，63.994 秒，未超时 | [report.json](../local-build/electron-smoke/72d1896f-98fc-45b0-8e0a-2ce0b202d6d6/report.json)、[process.json](../local-build/electron-smoke/72d1896f-98fc-45b0-8e0a-2ce0b202d6d6/process.json) |
| native 搜索、应用、剪贴板构建        | 本轮均通过，搜索 C++ 重新编译与链接                                       | `local-build/optimization-native-search.log`、`local-build/optimization-native-applications.log`、`local-build/optimization-native-clipboard.log`                                              |
| 当前文档本地链接、`git diff --check` | 14 个文档、0 个缺失目标；diff 无空白错误                                  | `local-build/check-active-doc-links.py`、`local-build/optimization-diff-check.log`                                                                                                             |

目录包 smoke 命令：在 `source scripts/use-toolchain.sh` 后，使用 PowerShell 7 执行 `scripts/smoke-windows.ps1 -ElectronExe 'D:/code/galaxy-tools/release-electron/win-unpacked/spark233.exe'`。执行过程使用隔离配置与数据目录，预置暂停剪贴板记录，不读取用户日常剪贴板历史。

本轮同时修正 smoke 的过期假设：通过真实 option 元素定位条目；按当前 Launcher 入口先输入模式名称，再验证维护恢复与业务错误保留；配置并发写入改由 Launcher 与真实设置窗口发起，并明确断言笔记窗口修改宿主配置被拒绝。上述调整保留原有失败保护断言。目录包报告确认 `saveFailurePreservesWindow`、`noteAdministrationDenied`、`independentSettingsPatches`、`finalPluginSave` 及维护恢复检查通过，`errors` 为空。

构建后的 `packages/official/notes/backend.mjs` 已再次从工作区移除，以保留版本控制中的删除；源码与构建入口保留，下次构建会按需生成该忽略产物。原有应用与插件生成物未做批量清理。

本轮 smoke 验证的是笔记、窗口/胶囊、IPC 权限、配置更新与维护生命周期链路，不代表七个插件的全部业务功能验收。报告中多屏迁移、冷启动恢复观察和全屏避让仍未取得成功观察证据；远程 CI、NSIS 安装、物理 IME、UAC/SYSTEM 服务及真实系统注销也未在本轮验收。lint 的 146 条 warning 及构建的大 chunk 提示仍存在，后续应随领域拆分逐步处理。上述本机报告位于被忽略的 `local-build`，不会随源码自动提交。

## 10. 后续拆分与验收（2026-10-28）

本节接续第 9 节，后续证据与尚需桌面配合的项目见 [后续验收记录](evidence/optimization-followup-2026-10-28.md)。

- `main.ts` 收敛为入口，启动组合根迁至 `runtime.ts`，窗口、便签界面、菜单、备份、MCP、官方运行时和设置逻辑拆入 `electron/host`；命令按领域拆入 `electron/ipc`。
- 笔记窗口拆出会话、文档、滚动同步、外部文件监听、更新提醒与菜单 hooks，以及侧栏、编辑器、标题栏、更新面板和菜单组件。
- 全部宿主命令具有显式参数 schema；注册表先校验再进入写队列。调用端、preload 与浏览器 fixture 共享命令参数/返回值与事件契约，领域分派使用 schema 推导的判别联合。底层未知 IPC 输入仍须运行时校验，业务动态 JSON 结果保留明确的 JSON 边界。
- 本地 typecheck、lint、格式检查与 Node/UI 测试已执行；本轮新增独立插件包业务探针、NSIS 安装/卸载探针、真实服务探针与不依赖旧 addon 的剪贴板服务探针。验收状态以链接记录为准。
- 已实际执行 NSIS 静默安装、已安装应用冒烟、卸载与默认文件关联保持；已实际执行搜索服务提权升级、LocalSystem 账户确认、生产连接和受控内容查询。
- 远程干净构建发现并修复 TEMP 短路径目录身份差异、原生资源归档的中文文件名解码和宿主 UI/插件组装顺序问题。最终快照 `aac62a9` 的检查与安装构建均成功；已下载远程 NSIS 产物并完成本机安装、运行、包内插件业务与卸载验收，五项检查通过。完整快照、报告与产物哈希见后续验收记录。
- 多屏、物理输入法与真实注销需要相应实机条件。剪贴板私有窗口站在普通进程下返回 AccessDenied (5)，提权隔离探针已验证真实监听和回放。AI 翻译未提供实际服务配置，仅验收离线词典和未配置时的拒绝行为。

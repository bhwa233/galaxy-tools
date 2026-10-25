# spark233 剪贴板历史

本插件的生产路径监听新增剪贴板通知，不主动读入启动前已有剪贴板。历史保存在本地 SQLite 和外置多格式原始资源中，默认不限条数和天数，也不自动清理。敏感标记在原生读取内容之前排除；暂停、排除应用和指定文本规则在记录入口生效。

已实现的业务路径包括：

- 内容、格式、来源、标签、备注搜索；原始格式、纯文本和图片按文件分别复制或回贴。
- 编辑并恢复原文，独立的未提交草稿；自动保存草稿及停用前刷新，草稿不会覆盖原内容，也不会进入待清理列表。
- 历史与独立收藏、分别置顶及排序、多标签与备注、收藏分组及图库分组。
- 主动导入图库 PNG、文字/图文/文件引用合并、表情符号及最近使用、便捷小窗的数字/F 键与位置偏好。
- 空间统计、可恢复的显示范围、待清理预览与确认。清理在同一写事务中重新核对全状态指纹，避免同一毫秒内重复制、编辑或增加引用后仍被旧预览删除。
- 简体中文 `zh-CN` 和英文 `en-US` 工作区资源，不提供第三种语言。

图库导入使用宿主原生文件选择器提供的解码 PNG，不接受页面提供任意路径。图片持久化为插件拥有的资源，区别于剪贴板文件条目对原文件的引用。文件原路径失效时拒绝文件复制，不假称备份了文件内容。

## 原生与数据边界

原生助手支持 `CF_UNICODETEXT`、`CF_HDROP`、`CF_DIB`、`CF_DIBV5`、HTML、RTF 和 PNG 的 HGLOBAL 原始数据，单次快照上限 64 MiB。一次复制的快照在同一 `OpenClipboard` 范围中读取。恢复先预分配内存，再在一个打开范围中清空并提交多个格式；失败时尝试恢复支持的旧格式并报告失败，历史原始快照不删除。其他自定义格式并非本版本的保真承诺。

`copy` 只修改剪贴板；`paste` 明确执行前台恢复和粘贴快捷键。目标同时绑定 HWND、PID 与进程创建时间，目标变化、焦点拒绝、修饰键未释放或 UIPI/按键注入失败均报错。成功响应仅表示系统接收了粘贴按键，不证明目标应用已经消费内容。宿主内部切换工作区时应保留已有外部目标，不重复记忆当前宿主窗口。

DIB 先由 Windows WIC 转为 PNG，再交 Electron 的图片 API 或 OCR。Electron 45 对受控 BMP 的 `createFromBuffer` 和 `createFromPath` 均返回空图，不能用它们冒充 BMP 支持。原始 DIB 仍完整保留；PNG 与最大 320px 的缩略图按原始资源 hash 缓存，仅在无引用后主动回收。转换工作在原生后台线程中完成，不占用剪贴板通知消息循环。

停用时先等待工作区草稿，再冻结原生录制、排空已收到的快照并 checkpoint；保存拒绝后原实例保留并恢复此前录制策略。成功释放时正常停止助手、关闭数据库和清理私有 spool，不以强制结束进程冒充保存或正常停用。

后台崩溃后的未提交快照、来源元数据和草稿属于业务数据，持久化在插件 `dataDir/recovery/<session>/`，随统一备份与数据目录迁移保留。草稿交接直接写入该域；停止崩溃实例前把原生 cache/spool 中尚未提交的快照迁入该域，逐文件原子落盘后才移除 cache 副本。下次启用先恢复再开始录制；恢复 raw 时单项复制到当前受限 cache 后调用后台，不放宽后台路径授权。恢复失败保留业务数据中的原文件；当前隐私策略返回 `captured:false` 则按明确过滤处理并丢弃，不强制导入或反复重试。

## 宿主接口

`createClipboardRuntime(options)` 接收已经验证的插件目录、原生 descriptor、私有 data/cache、执行信任与 scope，以及真实 `PluginBackendController` 的 activate / maintenance / prepareStop。宿主控制器不打开 SQLite；数据业务在包内 backend.mjs 的 utilityProcess 中运行。界面入口使用 `request(ClipboardRequest)`。

内部后台协议为 `activate({commandId: "data", parameters: {action, ...}})`。CRUD、schema、精确去重、合并、草稿、收藏、图库与清理逻辑均随 backend.mjs 版本更新。原始快照和 PNG 在私有 cache/spool 文件中交换，不经 IPC 传大块 base64；后台拒绝越界路径、链接和超限文件。普通页面命令不能直接调用这些内部动作。

额外宿主回调：

- `pickImages(): Promise<Array<{name, png}>>`：原生选择并解码的 PNG。
- `renderThumbnail(bytes): Uint8Array`：只处理已经归一化的 PNG，返回小于 512 KiB 的 PNG。
- `prepareWorkspace(): Promise<StopDecision>`：刷新打开的工作区草稿。
- `beforePaste()`：先隐藏宿主工作面。
- `openWorkspace({compact, position})`：完整/便捷工作区，位置为 cursor 或 edge。

工作区 `registerPrepare(flush)` 可让宿主保存协议等待草稿。只有 `draft.save` 在 scope preparing 期间继续接受；复制、回贴及其他界面修改仍被拒绝。受信宿主用窄 maintenance 接口保存草稿和排空快照，最终再次请求 backend prepareStop，避免使用新写入之前的旧保存确认。

列表文字仅传前 4 Ki 字符，详情预览仅传前 256 Ki 字符，并明确标记超限；长文本编辑禁用、发送需要选择片段，原始复制、合并与文件导出继续使用完整数据。列表缩略图合计最多 2 MiB。待清理每批最多显示及删除 500 项，存在更多候选时必须重新预览，绝不删除未向用户展示的下一批。HTML 使用现有 sanitize Markdown 渲染链安全预览且不加载图片，RTF 提供有界源数据预览；两者都不改变原始格式。

## 构建和验证

正式原生构建与打包资源：

```powershell
pwsh -File scripts/native-clipboard/build.ps1 -BuildRoot local-build/spark233/native-clipboard-p6
node packages/official/clipboard/build.mjs --native-build-dir local-build/spark233/native-clipboard-p6/build
# 只更新可独立分发的数据业务后台，无需重编原生助手：
node packages/official/clipboard/build.mjs --backend-only
```

包内路径全部相对，`resources.json` 同时记录实际二进制字节、SHA-256 与 C++/CMake 输入 SHA-256。`backend-resources.json` 记录后台构建输入和单文件产物 SHA-256；已有 Vite 构建器将 Zod 打入模块，node:sqlite 等 Node 内置模块外置，Zod 许可证随包保留。客户端不执行 npm 生命周期脚本，也不临时编译。Windows WIC、COM 和用户界面系统库由 Windows 提供，没有新增 npm 依赖。

本轮使用隔离人工快照和 SQLite 目录验证数据，不访问真实桌面剪贴板：

- 独立后台证明：`local-build/spark233/native-clipboard-p6/backend-1792896204028/report.json`，11 项检查在实际 Electron 45 / Node 24.22 utilityProcess 中完成。单文件后台复制到独立包目录后捕获受控快照、精确文件回放、拒绝越界、有界 HTML/RTF 和长文本预览、收藏分组引用、清理 SQL、preparing 草稿保存与最终确认、正常退出并以新 PID 恢复。两个进程 PID 52792 / 54452 通过 scope 正常退出，资源归零，stderr 为空。
- 数据证明：`local-build/spark233/native-clipboard-p6/history-1792892900424/report.json`，19 项检查覆盖原始多格式、精确去重、编辑恢复、独立引用、显式清理、图库导入、UTF-8 CF_HTML 图文合并、草稿与同毫秒重复制保护。它使用开发 Node 26，并非新助手实时通知/回贴验收。
- 图片证明：`local-build/spark233/native-clipboard-p6/image-decode-1792893529780/report.json`，系统 WIC 将受控 2×1 BMP 转为 Electron 45 / Node 24.22 可以准确解码的红/绿 PNG。
- 缩略图与资源证明：`local-build/spark233/native-clipboard-p6/image-history-1792894160360/report.json`，真实 Electron 数据模块验证惰性缩略图、原始 DIB 保留、PNG 导出、最近使用排序及无引用缓存回收；没有创建窗口或打开剪贴板。

当前 Windows 用户创建新的私有 window station 被 `ERROR_ACCESS_DENIED (5)` 拒绝；此前 NULL 自动名曾返回 183。没有加入已有站、没有使用新的登录会话或账号，也没有改用真实桌面剪贴板绕过取证限制。新助手的实时录制、完整原生回放、焦点与回贴行为仍需最终受控验收；P1V 旧桥证据不等于本实现已通过这些行为。

包内 backend.mjs 已独立构建并实际运行，不再依赖宿主加载旧版 SQLite 业务代码。React renderer 的分包与按安装版本加载由宿主装配；完整插件启停、独立更新与最终界面验收仍以宿主集成证据为准，不能仅凭后台样本通过就标记全部 P6/P7 完成。

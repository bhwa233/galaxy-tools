# 文件名搜索改用 Everything

日期：2026-11-07

状态：已实现并通过隔离实测（[证据](evidence/everything-search-2026-11-07.md)），未做安装包与干净机器验证。只兼容 Everything 1.5；正文搜索保留，改用 Everything 1.5 内容索引。本文取代 [launcher-architecture.md](launcher-architecture.md) §7.4 的 Pulse 文件名索引路线；实施清单见 [launcher-todo.md](launcher-todo.md) 的「2026-11-07 文件名搜索改用 Everything」。

## 1. 决定

1. 文件名搜索的后端从自建 Pulse 索引服务改为 [Everything](https://www.voidtools.com/)。
2. 启动器内的内联文件结果保留，结果动作不变：打开、打开所在位置、复制路径。
3. 删除自有的「文件搜索」独立窗口。需要查看完整结果、筛选、排序或管理书签时，直接打开 Everything 自己的窗口并带上当前查询。
4. 不再同时维护两套全盘索引：Pulse 的索引服务、构建脚本、NSIS 服务钩子和相关原生程序全部移除。
5. **只兼容 Everything 1.5**，只使用 SDK3。用户已安装的 Everything 1.4 不使用，此时改用自带的便携 1.5 实例。
6. **正文搜索保留**：`nr` 关键词改为查询 Everything 1.5 的内容索引，在启动器内返回内联结果；不再自带正文进程。

## 2. 背景与取舍

现有方案（[search 插件 README](../packages/official/search/README.md)）从固定 commit 的上游 Pulse 编译原生程序，并由本项目负责一个以 SYSTEM 身份运行的索引服务，包括 MFT 枚举、USN 增量、命名管道、按调用者过滤权限，以及 UAC 安装和升级。一期 P5 剩余的待办大多卡在这套服务的实机验证上。

Everything 是成熟的全盘文件名索引，支持 NTFS 增量更新和按文件夹索引非 NTFS 卷与网络盘，许可（[License](https://www.voidtools.com/License.txt)）允许附带许可声明后打包分发。uTools 的官方「本地搜索」插件也采用同样的路线：自带便携版 Everything，用户已安装时优先使用已安装的版本。

接受的退化：

| 项目           | 现状                               | 改用 Everything 后                                                                        |
| -------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| 文件名拼音匹配 | Pulse 支持拼音和首字母             | 不支持。应用搜索的拼音不受影响                                                            |
| 按调用者过滤   | 服务按调用者权限过滤               | Everything 返回全部已索引文件。单用户桌面可以接受；宿主仍在内联结果中过滤自身私有数据目录 |
| 自有搜索窗口   | 目录范围、最近和收藏条件、命中预览 | 由 Everything 窗口的筛选、书签和预览代替；`workspace-history.json` 不再使用               |
| 正文命中行预览 | Pulse Instant 返回命中行           | Everything 只返回命中文件，不返回命中行；「预览命中行」移除                               |
| 版本成熟度     | 固定的 Pulse commit                | 自带便携版为 Everything 1.5.0.1424b（beta）；早期 alpha 安装使用实例名 `1.5a`             |

## 3. 接入方式

### 3.1 选择 Everything 实例

按以下顺序探测，使用第一个可连接的实例：

1. 用户已安装的 Everything 1.5：通过 [SDK3](https://github.com/voidtools/everything_sdk3) 的命名管道连接，先尝试默认实例，再尝试 `1.5a` 实例。连接后核对版本，低于 1.5 的实例不使用。
2. 插件自带的便携版 Everything 1.5（x64）：在独立实例名 `spark233` 下以后台方式启动，配置和数据库放在插件数据目录中，不显示托盘图标。这样不会与用户已安装或以后安装的 Everything 冲突。

   **与原设计的差异（实现时确定）**：便携实例不读取 NTFS 卷，只以文件夹方式索引当前用户目录并监视变化。读取 NTFS 卷需要安装 Everything Service 或管理员权限；这样首版无需服务和 UAC。用户目录以外的文件需要用户自己安装 Everything 1.5（会被优先使用）。

使用用户自己的 Everything 时，索引范围、排除规则和内容索引设置都以用户在 Everything 中的设置为准，本插件不修改。

### 3.2 查询

- 内联结果通过 IPC 查询，使用 SDK 提供的结果上限、偏移和排序，只请求路径、名称、大小和修改时间等必要字段。查询身份、取消和渐进补充仍遵循 §7.2 的合同。旧查询的结果不再进入列表。
- 用户输入原样作为 Everything 搜索语法传入，不拼接成命令行参数。
- 结果在宿主一侧过滤掉宿主和插件的私有数据目录，沿用现有的私有根检查。

### 3.3 打开 Everything 窗口

内联结果末尾提供「在 Everything 中查看全部」动作，按回车或点击后以当前查询打开对应实例的 Everything 主窗口。启动参数只包含受校验的实例名和查询文本，通过参数数组传递，不经过 shell。

原来的 `workspace` 命令（「文件搜索」窗口，关键词「搜索窗口」等）改为直接打开 Everything 窗口。原来的「文件搜索范围」设置改为打开 Everything 的选项窗口。

### 3.4 未就绪时

| 情况                         | 处理                                                                   |
| ---------------------------- | ---------------------------------------------------------------------- |
| 没有可用实例，便携版尚未启动 | 首次使用时启动便携版；启动中显示「正在准备文件索引」，其他来源继续工作 |
| 便携版首次建索引             | 显示建立中的状态，内联结果逐步补充                                     |
| 需要用户目录以外的文件       | 便携实例不覆盖；提示用户安装 Everything 1.5，安装后自动改用用户实例    |
| IPC 超时或实例退出           | 当前查询返回可重试的状态，不阻塞启动器                                 |

## 4. 移除的内容

- `scripts/native-search/` 的 Pulse 构建、冒烟和服务验证脚本。
- `packages/official/search/native/` 中的 Pulse 原生程序、`native-src/` 的桥接代码、`licenses/Pulse/`。
- 安装器中的 `search-service.nsh` 服务注册，以及应用内的「安装文件搜索服务」「索引服务管理」入口。
- 文件搜索工作区窗口（`SearchWorkspace`）及其在[插件窗口统一状态栏](plugin-window-status-bar.md)和[布局 PRD](plugin-window-layout-prd.md) 中的条目。

升级时停止并卸载旧的 spark233 Pulse 服务，删除其索引数据。这一步沿用现有安装器的提权路径执行，失败时不影响新版使用 Everything。

## 5. 正文搜索

Everything 1.5 提供内容索引（[Content Indexing](https://www.voidtools.com/forum/viewtopic.php?f=12&t=9793)），`content:` 查询的是已建立的内容索引，速度与文件名搜索相当。正文搜索因此只是同一条 SDK3 查询加上 `content:` 前缀，不再需要自有正文进程。

- `nr` 关键词在启动器内返回内联结果，结果动作与文件名搜索相同；「在 Everything 中查看全部」以 `content:` 查询打开 Everything 窗口。
- **自带便携实例**：在其配置中开启「Index file content」，包含范围限定为用户目录下的文本、Markdown 和常见代码扩展名，并排除宿主私有数据目录。内容索引常驻内存，作者建议文本总量不超过约 1 GB，没有包含规则时曾出现耗尽内存的问题，因此必须设置包含范围。
- **用户自己的 Everything**：不修改其设置。未开启内容索引时，查询退回 `notindexed:content:`（现场读盘，较慢），并在结果区提示可以在 Everything 中开启内容索引。
- Everything 不返回命中行或上下文片段，「预览命中行」命令移除。正文格式范围由 Everything 的内容索引决定，不再沿用 §7.5 中 64 MiB 单文件上限等 Pulse Instant 约定。

## 6. 待验证

已验证（隔离实例，见[证据](evidence/everything-search-2026-11-07.md)）：

- 便携实例 `spark233-smoke` 与本机已安装的 Everything 1.5.0.1424b（默认实例）及其服务同时运行，互不影响；不需要单独安装服务。
- SDK3 版本核对：默认实例返回 1.5.0.1424；`1.5a` 不存在时连接返回 ENOENT 并跳过。
- 文件名（含中文）与正文查询、私有目录排除、`node_modules` 正文排除、超过 4 MB 的文件不进入内容索引；首次结果约 0.3–0.9 秒。
- `-instance <名> -search <文本>` 能把查询转给运行中的实例并退出；`-focus-search-edit` 会让转发进程不退出，已去掉。
- 停止插件后实例退出，命名管道消失。

仍待验证：

- 安装包内的便携版体积（Everything.exe 约 5 MB）与许可声明位置；干净 Windows 上的首次启动与真实用户目录的内容索引内存占用。
- 安装器升级时卸载旧 Pulse 服务（`legacy-search-service.nsh`）的真实提权路径。
- Everything 窗口的中文界面（便携版附带 `Everything.lng`）。

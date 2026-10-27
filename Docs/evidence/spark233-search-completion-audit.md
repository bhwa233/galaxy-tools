# spark233 P5 搜索完成度审计

> 2026-10-26 续作：下文的“当前正式字节”属于 10 月 25 日历史输入，不能绑定本次重新构建。私有数据域的动态排除、真实 native 取消以及 Search 内容配置的 profile 归属已完成新字节 14 项回归，最新资源身份与隔离失误记录见[本轮收口](spark233-notes-finalization.md)。旧 S20/ACL/WAL 等证据仍仅证明其原输入与对应范围。

日期：2026-10-25；分支：`codex/spark233-refactor`。本记录按 `Docs/launcher-todo.md` P5.1–P5.10 与架构 7.3–7.6 逐条核对。源码实现、隔离 fixture 的实际证明、真实目标机验收分别记录；没有运行 UAC、真实用户盘全卷索引或用户剪贴板。本轮只强化现有生产 smoke 两个数据版本边界，不新增测试套件、框架或平台矩阵。

审计发现正文结果跨原生桥接丢失文件身份/版本的实际缺口，已修复并重新原生构建。其余列出的未证明项目仍然是验收缺口，不能因固定源码包含 MFT/USN 或默认卷规则就标成已验收。旧 `048671…` 安装器是修复前候选；随后统一完整构建 40596 和当前 `3caccc96…` 安装器已包含本轮修复，精确身份与分发证据见 [当前打包记录](spark233-packaging.md)。

## 当前正式字节与可引用报告

最新生产接入报告为 `local-build/evidence/search-production/a9a8a308-2c90-473a-9e8f-f117e8433e96/report.json`（以下称 S20），20 项检查全部为 true，`ok: true`、`serviceInstallationExecuted: false`。它真实经过本地 `.tgz` staging、PluginManager、正式 adapter、Search 和专用 fixture Index/Instant；打开/定位/复制路径使用记录回调，没有运行真实关联应用或改写剪贴板。

同目录 `current-native-binding.json` 重新计算报告留存的 `source/package/native`、当前 `packages/official/search/native` 与 manifest 的散列，四个 payload 均相同：

| 文件                  | 当前字节数 | 当前 SHA-256                                                       |
| --------------------- | ---------: | ------------------------------------------------------------------ |
| spark233.Search.exe   |  1,518,592 | `80299ce859bb3b3500f287cbf4718809fc8631ae92ff2a16717b103ce73dd521` |
| spark233.Index.exe    |  3,389,952 | `32ca4bd14e1633264b19386b9d317494866bf6c00e57759d3763310042fdf614` |
| spark233.Document.exe |    239,616 | `8b6a52713bb9aa9e8bac044be100e40804e9399db207d4e1fbc51e3dd51c1606` |
| pdfium.dll            |  7,370,752 | `04100c03e41cac1f979e36e5e26fb860bcb5a7461f53830d3c098716624a27a9` |

上游固定提交为 `c4fe01ed82fe091f495f531972a854aa32caac2b`，原始 tar SHA-256 `CD158FCB689324DF5065FECCCD5DB0147B86BFCC7B06A4FFB9B160427E096634`，当前 adaptation 为 7。构建脚本可以从固定导出依次应用 1–7 适配；manifest 记录本仓源码输入散列。新日志为 `local-build/spark233/packaging/native-build-file-version.log`、`p5-version-typecheck.log`、`p5-version-lint.log` 和 `p5-version-production-smoke.log`，均通过。此处描述 Search 阶段 gate；随后统一完整构建 40596、七包分发审计和目录包/NSIS 均已完成，当前 native 字节与本表相同，详见当前打包记录。

应用代表报告 `local-build/spark233/applications/custom-runs/6523128d-e70d-4e50-902b-654496505f71/report.json`（以下称 A12）12 项通过；它证明受控应用发现与参数/工作目录分派，不代表真实 Store 应用都已启动成功。P1V `20261024-183651-720` 的受限 token/ACL 报告属于旧 Index 字节和独立 fixture，保留为技术路线证据，不能冒充当前生产 Index 或 SYSTEM 服务的验收。

## 十项审计映射

### P5.1：应用来源、启动语义与拼音（架构 7.3）

源码：`packages/official/applications/backend.mjs` 的开始菜单 roots、`Get-StartApps`/`Get-AppxPackage`、`discover`、自定义 settings、`watch`/周期校准、`uninstallEntry`；`pinyin.mjs` 与正式 ApplicationMatcher；`electron/plugins/official/applications.ts` 的 `performIndexedApplicationAction`、原 shortcut 执行及 PNG 图标缓存。`.lnk` 保留原快捷方式语义，自定义 exe 传独立 argv/cwd；renderer 只持有不透明选择 token，执行前重新检查 inventory 与路径。

已证明：A12 的自定义设置原子持久化/重启、全拼发现、图标有界与附加动作、原 argv/cwd、卸载项排除、真实受控菜单变更失效/刷新、移除项与 renderer 任意路径拒绝、停机释放。尚缺：目标机实际开始菜单、注册/Store 应用代表启动与图标表现；没有新增实现缺口。不能将 Get-StartApps 源码存在扩展为所有 Windows 注册方式均覆盖。

### P5.2：固定 Pulse 与独立运行边界（架构 7.4、7.5）

源码：`scripts/native-search/build.ps1` 固定导出/适配与 manifest；`native/search/CMakeLists.txt` 复用上游目标；`native/search/search.cpp` 的 `idx::IndexClient` 和 `ContentSearchClient`/`ContentAgentMode::Instant`；adaptation 统一服务、pipe、mutex、data root 的 spark233 名称。`SPARK233_SERVICE_ONLY` 禁止 ordinary query 启动上游 profile walk fallback。

已证明：S20 使用上述当前字节，真实文件名管道查询、Instant 中文/代码召回、取消退出及缺少服务时返回 Windows 1060。没有使用 ripgrep 或 FTS5 tokenizer 冒充 Instant。尚缺：真实 SYSTEM 服务部署链与独立长期运行/升级验收；没有新增实现缺口。S20 是显式 fixture root，不能证明默认全卷 MFT 路径已经执行。

### P5.3：授权与普通调用者权限（架构 7.4、7.5）

源码：`electron/main.ts` 搜索运行时的确认框；adapter `confirmServiceAction`；`search.cpp` 的受保护 Program Files 根、SCM/owner marker/DACL 校验、固定 helper 与 `runas`，普通查询仅 `CheckServiceVersion`，不自动升级。固定上游 `index_host.cpp` 保留 `ImpersonateNamedPipeClient` 与调用者可见性过滤；Instant 用户态代理不经 SYSTEM 读取正文。

已证明：S20 拒绝宿主安装/服务配置确认后可重试、没有进入 UAC，任意选择路径拒绝。P1V 旧字节曾通过受限 token/ACL fixture，不能把它算成当前服务已验收。尚缺：真实 UAC 允许/取消、SYSTEM 安装/升级/回滚/卸载、普通账号连接当前服务的可见性。授权拒绝不等于已验证 Windows UAC 拒绝；没有新增实现缺口。

### P5.4：模式、范围、取消分页与动作（架构 7.4、7.5）

源码：搜索 package 清单 `files`/`content` 模式和 `directoryFilter`，`electron/launcher.ts` 模式与 opaque action 路由；adapter 的 session/generation、cancel、cursors/selections、revision、打开/定位/复制/预览；native 在排除过滤后计算文件名可见分页，Instant 设置 `maximum_hits` 并按 offset 有界重查。正文只在查询时读，不启动全文预读 writer。

已证明：S20 第一页两条可见结果、第二页剩余一条且无私有命中、下一页与状态读取不破坏选择、替换查询禁止旧结果、动作只使用实际返回路径、Unicode 命中行预览和停用清理。尚缺：主启动器模式与目录选择器、键盘稳定选择/附加动作界面操作；持续变动目录上的 Instant 跨页一致性和真实全卷取消成本仍待目标验收。Instant 页是重查而非持久快照，不能声称强快照一致性；没有新增实现缺口。

### P5.5：MFT/USN 与覆盖范围（架构 7.4）

源码：固定导出 `src/index/index_engine.cpp` 的 `FSCTL_ENUM_USN_DATA`、`FSCTL_READ_USN_JOURNAL`、journal 丢失恢复、DeltaLog、`RebuildVolumeMft`/`FullRebuild`；`index_config.cpp::EnumerateLocalVolumes` 仅纳入 fixed/removable 并判定 NTFS。配置/重建入口接入当前 helper。

已证明：当前源和构建包含这些实现；S20 只构建受控 fixture 文件名索引，不运行 MFT/USN 或全卷变更。仍缺的是实际验收：创建/移动/目录改名删除的增量，journal 漏事件补偿，重建，卷离线/重连，移动 NTFS，非 NTFS/网络盘不纳入默认 MFT 范围。没有可用于勾选 P5.5 的当前实机报告；默认 NTFS 服务源码存在不能替代这些验收。此次未发现可凭只读检查直接确定的缺代码。

### P5.6：Instant 召回与资源路径（架构 7.5）

源码：`search.cpp` 明确启动 Instant，任务查询设置 text/code 后缀和最大 bytes；上游 `content_task_search.cpp` 通过受管理 worker/有界队列按需提取；可选持久内容索引与 FTS5 路径继续区分，不自动启动 writer。

已证明：S20 `instantChineseHasTwoTextHits`、`instantCodeHasTwoTextHits`、Unicode preview、取消替换、`noPersistentContentBodyDatabase`。固定文本含中文连续词、英文混排和代码符号；不能因为样本含英文就称每种英文查询或路径召回已单独验证。尚缺：短词、路径/混排查询与排序的少量实际代表操作，以及真实数据规模取消耗时。旧 P1V 140 字节性能样本不代表当前字节或完整应用预算；没有新增实现缺口。

### P5.7：便签/剪贴板自身内容合同（架构 7.6）

源码：`main.ts` 为 notes 注入基于业务 store 的实时 search，结果使用真实 meta.id；`official/notes.ts` 路由自身命令。剪贴板 `ClipboardHistory.list` 在自己的数据库内先计算 `visibleHistory`，再按查询/类型/标签筛选；`removeHistory` 撤下 in_history，后续确认清理删除字节。通用 search 注入 `store.dataDir` 与插件业务 data 根作为不可覆盖的私有排除，native 与 host 双层排除，不另建便签/剪贴板全文副本。

已证明：S20 私有 fixture 排除与 native 可见分页继续通过；已有最终打包测量 `measurement-1792905486885` 证明便签模式两个动作和保存导航边界，但它属于修复前候选，仅对未变的便签功能有历史意义。剪贴板历史数据 probe `history-1792900022609` 证明可见范围先于搜索/类型、待清理/置顶保护，未触碰真实剪贴板。尚缺：业务删除/保留改变、插件停用撤下候选的最终整体验收，不能称所有 clipboard native 流已验证；没有新增实现缺口。

### P5.8：故障、撤权、损坏与停用（架构 7.4、7.6）

源码：adapter 明确返回 service-not-installed/update-required/unavailable/error，设置保存先取消旧查询并清除选择/游标，stop 清理 session；`SearchServicePanel` 展示卷/进度/状态与刷新重建；上游索引加载拒绝损坏/部分 replay 后不暴露旧结果并请求重建。宿主按启用插件路由，可用来源继续工作。

已证明：原 S20/后续 24 项包含 Windows 1060、可重试拒绝授权、停用清理、状态查询不破坏前台选择；后续[真实文件 ACL](spark233-search-acl-followup.md)补齐当前调用者文件 ReadData 撤权与精确恢复。[故障补证](spark233-search-corruption-followup.md)在当前 adaptation 7 原生字节上实际破坏私有 WAL 头，取得拒绝 replay、自动重建、恢复后 service-status 的 11 项通过；目录继承 ACL 的 7 项证明旧 preview/open 拒绝、新 Instant 查询明确失败可重试、原 ACL 精确恢复；绑定 `ui-contract-followup` ASAR 的 11 项证明搜索连接不可用后仍可切换并选择真实应用/离线词典来源。[服务面板](spark233-search-service-read-errors.md)的真实组件 5 项红/绿回归补齐读取成功清旧错、操作错误保留。按 P5.8 原文的功能范围，五类代表路径已有证据，主清单补勾选。

本次为 2026-10-26 文档复核，没有重新运行上述 Windows 场景或改绑其历史输入；组件上游 IPC 返回受控，不能用它证明 SYSTEM 服务恢复。损坏拒绝来自真实原生诊断，恢复状态来自正式 Search；未捕获或宣称 renderer 显示“正在重建”。主 snapshot 任意损坏、所有 WAL 错误组合、并发挂起查询延迟和完整物理 UI 未验证。SCM/SYSTEM/UAC、全卷 MFT/USN、卷离线重连仍按 P5.3/P5.5/P5.9 原范围保留，不新增为 P5.8 勾选前提。旧 scope report `12eaa8cb-3490-44e3-b491-a6727443bcce` 仅保留其个人范围设置/旧 token 撤销证据，不冒充当前 native 分页验收。

### P5.9：默认服务、卷与排除（架构 7.4）

源码：`electron/installer/search-service.nsh` 的 `customInstall` 默认调用固定 Search helper，升级卸载阶段保护服务；用户未确认时普通查询提供重试。固定 `index_config.h` 默认 `include_fixed_ntfs/include_removable_ntfs/exclude_system = true`，默认 groups 为 windows/temp/old/node_modules；`index_config.cpp` 生成系统排除并判定在线卷；`SearchServicePanel`、helper 提供卷/路径排除和显式重建，不要求首次逐卷选择。

已证明：安装脚本/默认配置/固定 native 产物和设置入口存在；S20 只证明拒绝宿主授权可重试与缺少服务反馈。尚缺：安装器实际默认服务安装、在线固定/移动 NTFS 自动纳入、真实系统排除/卷排除、UAC 拒绝再重试。源码默认值不是实际 MFT/USN 或安装成功证据；没有新增实现缺口。

### P5.10：正文准入、身份版本和撤销（架构 7.5、7.6）

已修复实际缺口：旧 `Hit` JSON 丢弃读取时 identity/size/modified，host 到达后 stat 可能把旧片段绑定为新版本。adaptation 7 将上游读句柄校验的 `job.version` 和真实 `file_id` 沿 ContentHit/agent/client 传到 bridge，JSON 的所有 64 位字段为十进制字符串；version 包含卷序列号、file ID 和 ChangeTime。host 使用 bigint stat 对比卷/ID/大小/mtime/ChangeTime，发布前丢弃过期命中，opaque 动作执行前重新比对；preview 从同一个 handle 在读取前后比对，并复核当前路径仍指向该身份。范围排除/取消/权限和任意 renderer 路径拒绝保持。

源码准入：后缀仅文本/Markdown/代码，1–64 MiB 设置；上游提取前拒绝 reparse/offline/cloud recall、隐藏文件/祖先，text reader 保留二进制/编码处理和读取期间稳定性检查。设置保存撤销旧查询/选择，session 缓存在停止时清理，无持久正文库。

已证明：S20 原有类型/1 MiB/隐藏及隐藏祖先/默认恢复继续通过；新增 `lateChangedContentIsNotPublished` 使用真实读取完成后、host 发布前修改文件，旧命中不发布；`sameSizeTimeReplacementIdentityIsRejected` 在原路径放入相同字节大小和精确 mtime、不同 file ID 的真实新文件，旧 preview 和 open 被拒绝。尚缺：真实云占位/离线文件、更多编码及 ACL 变化的少量目标机代表，真实服务范围变更后的跨进程状态；不能把编码源码和属性跳过源码称为这些配置已实测。当前发现的身份/版本实现缺口已补齐。

## 本轮收口范围

本轮产品源码仅修改 `native/search/search.cpp`、`scripts/native-search/build.ps1`、`electron/plugins/official/search.ts`，并强化原有 `scripts/native-search/production-smoke.cjs` 两项代表验证。依赖、框架、main.ts 与用户数据未变。本记录没有勾选 P5 完整验收，也没有把旧候选 native/hash/report 转写为新产物；随后统一构建/打包 `87818-final-offline-catalog` 已使用上表当前字节，并重新完成全部 14 模块的依赖审计、七包完整性和新隔离 profile smoke；这些打包证据仍不扩大本记录的目标机验收范围。

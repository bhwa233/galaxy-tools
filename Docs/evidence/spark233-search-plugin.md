# spark233 正式文件/正文搜索插件接入证据

2026-10-24，在 `codex/spark233-refactor`，使用项目选择的 Node 26.12.1 / npm 12.2.1、Electron 45 和已准备的 MSVC/CMake/Ninja。此记录是 P5 正式插件的隔离接入证据，复用 P1V 已通过的 Pulse 权限与底层取消证明；没有安装 SYSTEM 服务或读取真实用户磁盘/便签/剪贴板。

## 实现

- 官方 npm 包 `@spark233/plugin-search@0.1.0`，插件 ID `spark233.search`，Windows x64。命令 `search`/`content` 分别进入 `files`/`content` 模式；结果打开、分页和服务安装为内部命令。
- 原生正式入口 `spark233.Search.exe` 使用协议 1 的宿主私有 JSON 会话，绑定 owner/plugin/version/instance/session，限制查询长度、页大小和响应体积。其文件名客户端调用原始 Pulse 协议，正文调用 Instant agent；没有用命令行递归搜索替代 Pulse。
- 每次查询使用独立受追踪进程/资源域。新查询创建前请求前一会话取消；过期输出不能发布。宿主为结果路径分配不可猜测的选择令牌，renderer 不能通过输入路径直接打开任意文件；分页游标也由宿主分配，文件名索引 revision 改变时拒绝旧页。
- 正常范围读取文件名服务已启用/支持的卷及排除路径，保留 Pulse 的默认 NTFS 及系统排除。正文额外排除宿主私有根，仅允许文本/Markdown/常见代码后缀，默认单文件 64 MiB，执行时按需读取；没有启动默认常驻正文索引写入器。
- 服务缺失直接返回可安装状态。编译期 `SPARK233_SERVICE_ONLY` 适配阻止上游 profile-walk fallback，即使服务在初次检查后消失也不会转为扫描用户 profile。
- 服务安装先经宿主确认，再由 Windows UAC 启动固定 elevated helper。helper 取得系统 Program Files known-folder，拒绝 reparse 路径和非 Administrator/SYSTEM 所有者的已存在产品根，设置保护 DACL，仅把固定兄弟二进制和许可证复制到新建受保护版本目录，再运行该目录下的 Index `--install`；不会把用户可写插件目录注册为 LocalSystem 服务路径。升级复用上游 SCM 停机/配置切换流程，实际高权限执行尚未验证。

## 本次实际验证

复现：

```powershell
pwsh -File scripts/native-search/build.ps1
. ./scripts/use-toolchain.ps1
& ./node_modules/.bin/tsc.cmd -p electron/tsconfig.json
& ./node_modules/.bin/electron.cmd scripts/native-search/production-smoke.cjs
```

正式 bridge 和插件 payload 已成功构建。Electron 编译通过；变更的 TypeScript 与 smoke 脚本通过 oxlint。`production-smoke.cjs` 通过真实 `.tgz` staging、清单验证、PluginManager 安装启用和正式 adapter 调用，所有配置/索引/缓存/词样本位于 `local-build/`。

最终运行：`local-build/evidence/search-production/45080cbb-328c-43df-bd15-80c09bd58f0f/report.json`；稳定入口 `local-build/evidence/search-production/report.json`，12/12 检查通过：

1. 文件名查询一条结果加分页游标，下一页命中不同文件。
2. 选择令牌解析到真实受控 fixture 路径；把绝对路径伪装成选择令牌会被拒绝。打开使用记录回调验证 host 分派，没有实际启动用户关联应用。
3. 中文连续短词命中 Markdown 和 TXT 两条；代码符号命中 TS 和 TXT 两条。fixture 内额外包含同词的私有目录文件，未进入正文结果。
4. 并发替换查询不能回传旧结果，新文件名查询得到有效命中。
5. 用户在宿主确认层拒绝服务安装后，返回可重试安装操作；没有触发 UAC。
6. 进行中的查询停用时完成取消并清空会话目录，插件处于禁用状态。
7. 本次运行未生成 `content-v1.sqlite` 正文库。
8. 不带 fixture 路由的正式 native 查询实际返回 `service-not-installed` / Windows 1060；未启动 profile fallback。
9. 显式 fixture Index host 正常退出。最终 `processes-after.json` 为 `[]`，没有 Search/Index/Document 残留进程。

本次只运行正式接入链路；没有重复铺设 P1V 的受限 token/NTFS ACL 矩阵。最终包体积明细在 `local-build/evidence/search-production/sizes.json`，包含 Search/Index/Document、PDFium 和上游许可证；发布打包仍需按统一包构建流程验证。

## 未完成的目标机验收

实际 UAC 拒绝、SYSTEM 服务安装/升级、普通账号连接正式服务、全卷 MFT/USN 增量/改名删除/补偿/重建、卷离线及非 NTFS/网络盘覆盖、目录撤权/损坏索引、大小/编码/云占位边界仍未执行。当前有安装授权代码和受控小样本接入证据，不能因此勾选这些实机项。

正文分页当前为有界重新执行查询后跳过 offset；没有为变动中的目录建立持久快照。文件名分页检查服务 revision；Instant 的一致性仍须在真实持续变化文件样本上验收。卷/路径排除的服务设置界面和更丰富的定位/复制路径动作也不包含在本次 adapter 接入证明中。

## 2026-10-25 范围设置与文件名排除修复

范围设置已增加用户排除目录的持久化、规范化、取消旧查询和撤销旧 selection；宿主私有根由宿主注入，activation 无权替换。报告 `local-build/spark233/search-scope-functional/runs/12eaa8cb-3490-44e3-b491-a6727443bcce/report.json` 的 21 项通过，包含默认用户项为空、相对路径/privateRoots 注入拒绝、排除后正文无结果、重启保持、清空用户项恢复正文且仍排除宿主私有根。这是隔离正式 adapter 证据，未操作主宿主 UI。

该次范围报告使用旧 native，仅有 adapter 防御过滤，不能证明文件名原生分页已正确排除。后续修复复用 Pulse `ContentPathExcluded`，在文件名分支过滤后计算可见 offset/page/hasMore，多批读取中的 revision 变化要求重试。最新正式 native 报告 `local-build/evidence/search-production/f909f8b8-0f56-4325-b1e3-7effc4f419d7/report.json` 的 12 项通过：第一页两条可见命中和 cursor，第二页仅剩一条可见命中，无下一页；旧的任意路径拒绝、替换取消、停机清理及服务缺失行为继续通过。Search 修复已进入目录筛选版完整构建。

原生目录选择器、范围配置界面和真实主宿主查询尚未交互验收，不能据源码已接入勾选相关 UI 任务。SYSTEM 服务 UAC/安装/升级/卸载、全卷 MFT/USN 与撤权等实机边界仍未验证。最新其他业务变更的完整构建状态见 [本轮功能记录](spark233-functional-integration.md)。

## P5 功能审查补齐：服务、动作与正文策略

2026-10-25 根据功能审查继续实现 P5，以下说明覆盖前述历史报告尚未提供的功能；人工验收仍留在自动代表链之后。本轮没有新增测试文件、套件或框架，强化现有 `production-smoke.cjs`；所有样本、编译产物、profile 与索引均在 `local-build/`。

- **个人查询与全机索引分别管理。** 原有 `search-scope.json` 保留个人排除路径，增加正文扩展名、1–64 MiB 上限和隐藏文件/目录策略；空扩展名列表沿用受控文本/Markdown/代码白名单。设置保存先取消旧查询并撤销选择/游标。全机服务面板显示实际卷、文件系统、启用、在线、计数、进度、错误、有效排除及服务原始状态，支持配置卷/服务排除路径、显式刷新与重建。
- **高权限写入仍受限。** 修改服务范围或重建先经宿主确认，再由固定 Search helper 请求 UAC。elevated helper 重新验证 SCM 归属、受保护目录/DACL 与实际服务版本，只运行 Program Files 中已验证的固定 Index.exe 和上游固定配置命令；用户输入仅作为正确引用的卷 ID/排除项，不作为可执行文件、shell 命令或任意输出路径。写入前清除隔离机器/profile 环境覆盖，多个本产品管理操作串行；批处理失败逆向恢复已成功的变更，无法完全恢复时返回部分失败并要求刷新实际状态。未改写系统默认排除组。范围配置和重建没有在本机实际执行。
- **状态读取不破坏搜索。** 状态使用独立受资源域追踪的会话，不清理前台选择/分页，也不取消正在使用的查询；关闭设置后没有状态定时器。服务任务进行时设置面板阻止直接关闭。
- **结果动作仍通过 opaque 选择。** 文件提供打开、定位、复制路径，正文另有命中行预览。主进程只接收当前选择解析出的路径，renderer 不能提交任意路径；行号、Unicode 片段和受限文本由纯文本对话框显示，不执行 HTML。文件大小/修改时间改变时要求重新搜索；预览读取最多 256 KiB，无法可靠解码或命中行超出该片段时展示原生 Unicode 命中片段与真实行号。
- **读取前执行策略。** Pulse 固定源码 adaptation 6 将隐藏策略通过原有 Instant 协议传入，在正文提取前过滤隐藏文件及隐藏祖先目录；大小和白名单也在读取前执行。保留普通调用者权限、云占位/offline/reparse 防护和不创建持久全文库的 Instant 路线。

MSVC `/W4` 增量构建日志：`local-build/spark233/packaging/native-build-scope-policy-final.log`，退出码 0。最终完整 typecheck 和聚焦 lint 通过，类型日志为 `local-build/spark233/packaging/p5-completion-final-typecheck.log`。

最新正式链报告：`local-build/evidence/search-production/4ec7ef43-9626-4c78-99b0-b11d397eaadf/report.json`，18 项检查全部通过。新增代表证据为：状态读取后原选择/下一页仍可用；定位和复制回调只取得已返回 fixture 路径；中文预览及命中行正确；单组样本验证扩展名、1 MiB、隐藏文件和隐藏祖先过滤及开关恢复；宿主拒绝服务配置后不进入 UAC。既有取消、权限令牌、私有排除、分页、停用清理、无正文数据库和缺失服务反馈继续通过。定位/复制使用记录回调，没有改写真实剪贴板或打开 Explorer。

同轮应用补齐已在 `local-build/spark233/applications/custom-runs/6523128d-e70d-4e50-902b-654496505f71/report.json` 通过 12 项：自定义配置恢复与 argv/cwd 保留之外，真实菜单变更使缓存失效、显式刷新发现新入口、明显卸载快捷方式被过滤，受限 PNG 图标和受控附加动作可生成。图标缓存最多 256 项、每项 PNG data URI 不超过 32 KiB 字符，停用时清空；backend 停用时关闭菜单 watcher、定期校准和拼音助手。未执行真实用户应用或系统剪贴板动作。

人工界面、真实 UAC/服务范围修改、服务重建、全卷增量与资源预算仍保留为实机验收，不能把 fixture 状态或未授权返回扩大为这些操作已运行。

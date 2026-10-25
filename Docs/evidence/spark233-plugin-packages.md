# P2 插件包解析与安装证据

日期：2026-10-24。实现位于 `electron/plugins/package-source.ts`、`package-installer.ts`，私有边界模块为 `package-archive.ts`、`package-io.ts`。本记录证明包来源、校验和精确版本落盘；激活、更新事务、权限确认和运行实例由插件管理器负责。

## 来源和选择合同

- `resolveRegistryPluginPackage(request, environment)` 接受显式 npm 包名、registry、dist-tag、版本范围和可选预期身份；只使用 HTTPS 且 URL 不得嵌入凭据。读取完整 npm 元数据，默认最多 8 MiB。元数据记录和通道使用自有属性检查，避免原型属性被当作合法记录。
- dist-tag 是通道的版本上限。候选按 semver 降序选取，逐个通过共享 manifest 的宿主/API、平台/架构、身份与清单校验，跳过 deprecated 或不兼容版本。`latest` 排除预发布版本；其他通道允许符合版本范围的预发布版本。
- 返回精确包名、版本、清单、HTTPS tarball 地址和强 SRI。registry 包必须提供 SHA-256、SHA-384 或 SHA-512 SRI。
- `stageRegistryPluginPackage(selection, environment, paths, options)` 与 `stageLocalPluginPackage(tarballPath, environment, paths, options)` 使用同一解包和目录校验链路。registry 内容还必须匹配选择结果中的 npm 包名、版本和插件 ID；调用方提供的预期身份不能覆盖它们。
- 本地导入可以提供外部 SRI；无外部 SRI 时仍生成 SHA-512 内容标识，但这个标识不能证明包的发布者或来源可信。

## 解包和落盘边界

安装器只复制/下载 `.tgz`，不会运行 npm 生命周期脚本、安装 npm 依赖树、执行 Git 或目录来源。插件自身的依赖须由发布包包含，宿主插件依赖另由管理器处理。

调用方显式提供绝对路径 `stagingRoot`、`versionsRoot`、`cacheRoot`；安装器规范化根目录并要求三者不同，拒绝符号链接根目录与版本父目录。每次导入使用独立临时工作目录，失败和成功均清理暂存文件。

| 可调整上限                  | 默认值  |
| --------------------------- | ------- |
| 压缩包                      | 256 MiB |
| 解压后文件内容合计          | 512 MiB |
| 未压缩 tar 流（含头和填充） | 768 MiB |
| 单个文件                    | 256 MiB |
| tar 条目（含元数据）        | 20,000  |
| 路径层数（含 package）      | 32      |
| tar 元数据条目              | 1 MiB   |

压缩包先经过大小限制，gzip 再展开为有界的私有 tar。整个 tar 预检通过后才写入解包目录；只允许 `package/` 下的普通文件和目录。使用共享 SDK 路径规则拒绝绝对路径、跳目录、反斜杠、Windows 设备名/ADS 等不安全名称；另拒绝链接、其他 tar 类型、被解析器忽略的条目、警告、重复名称、大小写或 Unicode 规范化冲突，以及文件/目录冲突。必须存在拼写精确的 `package/package.json` 普通文件。

解包后调用共享 `validatePluginDirectory` 校验实际文件和入口。成功结果通过同一文件系统的 rename 放到 `versionsRoot/<encoded-plugin-id>/<encoded-semver>`；已存在的精确版本拒绝覆盖，跨文件系统移动直接失败。返回 `metadata`、`directory`、计算的 SHA-512 `integrity` 和 `source`，不在这个步骤切换活动版本。下载、复制和预检响应取消；最终解包有资源上限，并在结束后与提交前再次检查取消。

## 实际验证

使用项目选定的 Node 26.12.1，在 `local-build/spark233/plugin-packages/` 下构建 Electron 隔离输出并执行现有的两路径探针，未访问用户便签或剪贴板数据。最终报告：

`local-build/spark233/plugin-packages/runs/2026-10-24T11-43-56-502Z/report.json`

1. 通过 `tar.c` 生成真实 npm `.tgz`，包含有效 spark233 清单、网页入口、LICENSE、会写标记的 `postinstall` 和不存在的 npm 依赖。使用外部 SHA-512、精确包名/版本/插件 ID 导入成功，入口内容一致，落盘到 `versions/package-boundary/1.0.0`；标记文件和 `node_modules` 均未出现。
2. 通过 `tar.Header` 生成含 `package/../../escaped.txt` 的 gzip tar。安装器拒绝，错误为 `Unsafe plugin archive path: package/../../escaped.txt`；暂存目录为空。

四个安装模块的聚焦 oxlint（`--deny-warnings`）和 Electron TypeScript 检查通过，最终源码重新编译后上述两路径再次通过。没有增加 Vitest 测试文件、框架或恶意样本矩阵；全仓门禁由集成阶段统一执行。

另外通过实际解析函数请求 npm 公共 registry 的 `@crosscopy/clipboard` 元数据，560 ms 后正确拒绝为 `No compatible @crosscopy/clipboard version in channel latest`，记录在 `local-build/spark233/plugin-packages/registry-read.json`。这证明实际元数据读取和非插件拒绝路径；当前没有已发布的 spark233 公共包，未验证公共 registry 的成功插件安装，也未执行 npm publish。

## 桌面宿主接线

`electron/plugins/desktop-host.ts` 复用安装器、`PluginManager`、可信后台和 Web 宿主；前端合同位于 `src/features/plugins/types.ts`。管理 IPC 的发送者限制由主进程接线负责，服务不暴露给插件页面。

- `plugins_import` 使用宿主原生文件选择器选择 `.tgz`；registry 安装先解析/下载，再返回包含完整清单、版本、来源、能力、SRI 和原生信任要求的 preview。`plugins_confirm_install` 才向管理器授予清单列出的能力，Node/native 必须显式确认信任。默认未实现的 Web broker 能力由 Web 宿主拒绝；纯 native 插件缺少业务适配器时明确拒绝启动。
- 已落到精确版本目录的待确认包保存在根目录 `previews.json`，重启恢复同一 preview ID。确认时重新验证目录和清单；已被成功安装的陈旧 preview 在初始化时移除。取消只清理此 preview 的精确版本目录，且先检查管理器活动记录与恢复事务均未占用它；卸载前要求先处理同一插件的待确认包。
- 包来源保留可选 `registry` / `channel`；本地包不自动追踪 npm。启动按照持久的上次检查时间，之后每六小时只读兼容版本元数据，默认 `latest` 稳定通道，仅产生更新提示。用户准备并确认更新后才安装，准备更新拒绝相同或更旧版本。
- 工厂通过共享解析器取实际入口，后台再次检查信任授权；Web 安装校验等待隐藏 SDK 握手，`on-startup` 空激活只通知后台，实际命令或上下文激活才展示 Web。用户直接打开插件时选清单第一个命令。

真实 Electron 45 / Windows x64 服务探针使用现有 `examples/plugins/hello-web`，所有包、插件状态、数据和 Electron profile 均在隔离目录内。最终报告：

`local-build/spark233/desktop-host/runs/2026-10-24T12-12-39-478Z/report.json`

实际顺序为：生成独立 `.tgz` → `plugins_import` → 关闭服务并新建宿主 → 同 preview ID 恢复 → `plugins_confirm_install` 且隐藏 SDK 握手通过 → `plugins_enable(false)` 保存确认 → `plugins_uninstall(deleteData:false)`。安装校验期间可见插件窗口数为 0，最终插件与待确认列表为空，stdout 成功、stderr 为空。探针把原生 picker 的返回值固定到此隔离 `.tgz`，因此不宣称验证了用户操作文件选择器或完整管理 UI。最终服务、安装器和类型文件的聚焦 lint 以及 Electron TypeScript 隔离编译通过。

## 复用和许可证

使用 npm 官方生态工具完成 transport、npm spec、semver、SRI 和 tar 解析；私有代码只补产品资源预算、路径与身份边界，不实现另一套包管理器。

| 运行依赖           | 固定版本 | 许可证        | 来源                                      |
| ------------------ | -------- | ------------- | ----------------------------------------- |
| semver             | 7.8.5    | ISC           | https://github.com/npm/node-semver        |
| tar                | 7.5.22   | BlueOak-1.0.0 | https://github.com/isaacs/node-tar        |
| npm-registry-fetch | 20.0.1   | ISC           | https://github.com/npm/npm-registry-fetch |
| ssri               | 14.0.0   | ISC           | https://github.com/npm/ssri               |
| npm-package-arg    | 14.0.0   | ISC           | https://github.com/npm/npm-package-arg    |

这些依赖的发布许可由根 `THIRD_PARTY_NOTICES.md` 统一汇总；本文不代替打包产物的最终许可清点。

## 2026-10-25：受控 HTTPS registry 成功安装与更新

新增一条隔离 registry 成功链，补充前述公共元数据拒绝和本地归档报告的范围。入口为 `local-build/spark233/plugin-crash-functional/registry-https.mjs` 和同目录 `registry-https-child.cjs`；最终报告为 [registry HTTPS report](../../local-build/spark233/plugin-crash-functional/registry-https-runs/2c800235-257d-447c-8416-e8e459bc3560/report.json)。生产源码未修改，使用项目 Node 26.12.1 / npm 12.2.1、Electron 45 和独立 `registry-compiled/` 输出。

探针复用已安装 Git 的 OpenSSL 3.2.4，在运行目录生成一天有效、SAN 为 `127.0.0.1` 的临时自签证书。未修改父进程或系统证书信任；父进程默认 HTTPS 请求实际返回 `DEPTH_ZERO_SELF_SIGNED_CERT`。仅 Electron 子进程通过 `NODE_EXTRA_CA_CERTS` 增加该证书，没有关闭 TLS 校验或修改系统 certstore。registry 仅监听 loopback；请求日志记录生产解析器和下载器实际读取两版 metadata/tarball，全部为 TLS 1.3。

使用现有 Hello Web 示例生成 `0.1.0` / `0.2.0` 两个真实 npm `.tgz`，依次执行生产 `resolveRegistryPluginPackage`、`stageRegistryPluginPackage` 和 DesktopPluginHost 的 prepare/confirm 管理入口：

- 首次 `plugins_prepare_registry` 下载并校验 v1，仅生成 pending preview；管理器无安装记录，也无插件窗口。显式 `plugins_confirm_install` 后才启用 v1，保留 registry 来源，隐藏页面完成真实 SDK 握手。
- 通过真实 preload/storage IPC 写入人工 `message`。停止宿主后，将隔离 registry 的 `latest` 指向 v2，并将隔离检查时间设为七小时前；重启触发生产自动检查，出现 v2 更新提示，但版本仍为 v1、无 pending preview、无 v2 目录。请求日志也显示该自动检查只获取 metadata，没有请求 v2 tarball。
- 让 v2 metadata 返回错误 SHA-512 SRI，实际下载后报 `integrity checksum failed`。安装版本仍为 v1，pending 为空，staging 清空、v2 目录不存在，原数据字节保留。
- 修正 fixture SRI 后，`plugins_prepare_update` 下载 v2 并生成预览，仍保持 v1；确认后才切换 v2，清除 pending/更新提示。新版隐藏 renderer 通过真实 storage IPC 读回 v1 的人工正文，磁盘 `web-storage.json` 同样保留内容。

子进程 9 条业务检查和父进程传输检查均通过，窗口 show 事件为 0，最后无残余窗口。报告、归档、证书、profile、状态和日志均在本次运行目录；没有 npm 账号、发布、真实 registry 写入、真实用户数据或管理界面操作。这证明受控 HTTPS registry 的成功安装/升级及一条完整性拒绝边界，不等同公共包已发布、生产分发或人工界面验收。

## 开发目录按不可变快照安装

`plugins_import_directory` 从管理页调用宿主原生目录选择器，不接受 renderer 自行传入路径。`stageDevelopmentPluginPackage` 对预构建目录遍历时拒绝符号链接/junction、特殊文件、越界、非法路径及与插件宿主存储重叠，复用原有条目数、路径层数、单文件/总内容/归档大小预算；打包后再次检查源文件身份与修改状态。复用已安装 tar 写入私有临时 `.tgz`，再走既有归档预检、SRI、清单、精确版本目录、待确认预览和信任安装链，不执行 npm 脚本、不直接运行可变目录。来源保存为 `kind: directory` 和原目录 realpath；后续开发修改需要新版本重新导入。

沿用既有 [desktop-host probe](../../local-build/spark233/desktop-host/verify-service.mjs)，最新 [report](../../local-build/spark233/desktop-host/runs/2026-10-25T04-52-23-527Z/report.json) 通过原本 `.tgz` 安装启停链及新增目录代表：目录只生成未安装预览；预览后把源 `app.js` 改为抛错脚本，确认安装仍使用预览时的原副本；真实 junction 被拒绝，既有插件与 pending 不变、staging 无残留；目录来源在管理器重启后保持。probe 固定 picker 返回隔离目录，未人工操作文件选择器或验收管理页。新增 UI/类型/lint 和 Electron 隔离编译通过，没有新增 Vitest 文件或依赖。

清单另支持可信 `migration.entry`，与后台入口同样解析为包内预构建 JS，须声明 `node.backend` 并取得 native 信任。Web/native 插件也可提供该独立入口；需提升数据版本却未声明时拒绝更新。迁移先于普通 factory，已提交数据版本、停用更新及失败/重启恢复证据见[显式迁移记录](spark233-plugin-manager.md#显式数据迁移已提交版本与匹配恢复)和 [SDK 合同](../../packages/sdk/README.md)。安装器仍不执行 npm 生命周期脚本；显式迁移只在宿主取得授权并完成旧数据备份之后运行。

## 官方离线插件目录与卸载后重装

管理页提供随包七个官方插件的离线目录，复用现有 Card/Button 与待确认安装清单。构建索引附带 `displayName` / `translations`，宿主按 zh-CN/en-US 返回友好名称；旧索引可省略这些展示字段。`plugins_list.catalog` 返回 pluginId、packageName、displayName、随包 version、installedVersion、pending 与 canPrepare。目录仅暴露七个固定官方插件 ID 及匹配的 npm 身份，不扩展为外部市场或服务。

`plugins_prepare_bundled({pluginId})` 只从当前已校验索引取得固定归档路径、包名、版本、插件 ID 和强 SRI，不接受客户端指定文件。未知 ID、替换路径参数、已装相同/更新版本或同插件已有待确认包均拒绝。准备仅走原 `stageLocal → addPreview`；随后仍需用户按原能力/原生信任清单确认。归档来源保持真实 `file`，独立 `updateSource` 映射继续存在。已消费标记阻止重启时静默重装，但不撤下目录条目，卸载保留数据后仍可从目录主动重装。

沿用既有 desktop-host probe 的 `--catalog-only` [报告](../../local-build/spark233/desktop-host/runs/2026-10-25T06-20-07-667Z/report.json)，9 项通过。使用受控 Hello Web 归档及固定官方 notes 身份，实际验证中英文目录名称、已装重复准备拒绝、写入私有数据后卸载/重启仍可发现且不自动安装、未知 ID/替换文件参数拒绝、固定归档/SRI/精确身份预览、确认重装后读回原数据及保留 file 来源/更新映射。所有校验窗口隐藏，退出后释放；没有联网更新检查，也不把这个 fixture 视为真实便签业务或管理页人工验收。相关源码通过五边界 typecheck、聚焦 lint 和独立 Electron 编译，没有新增仓库测试、依赖或 UI primitive。

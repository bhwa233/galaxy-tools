# 桌面层截图贴图迁移与默认开启记录

日期：2026-10-31；续验：2026-11-01。分支 `codex/spark233-refactor`，未commit/push。用户明确要求三个桌面相关开关默认开启，并迁移截图的常驻图钉。本文记录该增量；[首版记录](desktop-widget-layer-implementation-2026-10-31.md)和[第二阶段记录](desktop-widget-layer-expansion-2026-10-31.md)保留各自历史范围。

**当前状态：最终构建、lint、75文件/316测试、真实Electron自动集成23项，以及原生图钉/继续标注/撤销重做/Escape恢复代表链均已通过。**默认值、显式false、便签超额迁移兼容恢复及两次新进程贴图恢复也已有证据。此前两轮launcher-preferences rename EPERM失败日志保留；最终通过不等于该Windows间歇写入问题已根治。完整物理跨窗口拖动、真实休眠/热拔及24h验收继续保留为未完成。

## 默认值与便签启动恢复

| 场景                               | 当前合同                                                                                                                          |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 新配置                             | `desktopLayer.enabled/notesEnabled/webEnabled` 全部true                                                                           |
| 旧配置没有desktopLayer或缺少某字段 | 只对缺失项补true                                                                                                                  |
| 已明确保存false                    | 保持false，不被默认值覆盖                                                                                                         |
| 自动启动/owner恢复时便签迁移失败   | 保留旧notes模式和可恢复journal/已提交状态，记录notesMigrationError，宿主管理页显示warning；其他桌面层继续同步，不自动改写持久偏好 |
| 用户显式在设置切换桌面开关         | 使用strict事务；迁移/应用失败拒绝本次变更、恢复原配置及原模式，向调用者返回错误                                                   |

默认开启不会自动创建所有widget模板实例，也不会绕过既有native trust或Web插件授权。平台显式关闭时不渲染桌面卡片，已有布局和插件数据按原保留语义处理。

## 已完成实现

| 部分          | 实现行为                                                                                                                                                                                                                                        |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 展示与管理    | ScreenshotLayerCoordinator作为共享可信consumer提供screenshot UUID成员；宿主处理布局、显示器、置顶、隐藏/恢复、鼠标模式和配额。ScreenshotCard提供拖动、缩放、适应屏幕、编辑、置顶、隐藏和关闭，管理页合并截图实例及故障重试                      |
| 可编辑数据    | 私有bundle保存source.png原图、preview.png合成预览及document.json scene；复用WinPin现有History、形状与几何重建，保存矩形、椭圆、箭头、线条、编号、文字、马赛克、橡皮擦八类形状及undo状态。继续编辑加载原图+scene，预览不承担可编辑源职责         |
| 原生交接      | pin.json与pin.ack绑定当前session/PID/attempt。宿主检查owner/scope及当前attempt，校验私有路径和有界图像/文档，持久化bundle、提交布局并等待surface就绪后才接受交接；原生收到对应accepted ACK后才退出编辑会话                                      |
| 失败恢复      | 重新编辑使用COW revision，旧revision保留到ACK后回收；失败回滚布局/当前revision，保留原编辑器或上一张可用图。GC失败记录诊断并保留已接受的新图；待回滚项由现有串行队列重试                                                                        |
| 私有图片      | renderer只取得随机UUID句柄的同源图片URL。仅当前共享可信surface主frame的image GET可读取已分配的截图，异步读取后重新核对授权；Web壳、iframe、未知/失效句柄、附加query/hash及非GET拒绝。响应为有界PNG、no-store/nosniff，不开放磁盘路径、不放宽CSP |
| owner生命周期 | scope停用/更新前取消手势并flush；owner撤销清活动呈现、资源和旧句柄，保留布局及私有bundle；恢复绑定新owner并轮换句柄。截图与便签独立计插件配额，共用屏幕/全局容量                                                                                |
| 启动与版本    | 截图官方插件0.1.5改为on-startup以恢复owner/既有贴图，启动激活不发起截屏；显式capture/ocr或继续编辑才创建原生任务，继续受现有native trust控制                                                                                                    |
| 原生可访问性  | 宿主模式临时标注窗使用本地化caption和APPWINDOW，可经任务栏/Alt+Tab切换；Ctrl+P复用pin动作，既有tooltip显示快捷键。工具栏及独立/旧图钉模式保持原样式；交接后原生窗关闭，常驻共享层仍skipTaskbar                                                  |
| 集成          | 全局hide/show、剪贴板/launcher宿主焦点识别、选取侦测及全屏watch排除集合直接包含desktopLayer.windows()；共享截图在全屏时沿便签降层语义，普通HUD仍抑制。desktop-pins-changed驱动管理页合并刷新，便签迁移warning单独展示                           |

主要接线位置：`apps/desktop/electron/screenshot-layer.ts`、`electron/plugins/official/capture.ts`、`electron/host/official-runtimes.ts`、`electron/runtime.ts`、`electron/plugins/widget-host.ts`、`shared/layer-contract.ts`、`src/features/desktop-layer/ScreenshotCard.tsx`与管理IPC/UI。原生适配位于`scripts/native-capture/PinDocument.h`及`adapt.ps1`，本轮已重新编译ScreenCapture.exe。

官方原生截图目前只在调用前隐藏launcher，未提供独立capture exclusion API。上表的宿主窗口集合用于全局显示、焦点及侦测边界，不能据此声称桌面层窗口已从原生截图画面排除。

## 验证结果

| 验证                   | 结果与实际范围                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 原生重编译             | 最终ScreenCapture.exe与正式staging及resources.json的SHA256、字节数一致；指纹见下节                                                                                                                                  |
| 关键回归               | 6文件、23测试通过：capture、capture-history、host-config、layer-layout-store、notes-layer及IPC registry；复用既有Vitest测试，无新测试框架                                                                           |
| TypeScript、lint/build | 最终pnpm build及pnpm lint均exit0；构建包含typecheck与8个官方包，完整日志见下文                                                                                                                                      |
| 真实Electron自动集成   | 最终23项通过、exit0；同surface私有PNG成功，未知句柄/跨surface/普通hide拒绝，统一编辑器可显示隐藏贴图，owner失效回滚、cache域拒绝、配额拒绝不落盘、scope停用保留、新owner/磁盘恢复及两条拖动取消回归均有实际模块证据 |
| 原生编辑器拒停         | 同一原生UI run额外1项通过：编辑器活跃时prepareStop拒绝停用并保留scene；该run检查数为22，不与23项单元测试加总                                                                                                        |
| 原生图钉与继续标注     | 生成图片中八类形状及第九条undo线经实际原生Ctrl+Y/Z/P验证；策略拒绝保留编辑器，再次提交被接受；继续标注后同UUID写新revision，旧revision在ACK后回收；另一次Escape恢复已接受revision，三次native exit0                 |
| 默认值与兼容恢复       | 四阶段共21条检查通过：缺失配置补true且启动不截屏、同profile恢复贴图、显式false保留、9张浮动便签超额迁移时保留旧窗口并显示warning                                                                                    |
| 最终新进程贴图恢复     | 两次新Electron进程各6条检查通过，renderer errors为0、load-timeout为0、expired surface为0，均初代surface直接加载私有640×480 PNG                                                                                      |
| 新增手势取消回归       | 最终23项中新增2条通过：displayChanged即使几何不变也取消瞬态拖动，管理改passive后恢复interactive不能复活迟到up；这是实际生产模块及renderer的受控IPC验证，不记为物理鼠标验收                                          |
| 当前全量测试           | **最终75文件、316测试全部通过**，使用仓库内TEMP/TMP与vitest run --maxWorkers=1；早前315通过/1失败及单文件重跑失败日志仍保留，未声称间歇rename EPERM已根治                                                           |

这些结果分别证明持久化、身份边界、实际原生编辑及启动恢复，不合并成全部权限或发布矩阵通过。native trust仍由现有审批路径控制；本轮成功原生链使用隔离测试授权，不补记“拒绝native信任后恢复”的额外UI验收。拖动/缩放/隐藏/关闭的全部物理操作组合也未据此勾选。

## 原生往返与失败恢复证据

原生UI运行ID为 `55afd401-4490-4404-ad31-05c44db968ca`，证据根：

`local-build/screenshot-pin-smoke/runs/55afd401-4490-4404-ad31-05c44db968ca/`

输入是生成的640×480网格/渐变图，未捕获真实桌面。fixture含矩形、椭圆、箭头、线条、编号、文字、马赛克、橡皮擦八类形状，以及第九条`undo:true`线。Computer Use通过`@oai/sky`调用Windows原生键盘输入；Ctrl+Y使第九条线出现，Ctrl+Z再次撤销。没有把DOM点击或Electron输入注入写成物理鼠标输入。

| 步骤                           | 可复核结果                                                                                                              | 原始证据                                                                          |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| 活跃编辑器拒停                 | prepareStop返回拒绝，原生工作面未丢失                                                                                   | report.json的第22项及controls                                                     |
| 桌面策略关闭后提交             | attempt1返回精确rejected ACK，native日志记录`pin-host-rejected-editor-restored`，原生图像/标注保持                      | native-policy-rejected/pin.ack、pin.json、pin-document.json、native-lifecycle.log |
| 重新开启并固定                 | attempt2发布、ACK、编辑完成顺序有记录；native进程50976以exit0结束，取消标志为false                                      | report.json的nativeEvents、native-first-roundtrip.json                            |
| scene往返                      | 八类形状、9个历史条目、最后undo=true，文档与fixture各字段一致；浮点容差1e-5                                             | native-first-document.json、native-first-roundtrip.json                           |
| 从桌面贴图继续标注并重做后固定 | 保留UUID `ee10ff94-3f21-45e1-a7f1-00679550d32a`；新revision不同、createdAt保持，最后undo=false；原生进程3768以exit0结束 | native-second-document.json、native-second-roundtrip.json、report.json            |
| 接受后回收旧版本               | 旧revision `f500b9d0-3e19-4399-a61d-2c36208c58fd`已回收，新revision `c07f4fc3-1b48-4017-bd68-1615a1a567ec`可读          | native-second-roundtrip.json及私有manifest                                        |

继续标注会撤去发起操作的旧共享surface；该frame的在途RPC可能报告`Render frame was disposed before the request completed`。这条日志不能单独判断原生任务或保存失败；本轮按nativeEvents中的accepted、native进程exit0、私有manifest和scene比对确认交接成功。负向图片请求的浏览器console错误、销毁frame晚到的身份拒绝及退出时heartbeat围栏日志也保留，不声称全部日志为空。

第三次进入该图钉的原生编辑器后，实际按Escape退出，已接受revision保持不变，桌面贴图恢复active；第三次native进程39872以exit0结束。`native-cancel-restore.json`记录了同一UUID、revisionUnchanged和三个原生进程的退出结果，这个恢复链没有重新捕获桌面。

最终原生产物：

```text
local-build/screenshot-pin-native/build/ScreenCapture.exe
packages/official/screenshot/native/win32-x64/ScreenCapture.exe
SHA256: 34F81F9756C5AC469DB97268569803FE1D2F6407FCFD83C6F220B9EBA736E2E2
Bytes: 1325568
Source generation: adapted-53890b0113e30d9e
Build log: local-build/screenshot-pin-native/build-accessibility-keyboard.log
```

编译产物、正式staging与resources.json由现有native build及screenshot/build.mjs生成并逐项核对；没有绕过或手动伪造完整性记录。文档上限8MiB、边长16000及总像素32,000,000由native/host统一执行。

## 最终自动回归与合并门禁

最终截图自动run为 `local-build/screenshot-pin-smoke/runs/8f2c9b95-de5a-4041-9929-d80ff9ce62de/report.json`：`ok=true`、23条检查通过、failures为空、进程exit0。原始日志为 `local-build/screenshot-pin-smoke/launches/95e4a4d1-4cad-4969-9ef7-cdbe40afd5ad.log`。新增两条回归实际先建立down/move瞬态预览，再触发显示变化或管理切换passive，确认预览清除、迟到up不写回布局；没有只断言注册表或stub调用顺序。

此前run `ab205c13-045c-400d-b449-f8c9f2f881fe` 在最后删除已接受测试贴图时遇Windows `ENOTEMPTY`。回收revision与关闭贴图改为复用Node `fs.rmSync` 的 `maxRetries:3,retryDelay:25`，保持路径约束、tombstone和原有清理顺序；重试仍失败会保留错误，不假装已清理。失败run和原始日志保留，最终23项已正常完成清理。

最终合并门禁原始日志：

```text
local-build/screenshot-pin-final-build.log   pnpm build，exit0，含typecheck及8个官方包
local-build/screenshot-pin-final-lint.log    pnpm lint，exit0
local-build/screenshot-pin-final-tests.log   75 files / 316 tests passed，--maxWorkers=1
```

早前全量和单文件重跑分别在 `launcher-preferences.test.ts` 的高频持久化中遇`rename EPERM`，决定性失败记录保留于 `local-build/screenshot-pin-unit-tests.log` 与 `local-build/screenshot-pin-unit-retry.log`。最终全量通过是本次门禁结果，不构成该间歇Windows写入问题已根治的结论，也不声称默认并行测试已稳定。

## 默认值与启动恢复证据

历史四阶段run为 `local-build/default-on-startup/runs/7405aee6-ce55-4ac1-abc7-3b126a71d596/report.json`，检查数分别为3、6、6、6。`notes-over-quota`使用9张生成的浮动便签，实际保留9个旧native胶囊窗，notes与screenshot插件均active，管理页有notesMigrationError；没有裁掉便签或关闭其他桌面层。`explicit-off`确认内存和磁盘三个false都保持，已有截图只列为hidden、不建共享窗；截图插件仍可启动而不创建capture session。

最终启动汇总为 `local-build/default-on-startup/startup-verification-summary.json`，其中两次新进程分别为：

| runID                                             | 检查       | renderer errors / load-timeout / expired surface | 初代surface加载     |
| ------------------------------------------------- | ---------- | ------------------------------------------------ | ------------------- |
| async-scan-1-994a0c18-c98a-42f9-b5df-90f8f4b16c70 | 6/6、exit0 | 0 / 0 / 0                                        | generation1，2514ms |
| async-scan-2-45d45519-f102-4079-aa45-810bb99145ca | 6/6、exit0 | 0 / 0 / 0                                        | generation1，2729ms |

两次均直接恢复screenshot 0.1.5 owner与私有PNG，没有启动原生截屏任务。原始`.json`、`.log`和`report.json`位于`local-build/default-on-startup/runs/<runID>/`。每次仅在app.quit之后保留两条`Desktop cards are stopping` heartbeat拒绝，进程退出后没有探针残留。

早期对照run各出现一次5s就绪超时；探针当时在Electron主线程内用execFileSync同步执行PowerShell子进程扫描，观测到数秒事件循环阻塞。只将该扫描改为await异步execFile后，上述连续两次均无超时。保留前后日志作为探针扰动证据，不能把早期结果继续描述为生产冷启动仍有固定超时，也不能据两个代表样本承诺所有机器都满足预算。生产LayerWindow的5s就绪时限未加长。

## 仍未覆盖的发布范围

不得将第二阶段75文件/314测试、旧Windows smoke或此前100/125/150%输入记录补记为本轮截图的全部验收。24小时、管理员窗口、真实游戏全屏、真实休眠/热拔及完整跨native窗口拖动仍按第二阶段未覆盖项保留。两条新增手势取消回归已通过受控IPC探针，不替代这些真实场景。

全部profile、插件数据、图像/scene和fixture均位于仓库local-build或明确临时目录；未读取真实用户便签、剪贴板历史或截图历史。用户侧总结与证据归档为：

```text
C:\Users\bhwa233\Documents\Codex\2026-10-31\docs-traffic-monitor-per-process-tech\outputs\desktop-layer-defaults-and-pins.md
C:\Users\bhwa233\Documents\Codex\2026-10-31\docs-traffic-monitor-per-process-tech\outputs\desktop-layer-defaults-and-pins-evidence\
```

归档保留通过结果、失败/对照日志、隔离生成图像和复现探针；不复制真实profile或插件安装缓存。本文同时保留仓库内原始路径，便于核对运行ID及具体版本范围。

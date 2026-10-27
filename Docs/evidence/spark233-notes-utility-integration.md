# 便签 utility 数据引擎与主进程接线

> 本文保留最初接线阶段及其输入。后续通用备份、私有数据保护、崩溃恢复、设置补丁与新 Windows 候选见[便签收口记录](spark233-notes-finalization.md)；下述“缺少 Windows 原生资源”是当时状态，当前工具链及资源已经恢复。

日期：2026-10-26。接续 [10 月 25 日交接](../spark233-handoff-2026-10-25.md)。本轮完成暂停的异步接线，并取得当前源码的 Linux Electron utility 与真实 main/renderer 代表证据。尚未生成包含这些改动的新 Windows 安装包，P3.1 保持未勾选；原 `ui-contract-followup` 安装器继续只证明原输入。

## 源码边界与修复

- `main.ts` 不再构造 `NoteStore` 或 `Reminders`。正文、分类、搜索、附件、背景、opaque 布局与提醒通过 `NotesDataClient` 交给 notes 0.1.1 的真实 utility backend；其自包含包内含实际引擎和 Zod 许可。宿主基础设施改从 `persistence.ts` 导入通用持久化函数，避免经 `store.ts` 间接加载便签引擎。
- 普通调用经过 manager；工厂启动仅临时使用本 owner 的 startup transport。最终保存仅允许当前待确认窗口的白名单写入使用 maintenance；窗口确认后拒绝新写，最终写撤销旧确认，runtime 再次 prepare 后才可释放。
- 真实窗口暴露一处遗漏：`notes_update` 已保存，但紧接的 `surface_state` 对同一 ID 再走公共读取，被正在停用的 manager 拒绝，导致保存误报失败。现在已绑定 ID 的窗口只确认已有 surface，切换到其他 ID 仍须正常验证。
- `cancelStop` 贯通 scope、manager、utility controller 和 worker。保存拒绝恢复原提醒计时器；异步恢复完成前保持阻挡；恢复失败进入 `resume-failed`，拒绝调用、事件和释放，已恢复资源重新暂停，允许显式重试。每次 prepare/cancel 都撤销旧的 durable ack。
- 删除的 OS 桥接重验 owner、signal、storage grant、活跃请求及受限路径；只有平台操作成功后才提交 metadata。宿主资源协议通过引擎解析图片，不再解释便签图片目录。
- 目录迁移先在最终保存后复制，完整停机后提交宿主指针并重启。新根启动失败时恢复原目录及原插件快照，清除本次启动失败产生的状态后自动重启旧引擎，保留源数据与失败副本。仅恢复目录指针的旧接线已通过真实失败场景证明不足。
- 异步菜单保留启动器和退出动作；manager 变更后刷新托盘，准备期间不沿用可用的便签动作。提醒语言在启用状态下随宿主语言设置同步。
- 原有五个 smoke 文件适配 Promise 数据 API、配置/数据根分离及 opaque state。原断言保留；原 smoke 额外保护一次真实 dirty editor 停用/恢复后的最终保存。根 `typecheck` 现在包含 notes backend 的独立类型边界。

## 当前验证

开发工具链为本检出独立的 Node 26.12.1 / npm 12.2.1；运行时为 Linux Electron 45，内嵌 Node 24.22.0。未关闭沙箱；合成数据、profile 与资源均在 `local-build/`。

| 检查                                         | 本轮结果                                                                                                         |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                          | 通过，含新增 notes 边界；暂停时的 main 42 个类型错误已消除                                                       |
| `npm run lint`                               | 通过；生成的第三方 bundle 有明确 generated/lint banner                                                           |
| `npm test`                                   | 现有 32 文件、162 项通过                                                                                         |
| Vite renderer、Electron 编译                 | 通过；既有 SettingsPanel 静态/动态导入提示保留                                                                   |
| notes 单包正式组装                           | 通过，生成 notes 0.1.1 `.tgz`、SRI、资源/体积记录                                                                |
| `npm run build`                              | 未通过：`spark233.applications native payload missing. Build Windows x64 resources on Windows before packaging.` |
| 原 smoke 的 `--smoke-notes-final-save` 入口  | Linux fixture 中单独通过，真实 renderer 最终保存并正常退出；不是完整 Windows smoke                               |
| 新 Windows pack / NSIS / 完整 packaged smoke | 未执行，缺少本检出的 Windows 原生资源；不以 Linux 代表检查代替                                                   |

门禁日志为 `local-build/spark233/{typecheck,lint,test,build,notes-package}-2026-10-26.log`。完整 build 失败在原生资源准备阶段，之前的类型检查与 renderer 构建已执行。没有降低平台约束或绕过缺失资源让完整 build 假通过。

## 真实 utility 代表链

可重复入口是仓库内的 `scripts/verify-notes-backend.mjs`，复用生产 controller、worker、scope、client 与 runtime，不新增依赖或测试框架。它核对 backend PID 与宿主不同，并记录实际输入散列。

五组代表流程通过：CRUD 与拒绝删除保护正文/metadata/提醒；保存拒绝后等待真实 15 秒提醒计时器恢复；恢复失败时命令/释放被阻挡且可重新准备；等待在途平台删除、阻止新调用、最终维护写入使旧 ack 失效并再次确认；新 utility 重启保持 ID、分类、Markdown、模式、附件、opaque 布局、提醒及删除结果。垃圾箱仅注入对合成文件的拒绝或受控移动，没有操作真实系统回收站。

运行前准备对应源码的输出：

```sh
npm run typecheck
npm exec -- tsc -p electron/tsconfig.json
node packages/official/notes/build.mjs
node scripts/verify-notes-backend.mjs
```

## 真实 main / renderer 代表链

独立入口和冻结运行副本保存在 `local-build/spark233/notes-main-probe/`。运行通过 WSLg/X11，使用真实 preload、renderer IPC、main、manager 和 utility。notes 包只有 fixture 清单的平台字段改为 Linux；宿主版本在 bootstrap 固定为产品 1.2.0；OS 选择器和垃圾箱使用合成边界。正式包的 Windows 清单、产品源码、安装和真实用户数据没有为 probe 修改。

五组流程通过：实际 renderer CRUD/分类/附件及回收站拒绝保护；真实 dirty editor 在磁盘写失败后保留窗口和文本、恢复磁盘后再次停用并保存；成功迁移后的正文/附件/源副本保持；新根引擎实际启动失败后的指针及插件状态回滚、旧数据自动重开；停用后根目录变为普通文件仍可读宿主配置，启用失败隔离，恢复目录后重试保持原 ID。

已保留的产品 red：`run-ImKBvW/report.json` 证明恢复磁盘后第二次停用仍因最终保存接续失败而被拒绝；`run-UgP3FE/report.json` 证明新根启动失败后仅恢复指针仍无法读取便签（`pluginDisabled`）。早期 headless GTK 失败、probe 误写 `running` 状态、错误消息匹配及新窗口尚未 ready 的失败不计为产品 red；记录仍保留。

最终报告与输入散列见本文末尾绑定。该主进程代表链不证明 Windows 原生拖动、胶囊物理操作、IME、多屏、真实通知或回收站，也没有重新执行全部 Windows smoke。

## 后续接续

1. 恢复 Windows 固定原生资源后，重新完整 build、pack/NSIS，运行适配后的原 smoke，绑定新的七包/ASAR 输入；旧包不可复用为当前版本通过。
2. 便签外置根仍由现有备份 `notesRoot`/`notes` mount 协调。虽未在宿主解释正文格式，这一特殊挂载的通用插件数据归属合同尚需按架构继续收口；本轮没有重写备份 schema 或声称完成新 backend 的整套恢复验收。
3. 原实机、SYSTEM/UAC、IME/多屏、性能和 npm 发布条目保留。本轮 P5.8 仅复核已提交的历史证据，未重复运行 Windows 搜索故障矩阵。

## 最终输入绑定

- 真实 utility：`local-build/spark233/notes-backend-probe/run-IfLsEf/report.json`，`ok:true`，五组检查通过；日志为 `local-build/spark233/notes-backend-final-2026-10-26.log`。
- 真实 main/renderer：`local-build/spark233/notes-main-probe/run-M9y7yT/report.json`，`ok:true`，五组检查通过；冻结运行副本为 `runtime-BE4MaS`。
- 原 smoke 的新最终保存入口：`local-build/spark233/notes-main-probe/final-save-smoke-IUYSaZ/report.json`，`ok:true`、`finalPluginSave:true`，进程正常退出。bootstrap 关闭其私有配置的全局快捷键，避免与其他运行实例争抢系统 `Alt+Space`。先前 `final-save-smoke-8JQnPo` 正因探针并行争抢快捷键失败，保留该失败，不将其计为产品故障。

| 输入                              | SHA-256                                                            |
| --------------------------------- | ------------------------------------------------------------------ |
| 当前编译的 `electron/main.js`     | `ac0037eee4f73f7eb128d3e3547e907baef2baca4a3156cb85b3bb6c0c83eb4e` |
| 当前编译的 `plugins/resources.js` | `b948d511d0c0653e80712bebfbb57910a0b06c243be0f402c8a45500ff7698df` |
| 正式 notes `backend.mjs`          | `f2c580c6f84c34f0047bfc60a90bbab00a219fbb78cfd7ab93a58f495b890920` |
| 正式组装的 `notes-0.1.1.tgz`      | `73b515b79c4fcf5d68a289802ca52ea88f29bce417e314db0268e3f831508cb7` |

正式 archive 位于 `local-build/spark233/plugin-artifacts/spark233.notes/`，Windows 清单保持原目标；Linux main fixture 的平台清单变更会产生不同 tgz，不能把正式 archive 的散列当作 fixture 安装归档的散列。报告绑定最终实际执行代码；旧失败与中间 green 均保留。

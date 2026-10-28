# 来源动作、文档入口及备份恢复功能回归

日期：2026-10-27。依据[实施基线](../archive/2026-10/spark233-remaining-implementation-2026-10-27.md)，先集中完成代码，再统一验证。遵照用户最新要求，本轮只新增功能测试，不增加 UI 测试，不运行 PowerShell、Windows 打包或烟测。

本轮四处实现已收口：普通文档正清单；来源程序匹配及最终派发；恢复后宿主管理状态刷新；文档级备份令牌生命周期。用户已取消旧配置兼容，宿主及插件配置读写均拒绝不支持的 document 项，没有原路径豁免。

代码核对另补齐四处边界：同 exe 新捕获后不展示旧执行返回的候选；Manager 最终派发 window 动作时不额外传选区正文；恢复接口只能在宿主真正排空后调用；对话框外部关闭及重开时不接纳旧异步预览。Main 的令牌逻辑提取为唯一的 `BackupSelections` 实例，便于直接测试生产状态机，IPC 参数及真实窗口身份仍由 Main 校验。

## 新增功能用例

| 文件                                             | 数量 | 直接验证的行为                                                                                                                                        |
| ------------------------------------------------ | ---: | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron/source-commands.test.ts`               |    4 | 真实 Controller/Manager 的来源筛选、别名/固定/模式/provider；window 元数据投影；冷启动期间同 exe 新代次拒绝旧动作；已接受业务完成但不展示旧候选。     |
| `electron/backup-selections.test.ts`             |    4 | 调用方隔离、重选即撤销、精确释放、文档退休及迟到登记、并发恢复拒绝、失败重试、接受后退休不打断事务及过期拒绝。                                        |
| `electron/plugins/desktop-host-restore.test.ts`  |    2 | 真实维护队列未排空时拒绝刷新；真实 Host/Manager/BackupService 与临时文件完成 A/B 恢复及失败回滚，检查时间同步，旧预览/任务/迟到进度不能覆盖恢复状态。 |
| `electron/plugins/official/applications.test.ts` |    2 | 独立插件真实文件读写与类型校验；拒绝旧未知配置时原文件不变；宿主在调用 Shell 前再次拒绝不支持的文档描述符。                                           |

既有 `electron/application-entries.test.ts` 已改为严格配置规则，未增加同构类型矩阵；既有 capability 用例检查原始 native 调用自报来源无法绕过限制。未增加依赖、测试框架、DOM 环境或生产测试开关。

## 统一运行结果

使用项目固定的 Node 26.12.1、npm 12.2.1：

- `npm test`：42 个文件、192 项测试通过，本轮新增 12 项，退出码 0。
- `npm run lint`：退出码 0。
- `npm run build`：包含完整 `typecheck`、前端构建、官方插件构建和 Electron 编译，退出码 0。
- `git diff --check`：通过；已有 Pulse manifest 的 CRLF 提示未影响结果。

日志与当前生产输入 SHA-256：`local-build/spark233/implementation-final-2026-10-27/functional-summary.json`，同目录保存 `tests.log`、`lint.log`、`build.log`。用户改变配置及验证策略之前的门禁日志分别保留在子目录，未重新标为当前输入通过。

## 验证范围

这些用例执行真实生产功能模块。来源动作的最终 runtime、Electron 系统副作用、目录 picker 及挂起的 registry 请求使用明确的受控替身；测试没有执行真实 Shell、网络、utility、鼠标或剪贴板操作。备份令牌用例直接验证生产权限状态机，不证明 Main 的原生窗口事件派发或 React 生命周期。

曾准备的临时 GUI/Windows 脚本停止使用；中断运行保留为未完成，不计本轮通过。原封存候选、历史 UI/utility 报告继续只证明各自输入。本轮没有生成新的 Windows 候选，也没有执行 UI 用例；Windows、物理交互和系统/发布要求仍待原范围验收，完整主清单保持 60/108。

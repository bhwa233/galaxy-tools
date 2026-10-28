# 活动截图 OCR 与便签保存失败功能回归

日期：2026-10-27。依据[实施基线 2.8–2.9](../archive/2026-10/spark233-remaining-implementation-2026-10-27.md)，先记录合同，再集中实现，最后统一运行功能测试。用户最终确认本轮以“功能用例补齐并全部通过”收口；原平台和发布清单保留为后续事项。

## 修复与功能用例

- `electron/plugins/official/capture.ts` 不再为宿主会话传入固定的 `--spark233-ocr-enabled=false`，避免截图启动时的停用状态永久锁死同一选区。继续在启动前初始化并定期同步 `ocr.disabled`，识别派发前仍复核可用性。新增一个 `capture.test.ts` 连续用例，以真实 CaptureController、临时会话文件和 PNG，覆盖 off→on→off、最终识别拒绝及会话清理；仅原生进程传输受控，没有 UI 测试或原生程序启动。
- `electron/store.ts` 在正文写入后 metadata 提交失败时，还原目标原内容或移除本次新目标，避免旧索引配新正文及重复 ID；回滚也失败则报告原提交和回滚两项错误。现有 `store.test.ts` 新增两个用例，实际文件读写、索引及重建均为真实临时数据，仅注入提交/回滚 I/O 故障，验证同路径恢复、改名移动无孤儿、故障解除重试及重建成功。同步回滚不代表断电多文件原子性。

便签插件更新至 0.1.2，数据格式仍为 1。`backend.mjs` 由正常 build 生成，资源清单的 backend 散列与生成文件一致，未手改生成代码；截图原生程序及其独立运行行为未变。

## 统一验证结果

使用固定 Node 26.12.1/npm 12.2.1，一次集中运行：

- `npm test`：**46 文件、202 项全部通过**，本批新增 3 项；本轮三个代码批次累计新增 22 项功能用例。
- `npm run lint`：退出码 0。
- `npm run build`：包含完整 typecheck、前端、七个官方插件及 Electron 编译，退出码 0。
- `git diff --check`：通过，仅保留原 Pulse manifest 的 CRLF 提示。

输入、日志及便签归档 SHA-256：`local-build/spark233/capture-save-functional-2026-10-27/summary.json`；同目录保留 `tests.log`、`lint.log`、`build.log`。此前 [192 项](spark233-source-restore-functional-tests.md)、[199 项](spark233-translation-lifecycle-functional-tests.md)报告各保留原输入。

本轮未新增 UI 测试、依赖或测试框架，未运行 PowerShell、Windows 打包、烟测及公开发布。按照用户确认的功能验证标准，本轮文档补修、代码和测试已收口；完整产品原清单的 60/108 验收统计继续保留，未执行的系统/实机/发布事项不冒充通过，也不作为本轮任务的继续执行条件。

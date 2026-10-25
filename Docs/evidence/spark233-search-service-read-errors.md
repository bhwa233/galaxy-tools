# 搜索服务面板读取恢复与操作错误保留

日期：2026-10-25。范围：P5.8 的服务状态面板错误恢复；本轮产品只修改 `src/features/search/SearchServicePanel.tsx`，不修改 main、smoke、Launcher、locale、服务端或共享 dist。

## 实际故障与修复

原面板的状态轮询、手动刷新及配置/重建操作共用 `error`。一次 `search_service_status` 拒绝后，后续状态请求虽然成功、服务状态已经更新，成功的 `refresh()` 没有清除前次读取错误；旧错误一直显示。简单在成功轮询中清空全部 error 会误删配置/重建的真实操作失败。

当前保留原操作 `error`，增加组件内 `readError`。定时轮询、手动刷新及操作后的状态刷新仅写读取错误；成功读取只清除 `readError`。显示使用 `error ?? readError`，操作错误优先，操作开始仍按既有逻辑清除前次操作错误。未改变轮询频率、dirty 输入保护、操作互斥和原调用路径，没有新 helper/hook、依赖、控件或翻译。

## 一条真实组件自动红绿回归

复用现有 `local-build/spark233/functional-integration/inspect-renderer.mjs`，增加 `--search-service-regression` 模式；复用既有 desktop preload。只有一个小型 preview 入口挂载生产 `SearchServicePanel`、生产 API 和 i18n，使用现有 Vite 配置在 `local-build/spark233/search-service-recovery/red-dist` / `green-dist` 分别构建。没有 mock React 组件、hook 或错误状态机，没有引入 Vitest 文件、DOM 模拟库或新测试框架。

隐藏 Electron Chromium 中，受控 desktop IPC 仅提供服务状态及重建结果，连续执行：

1. 初次真实组件状态请求拒绝，界面实际显示读取错误。
2. 等待组件原生 5 秒轮询成功，状态实际变为可用；读取错误应消失。
3. 触发真实重建按钮的 DOM 事件，受控返回明确拒绝，界面实际显示操作错误。
4. 保持同一个已挂载组件，等待操作后的刷新和下一次真实定时轮询成功；操作错误应继续显示。

未修改计时器或人工推进 React 状态；报告保存每次 IPC 调用时间及实际 DOM。上游响应被控制，断言验证组件对失败/恢复的反应，不用它证明 SYSTEM 服务恢复、UAC 或生产 IPC handler 已经执行。

| 输入                                                                               | 真实报告                                                                                      | 结果                                                                                            |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 原组件，SHA-256 `0e08c76d8903b1ecc676929268877bf28abaadb5b358d12c559f4f14b118c36d` | `functional-integration/search-service-runs/f51ebab9-735b-44e4-a3f2-836a4e1ea57c/report.json` | 退出 1；`successfulPollingClearsReadError:false`，已恢复服务状态仍显示旧读取错误；其余 4 项通过 |
| 修复后，SHA-256 `425a56f17ecadab591fe95a44107b799f23567363b30b3f2b7057df877e06ae5` | `functional-integration/search-service-runs/8c82b42a-a787-4e52-aaa7-e8103d995e49/report.json` | 退出 0，5 项全部通过；恢复后 alerts 为空，随后操作拒绝在成功轮询后继续显示                      |

以上路径均位于 `local-build/spark233/` 下。旧源码原样保存在 `search-service-recovery/SearchServicePanel-before.tsx`；`red-run.json` / `green-run.json` 固定具体报告，`source-freeze.json` 保存产品及 runner 输入散列。报告早期 scope 的 “no UI clicks” 指没有 Windows 原生点选，实际重建按钮是 DOM 事件；该措辞澄清及 runner 更精确的 scope 已记录在 freeze 中，未改写原报告检查或结果。

项目选定 Node 26.12.1 / npm 12.2.1 下，两份隔离 Vite 构建通过，既有入口及新增 runner 的 Node 语法检查通过。完整 type/lint/test/build 与最终候选重新绑定由 root 统一执行，本分工不提前宣称这些产品门禁已通过。原 `automated-regressions-followup` 的 ASAR 不含这次新增修复，其原报告保持原时点事实。

复现入口：先用现有 Vite 配置将 `functional-integration/search-service-preview.html` 构建到一个隔离目录；设置 `SPARK233_SEARCH_RECOVERY_ENTRY` 为该目录实际输出 HTML 的绝对路径，`SPARK233_SEARCH_RECOVERY_SOURCE` 为对应组件源文件绝对路径，再运行 `node local-build/spark233/functional-integration/inspect-renderer.mjs --search-service-regression`。所有 Chromium profile 和报告自动新建于 `functional-integration/search-service-runs/`。

本轮没有启动搜索 native 或 SYSTEM 服务、访问 OS 剪贴板、截图、执行 UAC 或 Windows 点选，也没有读取真实用户便签/历史。没有据此勾选整个 P5.8、P7.4 或其他完整系统级验收条目。

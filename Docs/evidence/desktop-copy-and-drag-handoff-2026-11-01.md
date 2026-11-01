# 桌面文案精简与拖动保存交接

日期：2026-11-01（Asia/Hong_Kong）。范围为桌面小网速窗、排行浮层、插件栏、桌面设置与快捷快开。按用户要求，启动器底部键盘提示保持原样。

## 界面调整

- 流量排行正常时只显示上传、下载、程序与速率；暂停、缺口等只保留短状态。删除操作说明及正常状态说明。
- 插件栏和桌面编辑移除常驻教学、重复打开说明；桌面卡片管理正常状态不显示插件 ID、显示器 ID。
- 桌面设置使用简短功能名称，保留必要的开关影响；快捷快开移除重复保存提醒，模板说明按需展开。
- 排行浮层复用浏览器原生 ResizeObserver 测量自然内容高度，经受限内部 IPC 交给宿主约束与定位。未新增依赖；未在主进程复制字号、行高和文本宽度估算。

## 拖动交接

旧逻辑在 pointer up 后立即撤掉临时投影，再等待布局保存和运行时同步。其他刷新在中间发生时会让旧位置重新可见；lostpointercapture 产生的 cancel 也会抢先清除预览。

当前流程：拖动预览 → committing → 持久化完成 → 运行时同步 → 移除预览。已接受 up 的提交期间忽略该指针随后的 capture cancel；环境隐藏、停用和实例释放继续使用既有取消边界。保存失败后释放预览并恢复旧布局。

## 验证

所有合成数据与 profile 位于 local-build，未用于测试真实便签或剪贴板数据。

| 检查                                         | 结果                                                            |
| -------------------------------------------- | --------------------------------------------------------------- |
| 全仓类型检查、lint、完整 pnpm build          | 通过；保留已有 lint warning                                     |
| 设置及 DesktopLayerView 的 Chromium 组件回归 | 2 文件、5 项通过                                                |
| 受控延迟保存的旧版基线                       | 58 个松手阶段采样帧中 27 帧显示旧位置                           |
| 新版保存成功交接                             | 10 项通过；56 帧无旧位置、空白或重复画面                        |
| 保存失败回滚                                 | 12 项通过；28 个等待保存采样帧维持终点，失败后旧数据保留        |
| 最新 renderer 交接复测                       | 10 项通过，无位置回退，同屏零新增窗口                           |
| 自适应高度和内部尺寸请求边界                 | 9 项通过；无 renderer errors 或 diagnostics                     |
| 全套 Node 回归第二轮                         | 326/327 通过；一个翻译历史用例在 Windows 原子 rename 遇到 EPERM |

高度实测：上传 1 条、下载 2 条时 152 DIP；3+3 条时 230 DIP，完整显示最后一行。正常说明和空 caption 均未出现。主卡片尺寸请求、非法高度、过期 surface generation 被拒绝；合法上报仍限制在声明的 300 DIP 内，布局文件字节未变。

当前开发项目另完成两次原生鼠标短拖动。两次松手之后均没有观察到旧位置重新可见，也未创建新窗口；临时投影维持到已保存卡片接替。记录为 local-build/hud-drag-latency/native-flicker-final.json 及 native-flicker-final-summary.json。测试后恢复本轮开始时的位置 `{x:2304,y:1300,width:140,height:52}`，还原 IPC 观察器、移除页面探针并关闭 Inspector。目视确认真实排行浮层已精简并随内容收缩。这些事件／DOM 观察不等同于显示器逐帧扫描测量。

全套首轮有翻译历史缓存断言失败及启动器偏好 rename EPERM；使用隔离 TEMP/TMP 和单 worker 后启动器用例通过，翻译历史另一个用例仍遇到 dictionary-history.json rename EPERM。未修改这些无关的持久化实现，不能将全套测试描述为完全通过。

主要记录：

- local-build/hud-drag-latency/runs/flicker-baseline/report.json
- local-build/hud-drag-latency/runs/flicker-after/report.json
- local-build/hud-drag-latency/runs/flicker-save-failed/report.json
- local-build/hud-drag-latency/runs/flicker-final-renderer/report.json
- local-build/hud-drag-latency/runs/hover-intrinsic-after/report.json
- local-build/hud-drag-latency/tests-flicker-sequential.log
- local-build/hud-drag-latency/browser-copy-final.log

## 逻辑与复用判断

业务插件维护采样；WidgetHost 管实例绑定和临时交互；DesktopLayer 管可信卡片投影与 IPC 身份；LayerWindow 管原生窗口；renderer 管实际排版；LayerLayoutStore 管已经提交的布局。

当前不需要新增拖拽库。Base UI 已覆盖菜单和弹窗；Pointer Events、rAF、ResizeObserver 已覆盖现有输入和尺寸测量。use-gesture 能简化 DOM 手势，但不能替代原生 DIP、共享窗口和保存交接；dnd-kit 更适合后续网格／列表排序；Floating UI 的页面浮层能力已由现有组件使用，跨原生屏幕还需自定义 platform。

相邻截图贴图和插件栏的拖动收尾也存在类似静态风险，尚未纳入这次已验证的 HUD 结论。后续整理应统一“新位置已同步才撤预览”的规则，按生命周期、交互、session/资源隔离逐步拆分 WidgetHost，避免一次性引入框架或大范围重写。

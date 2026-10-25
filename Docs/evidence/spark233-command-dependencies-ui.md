# 命令依赖的新包 Windows 无障碍验收

日期：2026-10-25。输入：`parallel-command-availability`，截图插件实际安装版本为 `0.1.1`，不是旧 profile 的 `0.1.0`。使用新建 `local-build/spark233/parallel-followup/ui-1792920761844`，首次启动自动展开七个官方包；只预置已知版本的暂停剪贴板和两条合成记录，便签没有预置数据版本。

实际运行程序为 `local-build/spark233/parallel-followup/release/win-unpacked/spark233.exe`，主进程 38896，Windows 工具返回的启动器窗口为 2560272。原 `ui-error-details-followup` 实例已正常退出，其已获用户确认安装的 Hello Web 和 profile 原样保留；新配置没有复制该安装。

代理通过 Computer Use 的 Windows 无障碍和原生鼠标执行以下操作，没有使用 CDP、DOM 注入或直接修改启停状态文件：

1. 完成首次引导；启用状态的启动器列出“截图”和“截图取字”。插件管理的截图卡片显示版本 `0.1.1`、可选依赖 `spark233.ocr ^0.1.0`，其可用命令包含“截图取字”。
2. 点击 OCR 卡片“停用”。管理页显示“已停用”，截图卡片撤下“截图取字”，保留基础“截图”和取消命令。
3. 关闭管理页。启动器同样撤下“截图取字”和 OCR 自有命令，基础截图及其他插件入口仍在。
4. 重新打开管理页，点击 OCR 的“启用”。管理页截图卡片和启动器均恢复“截图取字”。
5. 正常退出新实例。只读检查七插件均启用、没有安装错误；剪贴板仍为 `paused=true`、两条合成记录。

机器记录为 `local-build/spark233/parallel-followup/native-ui/report.json`，11 项检查均通过；同目录的 enabled/disabled/restored launcher 和 management 文本保留各阶段实际无障碍树。部分抓图错取其他前台程序，未保存为目标证据，也未据其坐标操作；滚动操作仅使用重新激活后核对正确的 spark233 画面。

这次验证证明新命令依赖字段在实际新包、管理页和启动器中的启停同步效果，不证明截图遮罩内的按钮动态显隐或框选识别。后者、基础标注/复制/保存、多屏 DPI 仍保留。没有操作真实剪贴板、执行安装器、提升 native 信任、UAC 或 SYSTEM 服务。

该包的综合 smoke 在另一个隔离 profile 的便签置顶/原生层级断言失败，见[打包记录](spark233-parallel-packaging.md)。本局部 UI 通过不覆盖该失败，也不将旧 21 项综合链改绑到本包。

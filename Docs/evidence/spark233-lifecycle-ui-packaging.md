# spark233 生命周期 UI 状态恢复跟进：独立 Windows 候选

日期：2026-10-25；预定冻结标签：`lifecycle-ui-state-followup`。

当前已通过 32 文件/162 项现有测试、完整 pack:win、NSIS 和静态产物审计，尚未启动本候选的可见 packaged smoke。根任务仍在完成上一版 packaged UI 操作，等待其明确释放桌面。当前 `artifact-static-report.json` 为 `artifactIntegrity: true`、整体 `ok: null`、`packagedSmoke.pending: true`，没有把静态成功冒充完整运行成功。

新输出为 `local-build/spark233/lifecycle-ui-followup/release/`。上一 `lifecycle-followup` 目录、artifact 报告及成功 smoke 保持不变；实际 UI 新发现的是备份成功后的状态刷新错误 banner 残留，不能据此修改旧测试/打包的成功事实。业务 manager/backup 字节未计划改变，修复由独立 Renderer lane 负责。本 lane 不编辑产品源码，不使用或修改正在运行的旧 UI profile。

相对上一冻结输入，`changes-from-lifecycle.json` 只列出 `src/features/launcher/Launcher.tsx`，SHA-256 `90cd2465803d1959684ee0139559eb9aaeab6f63002230120e2655812c3659c0`；349 输入 before/after 一致。七包 SRI/member/catalog 与 14 个 native 的新审计通过，manager/backup 当前编译字节与对应独立回归模块一致。

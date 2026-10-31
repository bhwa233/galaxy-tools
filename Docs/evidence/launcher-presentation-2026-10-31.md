# 启动器呈现路径改造证据（2026-10-31）

## 目标

快捷键呼出启动器时不再等待隐藏释放、剪贴板目标捕获与 UIA 选区读取：先显示窗口，再补齐内容；关闭后重开从主页开始，插件工作区只保留最近关闭的一个。

## 改动

- `apps/desktop/electron/host/presentation-epoch.ts`：呈现纪元（`markPresented`/`presentationCount`）。
- `apps/desktop/electron/host/launcher-runtime.ts`：`presentLauncher()` 同步显示；剪贴板目标捕获与隐藏释放转入后台 settle；`launcher-reset` 预绘制 + 40 ms 后隐藏；选区读取改为显示后补丁。
- `apps/desktop/electron/host/desktop-windows.ts`：复用窗口一律 `show()/focus()`，不再等 `desktop_ready`。
- `apps/desktop/electron/host/window-close.ts`：`prepare()` 回执期间若已重新呈现则跳过隐藏；插件工作区窗口保留最近一个。
- `apps/desktop/electron/host/windows.ts`：启动器窗口按主题给 `backgroundColor`，首帧未绘制时不再闪白。
- `apps/desktop/electron/selection-*.ts`、`assets/SelectionReader.cs`：助手新增 `operation:"foreground"` 与 `targetWindow`；显式目标不再要求来源保持前台；焦点子窗口缺失时回退窗口级文本提供器扫描。
- `apps/desktop/shared/desktop-contract.ts`、`Launcher.tsx`：`launcher-input-updated` 补丁与 `launcher-reset` 清场。

## 实测（dev14，单实例，`SPARK233_LAUNCHER_TIMELINE=1`）

| 场景                      | 时间线                                                               |
| ------------------------- | -------------------------------------------------------------------- |
| 热键 → 显示（含句柄采样） | `selection-target 0 129` + `selection-shown 81`                      |
| 热键 → 显示               | `selection-shown 40/61/66/97/98/106`                                 |
| 句柄采样（助手已热）      | `selection-target 3870140 1`                                         |
| 显示 → 选区补丁           | `selection-read target=3870140 chars=47 167`、`selection-patch 47 8` |
| 隐藏                      | `launcher-hidden 352`（含 40 ms 预绘制窗口）                         |

`selection-shown` 覆盖 40–106 ms；改造前同一份日志里热键命中时常出现 4 s 不显示或 1.6–6 s 后才显示。

## 环境限制与注意事项

- 本次会话处于锁屏/无桌面状态，`PrintWindow` 与全屏截图只得到背景色，无法给视觉验收；结论来自时间线、单测与浏览器测试。
- dev 必须保持单实例：多个 `dev-electron` 会互相替换 `local-build/spark233/dev/plugins/*.tgz`，安装器随机 ENOENT。
- 并发 dev 重建可能留下与源码同名但行为过期的 `config/cache/selection-native/selection-<hash>.exe`；改助手后先用 `probe-helper-debug.mjs` 直接验证协议再排查 app。
- 首次按键时助手可能尚未预热：`target()` 返回 0，读取退化为空输入（不阻塞显示）。

## 门禁

`pnpm typecheck`、`pnpm lint`（0 error / 153 warning）、`window-close`/`selection-launcher`/`launcher-resident` 单测（6 passed）、`Launcher.browser.test.tsx`（6 passed）。

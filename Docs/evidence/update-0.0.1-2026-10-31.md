# 应用内更新（electron-updater）与 0.0.1 版本线

日期：2026-10-31
状态：宿主实现完成并通过类型/单测门禁；打包安装与升级链路待实机验收（见文末）。

## 背景

Electron 重写后，更新链路只移植了渲染层：`apps/desktop/src/features/update/` 的 api/类型/i18n/事件监听齐全，`shared/command-*` 合同齐全，但主进程 `ipc/platform-commands.ts` 把 `update_check` / `update_download` / `update_install` / `update_settings_*` 全部落到占位 `run`，除 `update_status`（硬编码 idle）与 `update_install_prepare_report`（空实现）外都抛 `Unsupported host command`；`update://` 事件也没有任何发射方。设置页与关于页只有两行静态提示。

## 方案

- **库**：`electron-updater` 6.8.12（对应 electron-builder 26.18.0）。
- **源**：仅 GitHub Releases（公开仓库 `bhwa233/galaxy-tools`）；Mirror酱合同与 i18n 保留，主进程 no-op。
- **安装形态**：NSIS `oneClick: true`、`perMachine: false`，实现无感升级；不配置签名。
- **不做**：自动回滚、降级、第三方下载源。
- **保存屏障**：安装前复用 `ShutdownCoordinator`，让每个窗口先保存，失败即取消更新。

### 主进程

- `apps/desktop/electron/update/settings.ts`：`defaultUpdateSettings()` / `normalizeUpdateSettings()`（强制 GitHub-only、间隔 1–720h、通道 stable|beta）/ `UpdateSettingsStore`（`configDir/update.json`，`atomicWrite`，损坏回落默认值）。
- `apps/desktop/electron/update/service.ts`：`UpdateService` 状态机（idle/checking/available/downloading/downloaded/installing/installScheduled/failed）、检查与下载单飞、`update://checking|checked|download-finished|install-finished|error|auto-check-error` 状态快照事件、自动检查定时器（打包且开启 autoCheck，启动 30s 后首查）、`installKind` 判定（portable/msix/nsis/unknown 与平台不支持错误码）、错误码启发式映射（网络/hash/app-update.yml/already-running）。
- `apps/desktop/electron/ipc/platform-commands.ts`：`update_*` 全部委托 `ctx.updateService`。
- `apps/desktop/electron/runtime.ts`：`RuntimeContext.updateService`；`hostShutdown.onCommit` 在有待执行的更新安装时先 `quitAndInstall`，否则 `app.quit()`；`requestUpdateInstall()` 以 `updateInstallCommitted` 判断保存屏障是否成功，失败抛 `installSaveFailed`。

### 渲染层

- `apps/desktop/src/features/update/UpdateSettingsSection.tsx` 从 13 行静态提示改为真实面板：`checkOnly`（关于页：版本、状态、检查/下载/安装并重启、进度与错误）、`settingsOnly`（设置页：自动检查、自动下载、检查频率、稳定/测试通道）、`full` 兼有；订阅全部 `update://` 事件，无 Mirror酱 UI。

### 构建与发版

- `apps/desktop/package.json`：`build.publish` → GitHub（owner bhwa233 / repo galaxy-tools / releaseType release）；`build.nsis` → `oneClick: true`，保留 `search-service.nsh`、`deleteAppDataOnUninstall: false`。
- `.github/workflows/build-artifacts.yml`：新增 `push tags v*` 触发、`contents: write`，标签构建用 `pnpm dist:win --publish always`（`GH_TOKEN` 注入），仍上传 `release-electron/*.exe`。

## 版本线 0.0.1

- 根 `package.json` 与 `apps/desktop/package.json` 版本 `0.0.1`；七个官方插件 `spark233.host` 由 `">=1.3.0 <2"` 改为 `">=0.0.1 <1"` 并重打包（`dist-plugins/`），`plugins/manifest.ts` 窗口声明门禁与文案同步改 0.0.1。
- **`HOST_API_VERSION` 保持 `1.3.0`**：它是宿主 API 合同版本，与产品版本解耦；插件 `api` 范围仍为 `^1.0.0`（screenshot `^1.1.0`）。
- 同步更新 `source-commands.test.ts`、`plugins/presentation-contract.test.ts`、`examples/plugins/hello-web/package.json`、`packages/sdk/README.md`、`examples/plugins/hello-web/README.md`。

## 验证（2026-10-31）

- `tsc`：apps/desktop 四段（src / node / electron / tests）与全 workspace typecheck 通过。
- `oxlint` + `check-locales`：0 error（153 条既有 warning）。
- 测试：更新相关 6 个兼容测试文件 23 tests 通过；`AboutPanel.test.tsx` 的更新策略断言按新面板更新。全量 294 条多轮运行：292 通过，`electron/plugins/official/ocr.test.ts` 与 `packages/official/translation/provider.test.ts` 在 72 worker 高并发下偶发 5000ms 超时，单独重跑 16 tests 全过（本机另有并行 dev/build 任务放大负载，与本次改动无关）。
- `node scripts/build-official-plugins.mjs`：七个插件重新生成，抽查 `notes-0.1.5.tgz` 的 `spark233.host` 为 `">=0.0.1 <1"`。
- `electron-builder --win nsis --x64 --publish never`（NSIS 产物）：`release-electron/` 生成 `spark233-0.0.1-x64.exe`（202 MB）、`spark233-0.0.1-x64.exe.blockmap`、`latest.yml`（version 0.0.1 + sha512 + size）。
- `release-electron/win-unpacked/resources/app-update.yml` 为 `provider: github`、`owner: bhwa233`、`repo: galaxy-tools`、`releaseType: release`、`updaterCacheDirName: '@spark233desktop-updater'`。
- asar 内容核对：包含 `dist-electron/electron/update/service.js`、`dist-electron/electron/update/settings.js` 与 `node_modules/electron-updater/**`（更新器随包分发）；`spark233.exe` 文件版本 0.0.1，ProductVersion 0.0.1.0。
- 本机网络对 electron-builder 二进制下载不稳（GitHub release-assets 超时 600s）：用 `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/` 重跑后成功（CI 不需要该环境变量）。

## 待实机验收

1. ✅ 产物生成（Setup、`latest.yml`、`.blockmap`、`app-update.yml` 均已核对）。
2. 一键安装（验证静默安装、开始菜单/桌面快捷方式、文件关联）。
3. 发布 tag `v*` 触发 `--publish always`，GitHub Release 出现三件套。
4. 旧版本安装 → 新版本检查/下载/安装 → 重启后版本更新；保存失败（窗口未保存）时取消更新；断网/哈希不匹配的错误码展示。
5. 一键安装（验证静默安装、开始菜单/桌面快捷方式、文件关联）。
6. 发布 tag `v*` 触发 `--publish always`，GitHub Release 出现三件套。
7. 旧版本安装 → 新版本检查/下载/安装 → 重启后版本更新；保存失败（窗口未保存）时取消更新；断网/哈希不匹配的错误码展示。

## 已知限制

- 未签名：SmartScreen 提示未知发布者，完整性靠 `latest.yml` 的 SHA-512。
- 0.0.1 无法从 1.3.0 内部构建自动升级（electron-updater 不降级），需卸载重装。
- oneClick 静默安装跳过 `search-service.nsh` 的服务注册；应用内搜索设置可提权安装。
- 备份恢复 `plugins/backup.ts:416` 以 `app.getVersion()` 比较：0.0.1 会把 1.3.0 时代备份判为“较新版本创建”而拒绝恢复（fail-closed，不丢数据），未做兼容。

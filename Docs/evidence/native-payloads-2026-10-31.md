# 预编译原生插件载荷

日期：2026-10-31
状态：机制已实施并通过实机验证；正式载荷由 CI 产出并通过 GitHub Release 分发。

## 背景

`pnpm dev` 原先在启动阶段无条件从源码构建五个原生插件（截图 ScreenCapture、OCR ImageReader、剪贴板服务、应用匹配器、Pulse 搜索），因此开发机必须具备 PowerShell 7、便携 MSVC 2026、CMake、Ninja、OpenCV 与 ONNX Runtime。没有这套工具链的机器无法启动桌面应用，即使只改前端或便签代码。

## 方案

原生载荷改为 CI 预编译、按提交打包、本地校验后复用；源码构建保留给维护原生代码的机器。

- `scripts/native-payloads.mjs`
  - `pack`：收集 `packages/official/{screenshot,ocr,clipboard,applications,search}/native`，生成 `native-payloads.json`（`schemaVersion: 1`、提交、包大小/SHA-256、逐文件大小/SHA-256）与 `spark233-native-payloads-<commit>.tar.gz`。OCR 的 `legal/` 受版本控制、不随载荷分发，避免用运行器生成的副本覆盖仓库中的许可文件。
  - `fetch`：从目录或 HTTP(S) 基址读取清单，校验包哈希后解压到暂存目录，逐文件校验再落盘；路径只允许上述根，拒绝 `..`、绝对路径与重复项。
  - `check` / `has`：按落盘清单校验当前工作区，`has` 供 `pnpm dev` 快速判断。
- `apps/desktop/scripts/dev-electron.mjs`：`prepareNative()` 依次尝试预编译载荷 → 本机工具链源码构建 → `SPARK233_NATIVE_PAYLOAD_URL` 自动拉取 → 告警并跳过缺载荷的插件。另删除继承的 `ELECTRON_RUN_AS_NODE`，避免 Electron 被当作 Node 运行。
- `scripts/build-official-plugins.mjs`：开发构建（`SPARK233_DEV_SKIP_MISSING_NATIVE=1` 且无工具链）跳过缺原生载荷的插件；打包仍要求七个官方插件齐全。
- `.github/workflows/native-payloads.yml`：标签 `native-payloads-*` 或手动触发；构建资源后上传 `spark233-native-payloads` 产物，并在标签构建时把包与清单发布为同名 Release 资产，开发者可直接 `pnpm native:fetch --from https://github.com/bhwa233/galaxy-tools/releases/download/<tag>`。
- `package.json`：`native:pack` / `native:fetch` / `native:check`。

## 验证（2026-10-31）

- CI：`Native payloads` 运行 [41166974894](https://github.com/bhwa233/galaxy-tools/actions/runs/41166974894) 成功，耗时 9 分 32 秒；产物包含 `native-payloads.json`（5,345 字节）与 `spark233-native-payloads-4e1b49052dba.tar.gz`（20,580,072 字节）。
- 发布：运行 [41168401891](https://github.com/bhwa233/galaxy-tools/actions/runs/41168401891)（标签 `native-payloads-20261031c`）成功，耗时 9 分 14 秒，产出 [Release native-payloads-20261031c](https://github.com/bhwa233/galaxy-tools/releases/tag/native-payloads-20261031c)：`native-payloads.json`（4,006 字节）与 `spark233-native-payloads-4e80378e2c21.tar.gz`（20,507,396 字节）。
- 公网拉取：`pnpm native:fetch --from https://github.com/bhwa233/galaxy-tools/releases/download/native-payloads-20261031c` 安装 19 个文件并通过校验（提交 `4e80378`，工作区未出现额外改动）。
- 本地：`pnpm native:fetch --from local-build/ci-payloads` 安装 26 个文件，`pnpm native:check` 通过（提交 `4e1b490`，含当时尚未剔除的 `ocr/legal`）。
- `pnpm dev`：日志为 `Using prebuilt native payloads.`，随后 `Prepared 7 independent official plugin packages`，Vite 于 `http://127.0.0.1:1129/` 与 `http://127.0.0.1:2804/` 就绪，Electron 进程正常运行，无工具链也能启动。
- 安全回归：构造 `packages/official/../../evil.txt` 清单被拒绝且仓库外无写入；篡改压缩包一个字节被 `does not match its manifest` 拒绝；删除 `applications/native` 后重新 `fetch` 可恢复。
- `pnpm lint`：0 error（153 个既有 warning），locale 检查通过。

## 边界与后续

- 修改任一原生源码后，`resources.json` 内的源码哈希会失配，开发构建会跳过该插件；需要重跑 CI 生成新载荷或在具备工具链的机器上重建。
- `pnpm native:check` 在清单缺失、不可解析或指向已移出载荷的旧路径时退出 1 并提示重新 `fetch`，不会把过期载荷当成可用。
- 载荷不包含翻译词典（`packages/official/translation/data/ecdict.sqlite`，约 102 MB），词典仍由 `scripts/dictionary/build.py` 生成。
- 本机 dev 配置中的启动器快捷键改为 `Ctrl+Alt+Space`（`Alt+Space` 被其它程序占用）。
- 长期方向仍是把原生能力上收宿主，届时按插件分发原生载荷的机制可以整体退役。

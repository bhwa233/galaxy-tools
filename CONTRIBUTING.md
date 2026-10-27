# 开发说明

现行运行时为 Electron + TypeScript，采用 pnpm monorepo，开发工具链固定为 Node.js 26.12.1 与 pnpm 12.15.0。Windows 工具链选择和初始化见 [README](README.md#开发)。

1. `pnpm install --frozen-lockfile`、`pnpm dev`：启动桌面开发环境。
2. `apps/desktop/electron/main.ts` 管理原生窗口、托盘、IPC、快捷键；`apps/desktop/electron/store.ts` 管理 Markdown 与元数据。
3. `apps/desktop/electron/preload.cts` 提供隔离桥接；前端统一依赖 `apps/desktop/src/platform/desktop.ts`，禁止直接引入 Electron/Node。
4. 复用 `apps/desktop/src/components`、`apps/desktop/src/features` 的 React 编辑器、Markdown、主题及控件。桌面依赖见 `apps/desktop/package.json`；SDK、UI、官方插件和示例各自在其 workspace 中声明依赖，内部依赖使用 `workspace:`，全仓只维护根 `pnpm-lock.yaml`。
5. 检查：`pnpm typecheck`、`pnpm lint`、`pnpm test`、`pnpm build`。测试使用现有 Vitest runner，文件名 `*.test.ts[x]`；新测试不需要逐文件注册。
6. Windows 构建：`pnpm pack:win`、`pnpm dist:win`。以隔离数据目录做 Windows 运行验收，绝不能把真实便签当测试夹具。

只为真实逻辑、保存/并发、信任边界和已发生回归增加测试，不新增文本快照或源码字符串断言。上游 Tauri 更新器、打包脚本和工作流均为历史参考；不要从现行 Electron 代码中调用它们。

以上命令从仓库根目录执行；根目录提供统一编排，单包任务使用 `pnpm --filter <包名> <命令>`。桌面构建输出在 `apps/desktop/dist` 与 `apps/desktop/dist-electron`，分发与验证目录 `release-electron`、`dist-host`、`dist-plugins`、`local-build` 留在根目录。

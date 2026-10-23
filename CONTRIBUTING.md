# 开发说明

现行运行时为 Electron + TypeScript，使用 Node.js 24 与 npm。

1. `npm ci`、`npm run dev`：启动桌面开发环境。
2. `electron/main.ts` 管理原生窗口、托盘、IPC、快捷键；`electron/store.ts` 管理 Markdown 与元数据。
3. `electron/preload.cts` 提供隔离桥接；前端统一依赖 `src/platform/desktop.ts`，禁止直接引入 Electron/Node。
4. 复用 `src/components`、`src/features` 的 React 编辑器、Markdown、主题及控件。依赖见 `package.json`。
5. 检查：`npm run typecheck`、`npm run lint`、`npm test`、`npm run build`。测试使用现有 Vitest runner，文件名 `*.test.ts[x]`；新测试不需要逐文件注册。
6. Windows 构建：`npm run pack:win`、`npm run dist:win`。以隔离数据目录做 Windows 运行验收，绝不能把真实便签当测试夹具。

只为真实逻辑、保存/并发、信任边界和已发生回归增加测试，不新增文本快照或源码字符串断言。上游 Tauri 更新器、打包脚本和工作流均为历史参考；不要从现行 Electron 代码中调用它们。

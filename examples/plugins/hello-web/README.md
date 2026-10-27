# Hello Web

这是独立的预构建 Web 插件包，不静态编入宿主，不需要 Node、原生执行、网络或剪贴板权限。唯一能力是插件私有存储。

在本目录执行 `pnpm pack` 可生成本地 `.tgz`，由宿主按普通插件导入。安装授权仅勾选 `storage`，不授予原生信任。

`sdk.js` 是本仓 `packages/sdk/dist/browser.js` 的预构建副本；更新 SDK 后先执行根目录的 `pnpm sdk:build`，再执行 `pnpm --filter @spark233/example-hello-web build` 同步该文件。页面本身只有 HTML、CSS 和原生 JavaScript，没有安装脚本或运行时依赖。

示例验证 context/theme、命令激活、私有存储和保存确认：修改文本后直接关闭页面或者停用插件，`onPrepareStop` 会先写入私有存储。关闭页面不会停用插件，再次执行命令可恢复内容。

页面没有 `ipcRenderer`、Node 或任意 IPC 通道。其他能力只能经宿主代理调用，同时具备清单声明和用户授权；未实现的代理能力明确拒绝。

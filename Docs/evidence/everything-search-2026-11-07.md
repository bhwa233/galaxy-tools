# Everything 1.5 文件与正文搜索隔离实测（2026-11-07）

对应方案：[文件名搜索改用 Everything](../everything-file-search.md)。所有数据位于 `local-build/everything-smoke/`，未索引真实用户目录，未安装服务，未触发 UAC。

## 来源

- Everything 1.5.0.1424b x64 便携版，`https://www.voidtools.com/Everything-1.5.0.1424b.x64.zip`，SHA-256 `f8e5d907…7083084`，签名者 voidtools PTY LTD。各文件哈希见 `scripts/native-everything/sources.lock.json`，由 `scripts/native-everything/stage.mjs` 校验后放入 `packages/official/search/native/`。
- SDK3 只作为协议参考：`everything-ipc.ts` 的命令号、回复码、搜索标志、属性 id、值类型编号与回复解析顺序已逐项对照 `everything_sdk3/src/Everything3.c` 与 `include/Everything3.h`。

## 实测

命令（终端面板）：

```
node scripts/native-everything/stage.mjs --zip <下载的 zip>
cd apps/desktop
npx vitest run --root ../../scripts/native-everything --pool=threads
```

结果（`local-build/everything-smoke/smoke-main.log`）：

| 检查                                                    | 结果                                                         |
| ------------------------------------------------------- | ------------------------------------------------------------ |
| 本机用户实例                                            | 默认实例版本 1.5.0.1424；`1.5a` 不存在（ENOENT），跳过       |
| 便携实例启动后首个文件名结果                            | 322 ms                                                       |
| 文件名 `alpha`、`设计`                                  | 各命中唯一的夹具文件                                         |
| 正文 `zebra-orchid-4471`、`紫藤萝-8812`、`kumquat-5590` | 各命中唯一文件；私有目录与 `node_modules` 中的同词文件被排除 |
| 5 MiB 文件中的词                                        | 无命中（超过 4 MB 内容上限）                                 |
| 私有目录中的文件名                                      | 无命中                                                       |
| `workspace` 命令打开 Everything 窗口                    | 成功，转发进程退出                                           |
| 停止插件后                                              | 便携实例退出，`Everything IPC (spark233-smoke)` 管道消失     |

单独探测（`local-build/everything-probe.ps1`）：`-instance <名> -search hello` 转发后 8 秒内退出；加上 `-focus-search-edit` 时转发进程不退出。实现已去掉该参数。

## 未验证

安装包体积、干净 Windows 首次启动、真实用户目录的内容索引内存占用、安装器升级时卸载旧 Pulse 服务的提权路径。

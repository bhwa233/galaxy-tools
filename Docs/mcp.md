# 本地 MCP 接口

spark233 内置一个本地 MCP（Model Context Protocol）服务，允许 AI 客户端（Claude Desktop、Cursor 等）按授权读写便签。默认关闭，需在设置中手动开启；便签插件停用时 MCP 服务也停止，重新启用后按已保存设置恢复。

## 开启方式

1. 打开便签列表 → 设置 → **AI 接口（MCP）**，开启「启用 MCP 服务」。
2. 选择权限级别：
   - **只读**：仅列出/读取/搜索便签；
   - **追加写入**：可新建便签、追加或替换正文、设置提醒；
   - **完全控制**：额外允许删除便签（进回收站）。
3. 点击「复制客户端配置」得到一段 JSON，按客户端说明粘贴即可。

## 客户端配置

通用 MCP 客户端配置格式（安装版示例路径，请以复制结果为准）：

```json
{
  "mcpServers": {
    "spark233": {
      "command": "C:\\Users\\<用户名>\\AppData\\Local\\Programs\\spark233\\spark233.exe",
      "args": ["--mcp"]
    }
  }
}
```

- Claude Desktop：粘贴到 设置 → Developer → Edit Config 的 `claude_desktop_config.json`。
- Cursor：项目或全局 `mcp.json` 使用同样结构。

`--mcp` 进程是 stdio 服务：若 spark233 主应用未运行，会自动拉起主应用再连接（最多等待 15 秒）；若设置中未开启 MCP 或便签插件已停用，连接失败并在客户端日志中提示。设置保存在 `%APPDATA%/spark233/host/config.json`，客户端应使用设置中复制的当前可执行路径。

## 工具清单（spark233_ 前缀）

| 工具                       | 最低权限 | 说明                                      |
| :------------------------- | :------- | :---------------------------------------- |
| `spark233_list_categories` | 只读     | 列出全部分类                              |
| `spark233_list_notes`      | 只读     | 列出便签摘要，可按分类过滤                |
| `spark233_read_note`       | 只读     | 按 id 读取完整正文                        |
| `spark233_search_notes`    | 只读     | 标题+正文关键词搜索，返回命中片段         |
| `spark233_create_note`     | 追加写入 | 新建便签                                  |
| `spark233_write_note`      | 追加写入 | append 追加 / replace 整篇替换            |
| `spark233_set_reminder`    | 追加写入 | 便签级或任务行级提醒（minutes 或 fireAt） |
| `spark233_delete_note`     | 完全控制 | 删除便签（系统回收站）                    |

低于权限级别的工具不出现在 `tools/list` 中，强行调用会被拒绝。

## 安全模型

- 通信走本机命名管道 `\\.\pipe\spark233-mcp`，没有网络监听端口；
- 首行需携带配置根目录（`%APPDATA%/spark233/mcp-token`）中的随机 token 握手，错误即断开。token 不位于 `host/` 子目录，不应提供给不受信任的客户端；
- 所有数据操作都由主应用进程内的唯一 NoteStore 执行，MCP 写入与界面写入共用同一条磁盘事务串行链，写入成功后所有窗口实时同步；
- 协议为换行分隔 JSON-RPC（MCP stdio），MCP 通道使用 Node 内置模块实现。

## 开发模式

先完成构建，再执行 `npx electron . --mcp`（或 `npm start -- --mcp`）。设置中的「复制客户端配置」根据实际运行方式生成参数：开发版包含应用目录绝对路径及 `--mcp`，安装版只需 `--mcp`。手工配置开发用 `electron.exe` 时，`args` 应为 `["C:\\实际仓库目录", "--mcp"]`，或直接运行上述命令。

隔离验证请设置 `SPARK233_CONFIG_DIR` / `SPARK233_DATA_DIR`，应用和 MCP 中继使用相同环境，全部数据放在 `local-build/` 或明确的临时目录；不要使用真实便签数据。spark233 使用新管道、配置和工具命名空间，不提供旧 `floral_` 工具别名。协议权限和旧便签链路已有阶段证据，最终安装版客户端连接仍须随本轮整体验收复核。

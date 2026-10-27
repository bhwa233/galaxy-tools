// MCP stdio 协议层：换行分隔的 JSON-RPC 2.0。不依赖 electron / node 专有 API，
// 工具执行通过注入的 McpOps 等待便签插件的数据操作。
export type McpPermission = "read" | "append" | "full";

export const PROTOCOL_VERSION = "2025-06-18";

export interface McpNoteSummary {
  id: string;
  title: string;
  category: string;
  updatedAt: string;
  wordCount: number;
}
export interface McpNote extends McpNoteSummary {
  content: string;
}
export interface McpSearchHit {
  id: string;
  title: string;
  snippet: string;
}
export interface McpReminderRef {
  id: string;
  noteId: string;
  fireAt: string;
  taskText?: string;
}

export interface McpOps {
  version(): string;
  listCategories(): string[] | Promise<string[]>;
  listNotes(category?: string): McpNoteSummary[] | Promise<McpNoteSummary[]>;
  readNote(id: string): McpNote | Promise<McpNote>;
  searchNotes(query: string, limit: number): McpSearchHit[] | Promise<McpSearchHit[]>;
  createNote(input: {
    title?: string;
    content?: string;
    category?: string;
  }): McpNote | Promise<McpNote>;
  writeNote(id: string, mode: "append" | "replace", content: string): McpNote | Promise<McpNote>;
  deleteNote(id: string): void | Promise<void>;
  setReminder(input: {
    noteId?: string;
    title?: string;
    minutes?: number;
    fireAt?: string;
    taskText?: string;
  }): McpReminderRef | Promise<McpReminderRef>;
}

export class McpToolError extends Error {}

const PERMISSION_RANK: Record<McpPermission, number> = { read: 0, append: 1, full: 2 };

export function allows(permission: McpPermission, required: McpPermission): boolean {
  return PERMISSION_RANK[permission] >= PERMISSION_RANK[required];
}

function textArg(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new McpToolError(`参数 ${field} 需要非空字符串`);
  return value;
}
function optionalText(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

interface McpTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  permission: McpPermission;
  run: (args: Record<string, unknown>, ops: McpOps) => unknown;
}

const TOOLS: McpTool[] = [
  {
    name: "spark233_list_categories",
    description: "列出全部便签分类。",
    inputSchema: { type: "object", properties: {} },
    permission: "read",
    run: (_args, ops) => ops.listCategories(),
  },
  {
    name: "spark233_list_notes",
    description: "列出便签摘要（id、标题、分类、更新时间、字数），可按分类过滤。",
    inputSchema: {
      type: "object",
      properties: { category: { type: "string", description: "可选，按分类过滤" } },
    },
    permission: "read",
    run: (args, ops) => ops.listNotes(optionalText(args.category)),
  },
  {
    name: "spark233_read_note",
    description: "按 id 读取一篇便签的完整正文。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    permission: "read",
    run: (args, ops) => ops.readNote(textArg(args.id, "id")),
  },
  {
    name: "spark233_search_notes",
    description: "按关键词搜索全部便签的标题与正文，返回命中片段。",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        limit: { type: "number", description: "返回上限，默认 20，最大 50" },
      },
      required: ["query"],
    },
    permission: "read",
    run: (args, ops) => {
      const limit = Number(args.limit);
      return ops.searchNotes(
        textArg(args.query, "query"),
        Number.isFinite(limit) && limit > 0 ? Math.min(50, Math.floor(limit)) : 20,
      );
    },
  },
  {
    name: "spark233_create_note",
    description: "新建便签，返回新便签（含 id）。",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string" },
        content: { type: "string", description: "Markdown 正文" },
        category: { type: "string" },
      },
    },
    permission: "append",
    run: (args, ops) =>
      ops.createNote({
        title: optionalText(args.title),
        content: optionalText(args.content),
        category: optionalText(args.category),
      }),
  },
  {
    name: "spark233_write_note",
    description: "写入便签正文：append 追加到末尾，replace 整篇替换。",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        content: { type: "string" },
        mode: { type: "string", enum: ["append", "replace"] },
      },
      required: ["id", "content", "mode"],
    },
    permission: "append",
    run: (args, ops) => {
      const mode =
        args.mode === "replace" ? "replace" : args.mode === "append" ? "append" : undefined;
      if (!mode) throw new McpToolError("参数 mode 只支持 append 或 replace");
      return ops.writeNote(textArg(args.id, "id"), mode, textArg(args.content, "content"));
    },
  },
  {
    name: "spark233_set_reminder",
    description:
      "设置提醒。用 noteId 或 title 定位便签；minutes（从现在起）或 fireAt（ISO 时间）二选一；taskText 可选，提供则为任务行级提醒。",
    inputSchema: {
      type: "object",
      properties: {
        noteId: { type: "string" },
        title: { type: "string", description: "按标题精确匹配定位便签" },
        minutes: { type: "number" },
        fireAt: { type: "string", description: "ISO 时间字符串" },
        taskText: { type: "string" },
      },
    },
    permission: "append",
    run: (args, ops) =>
      ops.setReminder({
        noteId: optionalText(args.noteId),
        title: optionalText(args.title),
        minutes: typeof args.minutes === "number" ? args.minutes : undefined,
        fireAt: optionalText(args.fireAt),
        taskText: optionalText(args.taskText),
      }),
  },
  {
    name: "spark233_delete_note",
    description: "按 id 删除便签（移入系统回收站）。需要完全控制权限。",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
    permission: "full",
    run: async (args, ops) => {
      await ops.deleteNote(textArg(args.id, "id"));
      return { deleted: true };
    },
  },
];

export function visibleTools(permission: McpPermission) {
  return TOOLS.filter((tool) => allows(permission, tool.permission)).map(
    ({ name, description, inputSchema }) => ({ name, description, inputSchema }),
  );
}

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string | null;
  method?: string;
  params?: Record<string, unknown>;
}

function response(id: number | string | null, result: unknown): string {
  return JSON.stringify({ jsonrpc: "2.0", id, result });
}
function errorResponse(id: number | string | null, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });
}
function toolResult(id: number | string | null, value: unknown): string {
  return response(id, {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
  });
}
function toolError(id: number | string | null, message: string): string {
  return response(id, {
    content: [{ type: "text", text: message }],
    isError: true,
  });
}

export interface McpContext {
  permission: McpPermission;
  ops: McpOps;
}

/** 处理一行 JSON-RPC；返回要写回的响应行，通知（无 id）与空行返回 null。 */
export async function handleLine(line: string, context: McpContext): Promise<string | null> {
  let message: JsonRpcMessage;
  try {
    message = JSON.parse(line);
  } catch {
    return errorResponse(null, -32700, "Parse error");
  }
  if (message == null || typeof message !== "object" || Array.isArray(message))
    return errorResponse(null, -32600, "Invalid Request");
  const id = message.id ?? null;
  if (id === null) return null; // 通知：notifications/initialized、cancelled 等直接忽略
  switch (message.method) {
    case "initialize": {
      const requested = message.params?.protocolVersion;
      return response(id, {
        protocolVersion: typeof requested === "string" ? requested : PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "spark233", version: context.ops.version() },
      });
    }
    case "ping":
      return response(id, {});
    case "tools/list":
      return response(id, { tools: visibleTools(context.permission) });
    case "tools/call": {
      const name = message.params?.name,
        args = message.params?.arguments;
      const tool = TOOLS.find((candidate) => candidate.name === name);
      if (!tool) return errorResponse(id, -32602, `未知工具: ${String(name)}`);
      if (!allows(context.permission, tool.permission))
        return errorResponse(
          id,
          -32602,
          `工具 ${tool.name} 需要更高 MCP 权限（当前: ${context.permission}），请在spark233设置中调整`,
        );
      try {
        const toolArgs: Record<string, unknown> =
          args && typeof args === "object" && !Array.isArray(args)
            ? (args as Record<string, unknown>)
            : {};
        return toolResult(id, await tool.run(toolArgs, context.ops));
      } catch (error) {
        if (error instanceof McpToolError) return toolError(id, error.message);
        return toolError(id, error instanceof Error ? error.message : String(error));
      }
    }
    default:
      return errorResponse(id, -32601, `Method not found: ${String(message.method)}`);
  }
}

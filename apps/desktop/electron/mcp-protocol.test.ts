import { describe, expect, it, vi } from "vitest";
import { handleLine, visibleTools, type McpOps } from "./mcp-protocol.js";

function ops(overrides: Partial<McpOps> = {}): McpOps {
  return {
    version: () => "1.2.0",
    listCategories: () => ["工作", "生活"],
    listNotes: (category) =>
      [
        {
          id: "n1",
          title: "清单",
          category: "生活",
          updatedAt: "2026-10-24T02:00:00Z",
          wordCount: 8,
        },
        {
          id: "n2",
          title: "周报",
          category: "工作",
          updatedAt: "2026-10-23T02:00:00Z",
          wordCount: 800,
        },
      ].filter((note) => !category || note.category === category),
    readNote: (id) => ({
      id,
      title: "清单",
      category: "生活",
      updatedAt: "",
      wordCount: 0,
      content: "# 清单",
    }),
    searchNotes: (query, limit) =>
      [{ id: "n1", title: "清单", snippet: `...${query}...` }].slice(0, limit),
    createNote: vi.fn().mockResolvedValue({
      id: "n3",
      title: "新建",
      category: "",
      updatedAt: "",
      wordCount: 0,
      content: "hello",
    }),
    writeNote: vi.fn().mockResolvedValue({
      id: "n1",
      title: "清单",
      category: "",
      updatedAt: "",
      wordCount: 0,
      content: "x",
    }),
    deleteNote: vi.fn(),
    setReminder: vi
      .fn()
      .mockResolvedValue({ id: "r1", noteId: "n1", fireAt: "2026-10-24T03:00:00Z" }),
    ...overrides,
  } as McpOps;
}

function payload(line: string | null): any {
  if (line === null) throw new Error("Expected a JSON-RPC response");
  return JSON.parse(line);
}

describe("handleLine", () => {
  it("answers initialize with protocol version and server info", async () => {
    const line = await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: { protocolVersion: "2025-06-18" },
      }),
      { permission: "read", ops: ops() },
    );
    const result = payload(line).result;
    expect(result.serverInfo).toEqual({ name: "spark233", version: "1.2.0" });
    expect(result.protocolVersion).toBe("2025-06-18");
    expect(result.capabilities.tools).toBeDefined();
  });

  it("replies to ping with an empty object", async () => {
    const line = await handleLine(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" }), {
      permission: "read",
      ops: ops(),
    });
    expect(payload(line).result).toEqual({});
  });

  it("ignores notifications", async () => {
    expect(
      await handleLine(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }), {
        permission: "read",
        ops: ops(),
      }),
    ).toBeNull();
  });

  it("reports parse errors", async () => {
    const line = await handleLine("{broken", { permission: "read", ops: ops() });
    expect(payload(line).error.code).toBe(-32700);
  });

  it("reports unknown methods", async () => {
    const line = await handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 3, method: "resources/list" }),
      {
        permission: "read",
        ops: ops(),
      },
    );
    expect(payload(line).error.code).toBe(-32601);
  });

  it("lists tools filtered by permission", async () => {
    const readLine = await handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 4, method: "tools/list" }),
      {
        permission: "read",
        ops: ops(),
      },
    );
    const readNames = payload(readLine).result.tools.map((tool: any) => tool.name);
    expect(readNames).toContain("spark233_read_note");
    expect(readNames).not.toContain("spark233_create_note");
    expect(readNames).not.toContain("spark233_delete_note");

    const fullLine = await handleLine(
      JSON.stringify({ jsonrpc: "2.0", id: 5, method: "tools/list" }),
      {
        permission: "full",
        ops: ops(),
      },
    );
    const fullNames = payload(fullLine).result.tools.map((tool: any) => tool.name);
    expect(fullNames).toContain("spark233_delete_note");
  });

  it("executes read tools and wraps results as text content", async () => {
    const line = await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 6,
        method: "tools/call",
        params: { name: "spark233_read_note", arguments: { id: "n1" } },
      }),
      { permission: "read", ops: ops() },
    );
    const result = payload(line).result;
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text).content).toBe("# 清单");
  });

  it("blocks write tools below the required permission", async () => {
    const line = await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "spark233_create_note", arguments: {} },
      }),
      { permission: "read", ops: ops() },
    );
    expect(payload(line).error.code).toBe(-32602);
  });

  it("runs append tools at append permission", async () => {
    const context = { permission: "append" as const, ops: ops() };
    await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: { name: "spark233_create_note", arguments: { title: "新" } },
      }),
      context,
    );
    expect(context.ops.createNote).toHaveBeenCalledWith({
      title: "新",
      content: undefined,
      category: undefined,
    });
  });

  // Append permission previously allowed a destructive whole-document replacement.
  it("requires full permission for replacement while retaining append access", async () => {
    const operations = ops();
    const call = (mode: string, permission: "append" | "full") =>
      handleLine(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 30,
          method: "tools/call",
          params: {
            name: "spark233_write_note",
            arguments: { id: "n1", content: "replacement", mode },
          },
        }),
        { permission, ops: operations },
      );
    expect(payload(await call("replace", "append")).error.code).toBe(-32602);
    expect(operations.writeNote).not.toHaveBeenCalled();
    await call("append", "append");
    expect(operations.writeNote).toHaveBeenCalledWith("n1", "append", "replacement");
    await call("replace", "full");
    expect(operations.writeNote).toHaveBeenCalledWith("n1", "replace", "replacement");
  });

  it("turns tool argument errors into isError results", async () => {
    const line = await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 9,
        method: "tools/call",
        params: { name: "spark233_read_note", arguments: {} },
      }),
      { permission: "read", ops: ops() },
    );
    expect(payload(line).result.isError).toBe(true);
    expect(payload(line).result.content[0].text).toContain("id");
  });

  it("turns domain errors into isError results with the message", async () => {
    const failing = ops({
      readNote: () => {
        throw new Error("找不到该便签");
      },
    });
    const line = await handleLine(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "spark233_read_note", arguments: { id: "missing" } },
      }),
      { permission: "read", ops: failing },
    );
    expect(payload(line).result.isError).toBe(true);
    expect(payload(line).result.content[0].text).toContain("找不到该便签");
  });
});

describe("visibleTools", () => {
  it("never exposes delete at append level", () => {
    expect(visibleTools("append").map((tool) => tool.name)).not.toContain("spark233_delete_note");
    expect(visibleTools("full").map((tool) => tool.name)).toContain("spark233_delete_note");
  });
});

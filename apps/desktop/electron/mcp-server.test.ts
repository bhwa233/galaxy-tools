import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { createInterface } from "node:readline";
import { once } from "node:events";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { McpServer, ensureMcpToken, mcpPipePath, mcpProof } from "./mcp-server.js";
import type { McpOps } from "./mcp-protocol.js";

// Exercise real bounded named pipes, not a mock transport or a user's MCP profile.
it("authenticates both peers and closes an unbounded client before dispatch", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-mcp-boundary-"));
  let listening!: () => void;
  const ready = new Promise<void>((resolve) => {
    listening = resolve;
  });
  const server = new McpServer({
    configDir: () => root,
    context: () => ({ permission: "read", ops: { version: () => "fixture" } as McpOps }),
    onLog: (message) => {
      if (message === "mcp-server-listening") listening();
    },
  });
  server.start();
  await ready;
  const socket = net.connect(mcpPipePath(root));
  socket.on("error", () => {});
  const lines = createInterface({ input: socket })[Symbol.asyncIterator]();
  try {
    const { challenge } = JSON.parse((await lines.next()).value!);
    const token = ensureMcpToken(root),
      nonce = randomBytes(32).toString("hex");
    socket.write(
      JSON.stringify({ nonce, proof: mcpProof(token, "client", challenge, nonce) }) + "\n",
    );
    const response = JSON.parse((await lines.next()).value!);
    expect(response.proof).toBe(mcpProof(token, "server", challenge, nonce));
    socket.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }) + "\n");
    expect(JSON.parse((await lines.next()).value!).id).toBe(1);
    const closed = once(socket, "close");
    socket.write("x".repeat(1024 * 1024 + 1));
    await closed;
    const invalid = net.connect(mcpPipePath(root));
    invalid.on("error", () => {});
    const invalidLines = createInterface({ input: invalid })[Symbol.asyncIterator]();
    await invalidLines.next();
    const rejected = once(invalid, "close");
    invalid.write(JSON.stringify({ token }) + "\n");
    await rejected;
  } finally {
    socket.destroy();
    server.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

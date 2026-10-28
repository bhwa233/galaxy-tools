import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { handleLine, type McpContext } from "./mcp-protocol.js";

export const MCP_MAX_LINE_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 15_000;
const RETRY_INTERVAL_MS = 250;

export function mcpPipePath(configDir: string): string {
  const profile = createHash("sha256")
    .update(path.resolve(configDir).toLowerCase())
    .digest("hex")
    .slice(0, 24);
  return path.win32.join("//./pipe", `spark233-mcp-${profile}`);
}
export function mcpProof(
  token: string,
  role: "client" | "server",
  challenge: string,
  nonce: string,
): string {
  return createHmac("sha256", token).update(`${role}:${challenge}:${nonce}`).digest("hex");
}
export function validMcpProof(actual: unknown, expected: string): boolean {
  return (
    typeof actual === "string" &&
    /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"))
  );
}
export function mcpTokenFile(configDir: string): string {
  return path.join(configDir, "mcp-token");
}
export function ensureMcpToken(configDir: string): string {
  const file = mcpTokenFile(configDir);
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token) return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  fs.mkdirSync(configDir, { recursive: true });
  const token = randomBytes(32).toString("hex");
  const temporary = path.join(configDir, `mcp-token-${randomBytes(16).toString("hex")}.pending`);
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(temporary, "wx", 0o600);
    fs.writeFileSync(descriptor, token);
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    // A hard link publishes complete bytes without overwriting a competing creator.
    try {
      fs.linkSync(temporary, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const published = fs.readFileSync(file, "utf8").trim();
    if (!published) throw new Error("MCP token file is empty");
    return published;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}
export interface McpServerOptions {
  configDir: () => string;
  context: () => McpContext;
  onLog?: (message: string, error?: unknown) => void;
}
/** Profile-scoped pipe with bounded framing and mutual proof of token possession.
 * The token is never sent to an unverified pipe listener. */
export class McpServer {
  private server?: net.Server;
  private sockets = new Set<net.Socket>();
  constructor(private options: McpServerOptions) {}
  get listening(): boolean {
    return !!this.server;
  }
  start(): void {
    if (this.server) return;
    const configDir = this.options.configDir();
    const token = ensureMcpToken(configDir);
    const server = net.createServer((socket) => {
      if (this.server !== server || this.sockets.size >= 32) {
        socket.destroy();
        return;
      }
      this.handleConnection(socket, token);
    });
    this.server = server;
    server.on("error", (error) => {
      this.options.onLog?.("mcp-server-error", error);
      if (this.server === server) this.server = undefined;
    });
    server.once("close", () => {
      if (this.server === server) this.server = undefined;
    });
    server.listen(mcpPipePath(configDir), () => {
      if (this.server !== server) {
        server.close();
        return;
      }
      this.options.onLog?.("mcp-server-listening");
    });
  }
  stop(): void {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    server?.close(() => {});
  }
  private handleConnection(socket: net.Socket, token: string): void {
    this.sockets.add(socket);
    const challenge = randomBytes(32).toString("hex");
    const timeout = setTimeout(() => socket.destroy(), 5000);
    timeout.unref();
    socket.on("close", () => {
      clearTimeout(timeout);
      this.sockets.delete(socket);
    });
    socket.on("error", () => socket.destroy());
    socket.write(JSON.stringify({ challenge }) + "\n");
    let authenticated = false,
      buffer = "",
      pending = 0;
    let queue = Promise.resolve();
    const decoder = new StringDecoder("utf8");
    socket.on("data", (chunk: Buffer) => {
      buffer += decoder.write(chunk);
      if (Buffer.byteLength(buffer) > MCP_MAX_LINE_BYTES) {
        socket.destroy();
        return;
      }
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        if (!authenticated) {
          try {
            if (Buffer.byteLength(line) > 8192) throw new Error("Authentication frame too large");
            const data = JSON.parse(line);
            if (
              typeof data.nonce !== "string" ||
              !/^[a-f0-9]{64}$/.test(data.nonce) ||
              !validMcpProof(data.proof, mcpProof(token, "client", challenge, data.nonce))
            )
              throw new Error("Invalid MCP client proof");
            socket.write(
              JSON.stringify({ proof: mcpProof(token, "server", challenge, data.nonce) }) + "\n",
            );
            authenticated = true;
            clearTimeout(timeout);
          } catch {
            this.options.onLog?.("mcp-auth-rejected");
            socket.destroy();
            return;
          }
          continue;
        }
        if (++pending > 64) {
          socket.destroy();
          return;
        }
        queue = queue.then(async () => {
          try {
            if (socket.destroyed) return;
            const response = await handleLine(line, this.options.context());
            if (response !== null && !socket.destroyed) {
              if (socket.writableLength + Buffer.byteLength(response) > 8 * MCP_MAX_LINE_BYTES)
                socket.destroy();
              else socket.write(response + "\n");
            }
          } catch (error) {
            this.options.onLog?.("mcp-handle-error", error);
          } finally {
            pending--;
          }
        });
      }
      if (!authenticated && Buffer.byteLength(buffer) > 8192) socket.destroy();
    });
  }
}
export function probePipe(configDir: string, timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(mcpPipePath(configDir));
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.on("error", () => {});
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}
export async function waitForPipe(
  ready: () => Promise<boolean> | boolean,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return true;
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }
  return false;
}

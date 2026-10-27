import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { handleLine, type McpContext } from "./mcp-protocol.js";

export const MCP_PIPE_PATH = "\\\\.\\pipe\\spark233-mcp";
const CONNECT_TIMEOUT_MS = 15_000;
const RETRY_INTERVAL_MS = 250;

export function mcpTokenFile(configDir: string): string {
  return path.join(configDir, "mcp-token");
}

export function ensureMcpToken(configDir: string): string {
  const file = mcpTokenFile(configDir);
  try {
    const token = fs.readFileSync(file, "utf8").trim();
    if (token) return token;
  } catch {
    /* 首次生成 */
  }
  const token = randomBytes(32).toString("hex");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

export interface McpServerOptions {
  configDir: () => string;
  context: () => McpContext;
  onLog?: (message: string, error?: unknown) => void;
}

/**
 * 主应用内的命名管道 MCP 服务。Windows 命名管道默认 ACL 仅当前用户可连接，
 * 另加 config 目录下随机 token 的首行握手做双重校验。
 * 数据操作全部经注入的 McpOps 走主进程唯一 NoteStore，无并发写风险。
 */
export class McpServer {
  private server?: net.Server;
  private sockets = new Set<net.Socket>();

  constructor(private options: McpServerOptions) {}

  get listening(): boolean {
    return !!this.server;
  }

  start(): void {
    if (this.server) return;
    const token = ensureMcpToken(this.options.configDir());
    const server = net.createServer((socket) => this.handleConnection(socket, token));
    server.once("error", (error) => {
      this.options.onLog?.("mcp-server-error", error);
      this.server = undefined;
    });
    server.once("close", () => {
      this.server = undefined;
    });
    server.listen(MCP_PIPE_PATH, () => {
      this.server = server;
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
    socket.on("close", () => this.sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    let authenticated = false,
      buffer = "";
    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (!line) continue;
        if (!authenticated) {
          try {
            authenticated = JSON.parse(line).token === token;
          } catch {
            authenticated = false;
          }
          if (!authenticated) {
            this.options.onLog?.("mcp-auth-rejected");
            socket.end();
            return;
          }
          continue;
        }
        void handleLine(line, this.options.context())
          .then((response) => {
            if (response !== null && !socket.destroyed) socket.write(`${response}\n`);
          })
          .catch((error) => this.options.onLog?.("mcp-handle-error", error));
      }
    });
  }
}

/** 探测命名管道是否已有服务在监听（供 --mcp 启动器决定是否拉起主应用）。 */
export function probePipe(timeoutMs = 800): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(MCP_PIPE_PATH);
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

/** 等待管道就绪；ready 谓词每轮先行检查（例如先拉起主应用再等监听）。 */
export async function waitForPipe(
  ready: () => Promise<boolean> | boolean,
  timeoutMs = CONNECT_TIMEOUT_MS,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return true;
    await new Promise((sleep) => setTimeout(sleep, RETRY_INTERVAL_MS));
  }
  return false;
}

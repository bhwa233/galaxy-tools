// 纯 Node 中继：以 ELECTRON_RUN_AS_NODE 运行，保证 stdout 不被 Chromium 污染。
// 职责单一——stdin 换行帧 → 命名管道，管道响应 → stdout，首行发 token 握手。
// 用法: node mcp-relay.js <configDir>
import net from "node:net";
import path from "node:path";
import { ensureMcpToken, MCP_PIPE_PATH } from "./mcp-server.js";

const configDir = process.argv[2];
if (!configDir || !path.isAbsolute(configDir)) {
  process.stderr.write("mcp-relay: 需要 configDir 绝对路径参数\n");
  process.exit(2);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

async function connectWithRetry(): Promise<net.Socket> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      return await new Promise<net.Socket>((resolve, reject) => {
        const socket = net.connect(MCP_PIPE_PATH);
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch {
      if (Date.now() > deadline)
        fail("无法连接spark233 MCP 服务：请确认spark233已启动，并在设置中开启 AI 接口（MCP）");
      await new Promise((sleep) => setTimeout(sleep, 250));
    }
  }
}

const token = ensureMcpToken(configDir);
const socket = await connectWithRetry();
socket.write(`${JSON.stringify({ token })}\n`);

let inbound = "";
socket.setEncoding("utf8");
socket.on("data", (chunk: string) => {
  inbound += chunk;
  let newline = inbound.indexOf("\n");
  while (newline >= 0) {
    process.stdout.write(inbound.slice(0, newline + 1));
    inbound = inbound.slice(newline + 1);
    newline = inbound.indexOf("\n");
  }
});
socket.once("close", () => process.exit(0));
socket.once("error", () => process.exit(0)); // 连接中断视为会话结束

if (process.stdin.isTTY) fail("mcp-relay: stdin 不能是终端");
process.stdin.setEncoding("utf8");
let outgoing = "";
process.stdin.on("data", (chunk: string) => {
  outgoing += chunk;
  let newline = outgoing.indexOf("\n");
  while (newline >= 0) {
    socket.write(outgoing.slice(0, newline + 1));
    outgoing = outgoing.slice(newline + 1);
    newline = outgoing.indexOf("\n");
  }
});
process.stdin.once("end", () => {
  socket.end();
  process.exit(0);
});
process.stdin.resume();

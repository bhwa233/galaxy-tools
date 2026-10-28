import net from "node:net";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  ensureMcpToken,
  mcpPipePath,
  mcpProof,
  validMcpProof,
  MCP_MAX_LINE_BYTES,
} from "./mcp-server.js";

const configDir = process.argv[2];
if (!configDir || !path.isAbsolute(configDir) || process.stdin.isTTY) {
  process.stderr.write("mcp-relay: requires an absolute configuration directory and piped stdin\n");
  process.exitCode = 2;
} else {
  const token = ensureMcpToken(configDir);
  const nonce = randomBytes(32).toString("hex");
  let socket: net.Socket | undefined;
  const deadline = Date.now() + 15_000;
  while (!socket) {
    try {
      socket = await new Promise<net.Socket>((resolve, reject) => {
        const candidate = net.connect(mcpPipePath(configDir));
        candidate.once("connect", () => {
          candidate.removeListener("error", reject);
          resolve(candidate);
        });
        candidate.once("error", (error) => {
          candidate.destroy();
          reject(error);
        });
      });
    } catch {
      if (Date.now() > deadline)
        throw new Error(
          "Cannot connect to spark233 MCP. Start the app and enable MCP in settings.",
        );
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  const connection = socket;
  let inbound = "",
    challenge: string | undefined,
    authenticated = false;
  const timer = setTimeout(
    () => connection.destroy(new Error("MCP authentication timed out")),
    5000,
  );
  const finish = (error?: Error) => {
    clearTimeout(timer);
    process.stdin.pause();
    process.stdin.unpipe(connection);
    if (error) {
      process.stderr.write(error.message + "\n");
      process.exitCode = 1;
    }
    // Let stdout drain naturally; process.exit can truncate the last response.
  };
  connection.setEncoding("utf8");
  connection.on("data", (chunk: string) => {
    inbound += chunk;
    if (Buffer.byteLength(inbound) > 8 * MCP_MAX_LINE_BYTES) {
      connection.destroy(new Error("MCP response exceeds limit"));
      return;
    }
    for (;;) {
      const newline = inbound.indexOf("\n");
      if (newline < 0) break;
      const line = inbound.slice(0, newline);
      inbound = inbound.slice(newline + 1);
      if (!authenticated) {
        try {
          const value = JSON.parse(line);
          if (!challenge) {
            if (typeof value.challenge !== "string" || !/^[a-f0-9]{64}$/.test(value.challenge))
              throw new Error("Invalid MCP challenge");
            challenge = value.challenge;
            connection.write(
              JSON.stringify({ nonce, proof: mcpProof(token, "client", challenge!, nonce) }) + "\n",
            );
          } else {
            if (!validMcpProof(value.proof, mcpProof(token, "server", challenge, nonce)))
              throw new Error("MCP server identity could not be verified");
            authenticated = true;
            clearTimeout(timer);
            process.stdin.pipe(connection);
          }
        } catch (error) {
          connection.destroy(error instanceof Error ? error : new Error(String(error)));
          return;
        }
      } else if (!process.stdout.write(line + "\n")) {
        connection.pause();
        process.stdout.once("drain", () => connection.resume());
      }
    }
  });
  connection.once("error", finish);
  connection.once("close", () => finish());
}

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { PluginResourceScope } from "../resources.js";
import { everythingPipeName } from "./everything-ipc.js";
import { createSearchRuntime } from "./search.js";

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

/** Replies split across `100 OK_MORE_DATA` chunks, as Everything streams them. */
function reply(socket: net.Socket, payload: Buffer, chunk = 7): void {
  for (let offset = 0; offset < payload.length || offset === 0; offset += chunk) {
    const part = payload.subarray(offset, offset + chunk);
    const header = Buffer.alloc(8);
    header.writeUInt32LE(offset + chunk >= payload.length ? 200 : 100, 0);
    header.writeUInt32LE(part.length, 4);
    socket.write(Buffer.concat([header, part]));
    if (!payload.length) break;
  }
}
const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
const u64 = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};
const text = (value: string) => {
  const bytes = Buffer.from(value, "utf8");
  return Buffer.concat([Buffer.from([bytes.length]), bytes]);
};

it("decodes chunked SDK3 search replies and drops host private paths", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-everything-"));
  const pluginRoot = path.join(root, "package");
  fs.mkdirSync(path.join(pluginRoot, "native"), { recursive: true });
  fs.writeFileSync(path.join(pluginRoot, "native", "Everything.exe"), "");
  const privateRoot = path.join(root, "private");
  const instance = `spark233-test-${randomUUID()}`;
  const searches: string[] = [];
  const server = net.createServer((socket) => {
    let buffer = Buffer.alloc(0);
    socket.on("data", (data: Buffer) => {
      buffer = Buffer.concat([buffer, data]);
      while (buffer.length >= 8 && buffer.length >= 8 + buffer.readUInt32LE(4)) {
        const code = buffer.readUInt32LE(0);
        const body = buffer.subarray(8, 8 + buffer.readUInt32LE(4));
        buffer = buffer.subarray(8 + body.length);
        if (code >= 1 && code <= 4) reply(socket, u32([1, 5, 0, 1424][code - 1]));
        else if (code === 9) reply(socket, u32(1));
        else if (code === 7) {
          const length = body[4];
          searches.push(body.subarray(5, 5 + length).toString("utf8"));
          const rows = [
            ["report.md", "D:\\docs"],
            ["secret.md", privateRoot],
          ];
          reply(
            socket,
            Buffer.concat([
              u32(0x4000),
              u64(0),
              u64(rows.length),
              u64(0),
              u64(rows.length),
              Buffer.from([0]),
              Buffer.from([2]),
              ...[0, 1].map((id) => Buffer.concat([u32(id), u32(0), Buffer.from([id ? 14 : 10])])),
              ...rows.map(([name, parent]) =>
                Buffer.concat([Buffer.from([0]), text(name), text(parent)]),
              ),
            ]),
          );
        } else reply(socket, Buffer.alloc(0));
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(everythingPipeName(instance), resolve));
  const scope = new PluginResourceScope({
    pluginId: "spark233.search",
    version: "0.2.0",
    instanceId: "test",
  });
  cleanups.push(
    () => new Promise<void>((resolve) => server.close(() => resolve())),
    () => fs.rmSync(root, { recursive: true, force: true }),
    async () => void (await scope.stop("disable")),
  );
  const runtime = createSearchRuntime({
    scope,
    pluginRoot,
    descriptor: { path: path.join(pluginRoot, "native", "Everything.exe"), args: [] },
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    approveTrust: () => true,
    privateRoots: () => [privateRoot],
    openPath: async () => undefined,
    fixture: {
      profileRoot: root,
      bundledInstance: `${instance}-bundled`,
      userInstances: [instance],
    },
  });
  const page = (await runtime.query!(
    { commandId: "content", parameters: { query: "quarterly report", callerId: "c" } },
    new AbortController().signal,
  )) as { items: { title: string; description?: string; commandId: string }[] };
  expect(searches).toEqual(['content:"quarterly" content:"report"']);
  expect(page.items.filter((item) => item.commandId === "open")).toEqual([
    expect.objectContaining({ title: "report.md", description: "D:\\docs\\report.md" }),
  ]);
  expect(page.items.at(-1)?.commandId).toBe("open-everything");
});

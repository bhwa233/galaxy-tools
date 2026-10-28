import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTrustedNativeProcess,
  type NativeProcessExit,
  type PluginNativeController,
} from "../backend.js";
import { PluginResourceScope } from "../resources.js";
import { createSearchRuntime } from "./search.js";

vi.mock("../backend.js", () => ({ createTrustedNativeProcess: vi.fn() }));
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.resetAllMocks();
});

type SearchItem = {
  id: string;
  commandId: string;
  parameters: { selection: string; callerId: string };
  actions: Array<{ commandId: string; parameters: { selection: string; callerId: string } }>;
};
type NativeRequest = {
  sessionId: string;
  owner: { pluginId: string; version: string; instanceId: string };
  privateRoots: string[];
};

function fixture(deferred = false) {
  const root = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), "spark233-search-runtime-")),
  );
  const pluginRoot = path.join(root, "plugin"),
    publicRoot = path.join(root, "public"),
    privateRoot = path.join(root, "private"),
    cacheDir = path.join(root, "cache");
  for (const directory of [pluginRoot, publicRoot, privateRoot]) fs.mkdirSync(directory);
  const executable = path.join(pluginRoot, "search.exe"),
    visible = path.join(publicRoot, "report.txt"),
    secret = path.join(privateRoot, "private.txt");
  fs.writeFileSync(executable, "Owned native boundary fixture; never executed");
  fs.writeFileSync(visible, "Owned visible search file");
  fs.writeFileSync(secret, "Private fixture data must not be published");
  const owner = { pluginId: "fixture.search", version: "1.0.0", instanceId: randomUUID() };
  const scope = new PluginResourceScope(owner);
  const privateRoots = [privateRoot];
  const started = Promise.withResolvers<{ directory: string; request: NativeRequest }>();
  const exits: Array<() => void> = [];
  let finish = () => {};
  const disposed = vi.fn();
  const openPath = vi.fn(async (filename: string) => {
    expect(fs.readFileSync(filename, "utf8")).toBe("Owned visible search file");
  });
  const revealPath = vi.fn(async (filename: string) => {
    expect(fs.existsSync(filename)).toBe(true);
  });
  // Only the OS process boundary is controlled: SearchRuntime writes its own
  // request, validates the real reply file, owns sessions and publishes actions.
  vi.mocked(createTrustedNativeProcess).mockImplementation(async (options) => {
    const requestFile = options.descriptor.args[options.descriptor.args.indexOf("--request") + 1];
    const directory = path.dirname(requestFile);
    const request = JSON.parse(fs.readFileSync(requestFile, "utf8")) as NativeRequest;
    const exited = Promise.withResolvers<NativeProcessExit>();
    const requestId = randomUUID();
    let finished = false;
    finish = () => {
      if (finished) return;
      finished = true;
      fs.writeFileSync(
        path.join(directory, "result.json"),
        JSON.stringify({
          protocol: 1,
          sessionId: request.sessionId,
          owner: request.owner,
          status: "ok",
          revision: "owned-index-snapshot",
          hits: [visible, secret].map((filename) => ({
            path: filename,
            name: path.basename(filename),
            directory: false,
          })),
        }),
      );
      exited.resolve({ owner, requestId, code: 0, signal: null });
    };
    exits.push(finish);
    const controller: PluginNativeController = {
      owner,
      requestId,
      pid: undefined,
      prepareStop: async () => ({ ok: true }),
      waitForExit: () => exited.promise,
      dispose: async () => {
        await options.requestShutdown?.();
        disposed();
      },
    };
    options.scope.own("process", controller);
    started.resolve({ directory, request });
    if (!deferred) finish();
    return controller;
  });
  const runtime = createSearchRuntime({
    scope,
    pluginRoot,
    descriptor: { path: executable, args: [] },
    dataDir: path.join(root, "data"),
    cacheDir,
    approveTrust: () => true,
    privateRoots: () => privateRoots,
    openPath,
    revealPath,
    confirmServiceAction: async () => false,
  });
  cleanups.push(async () => {
    for (const exit of exits) exit();
    await scope.stop("disable");
    fs.rmSync(root, { recursive: true, force: true });
  });
  const query = async (query = "report", signal?: AbortSignal) =>
    (await runtime.query!(
      { commandId: "search", parameters: { query, callerId: "document-a", privateRoots: [] } },
      signal,
    )) as { items: SearchItem[] } | undefined;
  return {
    runtime,
    scope,
    query,
    started: started.promise,
    complete: () => finish(),
    openPath,
    revealPath,
    disposed,
    visible,
    secret,
    publicRoot,
    privateRoot,
    privateRoots,
    cacheDir,
  };
}

describe("file search sessions and selection authority", () => {
  it("opens and reveals opaque hits, then refuses them after a replacement query", async () => {
    const f = fixture();
    const result = await f.query();
    expect(result?.items).toEqual([expect.objectContaining({ description: f.visible })]);
    const hit = result!.items[0];
    expect(hit.parameters.selection).not.toBe(f.visible);
    await expect(
      f.runtime.activate({
        commandId: "open",
        parameters: { selection: f.visible, callerId: "document-a" },
      }),
    ).rejects.toThrow("Search selection expired");
    await f.runtime.activate({ commandId: hit.commandId, parameters: hit.parameters });
    const reveal = hit.actions.find((action) => action.commandId === "reveal")!;
    await f.runtime.activate({ commandId: reveal.commandId, parameters: reveal.parameters });
    expect(f.openPath).toHaveBeenCalledExactlyOnceWith(f.visible);
    expect(f.revealPath).toHaveBeenCalledExactlyOnceWith(f.visible);

    await expect(f.query("")).resolves.toMatchObject({ items: [] });
    await expect(
      f.runtime.activate({ commandId: "open", parameters: hit.parameters }),
    ).rejects.toThrow("Search selection expired");
    expect(f.openPath).toHaveBeenCalledTimes(1);
    expect(fs.readdirSync(path.join(f.cacheDir, "sessions"))).toEqual([]);
    expect(f.disposed).toHaveBeenCalledOnce();
  });

  it("filters host-private paths and rechecks changed private scope before executing an old hit", async () => {
    const f = fixture();
    const result = await f.query();
    const { request } = await f.started;
    expect(request.privateRoots).toContain(f.privateRoot);
    expect(result?.items).toEqual([expect.objectContaining({ description: f.visible })]);
    const hit = result!.items[0];
    // The native reply includes both files. Activation-supplied privateRoots=[]
    // cannot admit the private file, and new host-private roots revoke old hits.
    f.privateRoots.push(f.publicRoot);
    await expect(
      f.runtime.activate({ commandId: "open", parameters: hit.parameters }),
    ).rejects.toThrow("Search scope was revoked");
    expect(f.openPath).not.toHaveBeenCalled();
    expect(f.revealPath).not.toHaveBeenCalled();
  });

  it("marks cancellation durably and discards a late native reply before publishing selections", async () => {
    const f = fixture(true);
    const abort = new AbortController();
    const pending = f.query("report", abort.signal);
    const { directory, request } = await f.started;
    abort.abort();
    expect(fs.readFileSync(path.join(directory, "cancel.request"), "utf8")).toBe(request.sessionId);
    expect(fs.existsSync(directory)).toBe(true);
    f.complete();
    await expect(pending).resolves.toBeUndefined();
    expect(fs.existsSync(directory)).toBe(false);
    expect(f.openPath).not.toHaveBeenCalled();
    expect(f.revealPath).not.toHaveBeenCalled();
    expect(f.disposed).toHaveBeenCalledOnce();
    await expect(f.scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
  });
});

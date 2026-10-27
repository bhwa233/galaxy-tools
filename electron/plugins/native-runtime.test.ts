import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createNativePluginRuntime } from "./native-runtime.js";
import { PluginResourceScope } from "./resources.js";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));
const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  vi.resetAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

// There is no existing native runtime test fixture. Exercise the real protocol,
// entry registry and resource scope; replace only child_process's OS transport.
// No executable, PowerShell, GUI or user process is launched by these tests.
function child(options: { badInit?: boolean; delayExit?: boolean; refuseSave?: boolean } = {}) {
  const transport = new EventEmitter();
  const requests: Array<{ type: string }> = [];
  const stdout = new PassThrough(),
    stderr = new PassThrough();
  const pid = 42001 + vi.mocked(spawn).mock.calls.length;
  let closed = false;
  const close = (code: number | null) => {
    if (closed) return;
    closed = true;
    transport.emit("close", code);
  };
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      for (const line of chunk.toString().trim().split("\n")) {
        const request = JSON.parse(line);
        requests.push(request);
        if (request.type === "cancel") continue;
        const value =
          request.type === "init"
            ? { ready: !options.badInit, pid }
            : request.type === "prepareStop"
              ? options.refuseSave
                ? { ok: false, reason: "Still running without save confirmation" }
                : { ok: true }
              : request.type === "activate"
                ? { accepted: request.activation.commandId }
                : null;
        stdout.write(
          JSON.stringify({
            protocol: 1,
            owner: request.owner,
            sessionId: request.sessionId,
            requestId: request.requestId,
            type: "response",
            ok: true,
            value,
          }) + "\n",
        );
      }
      callback();
    },
    final(callback) {
      close(0);
      callback();
    },
  });
  const kill = vi.fn(() => {
    if (!options.delayExit) close(null);
    return true;
  });
  Object.assign(transport, { pid, stdin, stdout, stderr, kill });
  return { transport, requests, kill, close, pid };
}

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-native-init-"));
  roots.push(root);
  const pluginRoot = path.join(root, "plugin");
  fs.mkdirSync(pluginRoot);
  const executable = path.join(pluginRoot, "owned.exe");
  fs.writeFileSync(executable, "Transport fixture only; never executed");
  const scope = new PluginResourceScope({
    pluginId: "fixture.native",
    version: "1.0.0",
    instanceId: randomUUID(),
  });
  const onCrash = vi.fn();
  const runtime = await createNativePluginRuntime({
    scope,
    pluginRoot,
    entries: { main: { path: executable, args: [] } },
    capabilities: ["native.process"],
    approveTrust: () => true,
    dataDir: path.join(root, "data"),
    cacheDir: path.join(root, "cache"),
    timeoutMs: 20,
    onCrash,
  });
  return { runtime, scope, onCrash };
}

function nextChild(options?: Parameters<typeof child>[0]) {
  const value = child(options);
  vi.mocked(spawn).mockReturnValueOnce(value.transport as ReturnType<typeof spawn>);
  return value;
}

describe("native entry startup recovery", () => {
  it("forgets an exited bad handshake, retries the entry and then stops cooperatively", async () => {
    const failed = nextChild({ badInit: true });
    const healthy = nextChild();
    const f = await fixture();
    // Regression: the rejected starting Promise previously poisoned this entry
    // permanently, even though initialization cleanup had confirmed its exit.
    await expect(f.runtime.activate({ commandId: "first" })).rejects.toThrow();
    expect(f.runtime.pid).toBeUndefined();
    expect(failed.requests.map((x) => x.type)).toEqual(["init"]);
    await expect(f.runtime.activate({ commandId: "retry" })).resolves.toEqual({
      accepted: "retry",
    });
    expect(f.onCrash).not.toHaveBeenCalled();
    await expect(f.scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
    expect(healthy.requests.map((x) => x.type)).toEqual([
      "init",
      "activate",
      "prepareStop",
      "stop",
    ]);
    expect(healthy.kill).not.toHaveBeenCalled();
  });

  it("tracks an unconfirmed initialization exit until close, then permits ordinary disable", async () => {
    vi.useFakeTimers();
    const failed = nextChild({ badInit: true, delayExit: true, refuseSave: true });
    const f = await fixture();
    const rejected = expect(f.runtime.checkStartup()).rejects.toThrow("process remains tracked");
    await vi.advanceTimersByTimeAsync(21);
    await rejected;
    expect(f.runtime.pid).toBe(failed.pid);
    await expect(f.runtime.checkStartup()).rejects.toThrow("process remains tracked");
    expect(spawn).toHaveBeenCalledTimes(1);
    await expect(f.scope.prepareStop("disable")).resolves.toEqual({
      ok: false,
      reason: "Still running without save confirmation",
    });
    failed.close(null);
    await expect(f.scope.stop("disable")).resolves.toEqual({ ok: true, errors: [] });
    expect(f.runtime.pid).toBeUndefined();
    expect(f.onCrash).not.toHaveBeenCalled();
  });

  it("keeps initialized unexpected exits behind the existing crash/save boundary", async () => {
    const initialized = nextChild();
    const f = await fixture();
    await f.runtime.activate({ commandId: "accepted" });
    initialized.close(2);
    expect(f.onCrash).toHaveBeenCalledOnce();
    await expect(f.scope.prepareStop("disable")).resolves.toEqual({
      ok: false,
      reason: "Native plugin exited before saving",
    });
    await expect(f.scope.stop("crash")).resolves.toEqual({ ok: true, errors: [] });
    expect(initialized.kill).not.toHaveBeenCalled();
  });
});

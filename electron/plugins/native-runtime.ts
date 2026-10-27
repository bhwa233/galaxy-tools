import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { z } from "zod";
import type {
  JsonValue,
  NativePluginRequest,
  PluginActivation,
  PluginCapability,
  PluginOwner,
  StopReason,
} from "../../packages/sdk/src/index.js";
import { canonical, inside } from "../persistence.js";
import { PluginResourceScope, samePluginOwner, type StopDecision } from "./resources.js";

const MAX_LINE = 1024 * 1024;
const ownerSchema = z.strictObject({
  pluginId: z.string().min(1).max(80),
  version: z.string().min(1).max(128),
  instanceId: z.string().min(1).max(100),
});
const messageSchema = z.object({
  protocol: z.literal(1),
  owner: ownerSchema,
  sessionId: z.string().uuid(),
  requestId: z.string().uuid(),
  type: z.enum(["response", "event"]),
  ok: z.boolean().optional(),
  value: z.json().optional(),
  error: z.string().max(4096).optional(),
  name: z.string().min(1).max(80).optional(),
  payload: z.json().optional(),
});
const activationSchema = z.strictObject({
  commandId: z.string().min(1).max(80).optional(),
  parameters: z.json().optional(),
  context: z.json().optional(),
});
export interface NativePluginRuntimeOptions {
  scope: PluginResourceScope;
  pluginRoot: string;
  /** Only descriptors resolved from this plugin's validated manifest. */
  entries: Record<string, { path: string; args: string[] }>;
  capabilities: readonly PluginCapability[];
  dataDir: string;
  cacheDir: string;
  approveTrust: () => boolean | Promise<boolean>;
  onCrash?: (error: Error) => void;
  onOutputBytes?: (stream: "stdout" | "stderr", byteCount: number) => void;
  onEvent?: (event: {
    owner: PluginOwner;
    entryId: string;
    name: string;
    payload?: JsonValue;
  }) => void;
  timeoutMs?: number;
}
export interface NativePluginRuntime {
  readonly pid: number | undefined;
  checkStartup(): Promise<void>;
  activate(activation: PluginActivation): Promise<JsonValue | undefined>;
  query(activation: PluginActivation, signal?: AbortSignal): Promise<JsonValue | undefined>;
  request(
    entryId: string,
    activation: PluginActivation,
    signal?: AbortSignal,
  ): Promise<JsonValue | undefined>;
  prepareStop(reason: StopReason): Promise<StopDecision>;
  dispose(): Promise<void>;
}

// The existing native controller provides output/exit tracking but no stdin or
// responses while releasing. Reuse its fixed-descriptor spawn and scope pattern
// here, adding only the bounded persistent native-plugin protocol.
class NativeEntryProcess {
  readonly sessionId = randomUUID();
  readonly initId = randomUUID();
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly exit: Promise<number | null>;
  private readonly decoder = new StringDecoder("utf8");
  private buffer = "";
  private ended = false;
  private initialized = false;
  private prepared = false;
  private disposing = false;
  private fault?: Error;
  private pending = new Map<
    string,
    { resolve: (value?: JsonValue) => void; reject: (error: Error) => void; cleanup: () => void }
  >();
  constructor(
    private options: NativePluginRuntimeOptions,
    private entryId: string,
    descriptor: { path: string; args: string[] },
  ) {
    this.child = spawn(descriptor.path, descriptor.args.slice(), {
      cwd: options.pluginRoot,
      shell: false,
      windowsHide: true,
      stdio: "pipe",
    });
    this.exit = new Promise((resolve) => {
      this.child.once("error", (error) => this.fail(error));
      this.child.once("close", (code) => {
        this.ended = true;
        const error = this.fault ?? new Error(`Native plugin exited (${code})`);
        this.fail(error, !this.disposing);
        resolve(code);
      });
    });
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stdout.on("data", (chunk: Buffer) => {
      this.output("stdout", chunk.length);
      this.receive(chunk);
    });
    // stderr is diagnostic only; it can never be mistaken for a protocol reply.
    this.child.stderr.on("data", (chunk: Buffer) => this.output("stderr", chunk.length));
  }
  private output(stream: "stdout" | "stderr", byteCount: number): void {
    if (!this.disposing && this.options.scope.accepts(this.options.scope.owner))
      try {
        this.options.onOutputBytes?.(stream, byteCount);
      } catch {
        /* Observers do not own the native task. */
      }
  }
  get pid() {
    return this.child.pid;
  }
  get failedStartupExited(): boolean {
    return this.ended && !this.initialized;
  }
  private fail(error: Error, report = true) {
    const first = !this.fault;
    this.fault = error;
    for (const request of this.pending.values()) {
      request.cleanup();
      request.reject(error);
    }
    this.pending.clear();
    if (first && report && this.initialized && !this.disposing) {
      try {
        this.options.onCrash?.(error);
      } catch (failure) {
        console.error("native-plugin-crash-notification", failure);
      }
    }
  }
  private receive(chunk: Buffer) {
    this.buffer += this.decoder.write(chunk);
    try {
      for (;;) {
        const newline = this.buffer.indexOf("\n");
        if (newline < 0) break;
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (Buffer.byteLength(line) > MAX_LINE) throw new Error("Native plugin line exceeds 1 MiB");
        if (!line.trim()) continue;
        const message = messageSchema.parse(JSON.parse(line));
        if (
          message.sessionId !== this.sessionId ||
          !samePluginOwner(message.owner, this.options.scope.owner)
        )
          continue;
        if (message.type === "event") {
          if (
            message.name &&
            this.options.scope.state === "active" &&
            this.options.scope.accepts(message.owner) &&
            (message.requestId === this.initId || this.pending.has(message.requestId))
          )
            this.options.onEvent?.({
              owner: message.owner,
              entryId: this.entryId,
              name: message.name,
              payload: message.payload as JsonValue | undefined,
            });
          continue;
        }
        if (typeof message.ok !== "boolean") throw new Error("Invalid native plugin response");
        const request = this.pending.get(message.requestId);
        if (!request) continue;
        this.pending.delete(message.requestId);
        request.cleanup();
        if (message.ok) request.resolve(message.value as JsonValue | undefined);
        else request.reject(new Error(message.error ?? "Native plugin request failed"));
      }
      if (Buffer.byteLength(this.buffer) > MAX_LINE)
        throw new Error("Native plugin unfinished line exceeds 1 MiB");
    } catch (error) {
      this.buffer = "";
      this.fail(error instanceof Error ? error : new Error(String(error)));
    }
  }
  private send(request: NativePluginRequest) {
    const line = JSON.stringify(request) + "\n";
    if (Buffer.byteLength(line) > MAX_LINE) throw new Error("Native plugin request exceeds 1 MiB");
    this.child.stdin.write(line, (error) => {
      if (error) this.fail(error);
    });
  }
  private rpc(
    body:
      | { type: "init"; entryId: string; dataDir: string; cacheDir: string }
      | { type: "activate" | "query"; activation: PluginActivation }
      | { type: "prepareStop"; reason: StopReason }
      | { type: "stop" },
    signal?: AbortSignal,
    requestId = randomUUID(),
  ): Promise<JsonValue | undefined> {
    if (this.ended) return Promise.reject(new Error("Native plugin is no longer running"));
    if (this.pending.size >= 64)
      return Promise.reject(new Error("Too many native plugin requests"));
    signal?.throwIfAborted();
    const identity = {
      protocol: 1 as const,
      owner: this.options.scope.owner,
      sessionId: this.sessionId,
      requestId,
    };
    return new Promise((resolve, reject) => {
      const cancel = (error: Error) => {
        if (!this.pending.delete(requestId)) return;
        cleanup();
        try {
          this.send({ ...identity, type: "cancel" });
        } catch {
          /* The original timeout/abort remains the actionable failure. */
        }
        reject(error);
      };
      const abort = () => cancel(new Error("Native plugin request cancelled"));
      const timer = setTimeout(
        () => cancel(new Error(`Native plugin ${body.type} timed out; process remains tracked`)),
        this.options.timeoutMs ?? 10_000,
      );
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      this.pending.set(requestId, { resolve, reject, cleanup });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      try {
        this.send({ ...identity, ...body });
      } catch (error) {
        this.pending.delete(requestId);
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }
  async initialize() {
    try {
      const ready = await this.rpc(
        {
          type: "init",
          entryId: this.entryId,
          dataDir: this.options.dataDir,
          cacheDir: this.options.cacheDir,
        },
        undefined,
        this.initId,
      );
      z.object({ ready: z.literal(true), pid: z.literal(this.child.pid) }).parse(ready);
      this.initialized = true;
    } catch (error) {
      // No normal activation was admitted. Startup failure may be terminated;
      // this exception never applies to a running plugin's save refusal.
      this.disposing = true;
      if (!this.ended) this.child.kill();
      await this.waitForClose();
      throw error;
    }
  }
  async call(type: "activate" | "query", activation: PluginActivation, signal?: AbortSignal) {
    if (this.fault) throw this.fault;
    this.prepared = false;
    return this.rpc({ type, activation }, signal);
  }
  async prepareStop(reason: StopReason): Promise<StopDecision> {
    if (this.ended)
      return reason === "crash"
        ? { ok: true }
        : { ok: false, reason: "Native plugin exited before saving" };
    try {
      const decision = z
        .discriminatedUnion("ok", [
          z.object({ ok: z.literal(true) }),
          z.object({ ok: z.literal(false), reason: z.string().min(1).max(4096) }),
        ])
        .parse(await this.rpc({ type: "prepareStop", reason }));
      this.prepared = decision.ok;
      return decision;
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) };
    }
  }
  async dispose() {
    if (this.ended) return;
    if (!this.prepared) throw new Error("Native plugin requires successful save confirmation");
    this.disposing = true;
    await this.rpc({ type: "stop" });
    this.child.stdin.end();
    const code = await this.waitForClose();
    if (code !== 0) throw new Error(`Native plugin shutdown exited (${code})`);
  }
  private async waitForClose() {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.exit,
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Native plugin did not exit; process remains tracked")),
            this.options.timeoutMs ?? 10_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function createNativePluginRuntime(
  options: NativePluginRuntimeOptions,
): Promise<NativePluginRuntime> {
  if (!options.capabilities.includes("native.process") || !(await options.approveTrust()))
    throw new Error("Native plugins require native.process and explicit host trust approval");
  if (options.scope.state !== "active") throw new Error("Native plugin scope is not active");
  options = {
    ...options,
    timeoutMs: z
      .number()
      .int()
      .min(1)
      .max(120_000)
      .parse(options.timeoutMs ?? 10_000),
  };
  if (!path.isAbsolute(options.pluginRoot)) throw new Error("Native plugin root must be absolute");
  const root = canonical(options.pluginRoot);
  const entries = new Map<string, { path: string; args: string[] }>();
  for (const [id, descriptor] of Object.entries(options.entries)) {
    const executable = canonical(descriptor.path);
    if (
      !path.isAbsolute(descriptor.path) ||
      !inside(root, executable) ||
      executable === root ||
      !fs.statSync(executable).isFile()
    )
      throw new Error("Native entry escaped its validated package");
    const args = z.array(z.string().max(4096)).max(64).parse(descriptor.args);
    entries.set(id, { path: executable, args: args.slice() });
  }
  if (!entries.size) throw new Error("No native entry was declared");
  for (const directory of [options.dataDir, options.cacheDir]) {
    if (!path.isAbsolute(directory) || inside(root, canonical(directory)))
      throw new Error(
        "Native plugin data/cache must be private absolute paths outside its package",
      );
    fs.mkdirSync(directory, { recursive: true });
  }
  const processes = new Map<string, NativeEntryProcess>();
  const starting = new Map<string, Promise<NativeEntryProcess>>();
  let disposed = false;
  const queryControllers = new Set<AbortController>();
  const defaultEntry = () => {
    if (entries.has("main")) return "main";
    if (entries.size === 1) return entries.keys().next().value!;
    throw new Error("Multiple native entries require a main entry or an explicit entry ID");
  };
  const forgetFailedStartup = (id: string, process: NativeEntryProcess): boolean => {
    if (!process.failedStartupExited || processes.get(id) !== process) return false;
    processes.delete(id);
    starting.delete(id);
    return true;
  };
  const processFor = async (id: string) => {
    if (options.scope.state !== "active" || disposed)
      throw new Error("Native plugin is not accepting requests");
    if (!entries.has(id)) throw new Error("Native entry ID was not declared by this plugin");
    const existing = processes.get(id);
    if (existing && !forgetFailedStartup(id, existing)) {
      await starting.get(id);
      return existing;
    }
    // Recheck filesystem ownership immediately before every fixed spawn.
    const descriptor = entries.get(id)!;
    if (canonical(descriptor.path) !== descriptor.path || !inside(root, canonical(descriptor.path)))
      throw new Error("Native entry changed after manifest validation");
    const process = new NativeEntryProcess({ ...options, pluginRoot: root }, id, descriptor);
    processes.set(id, process);
    const ready = process.initialize().then(
      () => process,
      (error) => {
        // Only an exited process that never admitted business work is reusable.
        // A timed-out close stays tracked until a later retry/stop observes exit.
        forgetFailedStartup(id, process);
        throw error;
      },
    );
    starting.set(id, ready);
    void ready.catch(() => {});
    return ready;
  };
  const scopedCall = async (
    type: "activate" | "query",
    entryId: string,
    activation: PluginActivation,
    signal?: AbortSignal,
  ) => {
    if (options.scope.state !== "active" || disposed)
      throw new Error("Native plugin is not accepting requests");
    signal?.throwIfAborted();
    const cancellation = new AbortController();
    const combined = signal ? AbortSignal.any([signal, cancellation.signal]) : cancellation.signal;
    const release = options.scope.own("task", { dispose: () => cancellation.abort() });
    try {
      const input = activationSchema.parse(activation) as PluginActivation;
      const process = await processFor(entryId);
      combined.throwIfAborted();
      if (options.scope.state !== "active")
        throw new Error("Stale native plugin request after initialization");
      const result = await process.call(type, input, combined);
      if (options.scope.state !== "active" || !options.scope.accepts(options.scope.owner))
        throw new Error("Stale native plugin business response");
      return result;
    } finally {
      await release();
    }
  };
  const runtime: NativePluginRuntime = {
    get pid() {
      return [...processes.values()][0]?.pid;
    },
    async checkStartup() {
      await processFor(defaultEntry());
    },
    async activate(activation) {
      return this.request(defaultEntry(), activation);
    },
    async query(activation, signal) {
      signal?.throwIfAborted();
      const controller = new AbortController();
      queryControllers.add(controller);
      try {
        return await scopedCall(
          "query",
          defaultEntry(),
          activation,
          signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        );
      } finally {
        queryControllers.delete(controller);
      }
    },
    async request(entryId, activation, signal) {
      return scopedCall("activate", entryId, activation, signal);
    },
    async prepareStop(reason) {
      for (const controller of queryControllers) controller.abort();
      await Promise.allSettled(starting.values());
      for (const [id, process] of processes) {
        if (forgetFailedStartup(id, process)) continue;
        const decision = await process.prepareStop(reason);
        if (!decision.ok) return decision;
      }
      return { ok: true };
    },
    async dispose() {
      for (const process of processes.values()) await process.dispose();
      disposed = true;
      processes.clear();
    },
  };
  options.scope.own("process", {
    prepareStop: (reason) => runtime.prepareStop(reason),
    dispose: () => runtime.dispose(),
  });
  return runtime;
}

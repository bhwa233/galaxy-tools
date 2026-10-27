import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { z } from "zod";
import { atomicWrite, confined } from "./persistence.js";

export interface ContextPanelNativeConfig {
  enabled: boolean;
  button: "middle" | "x1" | "x2";
  /** Zero observes a click; positive values observe a hold. Original input always continues. */
  holdMs: number;
  excludedApps: string[];
  copyFallback?: boolean;
}
export interface ContextPanelNativeTrigger {
  sourceToken: string;
  sourceApp: string;
  /** Physical screen coordinates; the host converts these to DIP. */
  point: { x: number; y: number };
}
const reasons = [
  "unavailable",
  "disabled",
  "cancelled",
  "timeout",
  "busy",
  "sourceChanged",
  "focusChanged",
  "protectedSource",
  "emptySelection",
  "tooLarge",
  "unsupported",
  "inputBusy",
  "inputRejected",
  "clipboardUnavailable",
  "clipboardBusy",
  "clipboardUnchanged",
  "clipboardOwnerChanged",
] as const;
export type ContextPanelNativeReason = (typeof reasons)[number];
export type ContextPanelNativeCapture =
  | { kind: "none"; reason: ContextPanelNativeReason }
  | {
      kind: "text";
      text: string;
      sourceToken: string;
      sourceApp: string;
      method: "uia" | "clipboard";
    }
  | {
      kind: "image";
      file: string;
      bytes: number;
      sourceToken: string;
      sourceApp: string;
      method: "clipboard";
    }
  | { kind: "files"; paths: string[]; sourceToken: string; sourceApp: string; method: "clipboard" };
export interface ContextPanelNativeDriver {
  capture(
    sourceToken: string,
    requestId: string,
    signal?: AbortSignal,
  ): Promise<ContextPanelNativeCapture>;
  restoreSource(sourceToken: string): Promise<{ ok: boolean; reason?: ContextPanelNativeReason }>;
  update(config: ContextPanelNativeConfig): Promise<void>;
  /** Resolves only after the owned helper has actually closed. */
  stop(): Promise<void>;
}
export interface ContextPanelNativeOptions {
  /** Directory containing ContextPanelHelper.cs, not its parent. */
  assetDirectory: string;
  cacheDirectory: string;
  config: ContextPanelNativeConfig;
  onTrigger: (trigger: ContextPanelNativeTrigger) => void | Promise<void>;
  onError?: (error: Error) => void;
  /** Test-only own data. Native fixture mode never hooks, uses UIA, or touches clipboard/input. */
  fixture?: { file: string };
}

const FRAME = 262144,
  IMAGE = 8 * 1024 * 1024;
const uuid = z.string().uuid();
const appName = z
  .string()
  .min(1)
  .max(260)
  .refine((s) => !/[\\/\p{Cc}]/u.test(s));
const identity = { sourceToken: uuid, sourceApp: appName };
const captureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("none"), reason: z.enum(reasons) }).strict(),
  z
    .object({
      kind: z.literal("text"),
      text: z
        .string()
        .max(65536)
        .refine((s) => Buffer.byteLength(s, "utf8") <= 65536),
      ...identity,
      method: z.enum(["uia", "clipboard"]),
    })
    .strict(),
  z
    .object({
      kind: z.literal("image"),
      file: z.string().max(32768),
      bytes: z.number().int().positive().max(IMAGE),
      ...identity,
      method: z.literal("clipboard"),
    })
    .strict(),
  z
    .object({
      kind: z.literal("files"),
      paths: z
        .array(z.string().min(1).max(32768))
        .min(1)
        .max(100)
        .refine((a) => a.reduce((n, s) => n + s.length, 0) <= 65536),
      ...identity,
      method: z.literal("clipboard"),
    })
    .strict(),
]);
const configSchema = z
  .object({
    enabled: z.boolean(),
    button: z.enum(["middle", "x1", "x2"]),
    holdMs: z.number().int().min(0).max(2000),
    excludedApps: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .refine((s) => !/\p{Cc}/u.test(s)),
      )
      .max(100),
    copyFallback: z.boolean().optional().default(false),
  })
  .strict();
const envelope = { v: z.literal(1), sessionId: uuid };
const frameSchema = z.discriminatedUnion("type", [
  z.object({ ...envelope, type: z.literal("ready") }).strict(),
  z
    .object({
      ...envelope,
      type: z.literal("trigger"),
      ...identity,
      point: z
        .object({
          x: z.number().int().min(-1000000).max(1000000),
          y: z.number().int().min(-1000000).max(1000000),
        })
        .strict(),
    })
    .strict(),
  z
    .object({ ...envelope, type: z.literal("response"), requestId: uuid, result: z.unknown() })
    .strict(),
]);
type Pending = {
  resolve: (value: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
};
type Running = {
  child: ChildProcessWithoutNullStreams;
  session: string;
  spool: string;
  pending: Map<string, Pending>;
  closed: Promise<void>;
  dead: boolean;
  termination?: Promise<void>;
  captureTail: Promise<void>;
  captureCount: number;
};
const none = (reason: ContextPanelNativeReason): ContextPanelNativeCapture => ({
  kind: "none",
  reason,
});

// Reuse windows.ts's in-box compiler and persistence.ts's atomic/confinement
// primitives. No installed package exposes the required HWND/process-lifetime
// and fresh-clipboard owner checks; this driver only owns the helper protocol.
export async function startContextPanelNative(
  options: ContextPanelNativeOptions,
): Promise<ContextPanelNativeDriver> {
  let config = configSchema.parse(options.config);
  let running: Running | undefined;
  let stopped = false;
  let transitioning = false;
  let lifecycle: Promise<void> = Promise.resolve();
  const closing = new Set<Promise<void>>();
  const notify = () => {
    try {
      options.onError?.(new Error("Context panel helper unavailable"));
    } catch {
      /* Observer cannot break cleanup. */
    }
  };
  const safeDirectory = (directory: string) => {
    fs.mkdirSync(directory, { recursive: true });
    // A cache/session must never silently become a junction to another data domain.
    for (let current = path.resolve(directory); ; current = path.dirname(current)) {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error("Context panel cache unavailable");
      if (path.dirname(current) === current) break;
    }
    if (!fs.statSync(directory).isDirectory()) throw new Error("Context panel cache unavailable");
  };
  const settle = (state: Running, id: string, value: unknown) => {
    const pending = state.pending.get(id);
    if (!pending) return;
    state.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(value);
  };
  const write = (state: Running, type: string, id: string, extra: Record<string, unknown> = {}) => {
    if (state.dead || !state.child.stdin.writable) return false;
    const data =
      JSON.stringify({ v: 1, sessionId: state.session, type, requestId: id, ...extra }) + "\n";
    if (Buffer.byteLength(data) > FRAME) return false;
    return state.child.stdin.write(data);
  };
  const terminate = (state: Running): Promise<void> => {
    if (state.termination) return state.termination;
    const work = (async () => {
      if (running === state) running = undefined;
      // Fence callbacks before native closes its hook, then await actual close.
      if (!state.dead) {
        try {
          write(state, "stop", randomUUID());
        } catch {
          /* Force-close still runs below. */
        }
      }
      state.dead = true;
      for (const id of state.pending.keys()) settle(state, id, undefined);
      const force = setTimeout(() => {
        state.child.kill();
      }, 800);
      try {
        await state.closed;
      } finally {
        clearTimeout(force);
        try {
          fs.rmSync(state.spool, { recursive: true, force: true });
        } catch {
          notify();
        }
      }
    })();
    state.termination = work;
    closing.add(work);
    void work.finally(() => closing.delete(work)).catch(notify);
    return work;
  };
  const fail = (state: Running) => {
    if (state.dead) return;
    // Fence the failed helper before notifying Core: onError can synchronously
    // abort its capture, and that abort must not schedule a replacement helper.
    const closed = terminate(state);
    notify();
    void closed.catch(notify);
  };
  const request = (
    state: Running,
    type: string,
    id: string,
    extra: Record<string, unknown> = {},
    timeout = 2500,
  ): Promise<unknown> => {
    if (state.dead || state.pending.size >= 16 || state.pending.has(id))
      return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        settle(state, id, undefined);
        fail(state);
      }, timeout);
      state.pending.set(id, { resolve, timer });
      try {
        write(state, type, id, extra);
      } catch {
        settle(state, id, undefined);
        fail(state);
      }
    });
  };
  const compile = async () => {
    safeDirectory(options.cacheDirectory);
    const sourceFile = path.join(options.assetDirectory, "ContextPanelHelper.cs");
    if (fs.lstatSync(sourceFile).isSymbolicLink() || !fs.statSync(sourceFile).isFile())
      throw new Error("Context panel source unavailable");
    const source = fs.readFileSync(sourceFile);
    const hash = createHash("sha256").update(source).digest("hex");
    const exe = confined(options.cacheDirectory, `context-panel-${hash}.exe`);
    const sourceCopy = confined(options.cacheDirectory, `context-panel-${hash}.cs`);
    if (fs.existsSync(exe)) {
      if (
        fs.lstatSync(exe).isSymbolicLink() ||
        !fs.statSync(exe).isFile() ||
        !fs.existsSync(sourceCopy) ||
        fs.lstatSync(sourceCopy).isSymbolicLink() ||
        !fs.readFileSync(sourceCopy).equals(source)
      )
        throw new Error("Context panel cache unavailable");
      return exe;
    }
    atomicWrite(sourceCopy, source);
    const framework = path.join(
      process.env.WINDIR || "C:\\Windows",
      "Microsoft.NET",
      "Framework64",
      "v4.0.30319",
    );
    const temporary = confined(options.cacheDirectory, `context-panel-${randomUUID()}.exe`);
    try {
      await new Promise<void>((resolve, reject) =>
        execFile(
          path.join(framework, "csc.exe"),
          [
            "/nologo",
            "/optimize+",
            "/target:exe",
            `/out:${temporary}`,
            "/reference:System.Web.Extensions.dll",
            "/reference:System.Windows.Forms.dll",
            "/reference:System.Drawing.dll",
            `/reference:${path.join(framework, "WPF", "UIAutomationClient.dll")}`,
            `/reference:${path.join(framework, "WPF", "UIAutomationTypes.dll")}`,
            `/reference:${path.join(framework, "WPF", "WindowsBase.dll")}`,
            sourceCopy,
          ],
          { windowsHide: true, timeout: 30000, maxBuffer: 65536 },
          (error) => (error ? reject(new Error("Context panel compile failed")) : resolve()),
        ),
      );
      fs.renameSync(temporary, exe);
      return exe;
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  };
  const launch = async () => {
    if (stopped || !config.enabled || running) return;
    if (process.platform !== "win32") throw new Error("Context panel requires Windows");
    await Promise.all(closing);
    if (stopped || !config.enabled || running) return;
    const exe = await compile();
    if (stopped || !config.enabled) return;
    const session = randomUUID();
    const spool = confined(options.cacheDirectory, `session-${session}`);
    const args = [String(process.pid), session, spool];
    if (options.fixture) {
      const file = confined(
        options.cacheDirectory,
        path.relative(options.cacheDirectory, path.resolve(options.fixture.file)),
      );
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > FRAME)
        throw new Error("Context panel fixture unavailable");
      args.push("--fixture", file);
    }
    safeDirectory(spool);
    const child = spawn(exe, args, {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      cwd: options.cacheDirectory,
    });
    let closeResolve!: () => void;
    const state: Running = {
      child,
      session,
      spool,
      pending: new Map(),
      closed: new Promise<void>((resolve) => {
        closeResolve = resolve;
      }),
      dead: false,
      captureTail: Promise.resolve(),
      captureCount: 0,
    };
    running = state;
    let readyResolve!: () => void, readyReject!: () => void;
    const ready = new Promise<void>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = () => reject(new Error("Context panel startup failed"));
    });
    const readyTimer = setTimeout(() => {
      readyReject();
      fail(state);
    }, 5000);
    let bytes = Buffer.alloc(0);
    child.stdin.on("error", () => fail(state));
    child.stderr.on("data", () => {
      /* Drain only. Native text is never logged or exposed. */
    });
    child.stdout.on("data", (chunk: Buffer) => {
      if (state.dead || running !== state) return;
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > FRAME * 2) {
        fail(state);
        return;
      }
      let end: number;
      while ((end = bytes.indexOf(10)) >= 0) {
        const line = bytes.subarray(0, end);
        bytes = bytes.subarray(end + 1);
        if (line.length > FRAME) {
          fail(state);
          return;
        }
        let frame: z.infer<typeof frameSchema>;
        try {
          frame = frameSchema.parse(
            JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line)),
          );
        } catch {
          fail(state);
          return;
        }
        if (frame.sessionId !== session) {
          fail(state);
          return;
        }
        if (frame.type === "ready") {
          clearTimeout(readyTimer);
          readyResolve();
        } else if (frame.type === "response") settle(state, frame.requestId, frame.result);
        else if (config.enabled && !stopped) {
          const trigger = {
            sourceToken: frame.sourceToken,
            sourceApp: frame.sourceApp,
            point: frame.point,
          };
          setImmediate(() => {
            if (running !== state || state.dead || transitioning || stopped || !config.enabled)
              return;
            try {
              void Promise.resolve(options.onTrigger(trigger)).catch(notify);
            } catch {
              notify();
            }
          });
        }
      }
      if (bytes.length > FRAME) fail(state);
    });
    child.once("error", () => {
      readyReject();
      fail(state);
    });
    child.once("close", () => {
      clearTimeout(readyTimer);
      readyReject();
      closeResolve();
      if (!state.dead) {
        state.dead = true;
        if (running === state) running = undefined;
        notify();
      }
      for (const id of state.pending.keys()) settle(state, id, undefined);
      try {
        fs.rmSync(spool, { recursive: true, force: true });
      } catch {
        notify();
      }
    });
    try {
      await ready;
      const result = await request(state, "init", randomUUID(), { config });
      if (
        !z
          .object({ ok: z.literal(true) })
          .strict()
          .safeParse(result).success ||
        state.dead
      )
        throw new Error("Context panel configuration failed");
    } catch {
      await terminate(state);
      throw new Error("Context panel startup failed");
    }
  };
  const serialize = (work: () => Promise<void>) => {
    transitioning = true;
    const next = lifecycle.catch(() => {}).then(work);
    lifecycle = next;
    void next
      .finally(() => {
        if (lifecycle === next) transitioning = false;
      })
      .catch(() => {});
    return next;
  };
  // Native has one capture worker. Cancellation waits for that worker's actual
  // response (not just the cancel acknowledgement) before another request enters.
  // A hung provider still expires at the RPC deadline and retires this helper;
  // only a later explicit update may start another one.
  const captureSlot = async (
    state: Running,
    work: () => Promise<ContextPanelNativeCapture>,
  ): Promise<ContextPanelNativeCapture> => {
    if (state.captureCount >= 16) return none("busy");
    ++state.captureCount;
    const previous = state.captureTail;
    let release!: () => void;
    state.captureTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      await previous;
      if (state.dead || running !== state) return none("sourceChanged");
      return await work();
    } finally {
      --state.captureCount;
      release();
    }
  };
  const driver: ContextPanelNativeDriver = {
    async capture(sourceToken, requestId, signal) {
      if (signal?.aborted) return none("cancelled");
      if (!uuid.safeParse(sourceToken).success || !uuid.safeParse(requestId).success)
        return none("sourceChanged");
      const state = running;
      if (stopped || !config.enabled) return none("disabled");
      if (!state || state.dead || transitioning) return none("sourceChanged");
      return captureSlot(state, async () => {
        if (signal?.aborted) return none("cancelled");
        let aborted = false;
        const abort = () => {
          aborted = true;
          // Soft cancellation preserves other native source tokens. Keep waiting
          // for this capture response so the worker is drained before B starts.
          if (!state.dead) void request(state, "cancel", randomUUID(), { cancelId: requestId });
        };
        signal?.addEventListener("abort", abort, { once: true });
        try {
          const result = await request(state, "capture", requestId, { sourceToken });
          if (aborted || signal?.aborted) return none("cancelled");
          if (state.dead || running !== state) return none("unavailable");
          const parsed = captureSchema.safeParse(result);
          if (!parsed.success) {
            fail(state);
            return none("unavailable");
          }
          const value = parsed.data;
          if (value.kind !== "none" && value.sourceToken !== sourceToken) {
            fail(state);
            return none("sourceChanged");
          }
          if (value.kind === "image") {
            try {
              safeDirectory(state.spool);
              const expected = confined(state.spool, `image-${requestId}.png`);
              if (path.resolve(value.file) !== expected) throw new Error();
              const stat = fs.lstatSync(expected);
              if (
                !stat.isFile() ||
                stat.isSymbolicLink() ||
                stat.size !== value.bytes ||
                stat.size > IMAGE
              )
                throw new Error();
              const fd = fs.openSync(expected, "r");
              try {
                const magic = Buffer.alloc(8);
                fs.readSync(fd, magic, 0, 8, 0);
                if (!magic.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
                  throw new Error();
              } finally {
                fs.closeSync(fd);
              }
            } catch {
              fail(state);
              return none("unavailable");
            }
          }
          return value;
        } finally {
          signal?.removeEventListener("abort", abort);
        }
      });
    },
    async restoreSource(sourceToken) {
      const state = running;
      if (!state || state.dead || stopped || transitioning || !uuid.safeParse(sourceToken).success)
        return { ok: false, reason: "sourceChanged" };
      const result = await request(state, "restore", randomUUID(), { sourceToken });
      const parsed = z
        .object({ ok: z.boolean(), reason: z.enum(reasons).optional() })
        .strict()
        .safeParse(result);
      return parsed.success && !state.dead ? parsed.data : { ok: false, reason: "unavailable" };
    },
    update(next) {
      const checked = configSchema.parse(next);
      return serialize(async () => {
        if (stopped) throw new Error("Context panel stopped");
        config = checked;
        if (running) await terminate(running);
        await launch();
      });
    },
    stop() {
      stopped = true;
      return serialize(async () => {
        if (running) await terminate(running);
        await Promise.all(closing);
      });
    },
  };
  await serialize(launch);
  return driver;
}

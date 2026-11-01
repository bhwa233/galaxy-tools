import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { InterfaceFrame, TrafficCoverage, TrafficSnapshot } from "./traffic-contract.js";
export type { InterfaceFrame } from "./traffic-contract.js";

// Reuse Windows' maintained .NET/IP Helper counters and one serialized collector.
// Node os.networkInterfaces has no byte counters; the installed UI/SDK does not
// provide them. This adapter only owns baselines, coverage and process lifetime.
export class InterfaceRates {
  private previous?: InterfaceFrame;
  private rxSeries: number[] = [];
  private txSeries: number[] = [];
  readonly epoch = randomUUID();
  reset(): void {
    this.previous = undefined;
    this.rxSeries = [];
    this.txSeries = [];
  }
  ingest(frame: InterfaceFrame): TrafficSnapshot {
    const previous = this.previous;
    this.previous = frame;
    const intervalMs = previous ? frame.elapsedMs - previous.elapsedMs : null;
    const wallInterval = previous ? frame.at - previous.at : null;
    let coverage: TrafficCoverage = "warming";
    let rx: number | null = null,
      tx: number | null = null;
    if (!frame.adapters.length) coverage = "unavailable";
    else if (
      previous &&
      intervalMs &&
      intervalMs >= 200 &&
      intervalMs <= 5000 &&
      wallInterval !== null &&
      wallInterval >= 200 &&
      wallInterval <= 5000 &&
      Math.abs(wallInterval - intervalMs) <= 2000
    ) {
      const old = new Map(previous.adapters.map((adapter) => [adapter.id, adapter]));
      if (
        old.size !== frame.adapters.length ||
        frame.adapters.some(
          (adapter) =>
            !old.has(adapter.id) ||
            old.get(adapter.id)!.index !== adapter.index ||
            old.get(adapter.id)!.addresses.join() !== adapter.addresses.join() ||
            BigInt(adapter.rx) < BigInt(old.get(adapter.id)!.rx) ||
            BigInt(adapter.tx) < BigInt(old.get(adapter.id)!.tx),
        )
      ) {
        coverage = "gap";
      } else {
        const rxDelta = frame.adapters.reduce(
          (sum, adapter) => sum + BigInt(adapter.rx) - BigInt(old.get(adapter.id)!.rx),
          0n,
        );
        const txDelta = frame.adapters.reduce(
          (sum, adapter) => sum + BigInt(adapter.tx) - BigInt(old.get(adapter.id)!.tx),
          0n,
        );
        if (
          rxDelta <= BigInt(Number.MAX_SAFE_INTEGER) &&
          txDelta <= BigInt(Number.MAX_SAFE_INTEGER)
        ) {
          rx = (Number(rxDelta) * 1000) / intervalMs;
          tx = (Number(txDelta) * 1000) / intervalMs;
          coverage = "complete";
        } else coverage = "gap";
      }
    } else if (previous) coverage = "gap";
    if (coverage === "complete") {
      this.rxSeries = [...this.rxSeries.slice(-29), rx!];
      this.txSeries = [...this.txSeries.slice(-29), tx!];
    } else {
      this.rxSeries = [];
      this.txSeries = [];
    }
    return {
      source: "interface-totals",
      scope: "active-physical-adapters",
      collectorEpoch: this.epoch,
      coverage,
      at: frame.at,
      intervalMs,
      rxBytesPerSecond: rx,
      txBytesPerSecond: tx,
      adapters: frame.adapters,
      rxSeries: this.rxSeries,
      txSeries: this.txSeries,
    };
  }
}

function parseFrame(value: unknown): InterfaceFrame {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid counter frame");
  const frame = value as InterfaceFrame;
  if (
    !Number.isSafeInteger(frame.at) ||
    !Number.isSafeInteger(frame.elapsedMs) ||
    frame.elapsedMs < 0 ||
    !Array.isArray(frame.adapters) ||
    frame.adapters.length > 64
  )
    throw new Error("Invalid counter frame");
  const ids = new Set<string>();
  for (const adapter of frame.adapters) {
    if (
      !adapter ||
      typeof adapter !== "object" ||
      typeof adapter.id !== "string" ||
      adapter.id.length > 80 ||
      ids.has(adapter.id) ||
      !Number.isSafeInteger(adapter.index) ||
      adapter.index < 0 ||
      typeof adapter.name !== "string" ||
      adapter.name.length > 256 ||
      typeof adapter.description !== "string" ||
      adapter.description.length > 512 ||
      !Array.isArray(adapter.addresses) ||
      adapter.addresses.length > 32 ||
      adapter.addresses.some((address) => typeof address !== "string" || address.length > 128) ||
      !/^\d{1,20}$/.test(adapter.rx) ||
      !/^\d{1,20}$/.test(adapter.tx)
    )
      throw new Error("Invalid adapter counters");
    ids.add(adapter.id);
  }
  return frame;
}

export class TrafficSampler {
  private child?: ChildProcessWithoutNullStreams;
  private rates = new InterfaceRates();
  private stopping?: Promise<void>;
  private check?: ReturnType<typeof setInterval>;
  private lastFrame = 0;
  private retryAt = 0;
  private retries = 0;
  private enabled = false;
  private latest: TrafficSnapshot = this.empty("warming");
  constructor(private readonly publish: (snapshot: TrafficSnapshot) => void) {}
  get pid(): number | undefined {
    return this.child?.pid;
  }
  snapshot(): TrafficSnapshot {
    return structuredClone(this.latest);
  }
  private empty(coverage: TrafficCoverage, message?: string): TrafficSnapshot {
    return {
      source: "interface-totals",
      scope: "active-physical-adapters",
      collectorEpoch: this.rates.epoch,
      coverage,
      at: Date.now(),
      intervalMs: null,
      rxBytesPerSecond: null,
      txBytesPerSecond: null,
      adapters: [],
      rxSeries: [],
      txSeries: [],
      ...(message ? { message } : {}),
    };
  }
  private state(snapshot: TrafficSnapshot): void {
    this.latest = snapshot;
    this.publish(this.snapshot());
  }
  start(): void {
    if (this.enabled) return;
    this.enabled = true;
    this.retries = 0;
    this.launch();
    this.check = setInterval(() => {
      if (!this.enabled) return;
      if (this.child && Date.now() - this.lastFrame > 10000) {
        this.state(this.empty("unavailable", "Counter collector stopped responding"));
        this.child.kill();
      } else if (!this.child && this.retryAt && Date.now() >= this.retryAt) this.launch();
    }, 1000);
    this.check.unref();
  }
  private launch(): void {
    if (!this.enabled || this.child) return;
    this.rates = new InterfaceRates();
    this.state(this.empty("warming"));
    this.lastFrame = Date.now();
    this.retryAt = 0;
    const executable = path.join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32/WindowsPowerShell/v1.0/powershell.exe",
    );
    const child = spawn(
      executable,
      [
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        fileURLToPath(new URL("./collector.ps1", import.meta.url)),
        "-OwnerProcessId",
        String(process.pid),
      ],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    this.child = child;
    let buffer = "",
      errorText = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (text: string) => {
      errorText = (errorText + text).slice(-512);
    });
    child.stdout.on("data", (text: string) => {
      buffer += text;
      if (buffer.length > 128 * 1024) {
        child.kill();
        return;
      }
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const value: unknown = JSON.parse(line);
          this.lastFrame = Date.now();
          if (value && typeof value === "object" && "error" in value) {
            this.rates.reset();
            this.state(this.empty("unavailable", String(value.error).slice(0, 512)));
          } else {
            const snapshot = this.rates.ingest(parseFrame(value));
            this.retries = 0;
            this.state(snapshot);
          }
        } catch (error) {
          this.rates.reset();
          this.state(this.empty("unavailable", String(error).slice(0, 512)));
        }
      }
    });
    child.on("error", (error) => {
      errorText = error.message;
    });
    child.once("close", () => {
      if (this.child !== child) return;
      this.child = undefined;
      if (this.enabled) {
        this.state(this.empty("unavailable", errorText || "Counter collector exited"));
        this.retryAt = ++this.retries <= 3 ? Date.now() + [1000, 3000, 10000][this.retries - 1] : 0;
      }
    });
  }
  async stop(paused = false): Promise<void> {
    this.enabled = false;
    clearInterval(this.check);
    this.check = undefined;
    this.retryAt = 0;
    const child = this.child;
    if (!child) {
      if (paused) this.state(this.empty("paused"));
      return;
    }
    if (!this.stopping)
      this.stopping = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Counter collector did not exit")), 4000);
        child.once("close", () => {
          clearTimeout(timer);
          resolve();
        });
        child.kill();
      }).finally(() => {
        this.stopping = undefined;
      });
    await this.stopping;
    this.rates.reset();
    if (paused) this.state(this.empty("paused"));
  }
}

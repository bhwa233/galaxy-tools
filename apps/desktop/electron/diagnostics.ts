import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import semver from "semver";
import { z } from "zod";
import {
  DIAGNOSTIC_LEVELS,
  DIAGNOSTIC_KINDS,
  DIAGNOSTIC_CODES,
  DIAGNOSTIC_ERROR_CODES,
  type DiagnosticEntry,
  type DiagnosticEvent,
  type DiagnosticOwner,
  type DiagnosticKind,
  type DiagnosticFilter,
  type DiagnosticSnapshot,
  type DiagnosticBatch,
  type DiagnosticDropped,
  type DiagnosticExport,
  type DiagnosticLimits,
  type DiagnosticErrorCode,
} from "../src/features/diagnostics/types.js";

export type * from "../src/features/diagnostics/types.js";

/** Only fixed codes cross this boundary. Error text and coercion are never read. */
export function diagnosticErrorCode(error: unknown): DiagnosticErrorCode {
  try {
    if (!error || typeof error !== "object") return "unknownFailure";
    const value = error as { code?: unknown; name?: unknown };
    const code = value.code;
    switch (code) {
      case "pluginSaveRefused":
        return "saveRefused";
      case "pluginRecoveryRequired":
      case "backupRecoveryRequired":
        return "recoveryRequired";
      case "permissionDenied":
      case "EACCES":
      case "EPERM":
        return "permissionDenied";
      case "pluginDisabled":
      case "pluginStopping":
      case "pluginBusy":
      case "pluginStarting":
        return "unavailable";
      case "EINTEGRITY":
        return "integrityMismatch";
      case "ETIMEDOUT":
        return "timeout";
      case "ECONNRESET":
      case "ECONNREFUSED":
        return "networkFailure";
      case "incompatiblePlugin":
        return "incompatible";
      case "invalidPlugin":
      case "invalidData":
        return "invalidData";
      case "EPROTO":
        return "protocolFailure";
    }
    const name = value.name;
    if (name === "TimeoutError") return "timeout";
    if (name === "ZodError") return "invalidData";
  } catch {}
  return "unknownFailure";
}

const LIMITS: Readonly<DiagnosticLimits> = Object.freeze({
  historyEntries: 1000,
  historyBytes: 2 * 1024 * 1024,
  queueEntries: 256,
  queueBytes: 512 * 1024,
  diskFiles: 3,
  diskFileBytes: 2 * 1024 * 1024,
  entryBytes: 2048,
  subscribers: 16,
  outputGroups: 64,
  batchEntries: 100,
  batchIntervalMs: 200,
});
const maximumNumber = Number.MAX_SAFE_INTEGER;
const number = z
  .number()
  .finite()
  .transform((value) => Math.min(maximumNumber, Math.max(0, Math.trunc(value))));
const pluginId = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const version = z
  .string()
  .max(128)
  .refine((value) => semver.valid(value) === value);
const target = z.strictObject({ pluginId, version });
const owner = target.extend({ instanceId: z.uuid() });
const eventSchema = z.strictObject({
  kind: z.enum(DIAGNOSTIC_KINDS),
  code: z.enum(DIAGNOSTIC_CODES),
  level: z.enum(DIAGNOSTIC_LEVELS),
  owner: owner.optional(),
  target: target.optional(),
  taskId: z.uuid().optional(),
  durationMs: number.transform((value) => Math.min(value, 86_400_000)).optional(),
  byteCount: number.optional(),
  count: number.optional(),
  stream: z.enum(["stdout", "stderr"]).optional(),
  errorCode: z.enum(DIAGNOSTIC_ERROR_CODES).optional(),
});
const storedSchema = eventSchema
  .extend({
    epoch: z.uuid(),
    sequence: z
      .number()
      .int()
      .min(1)
      .max(maximumNumber - 1),
    at: z.number().int().nonnegative().safe(),
    source: z.enum(["host", "plugin"]),
  })
  .refine((value) => value.source === (value.owner || value.target ? "plugin" : "host"));
const filterSchema = z.strictObject({
  source: z.enum(["host", "plugin"]).optional(),
  pluginId: pluginId.optional(),
  levels: z.array(z.enum(DIAGNOSTIC_LEVELS)).max(4).optional(),
  from: number.optional(),
  to: number.optional(),
  afterSequence: number.optional(),
  limit: number.transform((value) => Math.min(LIMITS.historyEntries, value)).optional(),
});
const dropped = (): DiagnosticDropped => ({
  invalid: 0,
  history: 0,
  queue: 0,
  disk: 0,
  output: 0,
  subscribers: 0,
});
const sum = (a: number, b = 1) => Math.min(maximumNumber, a + b);
type Item = { entry: DiagnosticEntry; bytes: number; line: string };
type Subscriber = {
  callback: (batch: DiagnosticBatch) => void;
  sequence: number;
  epoch: string;
  droppedSignature: string;
};

/** Reuses fs, Zod and the existing owner identities. The private policy here is
 * fixed metadata admission and bounded retention; it never accepts arbitrary text. */
export class DiagnosticsStore {
  private readonly directory: string;
  private readonly files: string[];
  private epoch = randomUUID();
  private generation = 0;
  private sequence = 0;
  private history: Item[] = [];
  private historyBytes = 0;
  private queue: Item[] = [];
  private queueBytes = 0;
  private dropped = dropped();
  private diskStatus: "ready" | "unavailable" = "ready";
  private diskTail: Promise<void> = Promise.resolve();
  private writing?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;
  private subscribers = new Set<Subscriber>();
  private outputs = new Map<string, DiagnosticEvent>();
  private timer: ReturnType<typeof setInterval>;

  constructor(directory: string) {
    if (!path.isAbsolute(directory) || path.parse(directory).root === path.resolve(directory))
      throw new Error("Diagnostics requires a dedicated absolute directory");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(directory).isSymbolicLink() || !fs.lstatSync(directory).isDirectory())
      throw new Error("Diagnostics directory must be a real directory");
    this.directory = fs.realpathSync(directory);
    this.files = Array.from({ length: LIMITS.diskFiles }, (_, index) =>
      path.join(this.directory, `events.${index}.ndjson`),
    );
    this.guard();
    for (const file of [...this.files].reverse()) this.load(file);
    this.timer = setInterval(() => {
      this.flushOutputs();
      this.deliver();
      void this.flushDisk();
    }, LIMITS.batchIntervalMs);
    this.timer.unref();
  }

  private guard(): void {
    const info = fs.lstatSync(this.directory);
    if (
      info.isSymbolicLink() ||
      !info.isDirectory() ||
      fs.realpathSync(this.directory) !== this.directory
    )
      throw new Error("Diagnostics directory identity changed");
    for (const name of fs.readdirSync(this.directory)) {
      const file = path.join(this.directory, name);
      if (!this.files.includes(file)) throw new Error("Unexpected diagnostics directory entry");
      const stat = fs.lstatSync(file);
      if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1)
        throw new Error("Diagnostics requires unlinked regular files");
    }
  }

  private load(file: string): void {
    if (!fs.existsSync(file)) return;
    const info = fs.lstatSync(file);
    if (info.size > LIMITS.diskFileBytes)
      throw new Error("Diagnostics file exceeds the disk limit");
    const fd = fs.openSync(
      file,
      fs.constants.O_RDONLY | (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW),
    );
    try {
      const opened = fs.fstatSync(fd);
      if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino)
        throw new Error("Diagnostics file changed while opening");
      const buffer = Buffer.alloc(LIMITS.diskFileBytes + 1);
      let bytes = 0;
      while (bytes < buffer.length) {
        const size = fs.readSync(fd, buffer, bytes, buffer.length - bytes, bytes);
        if (!size) break;
        bytes += size;
      }
      if (bytes > LIMITS.diskFileBytes) throw new Error("Diagnostics file grew beyond its limit");
      for (const line of buffer.subarray(0, bytes).toString("utf8").split("\n")) {
        if (!line) continue;
        try {
          if (Buffer.byteLength(line) > LIMITS.entryBytes)
            throw new Error("Oversized diagnostic entry");
          const entry = storedSchema.parse(JSON.parse(line));
          if (entry.sequence <= this.sequence) throw new Error("Nonmonotonic diagnostic sequence");
          this.sequence = entry.sequence;
          this.remember({
            entry,
            line: JSON.stringify(entry) + "\n",
            bytes: Buffer.byteLength(JSON.stringify(entry)) + 1,
          });
        } catch {
          this.dropped.invalid = sum(this.dropped.invalid);
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  private remember(item: Item): void {
    this.history.push(item);
    this.historyBytes += item.bytes;
    while (this.history.length > LIMITS.historyEntries || this.historyBytes > LIMITS.historyBytes) {
      this.historyBytes -= this.history.shift()!.bytes;
      this.dropped.history = sum(this.dropped.history);
    }
  }

  record(value: unknown): boolean {
    try {
      if (this.closed) return false;
      const event = eventSchema.safeParse(value);
      if (!event.success || this.sequence >= maximumNumber - 1) {
        this.dropped.invalid = sum(this.dropped.invalid);
        return false;
      }
      const entry: DiagnosticEntry = {
        ...event.data,
        epoch: this.epoch,
        sequence: this.sequence + 1,
        at: Date.now(),
        source: event.data.owner || event.data.target ? "plugin" : "host",
      };
      const line = JSON.stringify(entry) + "\n",
        bytes = Buffer.byteLength(line);
      if (bytes > LIMITS.entryBytes) {
        this.dropped.invalid = sum(this.dropped.invalid);
        return false;
      }
      this.sequence = entry.sequence;
      const item = { entry, bytes, line };
      this.remember(item);
      if (this.diskStatus !== "ready") this.dropped.disk = sum(this.dropped.disk);
      else if (
        this.queue.length >= LIMITS.queueEntries ||
        this.queueBytes + bytes > LIMITS.queueBytes
      )
        this.dropped.queue = sum(this.dropped.queue);
      else {
        this.queue.push(item);
        this.queueBytes += bytes;
      }
      return true;
    } catch {
      this.dropped.invalid = sum(this.dropped.invalid);
      return false;
    }
  }

  output(
    value: DiagnosticOwner,
    stream: "stdout" | "stderr",
    byteCount: number,
    kind: DiagnosticKind = "backend",
  ): void {
    try {
      if (this.closed) return;
      const admitted = eventSchema.safeParse({
        owner: value,
        stream,
        byteCount,
        kind,
        level: stream === "stderr" ? "warn" : "info",
        code: "output",
        count: 1,
      });
      if (!admitted.success) {
        this.dropped.invalid = sum(this.dropped.invalid);
        return;
      }
      const event = admitted.data;
      const key = JSON.stringify([event.owner, stream, kind]);
      const previous = this.outputs.get(key);
      if (previous) {
        previous.byteCount = sum(previous.byteCount!, event.byteCount!);
        previous.count = sum(previous.count!);
      } else if (this.outputs.size >= LIMITS.outputGroups)
        this.dropped.output = sum(this.dropped.output);
      else this.outputs.set(key, event);
    } catch {
      this.dropped.invalid = sum(this.dropped.invalid);
    }
  }

  private flushOutputs(): void {
    const events = [...this.outputs.values()];
    this.outputs.clear();
    for (const event of events) this.record(event);
  }

  snapshot(filter: DiagnosticFilter = {}): DiagnosticSnapshot {
    this.flushOutputs();
    const parsed = filterSchema.parse(filter);
    const entries = this.history
      .map((item) => item.entry)
      .filter(
        (entry) =>
          (!parsed.source || entry.source === parsed.source) &&
          (!parsed.pluginId ||
            (entry.owner?.pluginId ?? entry.target?.pluginId) === parsed.pluginId) &&
          (!parsed.levels || parsed.levels.includes(entry.level)) &&
          (parsed.from === undefined || entry.at >= parsed.from) &&
          (parsed.to === undefined || entry.at <= parsed.to) &&
          (parsed.afterSequence === undefined || entry.sequence > parsed.afterSequence),
      );
    const selected = parsed.limit === undefined ? entries : entries.slice(0, parsed.limit);
    return structuredClone({
      epoch: this.epoch,
      entries: selected,
      firstSequence: this.history[0]?.entry.sequence ?? 0,
      lastSequence: this.sequence,
      dropped: this.dropped,
      limits: LIMITS,
      diskStatus: this.diskStatus,
    });
  }

  subscribe(callback: (batch: DiagnosticBatch) => void): () => void {
    if (this.closed) throw new Error("Diagnostics is closed");
    if (this.subscribers.size >= LIMITS.subscribers) {
      this.dropped.subscribers = sum(this.dropped.subscribers);
      throw new Error("Diagnostic subscription limit reached");
    }
    const subscriber = {
      callback,
      sequence: this.sequence,
      epoch: this.epoch,
      droppedSignature: JSON.stringify(this.dropped),
    };
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  }

  private deliver(): void {
    const generation = this.generation;
    for (const subscriber of this.subscribers) {
      if (generation !== this.generation) break;
      const reset = subscriber.epoch !== this.epoch;
      const cursor = reset ? 0 : subscriber.sequence;
      const snapshot = this.snapshot({ afterSequence: cursor, limit: LIMITS.batchEntries });
      if (
        !reset &&
        !snapshot.entries.length &&
        subscriber.droppedSignature === JSON.stringify(snapshot.dropped)
      )
        continue;
      const next = snapshot.entries.at(-1)?.sequence ?? snapshot.lastSequence;
      try {
        subscriber.callback({ ...snapshot, reset, cursor: next });
      } catch {
        this.dropped.subscribers = sum(this.dropped.subscribers);
      }
      if (generation === this.generation && this.subscribers.has(subscriber)) {
        subscriber.epoch = this.epoch;
        subscriber.sequence = next;
        subscriber.droppedSignature = JSON.stringify(this.dropped);
      }
    }
  }

  private flushDisk(): Promise<void> {
    if (this.writing) return this.writing;
    if (!this.queue.length) return this.diskTail;
    const items = this.queue.splice(0, LIMITS.batchEntries);
    for (const item of items) this.queueBytes -= item.bytes;
    const generation = this.generation;
    const operation = this.diskTail.then(async () => {
      if (generation !== this.generation) return;
      try {
        this.guard();
        const data = items.map((item) => item.line).join("");
        if (
          fs.existsSync(this.files[0]) &&
          fs.statSync(this.files[0]).size + Buffer.byteLength(data) > LIMITS.diskFileBytes
        ) {
          await fsp.rm(this.files.at(-1)!, { force: true });
          for (let i = this.files.length - 2; i >= 0; i--)
            if (fs.existsSync(this.files[i])) await fsp.rename(this.files[i], this.files[i + 1]);
        }
        this.guard();
        const file = await fsp.open(
          this.files[0],
          fs.constants.O_APPEND |
            fs.constants.O_CREAT |
            fs.constants.O_WRONLY |
            (process.platform === "win32" ? 0 : fs.constants.O_NOFOLLOW),
          0o600,
        );
        try {
          const stat = await file.stat();
          this.guard();
          if (
            !stat.isFile() ||
            stat.nlink !== 1 ||
            stat.size + Buffer.byteLength(data) > LIMITS.diskFileBytes
          )
            throw new Error("Unsafe diagnostic append");
          await file.writeFile(data);
        } finally {
          await file.close();
        }
      } catch {
        if (generation !== this.generation) return;
        this.diskStatus = "unavailable";
        this.dropped.disk = sum(this.dropped.disk, items.length + this.queue.length);
        this.queue = [];
        this.queueBytes = 0;
      }
    });
    const finished = operation.finally(() => {
      if (this.writing === finished) this.writing = undefined;
    });
    this.writing = finished;
    this.diskTail = finished;
    return finished;
  }

  async clear(): Promise<DiagnosticSnapshot> {
    if (this.closed) throw new Error("Diagnostics is closed");
    this.generation++;
    this.epoch = randomUUID();
    this.sequence = 0;
    this.history = [];
    this.historyBytes = 0;
    this.queue = [];
    this.queueBytes = 0;
    this.outputs.clear();
    this.dropped = dropped();
    const generation = this.generation;
    this.diskTail = this.diskTail.then(async () => {
      try {
        this.guard();
        for (const file of this.files) await fsp.rm(file, { force: true });
        if (generation === this.generation) this.diskStatus = "ready";
      } catch {
        if (generation === this.generation) {
          this.diskStatus = "unavailable";
          this.dropped.disk = sum(this.dropped.disk);
        }
      }
    });
    await this.diskTail;
    return this.snapshot();
  }

  export(filter: DiagnosticFilter = {}): string {
    const parsed = filterSchema.parse(filter);
    const value: DiagnosticExport = {
      schemaVersion: 1,
      generatedAt: Date.now(),
      filter: parsed,
      ...this.snapshot(parsed),
    };
    return JSON.stringify(value, null, 2);
  }

  async drain(): Promise<void> {
    this.flushOutputs();
    const sequence = this.sequence,
      generation = this.generation;
    await this.diskTail;
    while (
      generation === this.generation &&
      this.queue.length &&
      this.queue[0].entry.sequence <= sequence
    )
      await this.flushDisk();
  }

  shutdown(): Promise<void> {
    if (this.closing) return this.closing;
    this.flushOutputs();
    this.closed = true;
    clearInterval(this.timer);
    this.subscribers.clear();
    this.closing = this.drain();
    return this.closing;
  }
}

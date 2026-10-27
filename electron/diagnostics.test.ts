import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DiagnosticsStore,
  diagnosticErrorCode,
  type DiagnosticBatch,
  type DiagnosticOwner,
} from "./diagnostics.js";

const roots: string[] = [];
const stores: DiagnosticsStore[] = [];
const releases: (() => void)[] = [];
function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-diagnostics-"));
  roots.push(directory);
  const store = new DiagnosticsStore(directory);
  stores.push(store);
  return { directory, store };
}
function disk(directory: string) {
  return fs
    .readdirSync(directory)
    .map((name) => fs.readFileSync(path.join(directory, name), "utf8"))
    .join("");
}
const oldOwner: DiagnosticOwner = {
  pluginId: "fixture.diagnostics",
  version: "1.0.0",
  instanceId: randomUUID(),
};
const newOwner: DiagnosticOwner = { ...oldOwner, version: "2.0.0", instanceId: randomUUID() };
afterEach(async () => {
  for (const release of releases.splice(0)) release();
  for (const store of stores.splice(0)) await store.shutdown();
  vi.restoreAllMocks();
  vi.useRealTimers();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("bounded structured diagnostics", () => {
  it("rejects sensitive fields rather than redacting them, and aggregates only output counts under the captured owner", async () => {
    const { store, directory } = fixture();
    const event = { kind: "backend", code: "failed", level: "error", owner: oldOwner };
    const canaries = {
      message: "NOTE_BODY_CANARY_619",
      stack: "CLIPBOARD_CANARY_194",
      details: "sk-SECRET_CANARY_923",
      url: "https://user:password@example.invalid/private",
      query: "FULL_QUERY_CANARY_414",
    };
    for (const [field, value] of Object.entries(canaries))
      expect(store.record({ ...event, [field]: value })).toBe(false);
    expect(store.record({ ...event, owner: { ...oldOwner, apiKey: "NESTED_SECRET_122" } })).toBe(
      false,
    );
    expect(store.record({ ...event, errorCode: "UNTRUSTED_ERROR_TEXT_891" })).toBe(false);
    expect(store.record({ ...event, taskId: "NOT_A_HOST_UUID_118" })).toBe(false);
    expect(
      store.record({ ...event, errorCode: "timeout", durationMs: Number.MAX_SAFE_INTEGER }),
    ).toBe(true);
    store.output(oldOwner, "stderr", 120);
    store.output(oldOwner, "stderr", 80);
    store.output(newOwner, "stdout", 9);
    const exported = JSON.parse(store.export({ pluginId: oldOwner.pluginId }));
    expect(exported.schemaVersion).toBe(1);
    expect(
      exported.entries.find((entry: { errorCode?: string }) => entry.errorCode === "timeout")
        .durationMs,
    ).toBeLessThan(Number.MAX_SAFE_INTEGER);
    expect(
      exported.entries.filter((entry: { code: string }) => entry.code === "output"),
    ).toMatchObject([
      { owner: oldOwner, byteCount: 200, count: 2, stream: "stderr" },
      { owner: newOwner, byteCount: 9, count: 1, stream: "stdout" },
    ]);
    await store.drain();
    const retained = store.export() + disk(directory);
    for (const value of [
      ...Object.values(canaries),
      "NESTED_SECRET_122",
      "UNTRUSTED_ERROR_TEXT_891",
      "NOT_A_HOST_UUID_118",
    ])
      expect(retained).not.toContain(value);
    expect(store.snapshot({ levels: ["warn"], source: "plugin" }).entries).toMatchObject([
      { owner: oldOwner, code: "output" },
    ]);
    // A package has a verified target before its first runtime exists. It must
    // remain discoverable by plugin-source filters without inventing an owner.
    expect(
      store.record({
        kind: "package",
        code: "verifying",
        level: "info",
        target: { pluginId: oldOwner.pluginId, version: oldOwner.version },
      }),
    ).toBe(true);
    expect(
      store.snapshot({ source: "plugin", pluginId: oldOwner.pluginId }).entries.at(-1),
    ).toMatchObject({
      kind: "package",
      source: "plugin",
      target: { pluginId: oldOwner.pluginId, version: oldOwner.version },
    });
    expect(
      store
        .snapshot({ source: "host" })
        .entries.some((entry) => entry.target?.pluginId === oldOwner.pluginId),
    ).toBe(false);
    expect(store.snapshot().dropped.invalid).toBeGreaterThan(0);
    expect(
      diagnosticErrorCode({
        code: "EINTEGRITY",
        get message() {
          throw new Error("must not read text");
        },
      }),
    ).toBe("integrityMismatch");
    expect(
      diagnosticErrorCode({
        get code() {
          throw new Error("untrusted getter");
        },
      }),
    ).toBe("unknownFailure");
    expect(diagnosticErrorCode({ message: "ETIMEDOUT sk-SECRET" })).toBe("unknownFailure");
  });

  it("bounds a burst before disk drains, rotates real files, and refuses links or unrelated directory entries", async () => {
    const { store, directory } = fixture();
    const limits = store.snapshot().limits;
    for (let index = 0; index < limits.historyEntries + limits.queueEntries + 20; index++)
      store.record({ kind: "host", code: "completed", level: "info", count: index });
    expect(store.snapshot().entries.length).toBeLessThanOrEqual(limits.historyEntries);
    expect(store.snapshot().dropped.history).toBeGreaterThan(0);
    expect(store.snapshot().dropped.queue).toBeGreaterThan(0);
    await store.drain();
    const target = { pluginId: "fixture." + "a".repeat(72), version: "1.0.0-" + "a".repeat(120) };
    for (let batch = 0; batch < 70; batch++) {
      for (let index = 0; index < 200; index++)
        expect(
          store.record({
            kind: "package",
            code: "completed",
            level: "info",
            owner: { ...target, instanceId: oldOwner.instanceId },
            target,
            taskId: oldOwner.instanceId,
            byteCount: Number.MAX_SAFE_INTEGER,
            durationMs: 1234,
            count: index,
          }),
        ).toBe(true);
      await store.drain();
    }
    const files = fs.readdirSync(directory);
    expect(files.length).toBeGreaterThan(1);
    expect(files.length).toBeLessThanOrEqual(limits.diskFiles);
    for (const file of files)
      expect(fs.statSync(path.join(directory, file)).size).toBeLessThanOrEqual(
        limits.diskFileBytes,
      );
    expect(store.snapshot().entries.length).toBeLessThanOrEqual(limits.historyEntries);
    const unsafe = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-diagnostics-unsafe-"));
    roots.push(unsafe);
    const outside = path.join(unsafe, "retained.txt");
    fs.writeFileSync(outside, "must stay untouched");
    const linked = path.join(unsafe, "linked");
    fs.mkdirSync(linked);
    (process.platform === "win32" ? fs.linkSync : fs.symlinkSync)(
      outside,
      path.join(linked, "events.0.ndjson"),
    );
    expect(() => new DiagnosticsStore(linked)).toThrow();
    expect(() => new DiagnosticsStore(unsafe)).toThrow();
    expect(fs.readFileSync(outside, "utf8")).toBe("must stay untouched");
    const retained = store.snapshot().entries;
    await store.shutdown();
    const reopened = new DiagnosticsStore(directory);
    stores.push(reopened);
    expect(reopened.snapshot().entries).toEqual(retained);
    fs.unlinkSync(path.join(directory, "events.0.ndjson"));
    (process.platform === "win32" ? fs.linkSync : fs.symlinkSync)(
      outside,
      path.join(directory, "events.0.ndjson"),
    );
    reopened.record({ kind: "host", code: "failed", level: "error" });
    await reopened.drain();
    expect(reopened.snapshot().diskStatus).toBe("unavailable");
    expect(reopened.snapshot().dropped.disk).toBeGreaterThan(0);
    expect(fs.readFileSync(outside, "utf8")).toBe("must stay untouched");
    fs.unlinkSync(path.join(directory, "events.0.ndjson"));
  }, 15_000);

  it("fences clear against an actual pending append, batches cursors without skipping, and releases bounded subscribers", async () => {
    vi.useFakeTimers();
    const { store, directory } = fixture();
    const batches: DiagnosticBatch[] = [];
    const unlisten = store.subscribe((batch) => batches.push(batch));
    const bad = store.subscribe(() => {
      throw new Error("observer failure");
    });
    let release!: () => void, entered!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    releases.push(release);
    const opened = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = fsp.open.bind(fsp);
    let hold = true;
    vi.spyOn(fsp, "open").mockImplementation(async (...args: Parameters<typeof fsp.open>) => {
      const file = await original(...args);
      if (hold && args[0] === path.join(directory, "events.0.ndjson")) {
        hold = false;
        entered();
        await held;
      }
      return file;
    });
    store.record({ kind: "backend", code: "started", level: "info", owner: oldOwner });
    const oldEpoch = store.snapshot().epoch;
    const draining = store.drain();
    await opened;
    const clearing = store.clear();
    store.record({ kind: "backend", code: "completed", level: "info", owner: newOwner });
    release();
    await Promise.all([draining, clearing]);
    await store.drain();
    expect(store.snapshot().epoch).not.toBe(oldEpoch);
    expect(disk(directory)).not.toContain(oldEpoch);
    expect(store.snapshot().entries).toMatchObject([{ owner: newOwner }]);
    for (let index = 0; index < 101; index++)
      store.record({ kind: "host", code: "completed", level: "info", count: index });
    vi.advanceTimersByTime(200);
    expect(batches[0].reset).toBe(true);
    expect(batches[0].entries.length).toBeLessThanOrEqual(store.snapshot().limits.batchEntries);
    expect(batches[0].cursor).toBeLessThan(batches[0].lastSequence);
    vi.advanceTimersByTime(200);
    expect(batches.flatMap((batch) => batch.entries).length).toBe(102);
    expect(
      new Set(batches.flatMap((batch) => batch.entries.map((entry) => entry.sequence))).size,
    ).toBe(102);
    expect(store.snapshot().dropped.subscribers).toBeGreaterThan(0);
    const extras = Array.from({ length: store.snapshot().limits.subscribers - 2 }, () =>
      store.subscribe(() => {}),
    );
    expect(() => store.subscribe(() => {})).toThrow();
    unlisten();
    bad();
    for (const stop of extras) stop();
    const count = batches.length;
    store.record({ kind: "host", code: "completed", level: "info" });
    vi.advanceTimersByTime(400);
    expect(batches.length).toBe(count);
    await store.shutdown();
    expect(store.record({ kind: "host", code: "completed", level: "info" })).toBe(false);
  });
});

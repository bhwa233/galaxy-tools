import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, expect, test, vi } from "vitest";
import applicationsPlugin from "./backend.mjs";

const system = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock("node:child_process", () => system);
// Inventory queries below have no text, so no native pinyin matching is needed.
// Keep native executable resolution out of this filesystem/cache regression.
vi.mock("./pinyin.mjs", () => ({
  createPinyinMatcher: () => ({
    match: () => {
      throw new Error("Unexpected native pinyin query");
    },
    stop: async () => {},
  }),
}));

const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
let directory: string;
let backend: ReturnType<typeof applicationsPlugin> | undefined;
afterEach(async () => {
  try {
    await backend?.stop();
  } finally {
    backend = undefined;
    Object.defineProperty(process, "platform", platform);
    vi.unstubAllEnvs();
    vi.useRealTimers();
    system.execFile.mockReset();
    if (directory) fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("failed discovery retains complete source snapshots until an authoritative recovery confirms deletions", async () => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-applications-backend-"));
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date("2026-10-27T00:00:00Z"));
  Object.defineProperty(process, "platform", { ...platform, value: "win32" });
  vi.stubEnv("APPDATA", path.join(directory, "app-data"));
  vi.stubEnv("ProgramData", path.join(directory, "program-data"));
  vi.stubEnv("SystemRoot", path.join(directory, "system"));
  const userMenu = path.join(
    process.env.APPDATA!,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
  const commonMenu = path.join(
    process.env.ProgramData!,
    "Microsoft",
    "Windows",
    "Start Menu",
    "Programs",
  );
  const registered = {
    error: null as Error | null,
    records: [{ Name: "Registered old", AppID: "Synthetic.Package!Old" }],
  };
  system.execFile.mockImplementation(
    (
      _file: string,
      _args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => {
      const child = new EventEmitter();
      queueMicrotask(() => {
        callback(registered.error, JSON.stringify(registered.records));
        child.emit("close", registered.error ? 1 : 0);
      });
      return child;
    },
  );
  const lifetime = {
    dataDir: path.join(directory, "data"),
    cacheDir: path.join(directory, "cache"),
    signal: new AbortController().signal,
  };
  fs.mkdirSync(lifetime.dataDir);
  fs.mkdirSync(lifetime.cacheDir);
  // Start with absent roots so no real watcher is installed. The production
  // periodic calibration below owns invalidation, independent of OS event timing.
  backend = applicationsPlugin(lifetime);
  fs.mkdirSync(userMenu, { recursive: true });
  fs.mkdirSync(commonMenu, { recursive: true });
  fs.writeFileSync(path.join(userMenu, "User old.lnk"), "Synthetic shortcut; never launched");
  fs.writeFileSync(path.join(commonMenu, "Common old.lnk"), "Synthetic shortcut; never launched");
  const query = () => backend!.activate({ commandId: "search" }, lifetime);

  const complete = await query();
  expect(complete.inventoryState).toBe("complete");
  expect(complete.items.map((item) => item.title).sort()).toEqual([
    "Common old",
    "Registered old",
    "User old",
  ]);

  // A missing menu previously looked like an empty successful scan, silently
  // erasing its last complete cache. A process failure must retain its source too.
  fs.renameSync(userMenu, path.join(directory, "temporarily-unavailable-menu"));
  fs.unlinkSync(path.join(commonMenu, "Common old.lnk"));
  fs.writeFileSync(path.join(commonMenu, "Common new.lnk"), "Synthetic shortcut; never launched");
  registered.error = new Error("Synthetic registered-source outage");
  registered.records = [];
  vi.advanceTimersByTime(60_000);
  const stale = await query();
  expect(stale.items.map((item) => item.title).sort()).toEqual([
    "Common new",
    "Registered old",
    "User old",
  ]);
  expect(stale.inventoryState).toBe("stale");
  expect(stale.refreshedAt).toBe(complete.refreshedAt);
  expect(stale.lastAttemptAt).toBeGreaterThan(complete.lastAttemptAt);
  expect(stale.sourceStatus.menus.find((source) => source.root === userMenu)).toMatchObject({
    state: "stale",
    hasCompleteSnapshot: true,
  });
  expect(stale.sourceStatus.menus.find((source) => source.root === commonMenu)).toMatchObject({
    state: "complete",
  });
  expect(stale.sourceStatus.registeredApplications).toMatchObject({
    state: "stale",
    hasCompleteSnapshot: true,
  });
  expect(stale.warnings).not.toEqual([]);
  const attempts = system.execFile.mock.calls.length;
  const cached = await query();
  expect(cached.items).toEqual(stale.items);
  expect(cached.inventoryState).toBe("stale");
  expect(cached.refreshedAt).toBe(complete.refreshedAt);
  expect(system.execFile).toHaveBeenCalledTimes(attempts);

  // Only a readable, genuinely empty menu can confirm its former item's removal.
  fs.mkdirSync(userMenu, { recursive: true });
  registered.error = null;
  registered.records = [{ Name: "Registered new", AppID: "Synthetic.Package!New" }];
  vi.advanceTimersByTime(60_000);
  const recovered = await query();
  expect(recovered.items.map((item) => item.title).sort()).toEqual([
    "Common new",
    "Registered new",
  ]);
  expect(recovered.inventoryState).toBe("complete");
  expect(recovered.refreshedAt).toBeGreaterThan(complete.refreshedAt);
  expect(recovered.sourceStatus.menus.every((source) => source.state === "complete")).toBe(true);
  expect(recovered.sourceStatus.registeredApplications.state).toBe("complete");
  expect(recovered.warnings).toEqual([]);
});

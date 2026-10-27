import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HostPrivateDataRootsStore } from "./private-data-roots.js";

describe("private data root retention", () => {
  it("persists roots before draining search and preserves them after a failed drain", async () => {
    // Migration used to forget the retained old root and expose failed copies
    // to general content search. Registration must survive a restart and cannot
    // let the copy proceed until existing readers have acknowledged cancellation.
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-private-roots-"));
    const file = path.join(directory, "private-data-roots.json");
    const current = path.join(directory, "current");
    const destination = path.join(directory, "migration-destination");
    const failedCopy = path.join(directory, "failed-copy");
    try {
      const store = new HostPrivateDataRootsStore(file, [current]);
      let started!: () => void;
      let drained!: () => void;
      const entered = new Promise<void>((resolve) => {
        started = resolve;
      });
      const cancellation = new Promise<void>((resolve) => {
        drained = resolve;
      });
      const unsubscribe = store.subscribe(() => {
        started();
        return cancellation;
      });
      let completed = false;
      const registration = store.retain([destination]).then(() => {
        completed = true;
      });
      await entered;
      expect(completed).toBe(false);
      expect(new HostPrivateDataRootsStore(file, []).list()).toEqual(
        expect.arrayContaining([current, destination]),
      );
      expect(fs.existsSync(destination)).toBe(false);
      drained();
      await registration;
      unsubscribe();

      store.subscribe(() => {
        throw new Error("reader did not stop");
      });
      await expect(store.retain([failedCopy])).rejects.toThrow("搜索暂停尚未完成");
      expect(new HostPrivateDataRootsStore(file, []).list()).toEqual(
        expect.arrayContaining([current, destination, failedCopy]),
      );
      expect(fs.existsSync(failedCopy)).toBe(false);

      // A persistence failure must not publish a new exclusion only in memory.
      const unwritten = path.join(directory, "unwritten");
      fs.renameSync(file, `${file}.saved`);
      fs.mkdirSync(file);
      await expect(store.retain([unwritten])).rejects.toThrow();
      expect(store.list()).not.toContain(unwritten);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

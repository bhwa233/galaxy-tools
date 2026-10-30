import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { it, expect } from "vitest";
import { BackupScheduler } from "./backup-scheduler.js";

// Exercise actual ownership files and deletion. Only the existing snapshot
// service is replaced by controlled completed backup directories.
it("serializes scheduled snapshots and prunes only its own completed backups", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "backup-schedule-"));
  try {
    const host = path.join(root, "host"),
      destination = path.join(root, "destination");
    fs.mkdirSync(destination);
    let release!: () => void,
      calls = 0;
    const create = async (directory: string) => {
      if (++calls === 1)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      const snapshot = path.join(
        directory,
        "spark233-backup-2026-10-30T00-00-00-000Z-" + randomUUID(),
      );
      fs.mkdirSync(snapshot);
      fs.writeFileSync(path.join(snapshot, "manifest.json"), "{}");
      return { snapshotDirectory: snapshot, files: 1, bytes: 2, warnings: [] };
    };
    const scheduler = new BackupScheduler(host, create, () => true, root);
    scheduler.save({}, destination);
    scheduler.save({ enabled: true, keep: 1 });
    const pending = scheduler.run();
    await Promise.resolve();
    await scheduler.run(true);
    expect(calls).toBe(1);
    scheduler.save({ intervalDays: 7 });
    release();
    await pending;
    expect(scheduler.get().intervalDays).toBe(7);
    const directory = path.join(destination, "spark233-scheduled"),
      first = fs.readdirSync(directory)[0];
    const unrelated = path.join(directory, "manual-backup");
    fs.mkdirSync(unrelated);
    fs.writeFileSync(path.join(unrelated, "keep.txt"), "keep");
    await scheduler.run(true);
    expect(fs.existsSync(path.join(directory, first))).toBe(false);
    expect(fs.readFileSync(path.join(unrelated, "keep.txt"), "utf8")).toBe("keep");
    expect(scheduler.get()).toMatchObject({ enabled: true, running: false });
    expect(scheduler.get().lastSuccess).toBeTruthy();
    const failed = new BackupScheduler(
      host,
      async () => {
        throw new Error("save refused");
      },
      () => true,
      root,
    );
    await failed.run(true);
    expect(failed.get().lastError).toBe("save refused");
    expect(fs.existsSync(unrelated)).toBe(true);
    const newDestination = path.join(root, "new-destination");
    fs.mkdirSync(newDestination);
    scheduler.save({}, newDestination);
    expect(scheduler.get().lastSuccess).toBeUndefined();
    expect(scheduler.get().lastError).toBeUndefined();
    expect(fs.existsSync(unrelated)).toBe(true);
    // An imported configuration cannot authorize another destination or deletion ledger.
    const state = JSON.parse(fs.readFileSync(path.join(host, "backup-schedule.json"), "utf8"));
    state.directory = path.join(root, "unapproved");
    state.enabled = true;
    fs.writeFileSync(path.join(host, "backup-schedule.json"), JSON.stringify(state));
    expect(failed.get().enabled).toBe(false);
    await failed.run(true);
    expect(fs.existsSync(state.directory)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

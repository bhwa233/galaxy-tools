import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite, canonical, confined } from "./persistence.js";
import type { BackupSchedule } from "../shared/backup-schedule.js";
import type { BackupReport } from "../src/features/backup/types.js";
const schema = z.object({
  enabled: z.boolean(),
  directory: z.string(),
  intervalDays: z.number().int().min(1).max(30),
  keep: z.number().int().min(1).max(100),
  lastSuccess: z.string().optional(),
  lastAttempt: z.string().optional(),
  lastError: z.string().optional(),
  snapshots: z
    .array(
      z.object({
        directory: z.string(),
        name: z.string().regex(/^spark233-backup-[\dTZ.-]+-[a-f\d-]{36}$/i),
      }),
    )
    .max(1000)
    .default([]),
});
/** Product scheduling reuses the existing consistent snapshot service. Only
 * snapshots created by this scheduler enter its retention list. */
export class BackupScheduler {
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private stateFile: string;
  private authorizationFile: string;
  constructor(
    configDir: string,
    private create: (directory: string) => Promise<BackupReport>,
    private available: () => boolean,
    authorizationDir = path.dirname(configDir),
  ) {
    this.stateFile = confined(configDir, "backup-schedule.json");
    // This authorization/ownership ledger is outside the imported host backup.
    this.authorizationFile = confined(authorizationDir, "scheduled-backup-authorization.json");
  }
  private authorization() {
    if (!fs.existsSync(this.authorizationFile))
      return { directory: "", snapshots: [] as z.infer<typeof schema>["snapshots"] };
    return schema
      .pick({ directory: true, snapshots: true })
      .parse(JSON.parse(fs.readFileSync(this.authorizationFile, "utf8")));
  }
  private read() {
    if (!fs.existsSync(this.stateFile))
      return schema.parse({ enabled: false, directory: "", intervalDays: 1, keep: 7 });
    if (fs.statSync(this.stateFile).size > 1024 * 1024)
      throw new Error("Backup schedule is too large");
    const state = schema.parse(JSON.parse(fs.readFileSync(this.stateFile, "utf8"))),
      authorized = this.authorization();
    return {
      ...state,
      enabled: state.enabled && state.directory === authorized.directory,
      snapshots: authorized.snapshots,
    };
  }
  get(): BackupSchedule {
    const { snapshots: _, ...state } = this.read();
    return { ...state, running: this.busy };
  }
  save(
    patch: Partial<Pick<BackupSchedule, "enabled" | "intervalDays" | "keep">>,
    chosenDirectory?: string,
  ): BackupSchedule {
    if (this.busy && chosenDirectory) throw new Error("Backup is running");
    const next = schema.parse({
      ...this.read(),
      ...patch,
      ...(chosenDirectory ? { directory: canonical(chosenDirectory) } : {}),
    });
    if (next.enabled && !next.directory) throw new Error("Choose a backup destination first");
    if (chosenDirectory) {
      if (this.authorization().directory !== next.directory) {
        next.snapshots = [];
        next.lastSuccess = undefined;
        next.lastAttempt = undefined;
        next.lastError = undefined;
      }
      atomicWrite(
        this.authorizationFile,
        JSON.stringify({ directory: next.directory, snapshots: next.snapshots }),
      );
    }
    if (next.enabled && this.authorization().directory !== next.directory)
      throw new Error("Choose the backup destination again to authorize it");
    atomicWrite(this.stateFile, JSON.stringify(next));
    return this.get();
  }
  async run(force = false): Promise<BackupSchedule> {
    if (this.busy || !this.available()) return this.get();
    const state = this.read(),
      now = Date.now();
    const lastSuccess = Date.parse(state.lastSuccess ?? "") || 0,
      lastAttempt = Date.parse(state.lastAttempt ?? "") || 0;
    if (
      !state.directory ||
      this.authorization().directory !== state.directory ||
      (!force &&
        (!state.enabled ||
          now - lastSuccess < state.intervalDays * 86400000 ||
          now - lastAttempt < 1800000))
    )
      return this.get();
    this.busy = true;
    try {
      state.lastAttempt = new Date(now).toISOString();
      atomicWrite(this.stateFile, JSON.stringify(state));
      const directory = confined(state.directory, "spark233-scheduled");
      fs.mkdirSync(directory, { recursive: true });
      if (canonical(directory) !== path.resolve(directory))
        throw new Error("Backup destination identity changed");
      const report = await this.create(directory);
      // Final-save preparation may persist schedule edits while the snapshot is
      // running. Preserve those settings when recording the job's outcome.
      const settings = this.read();
      state.enabled = settings.enabled;
      state.intervalDays = settings.intervalDays;
      state.keep = settings.keep;
      const name = path.basename(report.snapshotDirectory);
      if (path.dirname(report.snapshotDirectory) !== directory)
        throw new Error("Unexpected backup destination");
      state.snapshots.unshift({ directory, name });
      atomicWrite(
        this.authorizationFile,
        JSON.stringify({ directory: state.directory, snapshots: state.snapshots }),
      );
      state.lastSuccess = new Date().toISOString();
      state.lastError = undefined;
      // Persist ownership before pruning. Never enumerate/delete arbitrary folders.
      atomicWrite(this.stateFile, JSON.stringify(schema.parse(state)));
      while (state.snapshots.length > state.keep) {
        const oldest = state.snapshots.at(-1)!;
        const target = confined(oldest.directory, oldest.name);
        if (
          oldest.directory !== directory ||
          path.basename(oldest.directory) !== "spark233-scheduled" ||
          canonical(oldest.directory) !== path.resolve(oldest.directory)
        )
          throw new Error("Backup retention destination changed");
        if (fs.existsSync(target)) {
          if (
            fs.lstatSync(target).isSymbolicLink() ||
            !fs.existsSync(confined(target, "manifest.json"))
          )
            throw new Error("Backup retention target changed");
          fs.rmSync(target, { recursive: true });
        }
        state.snapshots.pop();
        atomicWrite(
          this.authorizationFile,
          JSON.stringify({ directory: state.directory, snapshots: state.snapshots }),
        );
        atomicWrite(this.stateFile, JSON.stringify(state));
      }
    } catch (error) {
      const settings = this.read();
      state.enabled = settings.enabled;
      state.intervalDays = settings.intervalDays;
      state.keep = settings.keep;
      state.lastError = error instanceof Error ? error.message : String(error);
      atomicWrite(this.stateFile, JSON.stringify(state));
    } finally {
      this.busy = false;
    }
    return this.get();
  }
  start() {
    this.timer = setInterval(() => {
      void this.run().catch((error) => console.error("scheduled-backup", error));
    }, 60000);
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
}

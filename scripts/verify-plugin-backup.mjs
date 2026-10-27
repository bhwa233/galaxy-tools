// Exercise the real backup service and transaction manager with opaque synthetic
// data. Utility/editor durability is covered separately by the notes smoke.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { PluginManager } from "../apps/desktop/dist-electron/electron/plugins/manager.js";
import {
  PluginBackupService,
  readPendingBackupDataRoots,
} from "../apps/desktop/dist-electron/electron/plugins/backup.js";
import { defaultHostEnvironment } from "../apps/desktop/dist-electron/electron/plugins/manifest.js";
import { HostPrivateDataRootsStore } from "../apps/desktop/dist-electron/electron/private-data-roots.js";

const repo = fileURLToPath(new URL("../", import.meta.url));
const parent = path.join(repo, "local-build/spark233/plugin-backup-probe");
fs.mkdirSync(parent, { recursive: true });
const childContext = process.argv.find((arg) => arg.startsWith("--interrupt="))?.slice(12);
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
function readHostDataRoots(directory) {
  const file = path.join(directory, "config.json");
  if (!fs.existsSync(file)) return {};
  const info = fs.lstatSync(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.size <= 1024 * 1024);
  return read(file).pluginDataRoots ?? {};
}
async function connect(context, initialize = true) {
  const privateRoots = new HostPrivateDataRootsStore(
    path.join(context.root, "private-data-roots.json"),
    [
      context.hostRoot,
      context.pluginRoot,
      context.recoveryRoot,
      ...Object.values(context.dataRoots),
    ],
  );
  const manager = new PluginManager({
    stateFile: path.join(context.pluginRoot, "state.json"),
    dataRoot: path.join(context.pluginRoot, "data"),
    backupRoot: path.join(context.pluginRoot, "backups"),
    packages: Object.fromEntries(
      ["stagingRoot", "versionsRoot", "cacheRoot"].map((key) => [
        key,
        path.join(context.pluginRoot, key),
      ]),
    ),
    environment: defaultHostEnvironment("1.2.0"),
    resolveDataDirectory: (id) => context.dataRoots[id],
    createRuntime: async () => {
      throw new Error("Retained-domain probe must not start a plugin");
    },
  });
  if (initialize) await manager.initialize();
  const options = {
    manager,
    hostVersion: "1.2.0",
    hostRoot: context.hostRoot,
    pluginRoot: context.pluginRoot,
    recoveryRoot: context.recoveryRoot,
    externalDataRoots: () => context.dataRoots,
    legacyMountAliases: { notes: "spark233.notes" },
    rewriteHostConfig: (value, roots) => ({ ...value, pluginDataRoots: roots }),
    protectRoots: async (roots) => {
      context.protectionEvents ??= [];
      context.protectionEvents.push(roots.map((root) => ({ root, exists: fs.existsSync(root) })));
      await privateRoots.retain(roots);
    },
    pauseHost: async () => {
      context.pauses = (context.pauses ?? 0) + 1;
      return () => {};
    },
    reloadHost: () => {
      if (childContext) process.exit(97); // Actual abrupt exit after persisted applied journal.
      if (context.failReload) {
        context.failReload = false;
        throw new Error("Synthetic host reload failure");
      }
    },
  };
  return { manager, service: new PluginBackupService(options), options };
}
function fixture(root, secondary = true) {
  const context = {
    root,
    hostRoot: path.join(root, "host"),
    pluginRoot: path.join(root, "plugins"),
    recoveryRoot: path.join(root, "recovery"),
    dataRoots: { "spark233.notes": path.join(root, "external-a") },
  };
  if (secondary) context.dataRoots["example.retained"] = path.join(root, "external-b");
  for (const dir of [context.hostRoot, context.pluginRoot, ...Object.values(context.dataRoots)])
    fs.mkdirSync(dir, { recursive: true });
  write(
    path.join(context.hostRoot, "config.json"),
    JSON.stringify({ pluginDataRoots: context.dataRoots, theme: "dark" }),
  );
  return context;
}
function pendingRoots(context) {
  return readPendingBackupDataRoots({
    ...context,
    defaultDataRoots: {},
    legacyMountAliases: { notes: "spark233.notes" },
    readHostDataRoots,
  });
}
function interruptedRestore(context, snapshot) {
  const file = path.join(context.root, "interrupt-context.json");
  write(file, JSON.stringify({ ...context, snapshot }));
  const result = spawnSync(
    process.execPath,
    [fileURLToPath(import.meta.url), `--interrupt=${file}`],
    {
      cwd: repo,
      timeout: 45_000,
      encoding: "utf8",
    },
  );
  write(path.join(context.root, "interrupt-stdout.log"), result.stdout ?? "");
  write(path.join(context.root, "interrupt-stderr.log"), result.stderr ?? "");
  assert.equal(result.status, 97, result.stderr || String(result.error));
}

if (childContext) {
  assert.ok(path.resolve(childContext).startsWith(parent + path.sep));
  const context = read(childContext);
  const connected = await connect(context);
  const service = context.legacyEntry
    ? new (await import(pathToFileURL(context.legacyEntry).href)).PluginBackupService({
        ...connected.options,
        notesRoot: () => context.dataRoots["spark233.notes"],
      })
    : connected.service;
  const inspection = await service.inspect(context.snapshot);
  await service.restore(context.snapshot, inspection.manifestFingerprint);
  throw new Error("Interrupted child unexpectedly completed");
} else {
  const root = fs.mkdtempSync(path.join(parent, "run-"));
  const report = { ok: false, root, checks: [], inputs: {} };
  try {
    const context = fixture(path.join(root, "generic"));
    const { service } = await connect(context);
    const contents = new Map(
      Object.entries(context.dataRoots).map(([id, dir]) => [
        id,
        JSON.stringify({ opaque: id, path: path.join(dir, "must-not-remap-private-data") }),
      ]),
    );
    for (const [id, dir] of Object.entries(context.dataRoots))
      write(path.join(dir, "opaque.json"), contents.get(id));
    const destination = path.join(context.root, "snapshots");
    fs.mkdirSync(destination);
    const snapshot = (await service.create(destination)).snapshotDirectory;
    const preview = await service.inspect(snapshot);
    assert.ok(
      context.protectionEvents.some((event) =>
        event.some((entry) => entry.root === snapshot && !entry.exists),
      ),
    );
    assert.ok(
      new HostPrivateDataRootsStore(path.join(context.root, "private-data-roots.json"), [])
        .list()
        .includes(snapshot),
    );
    assert.equal(read(path.join(snapshot, "manifest.json")).schemaVersion, 2);
    assert.equal(read(path.join(snapshot, "manifest.json")).manager.plugins.length, 0);
    for (const id of contents.keys())
      assert.ok(fs.existsSync(path.join(snapshot, "files", `plugin-data-${id}`, "opaque.json")));
    report.checks.push("schema 2 backs up multiple retained domains without installed plugins");

    for (const dir of Object.values(context.dataRoots)) write(path.join(dir, "opaque.json"), "new");
    const replacement = (await service.create(destination)).snapshotDirectory;
    fs.renameSync(snapshot, snapshot + ".original");
    fs.renameSync(replacement, snapshot);
    const pauses = context.pauses;
    await assert.rejects(
      () => service.restore(snapshot, preview.manifestFingerprint),
      (error) => error.code === "backupSelectionChanged",
    );
    assert.equal(context.pauses, pauses, "Changed preview must be rejected before host pause");
    for (const dir of Object.values(context.dataRoots))
      assert.equal(fs.readFileSync(path.join(dir, "opaque.json"), "utf8"), "new");
    fs.renameSync(snapshot, replacement);
    fs.renameSync(snapshot + ".original", snapshot);
    report.checks.push(
      "valid snapshot replacement is rejected before saving or modifying live data",
    );

    context.dataRoots = Object.fromEntries(
      Object.entries(context.dataRoots).map(([id, dir]) => [id, dir + "-relocated"]),
    );
    for (const dir of Object.values(context.dataRoots))
      write(path.join(dir, "opaque.json"), "live");
    write(
      path.join(context.hostRoot, "config.json"),
      JSON.stringify({ pluginDataRoots: context.dataRoots }),
    );
    await service.restore(snapshot, preview.manifestFingerprint);
    assert.deepEqual(readHostDataRoots(context.hostRoot), context.dataRoots);
    for (const [id, dir] of Object.entries(context.dataRoots))
      assert.equal(fs.readFileSync(path.join(dir, "opaque.json"), "utf8"), contents.get(id));
    report.checks.push("restore rebinds host root pointers while preserving opaque plugin bytes");

    for (const dir of Object.values(context.dataRoots))
      write(path.join(dir, "opaque.json"), "keep-live");
    context.failReload = true;
    await assert.rejects(
      () => service.restore(snapshot, preview.manifestFingerprint),
      /reload failure/,
    );
    for (const dir of Object.values(context.dataRoots))
      assert.equal(fs.readFileSync(path.join(dir, "opaque.json"), "utf8"), "keep-live");
    // Rolled-back journals are finalized on startup before another transaction.
    await service.recoverInterrupted();
    report.checks.push("reload refusal rolls back every live domain and preserves recovery copies");

    interruptedRestore(context, snapshot);
    assert.deepEqual(pendingRoots(context), context.dataRoots);
    const restarted = await connect(context, false);
    await restarted.service.recoverInterrupted();
    for (const dir of Object.values(context.dataRoots))
      assert.equal(fs.readFileSync(path.join(dir, "opaque.json"), "utf8"), "keep-live");
    assert.equal(fs.existsSync(path.join(context.recoveryRoot, "active.json")), false);
    report.checks.push(
      "abrupt child exit after applied schema 2 journal recovers authorized domains",
    );

    // Generate the legacy snapshot using the actual checked-in schema 1 writer,
    // rather than duplicating its manifest or recovery schema in this probe.
    const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
    const { transformWithOxc } = await import(pathToFileURL(desktopRequire.resolve("vite")).href);
    const legacySource = execFileSync(
      "git",
      ["show", "37bc1c55d9b544baec2b3ce902a8c0ce6d9ec3e7:electron/plugins/backup.ts"],
      { cwd: repo, encoding: "utf8" },
    );
    const legacyRoot = path.join(root, "legacy-runtime");
    fs.cpSync(path.join(repo, "apps/desktop/dist-electron"), legacyRoot, { recursive: true });
    const legacyEntry = path.join(legacyRoot, "electron/plugins/backup-legacy.js");
    write(legacyEntry, (await transformWithOxc(legacySource, "backup-legacy.ts")).code);
    const { PluginBackupService: LegacyBackupService } = await import(
      pathToFileURL(legacyEntry).href
    );
    const legacy = fixture(path.join(root, "legacy"), false);
    const attached = await connect(legacy);
    const oldService = new LegacyBackupService({
      ...attached.options,
      notesRoot: () => legacy.dataRoots["spark233.notes"],
    });
    const legacyData = path.join(legacy.dataRoots["spark233.notes"], "opaque.json");
    write(legacyData, "legacy-source");
    const legacyDestination = path.join(legacy.root, "snapshots");
    fs.mkdirSync(legacyDestination);
    const oldSnapshot = (await oldService.create(legacyDestination)).snapshotDirectory;
    assert.equal(read(path.join(oldSnapshot, "manifest.json")).schemaVersion, 1);
    const oldPreview = await attached.service.inspect(oldSnapshot);
    write(legacyData, "legacy-live");
    await attached.service.restore(oldSnapshot, oldPreview.manifestFingerprint);
    assert.equal(fs.readFileSync(legacyData, "utf8"), "legacy-source");
    report.checks.push(
      "actual schema 1 writer snapshot restores through explicit legacy domain alias",
    );

    write(legacyData, "legacy-before-interruption");
    legacy.legacyEntry = legacyEntry;
    interruptedRestore(legacy, oldSnapshot);
    const active = read(path.join(legacy.recoveryRoot, "active.json"));
    const journalFile = path.join(legacy.recoveryRoot, active.id, "journal.json");
    const originalJournal = fs.readFileSync(journalFile, "utf8");
    const forged = JSON.parse(originalJournal);
    assert.equal(forged.schemaVersion, 1);
    const unapproved = path.join(legacy.root, "unapproved-domain");
    write(path.join(unapproved, "keep.bin"), "untouched");
    forged.roots.notes = unapproved;
    write(journalFile, JSON.stringify(forged));
    assert.throws(
      () =>
        readPendingBackupDataRoots({
          ...legacy,
          defaultDataRoots: { "spark233.notes": unapproved },
          legacyMountAliases: { notes: "spark233.notes" },
          readHostDataRoots,
        }),
      (error) => error.code === "invalidBackup",
    );
    assert.equal(fs.readFileSync(path.join(unapproved, "keep.bin"), "utf8"), "untouched");
    write(journalFile, originalJournal);
    assert.deepEqual(pendingRoots(legacy), legacy.dataRoots);
    await attached.service.recoverInterrupted();
    assert.equal(fs.readFileSync(legacyData, "utf8"), "legacy-before-interruption");
    report.checks.push(
      "schema 1 interrupted restore recovers; journal/default cannot override persisted root authority",
    );

    for (const file of ["electron/plugins/backup.js", "electron/plugins/manager.js"]) {
      report.inputs[file] = createHash("sha256")
        .update(fs.readFileSync(path.join(repo, "apps/desktop/dist-electron", file)))
        .digest("hex");
    }
    report.inputs.legacyWriter = createHash("sha256").update(legacySource).digest("hex");
    report.ok = true;
  } catch (error) {
    report.error = error instanceof Error ? error.stack : String(error);
    console.error(report.error);
    process.exitCode = 1;
  } finally {
    const output = path.join(root, "report.json");
    write(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ ok: report.ok, output, checks: report.checks }));
  }
}

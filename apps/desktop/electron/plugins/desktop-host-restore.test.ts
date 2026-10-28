import { createHash } from "node:crypto";
import { create as createTar } from "tar";
import { getPluginVersionDirectory } from "./package-installer.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";
import { dialog, type BrowserWindow } from "electron";
import { DesktopPluginHost } from "./desktop-host.js";
import { PluginBackupService } from "./backup.js";
import { resolveRegistryPluginPackage } from "./package-source.js";
import { HostConfigStore } from "../host-config.js";
import type {
  InstallPreview,
  PackageTaskSnapshot,
  PluginManagementState,
} from "../../src/features/plugins/types.js";

vi.mock("electron", () => ({
  app: {},
  BrowserWindow: {},
  protocol: {},
  session: {},
  utilityProcess: {},
  clipboard: {},
  dialog: { showOpenDialog: vi.fn() },
  globalShortcut: {},
  Notification: {},
}));
vi.mock("./package-source.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./package-source.js")>()),
  resolveRegistryPluginPackage: vi.fn(),
}));

const directories: string[] = [];
const hosts: DesktopPluginHost[] = [];
const parent = { webContents: { id: 1 } } as BrowserWindow;
const caller = "restore-test:document";

test("development bundled updates replace code while preserving plugin data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-dev-update-"));
  directories.push(root);
  const bundle = path.join(root, "bundle");
  const source = path.join(root, "source", "package");
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  const makePackage = async (version: string) => {
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({
        name: "@spark233/plugin-search",
        version,
        spark233: {
          schemaVersion: 1,
          id: "spark233.search",
          displayName: "Search",
          api: "^1.2.0",
          host: "^1.2.0",
          platforms: [process.platform],
          architectures: [process.arch],
          entry: "index.html",
          capabilities: [],
          commands: [{ id: "open", title: "Open" }],
        },
      }),
    );
    fs.writeFileSync(path.join(source, "index.html"), `<p>${version}</p>`);
    const filename = `search-${version}.tgz`;
    const archive = path.join(bundle, filename);
    await createTar({ cwd: path.dirname(source), file: archive, gzip: true }, ["package"]);
    const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(archive)).digest("base64")}`;
    fs.writeFileSync(
      path.join(bundle, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        plugins: [
          {
            pluginId: "spark233.search",
            name: "@spark233/plugin-search",
            version,
            file: filename,
            integrity,
          },
        ],
      }),
    );
  };
  const makeHost = (developmentBundledUpdates: boolean) => {
    const host = new DesktopPluginHost({
      root: path.join(root, "plugins"),
      bundledRoot: bundle,
      developmentBundledUpdates,
      hostVersion: "1.2.0",
      getTheme: () => ({ version: "1.0.0", preference: "light", effective: "light" }),
      createOfficialRuntime: async () => ({ activate: async () => undefined }),
    });
    hosts.push(host);
    return host;
  };
  await makePackage("0.1.1700000000000");
  const first = makeHost(true);
  await first.initialize();
  const data = path.join(first.manager.dataDirectory("spark233.search"), "saved.txt");
  const previousDirectory = first.manager.list()[0]!.directory;
  fs.writeFileSync(data, "kept");
  await first.shutdown();
  hosts.splice(hosts.indexOf(first), 1);
  await makePackage("0.1.1700000000001");
  const second = makeHost(true);
  await second.initialize();
  expect(second.manager.list().find((item) => item.pluginId === "spark233.search")?.version).toBe(
    "0.1.1700000000001",
  );
  expect(fs.readFileSync(data, "utf8")).toBe("kept");
  expect(fs.existsSync(previousDirectory)).toBe(false);
  await second.shutdown();
  hosts.splice(hosts.indexOf(second), 1);
  await makePackage("0.1.1700000000002");
  const production = makeHost(false);
  await production.initialize();
  expect(
    production.manager.list().find((item) => item.pluginId === "spark233.search")?.version,
  ).toBe("0.1.1700000000001");
});

afterEach(async () => {
  for (const host of hosts.splice(0)) await host.shutdown();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.mocked(dialog.showOpenDialog).mockReset();
  vi.mocked(resolveRegistryPluginPackage).mockReset();
});

async function fixture() {
  // Preserve TEMP's spelling: restore must work when Windows supplies an 8.3 alias.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-host-restore-"));
  directories.push(root);
  const hostRoot = path.join(root, "host");
  const pluginRoot = path.join(root, "plugins");
  const notesRoot = path.join(root, "notes");
  for (const directory of [hostRoot, notesRoot, path.join(root, "snapshots")])
    fs.mkdirSync(directory, { recursive: true });
  const config = new HostConfigStore(hostRoot, notesRoot);
  config.save(config.value);
  const onPackageTaskChanged = vi.fn();
  const host = new DesktopPluginHost({
    root: pluginRoot,
    hostVersion: "1.2.0",
    getTheme: () => ({ version: "1.0.0", preference: "light", effective: "light" }),
    onPackageTaskChanged,
  });
  hosts.push(host);
  await host.initialize();
  const handle = (command: string, args: unknown = {}) =>
    host.handle(command, args, parent, caller);
  const view = async () => (await handle("plugins_list")) as PluginManagementState;
  // No installed registry plugins: synchronize initialization without network or runtimes.
  await handle("plugins_check_updates");
  const importPreview = async (name: string) => {
    const source = path.join(root, "source", name);
    fs.mkdirSync(source, { recursive: true });
    fs.writeFileSync(
      path.join(source, "package.json"),
      JSON.stringify({
        name: `@fixture/restore-${name}`,
        version: "1.0.0",
        type: "module",
        spark233: {
          schemaVersion: 1,
          id: `fixture.restore-${name}`,
          displayName: `Restore ${name}`,
          api: "^1.2.0",
          host: "^1.2.0",
          platforms: [process.platform],
          architectures: [process.arch],
          entry: "index.html",
          capabilities: [],
          commands: [{ id: "open", title: "Open" }],
        },
      }),
    );
    fs.writeFileSync(path.join(source, "index.html"), "<p>Inert owned fixture</p>");
    vi.mocked(dialog.showOpenDialog).mockResolvedValueOnce({
      canceled: false,
      filePaths: [source],
    });
    return (await handle("plugins_import_directory")) as InstallPreview;
  };
  return {
    root,
    hostRoot,
    pluginRoot,
    notesRoot,
    host,
    handle,
    view,
    importPreview,
    onPackageTaskChanged,
  };
}

test("restore reload waits for the host mutation queue to drain and loses authority on resume", async () => {
  const { host } = await fixture();
  // maintenance=true previously allowed reload while an accepted operation was still running.
  const queuedHost = host as unknown as { serial(operation: () => Promise<void>): Promise<void> };
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const operation = queuedHost.serial(async () => {
    entered();
    await gate;
  });
  await started;
  const pausing = host.pauseMutations();
  try {
    expect(() => host.reloadAfterRestore()).toThrow(/暂停|排空/);
  } finally {
    release();
  }
  await operation;
  const resume = await pausing;
  try {
    expect(() => host.reloadAfterRestore()).not.toThrow();
  } finally {
    resume();
  }
  expect(() => host.reloadAfterRestore()).toThrow(/暂停|排空/);
});

// Real backup/restore IO sits close to the 5s default when the suite runs in
// parallel; the assertion is about state, not latency.
test(
  "real backup restore and rollback reload pending state without resurrecting retired tasks",
  { timeout: 30_000 },
  async () => {
    const {
      root,
      hostRoot,
      pluginRoot,
      notesRoot,
      host,
      handle,
      view,
      importPreview,
      onPackageTaskChanged,
    } = await fixture();
    const now = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    await handle("plugins_check_updates");
    const checkedA = (await view()).lastChecked;
    let failReload = false;
    const service = new PluginBackupService({
      manager: host.manager,
      hostVersion: "1.2.0",
      hostRoot,
      pluginRoot,
      externalDataRoots: () => ({ "spark233.notes": notesRoot }),
      recoveryRoot: path.join(root, "recovery"),
      pauseHost: () => host.pauseMutations(),
      rewriteHostConfig: (value, roots) => ({
        ...(value as Record<string, unknown>),
        dataDir: roots["spark233.notes"],
      }),
      reloadHost: () => {
        host.reloadAfterRestore();
        if (failReload) {
          failReload = false;
          throw new Error("OWN_RELOAD_FAILURE");
        }
      },
    });
    const a = await importPreview("a");
    const snapshot = (await service.create(path.join(root, "snapshots"))).snapshotDirectory;
    const inspection = await service.inspect(snapshot);
    await handle("plugins_cancel_install", { previewId: a.previewId });
    const b = await importPreview("b");
    now.mockReturnValue(1_800_000_001_000);
    await handle("plugins_check_updates");

    // Keep the actual task pending in registry resolution; pause aborts and drains it.
    vi.mocked(resolveRegistryPluginPackage).mockImplementationOnce(
      ({ signal }) =>
        new Promise((_resolve, reject) => {
          signal!.throwIfAborted();
          signal!.addEventListener("abort", () => reject(signal!.reason), { once: true });
        }),
    );
    const taskPromise = handle("plugins_prepare_registry", { name: "@fixture/retired-download" });
    interface HeldTask {
      snapshot: PackageTaskSnapshot;
    }
    const tasks = host as unknown as {
      packageTasks: Map<string, HeldTask>;
      taskChanged(task: HeldTask, change: Partial<PackageTaskSnapshot>): void;
    };
    const retired = [...tasks.packageTasks.values()][0];
    expect(retired).toBeDefined();
    await service.restore(snapshot, inspection.manifestFingerprint);
    await expect(taskPromise).resolves.toBeUndefined();

    // The original bug left memory B over disk A; cancelling B then erased A's ownership.
    const previewsFile = path.join(pluginRoot, "previews.json");
    const restoredBytes = fs.readFileSync(previewsFile);
    expect((await view()).pending.map((item) => item.previewId)).toEqual([a.previewId]);
    expect(
      JSON.parse(restoredBytes.toString()).pending.map(
        (item: { previewId: string }) => item.previewId,
      ),
    ).toEqual([a.previewId]);
    expect((await view()).lastChecked).toBe(checkedA);
    expect((await view()).tasks).toEqual([]);
    await expect(handle("plugins_cancel_install", { previewId: b.previewId })).rejects.toThrow(
      /does not exist/,
    );
    expect(fs.readFileSync(previewsFile)).toEqual(restoredBytes);
    onPackageTaskChanged.mockClear();
    const retiredRevision = retired.snapshot.revision;
    tasks.taskChanged(retired, { stage: "failed", error: "late progress" });
    expect(retired.snapshot.revision).toBe(retiredRevision);
    expect(onPackageTaskChanged).not.toHaveBeenCalled();
    await expect(
      handle("plugins_cancel_package_task", { taskId: retired.snapshot.taskId }),
    ).rejects.toThrow(/no longer exists/);
    await handle("plugins_cancel_install", { previewId: a.previewId });
    const reimported = await importPreview("a");
    expect(reimported.previewId).not.toBe(a.previewId);

    await handle("plugins_cancel_install", { previewId: reimported.previewId });
    const rollbackB = await importPreview("b");
    now.mockReturnValue(1_800_000_002_000);
    await handle("plugins_check_updates");
    const checkedB = (await view()).lastChecked;
    const previousBytes = fs.readFileSync(previewsFile);
    failReload = true;
    await expect(service.restore(snapshot, inspection.manifestFingerprint)).rejects.toThrow(
      "OWN_RELOAD_FAILURE",
    );
    expect((await view()).pending.map((item) => item.previewId)).toEqual([rollbackB.previewId]);
    expect(fs.readFileSync(previewsFile)).toEqual(previousBytes);
    expect((await view()).lastChecked).toBe(checkedB);
    expect((await view()).updates).toEqual([]);
    expect((await view()).tasks).toEqual([]);
    expect(fs.existsSync(path.join(root, "recovery", "active.json"))).toBe(false);
  },
);

// A snapshot can recompute its own hashes while copying a previously trusted
// installation's integrity fields. Those fields alone cannot authorize new code.
test("restore rejects changed executable package bytes even when backup hashes and grants agree", async () => {
  const { root, hostRoot, pluginRoot, notesRoot, host, importPreview } = await fixture();
  const preview = await importPreview("trusted");
  const pluginId = preview.metadata.spark233.id;
  const directory = getPluginVersionDirectory(
    host.manager.getBackupLayout().packages,
    pluginId,
    preview.metadata.version,
  );
  await host.manager.withQuiesced(async (access) => {
    access.replaceSnapshot({
      schemaVersion: 1,
      plugins: [
        {
          pluginId,
          packageName: preview.metadata.name,
          version: preview.metadata.version,
          directory,
          enabled: false,
          integrity: preview.integrity,
          manifestDigest: createHash("sha256")
            .update(fs.readFileSync(path.join(directory, "package.json")))
            .digest("hex"),
          source: preview.source,
          grant: { capabilities: [], native: true },
        },
      ],
      dataVersions: {},
    });
  });
  const pauseHost = vi.fn(() => host.pauseMutations());
  const service = new PluginBackupService({
    manager: host.manager,
    hostVersion: "1.2.0",
    hostRoot,
    pluginRoot,
    externalDataRoots: () => ({ "spark233.notes": notesRoot }),
    recoveryRoot: path.join(root, "recovery"),
    pauseHost,
    reloadHost: () => host.reloadAfterRestore(),
  });
  const snapshot = (await service.create(path.join(root, "snapshots"))).snapshotDirectory;
  const original = await service.inspect(snapshot);
  await service.restore(snapshot, original.manifestFingerprint);
  const manifestFile = path.join(snapshot, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const entry = manifest.entries.find((item: { path: string }) =>
    item.path.endsWith("/index.html"),
  );
  const changed = Buffer.from("<script>foreign code</script>");
  fs.writeFileSync(path.join(snapshot, "files", entry.path), changed);
  entry.bytes = changed.length;
  entry.sha256 = createHash("sha256").update(changed).digest("hex");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest));
  const inspected = await service.inspect(snapshot);
  pauseHost.mockClear();
  await expect(service.restore(snapshot, inspected.manifestFingerprint)).rejects.toMatchObject({
    code: "backupTrustRequired",
  });
  expect(pauseHost).not.toHaveBeenCalled();
  expect(fs.readFileSync(path.join(directory, "index.html"), "utf8")).toBe(
    "<p>Inert owned fixture</p>",
  );
});

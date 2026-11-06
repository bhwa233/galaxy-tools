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
import { createPackage } from "@electron/asar";
import { gzipSync } from "node:zlib";
import { stageLocalPluginPackage } from "./package-installer.js";
import { defaultHostEnvironment } from "./manifest.js";
import { createUToolsRuntime } from "./utools-runtime.js";
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
vi.mock("./utools-runtime.js", () => ({ createUToolsRuntime: vi.fn() }));

const directories: string[] = [];
const hosts: DesktopPluginHost[] = [];
const parent = { webContents: { id: 1 } } as BrowserWindow;
const caller = "restore-test:document";

test("binds an inspected store source without restarting identical code and preserves a refused update and its data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-utools-market-"));
  directories.push(root);
  const pluginRoot = path.join(root, "plugins"),
    source = path.join(root, "source");
  fs.mkdirSync(source);
  let version = "1.0.0",
    content = "first",
    refuseStop = false;
  let packageBytes: Buffer;
  const alive = new Set<string>();
  vi.mocked(createUToolsRuntime).mockImplementation((options) => {
    if (!options.startupCheckOnly) {
      alive.add(options.scope.owner.instanceId);
      options.scope.own("process", {
        prepareStop: () => (refuseStop ? { ok: false, reason: "save refused" } : { ok: true }),
        dispose: () => {
          alive.delete(options.scope.owner.instanceId);
        },
      });
    }
    return { activate: async () => undefined };
  });
  const makePackage = async () => {
    fs.writeFileSync(
      path.join(source, "plugin.json"),
      JSON.stringify({
        name: "market-fixture",
        pluginName: "Market fixture",
        version,
        main: "index.html",
        preload: "preload.js",
        features: [{ code: "open", cmds: ["Market fixture"] }],
      }),
    );
    fs.writeFileSync(path.join(source, "index.html"), "<p>" + content + "</p>");
    fs.writeFileSync(path.join(source, "a.bin"), "asset A");
    fs.writeFileSync(path.join(source, "b.bin"), "asset B");
    fs.writeFileSync(
      path.join(source, "preload.js"),
      "throw new Error('preview must never execute preload')",
    );
    const archive = path.join(root, "fixture-" + version + "-" + content + ".asar");
    await createPackage(source, archive);
    packageBytes = gzipSync(fs.readFileSync(archive));
  };
  const network: typeof fetch = async (input) => {
    const url = String(input);
    if (url.endsWith("plugins-search-index.json"))
      return new Response(
        JSON.stringify([
          {
            name: "market-fixture",
            pluginName: "Market fixture",
            href: "/plugins/detail/Market%20fixture/",
          },
        ]),
      );
    if (url.endsWith("/plugins/detail/Market%20fixture/"))
      return new Response(
        '<script type="application/ld+json">' +
          JSON.stringify({
            "@type": "SoftwareApplication",
            softwareVersion: version,
            downloadUrl: "https://res.u-tools.cn/plugins/marketfixture.upx",
          }) +
          "</script>",
      );
    if (url === "https://res.u-tools.cn/plugins/marketfixture.upx")
      return new Response(new Uint8Array(packageBytes));
    throw new Error("Unexpected network source");
  };
  const makeHost = async () => {
    const host = new DesktopPluginHost({
      root: pluginRoot,
      hostVersion: "0.0.1",
      getTheme: () => ({ version: "1.0.0", preference: "light", effective: "light" }),
      utoolsFetch: network,
    });
    hosts.push(host);
    await host.initialize();
    return host;
  };
  await makePackage();
  let host = await makeHost();
  const paths = {
    stagingRoot: path.join(pluginRoot, "staging"),
    versionsRoot: path.join(pluginRoot, "versions"),
    cacheRoot: path.join(pluginRoot, "cache"),
  };
  const local = path.join(root, "original.upx");
  fs.writeFileSync(local, packageBytes!);
  const staged = await stageLocalPluginPackage(local, defaultHostEnvironment("0.0.1"), paths);
  await host.manager.install(staged, {
    native: true,
    capabilities: staged.metadata.spark233.capabilities,
  });
  const pluginId = staged.metadata.spark233.id,
    commandId = staged.metadata.spark233.commands[0]!.id;
  await host.manager.activate(pluginId, { commandId });
  const owner = [...alive][0];
  const data = path.join(host.manager.dataDirectory(pluginId), "kept.txt");
  fs.writeFileSync(data, "user data");
  const handle = (command: string, args: unknown = {}) =>
    host.handle(command, args, parent, caller);
  // Moving bytes across file boundaries must not make changed code eligible
  // for provenance-only binding, even when a flat byte stream stays identical.
  const payload = path.join(staged.directory, "payload");
  fs.writeFileSync(path.join(payload, "a.bin"), "asset Apayload/b.bin\0asset B");
  fs.rmSync(path.join(payload, "b.bin"));
  await expect(handle("plugins_prepare_utools", { catalogId: "market-fixture" })).rejects.toThrow(
    "实际内容不一致",
  );
  expect(host.manager.list()[0]!.source.kind).toBe("file");
  expect(alive).toEqual(new Set([owner]));
  fs.writeFileSync(path.join(payload, "a.bin"), "asset A");
  fs.writeFileSync(path.join(payload, "b.bin"), "asset B");
  let preview = (await handle("plugins_prepare_utools", {
    catalogId: "market-fixture",
  })) as InstallPreview;
  expect(preview.change).toBe("source");
  // A source-binding preview shares the installed directory: cancelling must
  // drop the preview without deleting the installed plugin.
  const installedDirectory = host.manager.list()[0]!.directory;
  await handle("plugins_cancel_install", { previewId: preview.previewId });
  expect(fs.existsSync(path.join(installedDirectory, "package.json"))).toBe(true);
  preview = (await handle("plugins_prepare_utools", {
    catalogId: "market-fixture",
  })) as InstallPreview;
  expect(preview.change).toBe("source");
  await expect(
    handle("plugins_confirm_install", { previewId: preview.previewId, trustNative: false }),
  ).rejects.toThrow("显式信任");
  expect(host.manager.list()[0]!.source.kind).toBe("file");
  await handle("plugins_confirm_install", { previewId: preview.previewId, trustNative: true });
  expect(alive).toEqual(new Set([owner]));
  expect(host.manager.list()[0]!.source).toMatchObject({
    kind: "utools",
    catalogId: "market-fixture",
    upstreamVersion: "1.0.0",
  });
  await host.shutdown();
  hosts.splice(hosts.indexOf(host), 1);
  host = await makeHost();
  expect(host.manager.list()[0]!.source.kind).toBe("utools");
  await host.manager.activate(pluginId, { commandId });
  const running = [...alive][0];
  version = "2.0.0";
  content = "second";
  await makePackage();
  const checked = (await handle("plugins_check_updates")) as PluginManagementState;
  expect(checked.updates).toContainEqual(expect.objectContaining({ pluginId, version: "2.0.0" }));
  preview = (await handle("plugins_prepare_update", { pluginId })) as InstallPreview;
  refuseStop = true;
  await expect(
    handle("plugins_confirm_install", { previewId: preview.previewId, trustNative: true }),
  ).rejects.toThrow("save refused");
  expect(alive).toEqual(new Set([running]));
  expect(host.manager.list()[0]!.version).toBe(staged.metadata.version);
  expect(fs.readFileSync(data, "utf8")).toBe("user data");
  refuseStop = false;
  await handle("plugins_confirm_install", { previewId: preview.previewId, trustNative: true });
  expect(host.manager.list()[0]!.source.upstreamVersion).toBe("2.0.0");
  expect(fs.readFileSync(data, "utf8")).toBe("user data");
  // Fingerprints order code snapshots, not upstream versions. A republished
  // same-version package needs explicit content confirmation, not semver order.
  content = "revised";
  await makePackage();
  preview = (await handle("plugins_prepare_utools", {
    catalogId: "market-fixture",
  })) as InstallPreview;
  expect(preview.change).toBe("content");
  await handle("plugins_confirm_install", { previewId: preview.previewId, trustNative: true });
  expect(host.manager.list()[0]!.source.upstreamVersion).toBe("2.0.0");
  expect(fs.readFileSync(data, "utf8")).toBe("user data");
});

test("development bundled updates replace code while preserving plugin data", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-dev-update-"));
  directories.push(root);
  const bundle = path.join(root, "bundle");
  const source = path.join(root, "source", "package");
  fs.mkdirSync(bundle, { recursive: true });
  fs.mkdirSync(source, { recursive: true });
  const makePackage = async (version: string, hostRange = "^1.2.0") => {
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
          host: hostRange,
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
  const makeHost = (developmentBundledUpdates: boolean, hostVersion = "1.2.0") => {
    const host = new DesktopPluginHost({
      root: path.join(root, "plugins"),
      bundledRoot: bundle,
      developmentBundledUpdates,
      hostVersion,
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
  await production.shutdown();
  hosts.splice(hosts.indexOf(production), 1);
  // A renumbered host cannot run the installed copy; a newer compatible
  // bundled release replaces it even though the bundle was already consumed.
  await makePackage("0.1.1700000000003", ">=0.0.1 <1");
  const renumbered = makeHost(false, "0.1.4");
  await renumbered.initialize();
  const repaired = renumbered.manager.list().find((item) => item.pluginId === "spark233.search");
  expect(repaired?.version).toBe("0.1.1700000000003");
  expect(repaired?.lastError).toBeFalsy();
  expect(fs.readFileSync(data, "utf8")).toBe("kept");
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

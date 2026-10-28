import { dialog, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import semver from "semver";
import { z } from "zod";
import {
  pluginPackageSchema,
  localizePluginManifest,
  type PluginTheme,
  type PluginPackageMetadata,
  type PluginOwner,
  type JsonValue,
  type ResourceHandle,
} from "@spark233/sdk";
import type {
  InstallPreview,
  PluginManagementState,
  PluginSummary,
  UpdateSummary,
  PluginUpdateSource,
  PackageTaskSnapshot,
} from "../../src/features/plugins/types.js";
import { AppError, atomicWrite, canonical, confined, readJson } from "../persistence.js";
import {
  createTrustedBackend,
  type PluginBackendController,
  type TrustedBackendOptions,
} from "./backend.js";
import { PluginManager, type PluginInstallation, type ManagedPluginRuntime } from "./manager.js";
import type { PluginResourceScope } from "./resources.js";
import {
  defaultHostEnvironment,
  resolvePluginEntries,
  validatePluginDirectory,
} from "./manifest.js";
import {
  getPluginVersionDirectory,
  readPluginReleaseNotes,
  stageLocalPluginPackage,
  stageDevelopmentPluginPackage,
  stageRegistryPluginPackage,
  type PluginPackagePaths,
  type StagedPluginPackage,
} from "./package-installer.js";
import { resolveRegistryPluginPackage } from "./package-source.js";
import { createWebPluginRuntime } from "./web-host.js";
import { createNativePluginRuntime } from "./native-runtime.js";
import { runPluginDataMigration } from "./migration.js";
import { createCapabilityBroker } from "./capabilities.js";
import { registryPackageUrl, requirePackageIntegrity } from "./package-io.js";
import type { DiagnosticEvent, DiagnosticKind } from "../../src/features/diagnostics/types.js";
import { PluginTrayStateStore } from "../host/plugin-tray.js";

export interface DesktopPluginHostOptions {
  root: string;
  hostVersion: string;
  getTheme: () => PluginTheme;
  getLocale?: () => string;
  subscribeTheme?: (listener: () => void) => () => void;
  onChange?: () => void;
  onTrayChange?: () => void;
  onPackageTaskChanged?: (caller: string, task: PackageTaskSnapshot) => void;
  onDiagnostic?: (event: DiagnosticEvent) => void;
  onDiagnosticOutput?: (
    owner: PluginOwner,
    stream: "stdout" | "stderr",
    byteCount: number,
    kind: DiagnosticKind,
  ) => void;
  bundledRoot?: string;
  /** Host adapters are selected by the application, never by page-supplied code. */
  createOfficialRuntime?: (
    installation: PluginInstallation,
    metadata: PluginPackageMetadata,
    scope: PluginResourceScope,
    backend: PluginBackendController | undefined,
    startupCheckOnly: boolean,
  ) => Promise<ManagedPluginRuntime | undefined>;
  resolveDataDirectory?: (pluginId: string) => string | undefined;
  onPluginEvent?: (owner: PluginOwner, name: string, payload?: JsonValue) => void;
  resolveResource?: (resource: ResourceHandle) => string | undefined;
  subscribeResourceRevocations?: (listener: (ids: readonly string[]) => void) => () => void;
  onBackendHostCall?: TrustedBackendOptions["onHostCall"];
}
const sourceSchema = z.strictObject({
  kind: z.enum(["registry", "file", "directory"]),
  location: z.string(),
  registry: z.string().optional(),
  channel: z.string().optional(),
});
const pendingSchema = z.strictObject({
  previewId: z.uuid(),
  createdAt: z.number().finite(),
  staged: z.strictObject({
    metadata: pluginPackageSchema,
    directory: z.string(),
    integrity: z.string(),
    source: sourceSchema,
    releaseNotes: z
      .strictObject({
        status: z.enum(["available", "missing", "error"]),
        content: z.string().max(262144).optional(),
        message: z.string().max(4096).optional(),
      })
      .optional(),
  }),
  updateFrom: z
    .strictObject({
      pluginId: z.string(),
      name: z.string(),
      version: z.string(),
      registry: z.string(),
      channel: z.string(),
    })
    .optional(),
});
type PendingPackage = z.infer<typeof pendingSchema>;
interface PackageTask {
  owner: string;
  requestKey: string;
  snapshot: PackageTaskSnapshot;
  abort: AbortController;
  promise: Promise<InstallPreview | undefined>;
  notifiedAt: number;
}
const previewStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  pending: z.array(pendingSchema).max(16),
});
const checkStateSchema = z.strictObject({ lastChecked: z.number().finite().nonnegative() });
const pluginIdArgs = z.strictObject({ pluginId: z.string().min(1).max(80) });
const previewIdArgs = z.strictObject({ previewId: z.uuid() });
const SIX_HOURS = 6 * 60 * 60 * 1000;
const officialBundledIds = new Set([
  "spark233.notes",
  "spark233.screenshot",
  "spark233.ocr",
  "spark233.translation",
  "spark233.clipboard",
  "spark233.applications",
  "spark233.search",
]);
const bundledEntrySchema = z.strictObject({
  pluginId: z.string().min(1).max(80),
  name: z.string().min(1).max(214),
  version: z.string().refine((value) => !!semver.valid(value)),
  file: z.string().regex(/^[a-z0-9][a-z0-9.-]*\.tgz$/),
  integrity: z.string().transform(requirePackageIntegrity),
  displayName: z.string().min(1).max(160).optional(),
  translations: z
    .strictObject({
      "zh-CN": z.strictObject({ displayName: z.string().min(1).max(160) }).optional(),
      "en-US": z.strictObject({ displayName: z.string().min(1).max(160) }).optional(),
    })
    .optional(),
  updateSource: z.lazy(() => updateSourceSchema).optional(),
});
type BundledEntry = z.infer<typeof bundledEntrySchema>;
const updateSourceSchema = z.strictObject({
  registry: z
    .string()
    .max(2048)
    .transform((value) => {
      const url = registryPackageUrl(value);
      if (url.search) throw new Error("Plugin update registry cannot contain a query string");
      url.pathname = url.pathname.replace(/\/?$/, "/");
      return url.href;
    }),
  channel: z.string().regex(/^[a-z][a-z0-9._-]{0,127}$/i),
});

/** Reuses the package installer, transaction manager and runtime owners. This
 * service only coordinates desktop confirmation, previews and update notices. */
export class DesktopPluginHost {
  readonly trayStates: PluginTrayStateStore;
  readonly manager: PluginManager;
  private readonly root: string;
  private readonly paths: PluginPackagePaths;
  private readonly stateFile: string;
  private readonly previewsFile: string;
  private readonly checksFile: string;
  private readonly environment;
  private pending = new Map<string, PendingPackage>();
  private readonly packageTasks = new Map<string, PackageTask>();
  private offlineReservations = 0;
  private updates: UpdateSummary[] = [];
  private lastChecked?: number;
  private error?: string;
  private bundleError?: string;
  private checking?: Promise<void>;
  private timer?: ReturnType<typeof setInterval>;
  private operations: Promise<unknown> = Promise.resolve();
  private stopped = false;
  private maintenance = false;
  private maintenanceDrained = false;
  private restoreEpoch = 0;
  private abort = new AbortController();
  private readonly bundledUpdates = new Map<string, { name: string; source: PluginUpdateSource }>();
  private readonly bundledCatalog = new Map<string, BundledEntry>();

  constructor(private options: DesktopPluginHostOptions) {
    this.trayStates = new PluginTrayStateStore(() => options.onTrayChange?.());
    if (!path.isAbsolute(options.root)) throw new Error("Plugin host root must be absolute");
    fs.mkdirSync(options.root, { recursive: true });
    this.root = canonical(options.root);
    this.paths = {
      stagingRoot: confined(this.root, "staging"),
      versionsRoot: confined(this.root, "versions"),
      cacheRoot: confined(this.root, "cache"),
    };
    this.stateFile = confined(this.root, "state.json");
    this.previewsFile = confined(this.root, "previews.json");
    this.checksFile = confined(this.root, "update-check.json");
    this.environment = defaultHostEnvironment(options.hostVersion);
    this.manager = new PluginManager({
      stateFile: this.stateFile,
      dataRoot: confined(this.root, "data"),
      backupRoot: confined(this.root, "backups"),
      packages: this.paths,
      environment: this.environment,
      onChange: () => this.changed(),
      onDiagnostic: (event) => this.diagnostic(event),
      resolveDataDirectory: options.resolveDataDirectory,
      migrateData: (installation, metadata, migration) =>
        runPluginDataMigration({
          installation,
          metadata,
          migration,
          dataDir: this.manager.dataDirectory(installation.pluginId),
          cacheDir: confined(this.paths.cacheRoot, "migration", installation.pluginId),
        }),
      createRuntime: async (installation, metadata, scope, startupCheckOnly) => {
        const updateTray = this.trayStates.attach(scope, metadata.spark233);
        const onEvent = (event: { name: string; payload?: JsonValue }) => {
          if (event.name === "tray-state") {
            try {
              updateTray(event.payload);
            } catch (error) {
              console.error("plugin-tray-state", error);
            }
          } else options.onPluginEvent?.(scope.owner, event.name, event.payload);
        };
        const entries = resolvePluginEntries(installation.directory, metadata);
        const backend = entries.backend
          ? await createTrustedBackend({
              scope,
              pluginRoot: installation.directory,
              entryPath: entries.backend.entry,
              dataDir: this.manager.dataDirectory(installation.pluginId),
              cacheDir: confined(this.paths.cacheRoot, "runtime", installation.pluginId),
              approveTrust: () => installation.grant.native,
              startupCheckOnly,
              hostCapabilities: installation.grant.capabilities,
              onHostCall: options.onBackendHostCall,
              onLogBytes: (stream, bytes) =>
                this.diagnosticOutput(scope.owner, stream, bytes, "backend"),
              onEvent,
              onCrash: (error) => {
                void this.manager
                  .reportCrash(scope.owner, error)
                  .catch((failure) => console.error("plugin-crash-recovery", failure));
              },
              activationTimeoutMs: (activation) =>
                installation.pluginId === "spark233.translation" &&
                activation.commandId === "translate"
                  ? 120_000
                  : undefined,
            })
          : undefined;
        const official = await options.createOfficialRuntime?.(
          installation,
          metadata,
          scope,
          backend,
          startupCheckOnly,
        );
        if (official) return official;
        if (
          !entries.web &&
          Object.keys(entries.native).length &&
          metadata.spark233.commands.some((command) =>
            command.inputs.some((kind) => kind === "files" || kind === "image"),
          )
        )
          throw new Error(
            "Generic native-only entries cannot yet resolve file/image resource handles",
          );
        const native = Object.keys(entries.native).length
          ? await createNativePluginRuntime({
              scope,
              pluginRoot: installation.directory,
              entries: entries.native,
              capabilities: installation.grant.capabilities,
              dataDir: this.manager.dataDirectory(installation.pluginId),
              cacheDir: confined(this.paths.cacheRoot, "runtime", installation.pluginId),
              approveTrust: () => installation.grant.native,
              onOutputBytes: (stream, bytes) =>
                this.diagnosticOutput(scope.owner, stream, bytes, "native"),
              onEvent,
              onCrash: (error) => {
                void this.manager
                  .reportCrash(scope.owner, error)
                  .catch((failure) => console.error("plugin-crash-recovery", failure));
              },
            })
          : undefined;
        const broker = entries.web
          ? createCapabilityBroker({
              scope,
              manifest: metadata.spark233,
              manager: () => this.manager,
              updateTray,
              resolveResource: options.resolveResource,
              ...(native
                ? {
                    invokeNative: (entryId, activation, signal) =>
                      native.request(entryId, activation, signal),
                  }
                : {}),
            })
          : undefined;
        if (broker && options.subscribeResourceRevocations) {
          const stop = options.subscribeResourceRevocations((ids) => broker.revokeContext(ids));
          scope.own("event", { dispose: stop });
        }
        const web = entries.web
          ? await createWebPluginRuntime({
              scope,
              pluginRoot: installation.directory,
              entryPath: entries.web,
              manifest: metadata.spark233,
              dataDir: this.manager.dataDirectory(installation.pluginId),
              grant: installation.grant,
              getTheme: options.getTheme,
              subscribeTheme: options.subscribeTheme,
              capabilityBroker: broker,
              onCrash: (error) => {
                void this.manager
                  .reportCrash(scope.owner, error)
                  .catch((failure) => console.error("plugin-crash-recovery", failure));
              },
            })
          : undefined;
        if (!backend && !web) {
          if (!native) throw new Error("Plugin has no supported runtime entry");
          await native.checkStartup();
          return native;
        }
        await web?.checkStartup();
        return {
          query: async (activation, signal) => {
            signal?.throwIfAborted();
            broker?.grantContext(activation.context);
            return backend ? backend.activate(activation, signal) : web?.query(activation, signal);
          },
          activate: async (activation) => {
            broker?.grantContext(activation.context);
            const result = await backend?.activate(activation);
            // An on-startup activation must not display a window.
            if (activation.commandId || activation.context) await web?.activate(activation);
            return result;
          },
        };
      },
    });
  }

  private diagnostic(event: DiagnosticEvent): void {
    try {
      this.options.onDiagnostic?.(event);
    } catch {
      /* Telemetry cannot own a transaction. */
    }
  }
  private diagnosticOutput(
    owner: PluginOwner,
    stream: "stdout" | "stderr",
    bytes: number,
    kind: DiagnosticKind,
  ): void {
    try {
      this.options.onDiagnosticOutput?.(owner, stream, bytes, kind);
    } catch {
      /* Never retain raw output. */
    }
  }
  private changed(): void {
    try {
      this.options.onChange?.();
    } catch (error) {
      console.error("plugin-host-notification", error);
    }
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations
      .catch(() => {})
      .then(() => {
        if (this.stopped || this.maintenance)
          throw new Error("Plugin host is shutting down or taking a snapshot");
        return operation();
      });
    this.operations = next;
    return next;
  }
  private persistPreviews(): void {
    atomicWrite(
      this.previewsFile,
      JSON.stringify({ schemaVersion: 1, pending: [...this.pending.values()] }, null, 2),
    );
    this.changed();
  }
  private exactDirectory(staged: StagedPluginPackage): string {
    const expected = getPluginVersionDirectory(
      this.paths,
      staged.metadata.spark233.id,
      staged.metadata.version,
    );
    if (canonical(expected) !== canonical(staged.directory))
      throw new Error("Preview code directory does not match its package identity");
    return confined(this.root, path.relative(this.root, expected));
  }
  private validatePending(record: PendingPackage): void {
    const directory = this.exactDirectory(record.staged);
    const metadata = validatePluginDirectory(directory, this.environment, {
      name: record.staged.metadata.name,
      version: record.staged.metadata.version,
      pluginId: record.staged.metadata.spark233.id,
    });
    if (JSON.stringify(metadata) !== JSON.stringify(record.staged.metadata))
      throw new Error("Pending plugin manifest changed; cancel and import it again");
  }
  private preview(record: PendingPackage): InstallPreview {
    const { metadata, source, integrity, releaseNotes } = record.staged;
    const task = this.taskForPreview(record.previewId);
    return structuredClone({
      previewId: record.previewId,
      metadata,
      source,
      integrity,
      createdAt: record.createdAt,
      ...(releaseNotes ? { releaseNotes } : {}),
      ...(task ? { taskId: task.snapshot.taskId } : {}),
      ...(record.updateFrom ? { currentVersion: record.updateFrom.version } : {}),
      requiresNativeTrust:
        !!metadata.spark233.backend ||
        !!metadata.spark233.migration ||
        Object.keys(metadata.spark233.native).length > 0,
    });
  }
  private addPreview(
    staged: StagedPluginPackage,
    updateFrom?: PendingPackage["updateFrom"],
  ): InstallPreview {
    const record = {
      previewId: randomUUID(),
      createdAt: Date.now(),
      staged,
      ...(updateFrom ? { updateFrom } : {}),
    };
    this.pending.set(record.previewId, record);
    try {
      this.persistPreviews();
    } catch (error) {
      this.pending.delete(record.previewId);
      throw error;
    }
    return this.preview(record);
  }
  private ensurePreviewCapacity(): void {
    if (
      this.pending.size +
        this.offlineReservations +
        [...this.packageTasks.values()].filter((task) =>
          ["queued", "resolving", "downloading", "verifying", "cancelling"].includes(
            task.snapshot.stage,
          ),
        ).length >=
      16
    )
      throw new Error("Confirm or cancel pending packages before importing more");
  }
  async initialize(): Promise<void> {
    await this.manager.initialize();
    await this.installBundled();
    const saved = this.readManagementState();
    this.pending = saved.pending;
    this.lastChecked = saved.lastChecked;
    this.error = saved.error;
    if (fs.existsSync(this.previewsFile)) this.persistPreviews();
    this.timer = setInterval(() => {
      void this.checkUpdates();
    }, SIX_HOURS);
    this.timer.unref();
    if (!this.lastChecked || Date.now() - this.lastChecked >= SIX_HOURS) void this.checkUpdates();
  }
  private readManagementState(): {
    pending: Map<string, PendingPackage>;
    lastChecked?: number;
    error?: string;
  } {
    const pending = new Map<string, PendingPackage>();
    let error: string | undefined;
    if (fs.existsSync(this.previewsFile)) {
      if (fs.statSync(this.previewsFile).size > 8 * 1024 * 1024)
        throw new Error("Plugin preview state is too large");
      for (const record of previewStateSchema.parse(readJson(this.previewsFile)).pending) {
        this.exactDirectory(record.staged);
        if (
          this.manager
            .list()
            .some(
              (installed) => canonical(installed.directory) === canonical(record.staged.directory),
            )
        )
          continue;
        // Match startup: invalid candidates remain visible and cancellable;
        // loading a backup never grants trust or starts a pending package.
        pending.set(record.previewId, record);
        try {
          this.validatePending(record);
        } catch (failure) {
          error = String(failure);
        }
      }
    }
    const lastChecked = fs.existsSync(this.checksFile)
      ? checkStateSchema.parse(readJson(this.checksFile)).lastChecked
      : undefined;
    return { pending, lastChecked, error };
  }

  /** Called after the manager's snapshot replacement while the host is drained.
   * Restore and rollback both reload their own disk generation. Never reinitialize
   * the manager or install bundled packages here: enabled/uninstalled is restored state.
   */
  reloadAfterRestore(): void {
    if (
      !this.maintenance ||
      !this.maintenanceDrained ||
      this.stopped ||
      this.offlineReservations ||
      this.checking
    )
      throw new AppError("pluginBusy", "恢复管理状态前必须暂停并排空插件宿主");
    if (
      fs.existsSync(this.stateFile) &&
      readJson<{ transaction?: unknown }>(this.stateFile).transaction
    )
      throw new AppError("pluginRecoveryRequired", "未完成的插件事务不能被恢复管理状态覆盖");
    // Parse everything before replacing the live view. A bad restored file can
    // trigger the backup service's rollback without half-replacing these maps.
    const saved = this.readManagementState();
    ++this.restoreEpoch;
    this.pending = saved.pending;
    this.packageTasks.clear();
    this.updates = [];
    this.lastChecked = saved.lastChecked;
    this.error = saved.error;
    this.changed();
  }

  private async installBundled(): Promise<void> {
    if (!this.options.bundledRoot) return;
    const indexFile = confined(this.options.bundledRoot, "index.json");
    if (!fs.existsSync(indexFile))
      throw new Error("Bundled plugin index is missing; build official packages first");
    const index = z
      .strictObject({
        schemaVersion: z.literal(1),
        plugins: z.array(bundledEntrySchema).max(128),
      })
      .parse(readJson(indexFile));
    if (new Set(index.plugins.map((entry) => entry.pluginId)).size !== index.plugins.length)
      throw new Error("Bundled plugin index contains duplicate plugin identities");
    const consumedFile = confined(this.root, "bundled.json");
    const consumed = fs.existsSync(consumedFile)
      ? z.array(z.string()).parse(readJson(consumedFile))
      : [];
    const failures: string[] = [];
    for (const entry of index.plugins) {
      if (
        officialBundledIds.has(entry.pluginId) &&
        entry.name === `@spark233/plugin-${entry.pluginId.slice("spark233.".length)}`
      )
        this.bundledCatalog.set(entry.pluginId, entry);
      // Installation provenance remains the actual offline archive. Update
      // metadata is bound separately to this exact bundled package identity.
      if (entry.updateSource)
        this.bundledUpdates.set(entry.pluginId, { name: entry.name, source: entry.updateSource });
      // A later uninstall remains an uninstall. Package updates use confirmation.
      if (consumed.includes(entry.pluginId)) continue;
      try {
        if (!this.manager.list().some((record) => record.pluginId === entry.pluginId)) {
          const candidate = getPluginVersionDirectory(this.paths, entry.pluginId, entry.version);
          if (fs.existsSync(candidate)) {
            if (this.used(candidate))
              throw new Error("Bundled package is still owned by a pending recovery");
            fs.rmSync(candidate, { recursive: true, force: true });
          }
          const staged = await stageLocalPluginPackage(
            confined(this.options.bundledRoot, entry.file),
            this.environment,
            this.paths,
            {
              integrity: entry.integrity,
              expected: { name: entry.name, version: entry.version, pluginId: entry.pluginId },
            },
          );
          await this.manager.install(staged, {
            capabilities: staged.metadata.spark233.capabilities,
            native: true,
          });
        }
        consumed.push(entry.pluginId);
        atomicWrite(consumedFile, JSON.stringify(consumed));
      } catch (error) {
        failures.push(`${entry.pluginId}: ${String(error)}`);
        const detail = {
          timestamp: new Date().toISOString(),
          pluginId: entry.pluginId,
          version: entry.version,
          error: {
            name: error instanceof Error ? error.name : "Error",
            message: (error instanceof Error ? error.message : String(error)).slice(0, 4000),
            stack: error instanceof Error ? error.stack?.slice(0, 16000) : undefined,
            ...Object.fromEntries(
              ["code", "errno", "syscall", "path", "dest"].flatMap((key) => {
                const value =
                  error && typeof error === "object" && key in error
                    ? (error as Record<string, unknown>)[key]
                    : undefined;
                return typeof value === "string" || typeof value === "number"
                  ? [[key, typeof value === "string" ? value.slice(0, 2000) : value]]
                  : [];
              }),
            ),
          },
        };
        console.error("bundled-plugin-install", detail);
        try {
          const diagnosticFile = confined(this.root, "bundled-failures.json");
          if (fs.existsSync(diagnosticFile) && fs.statSync(diagnosticFile).size > 2 * 1024 * 1024)
            throw new Error("Bundled failure history exceeds 2 MiB; preserved without overwrite");
          const history: unknown = fs.existsSync(diagnosticFile) ? readJson(diagnosticFile) : [];
          if (!Array.isArray(history))
            throw new Error("Bundled failure history is invalid; preserved without overwrite");
          atomicWrite(diagnosticFile, JSON.stringify([...history, detail].slice(-16), null, 2));
        } catch (diagnosticError) {
          console.error("bundled-plugin-diagnostic", diagnosticError);
        }
      }
    }
    this.bundleError = failures.length ? failures.join("\n") : undefined;
  }
  private updateSource(record: PluginInstallation): PluginUpdateSource | undefined {
    if (record.source.kind === "registry" && record.source.registry)
      return { registry: record.source.registry, channel: record.source.channel ?? "latest" };
    const bundled = this.bundledUpdates.get(record.pluginId);
    return bundled?.name === record.packageName ? bundled.source : undefined;
  }
  trayPlugins() {
    return this.list().plugins.map((plugin) => ({
      ...plugin,
      enabled: plugin.enabled && !plugin.lastError,
    }));
  }
  private list(caller?: string): PluginManagementState {
    const plugins: PluginSummary[] = this.manager.list().map((record) => {
      let displayName = record.pluginId;
      let capabilities = record.grant.capabilities;
      let commands: PluginSummary["commands"] = [];
      let tray: PluginSummary["tray"];
      let dependencies: Record<string, string> = {};
      let optionalDependencies: Record<string, string> = {};
      let lastError = record.lastError;
      try {
        const metadata = this.manager.describe(record.pluginId);
        const localized = localizePluginManifest(
          metadata.spark233,
          this.options.getLocale?.() ?? "zh-CN",
        );
        displayName = localized.displayName;
        tray = localized.tray;
        capabilities = metadata.spark233.capabilities;
        commands = localized.commands.filter(
          (command) =>
            !command.internal && this.manager.commandDependenciesAvailable(metadata, command),
        );
        dependencies = metadata.spark233.dependencies;
        optionalDependencies = metadata.spark233.optionalDependencies;
      } catch (error) {
        lastError = String(error);
      }
      return {
        pluginId: record.pluginId,
        packageName: record.packageName,
        displayName,
        version: record.version,
        enabled: record.enabled,
        status: lastError ? "error" : record.status,
        source: record.source,
        ...(this.updateSource(record) ? { updateSource: this.updateSource(record) } : {}),
        capabilities,
        commands,
        ...(tray ? { tray } : {}),
        dependencies,
        optionalDependencies,
        ...(lastError ? { lastError } : {}),
      };
    });
    return structuredClone({
      plugins,
      catalog: [...this.bundledCatalog.values()].map((entry) => {
        const installed = plugins.find((plugin) => plugin.pluginId === entry.pluginId);
        const pending = [...this.pending.values()].some(
          (item) => item.staged.metadata.spark233.id === entry.pluginId,
        );
        const locale = this.options.getLocale?.().startsWith("en") ? "en-US" : "zh-CN";
        return {
          pluginId: entry.pluginId,
          packageName: entry.name,
          version: entry.version,
          displayName: entry.translations?.[locale]?.displayName ?? entry.displayName ?? entry.name,
          ...(installed ? { installedVersion: installed.version } : {}),
          pending,
          canPrepare: !pending && (!installed || semver.gt(entry.version, installed.version)),
        };
      }),
      pending: [...this.pending.values()]
        .filter(
          (record) =>
            !this.taskForPreview(record.previewId) ||
            this.taskForPreview(record.previewId)!.owner === caller,
        )
        .map((record) => this.preview(record)),
      tasks: [...this.packageTasks.values()]
        .filter((task) => task.owner === caller)
        .map((task) => this.taskSnapshot(task)),
      updates: this.updates,
      checking: !!this.checking,
      ...(this.lastChecked === undefined ? {} : { lastChecked: this.lastChecked }),
      ...([this.error, this.bundleError].filter(Boolean).length
        ? { error: [this.error, this.bundleError].filter(Boolean).join("\n") }
        : {}),
    });
  }
  private taskSnapshot(task: PackageTask): PackageTaskSnapshot {
    return structuredClone(task.snapshot);
  }
  private taskChanged(task: PackageTask, change: Partial<PackageTaskSnapshot>): void {
    if (this.packageTasks.get(task.snapshot.taskId) !== task) return;
    const previousStage = task.snapshot.stage;
    if (Object.hasOwn(change, "receivedBytes") && !Object.hasOwn(change, "totalBytes"))
      delete task.snapshot.totalBytes;
    if (change.stage === "saving") delete task.snapshot.error;
    Object.assign(task.snapshot, change, { revision: task.snapshot.revision + 1 });
    if (change.stage && change.stage !== previousStage && change.stage !== "cancelling")
      this.diagnostic({
        kind: "package",
        code: change.stage,
        level: ["failed", "recovery-required"].includes(change.stage) ? "error" : "info",
        taskId: task.snapshot.taskId,
        ...(task.snapshot.pluginId &&
        (task.snapshot.candidateVersion ?? task.snapshot.currentVersion)
          ? {
              target: {
                pluginId: task.snapshot.pluginId,
                version: (task.snapshot.candidateVersion ?? task.snapshot.currentVersion)!,
              },
            }
          : {}),
      });
    task.snapshot.cancelable = [
      "queued",
      "resolving",
      "downloading",
      "awaiting-confirmation",
    ].includes(task.snapshot.stage);
    // A separate narrow event must not invalidate launcher authorities or rebuild shortcuts.
    if (!change.stage && Date.now() - task.notifiedAt < 100) return;
    task.notifiedAt = Date.now();
    try {
      this.options.onPackageTaskChanged?.(task.owner, this.taskSnapshot(task));
    } catch (error) {
      console.error("plugin-package-task-notification", error);
    }
  }
  private taskForPreview(previewId: string): PackageTask | undefined {
    return [...this.packageTasks.values()].find((task) => task.snapshot.previewId === previewId);
  }
  private assertTaskOwner(task: PackageTask | undefined, caller: string): void {
    if (task && task.owner !== caller)
      throw new AppError("permissionDenied", "安装任务属于其他窗口文档");
  }
  private assertUpdateCurrent(
    staged: StagedPluginPackage,
    update?: PendingPackage["updateFrom"],
  ): void {
    if (!update) return;
    const installed = this.manager.list().find((item) => item.pluginId === update.pluginId);
    const source = installed && this.updateSource(installed);
    if (
      !installed ||
      installed.packageName !== update.name ||
      installed.version !== update.version ||
      !source ||
      source.registry !== update.registry ||
      source.channel !== update.channel ||
      staged.metadata.spark233.id !== update.pluginId ||
      staged.metadata.name !== update.name ||
      !semver.gt(staged.metadata.version, installed.version)
    )
      throw new Error("The installed plugin or update source changed; check for updates again");
  }
  private discardStaged(staged: StagedPluginPackage): void {
    const directory = this.exactDirectory(staged);
    if (
      this.used(directory) ||
      [...this.pending.values()].some(
        (record) => canonical(record.staged.directory) === canonical(directory),
      )
    )
      return;
    fs.rmSync(directory, { recursive: true, force: true });
  }
  private async cancelPackageTask(task: PackageTask, caller: string): Promise<PackageTaskSnapshot> {
    this.assertTaskOwner(task, caller);
    if (this.packageTasks.get(task.snapshot.taskId) !== task)
      throw new Error("Package task no longer exists");
    const failedPreview =
      task.snapshot.stage === "failed" &&
      !!task.snapshot.previewId &&
      this.pending.has(task.snapshot.previewId);
    if (
      ["cancelled", "completed", "recovery-required"].includes(task.snapshot.stage) ||
      (task.snapshot.stage === "failed" && !failedPreview)
    )
      return this.taskSnapshot(task);
    if (!task.snapshot.cancelable && task.snapshot.stage !== "cancelling" && !failedPreview)
      throw new Error("This task is verifying, saving or committing; wait for it to finish");
    if (task.snapshot.stage === "awaiting-confirmation" || failedPreview) {
      await this.serial(async () => {
        if (this.packageTasks.get(task.snapshot.taskId) !== task)
          throw new Error("Package task no longer exists");
        // Confirmation may have entered the queue first. Never cancel its transaction.
        if (!["awaiting-confirmation", "failed"].includes(task.snapshot.stage))
          throw new Error("Installation has already started");
        const record = task.snapshot.previewId && this.pending.get(task.snapshot.previewId);
        if (record) {
          const directory = this.exactDirectory(record.staged);
          if (this.used(directory)) throw new Error("The transaction still owns this package");
          this.pending.delete(record.previewId);
          try {
            this.persistPreviews();
          } catch (error) {
            this.pending.set(record.previewId, record);
            throw error;
          }
          this.discardStaged(record.staged);
        }
        this.taskChanged(task, { stage: "cancelled" });
      });
    } else {
      this.taskChanged(task, { stage: "cancelling" });
      task.abort.abort();
      await task.promise;
    }
    return this.taskSnapshot(task);
  }
  releaseCaller(caller: string): void {
    for (const task of this.packageTasks.values()) {
      if (task.owner !== caller) continue;
      if (["queued", "resolving", "downloading", "verifying"].includes(task.snapshot.stage)) {
        // Retirement can discard a late verification result; it cannot interrupt a commit.
        this.taskChanged(task, { stage: "cancelling" });
        task.abort.abort();
      } else if (
        task.snapshot.stage === "awaiting-confirmation" ||
        (task.snapshot.stage === "failed" &&
          !!task.snapshot.previewId &&
          this.pending.has(task.snapshot.previewId))
      ) {
        void this.cancelPackageTask(task, caller).catch((error) =>
          console.error("plugin-package-retirement", error),
        );
      }
    }
  }
  private prepareRegistryTask(
    caller: string,
    name: string,
    registry?: string,
    channel?: string,
    update?: PendingPackage["updateFrom"],
  ): Promise<InstallPreview | undefined> {
    if (this.stopped || this.maintenance)
      return Promise.reject(new Error("Plugin host is unavailable"));
    const source = updateSourceSchema.parse({
      registry: registry ?? "https://registry.npmjs.org/",
      channel: channel ?? "latest",
    });
    const requestKey = JSON.stringify([name, source.registry, source.channel, update?.pluginId]);
    const existing = [...this.packageTasks.values()].find(
      (task) =>
        task.snapshot.packageName === name &&
        !["completed", "cancelled", "failed", "recovery-required"].includes(task.snapshot.stage),
    );
    if (existing) {
      if (existing.owner === caller && existing.requestKey === requestKey) return existing.promise;
      return Promise.reject(new Error("An installation task for this package already exists"));
    }
    if ([...this.pending.values()].some((record) => record.staged.metadata.name === name))
      return Promise.reject(new Error("Confirm or cancel this package's pending preview first"));
    this.ensurePreviewCapacity();
    const task: PackageTask = {
      owner: caller,
      requestKey,
      abort: new AbortController(),
      notifiedAt: 0,
      snapshot: {
        taskId: randomUUID(),
        revision: 0,
        packageName: name,
        stage: "queued",
        receivedBytes: 0,
        cancelable: true,
        ...(update
          ? {
              pluginId: update.pluginId,
              currentVersion: this.manager.list().find((item) => item.pluginId === update.pluginId)
                ?.version,
            }
          : {}),
      },
      promise: Promise.resolve(undefined),
    };
    this.packageTasks.set(task.snapshot.taskId, task);
    // Prune only terminal records; active promises and pending ownership stay bound.
    for (const [id, previous] of this.packageTasks) {
      if (this.packageTasks.size <= 64) break;
      if (
        ["completed", "cancelled", "failed"].includes(previous.snapshot.stage) &&
        !(previous.snapshot.previewId && this.pending.has(previous.snapshot.previewId))
      )
        this.packageTasks.delete(id);
    }
    this.taskChanged(task, { stage: "queued" });
    task.promise = this.runRegistryTask(task, source, update);
    return task.promise;
  }
  private async runRegistryTask(
    task: PackageTask,
    source: PluginUpdateSource,
    update?: PendingPackage["updateFrom"],
  ): Promise<InstallPreview | undefined> {
    let staged: StagedPluginPackage | undefined;
    const abort = () => task.abort.abort();
    this.abort.signal.addEventListener("abort", abort, { once: true });
    try {
      task.abort.signal.throwIfAborted();
      this.taskChanged(task, { stage: "resolving" });
      const selection = await resolveRegistryPluginPackage(
        {
          name: task.snapshot.packageName,
          registry: source.registry,
          channel: source.channel,
          expected: update ? { pluginId: update.pluginId } : undefined,
          cacheRoot: confined(this.paths.cacheRoot, "registry-metadata"),
          signal: task.abort.signal,
        },
        this.environment,
      );
      task.abort.signal.throwIfAborted();
      const pluginId = selection.metadata.spark233.id;
      if (
        [...this.packageTasks.values()].some(
          (other) =>
            other !== task &&
            other.snapshot.pluginId === pluginId &&
            !["completed", "cancelled", "failed"].includes(other.snapshot.stage),
        ) ||
        [...this.pending.values()].some((record) => record.staged.metadata.spark233.id === pluginId)
      )
        throw new Error("A package task or pending preview already owns this plugin identity");
      this.taskChanged(task, {
        pluginId,
        candidateVersion: selection.version,
        stage: "downloading",
      });
      if (update)
        this.assertUpdateCurrent({ metadata: selection.metadata } as StagedPluginPackage, update);
      staged = await stageRegistryPluginPackage(selection, this.environment, this.paths, {
        signal: task.abort.signal,
        onProgress: (progress) => this.taskChanged(task, progress),
        onPhase: (stage) => this.taskChanged(task, { stage }),
      });
      task.abort.signal.throwIfAborted();
      return await this.serial(async () => {
        task.abort.signal.throwIfAborted();
        if (this.packageTasks.get(task.snapshot.taskId) !== task)
          throw new Error("Package task no longer exists");
        this.assertUpdateCurrent(staged!, update);
        const preview = this.addPreview(staged!, update);
        this.taskChanged(task, { stage: "awaiting-confirmation", previewId: preview.previewId });
        return { ...preview, taskId: task.snapshot.taskId };
      });
    } catch (failure) {
      // A retired task must not delete a path now owned by restored disk state.
      if (this.packageTasks.get(task.snapshot.taskId) !== task) return undefined;
      let error = failure;
      if (staged) {
        try {
          this.discardStaged(staged);
        } catch (cleanup) {
          error = new AggregateError([failure, cleanup], "Package cleanup needs attention");
          this.taskChanged(task, { stage: "failed", error: String(error) });
          throw error;
        }
      }
      if (task.abort.signal.aborted) {
        this.taskChanged(task, { stage: "cancelled" });
        return undefined;
      }
      this.taskChanged(task, { stage: "failed", error: String(error) });
      throw error;
    } finally {
      this.abort.signal.removeEventListener("abort", abort);
    }
  }
  private checkUpdates(): Promise<void> {
    if (this.checking) return this.checking;
    if (this.stopped || this.maintenance) return Promise.resolve();
    const epoch = this.restoreEpoch;
    const operation = (async () => {
      const updates: UpdateSummary[] = [];
      const errors: string[] = [];
      for (const installed of this.manager.list()) {
        const source = this.updateSource(installed);
        if (!source) continue;
        try {
          const selection = await resolveRegistryPluginPackage(
            {
              name: installed.packageName,
              registry: source.registry,
              channel: source.channel,
              expected: { pluginId: installed.pluginId },
              cacheRoot: confined(this.paths.cacheRoot, "registry-metadata"),
              signal: this.abort.signal,
            },
            this.environment,
          );
          if (semver.gt(selection.version, installed.version))
            updates.push({
              pluginId: installed.pluginId,
              currentVersion: installed.version,
              version: selection.version,
              packageName: selection.name,
              source: {
                kind: "registry",
                location: selection.tarball,
                registry: selection.registry,
                channel: selection.channel,
              },
            });
        } catch (error) {
          const missing =
            error &&
            typeof error === "object" &&
            (("statusCode" in error && error.statusCode === 404) ||
              ("code" in error && error.code === "E404"));
          errors.push(
            `${installed.pluginId}: ${
              missing
                ? "The update package is not published at the configured registry; the installed offline plugin remains available."
                : String(error)
            }`,
          );
        }
      }
      if (
        this.stopped ||
        this.maintenance ||
        this.abort.signal.aborted ||
        epoch !== this.restoreEpoch
      )
        return;
      this.updates = updates;
      this.error = errors.length ? errors.join("\n") : undefined;
      this.lastChecked = Date.now();
      atomicWrite(this.checksFile, JSON.stringify({ lastChecked: this.lastChecked }));
    })();
    this.checking = operation
      .catch((error) => {
        if (epoch === this.restoreEpoch) this.error = String(error);
      })
      .finally(() => {
        if (epoch !== this.restoreEpoch) return;
        this.checking = undefined;
        this.changed();
      });
    this.changed();
    return this.checking;
  }
  private used(directory: string): boolean {
    if (this.manager.list().some((record) => canonical(record.directory) === canonical(directory)))
      return true;
    // Recovery may still own the candidate even when the visible active record is old.
    if (!fs.existsSync(this.stateFile)) return false;
    const state = z
      .object({
        transaction: z
          .object({
            before: z.object({ directory: z.string() }).optional(),
            after: z.object({ directory: z.string() }),
          })
          .optional(),
      })
      .parse(readJson(this.stateFile));
    return [state.transaction?.before?.directory, state.transaction?.after.directory].some(
      (value) => value && canonical(value) === canonical(directory),
    );
  }

  async handle(
    command: string,
    args: unknown,
    parent: BrowserWindow,
    caller = `host:${parent.webContents.id}`,
  ): Promise<unknown> {
    if (command === "plugins_list") return this.list(caller);
    if (command === "plugins_cancel_package_task") {
      const { taskId } = z.strictObject({ taskId: z.uuid() }).parse(args);
      const task = this.packageTasks.get(taskId);
      if (!task) throw new Error("Package task no longer exists");
      return this.cancelPackageTask(task, caller);
    }
    if (this.maintenance) throw new Error("插件正在备份或恢复，请稍后重试");
    if (command === "plugins_check_updates") {
      await this.checkUpdates();
      return this.list(caller);
    }
    // Dispatch activation through the manager's queue, but do not hold the
    // service mutation queue for the duration of an AI/native plugin task.
    if (command === "plugins_activate") {
      if (this.stopped) throw new Error("Plugin host is shutting down");
      const input = pluginIdArgs.extend({ commandId: z.string().max(80).optional() }).parse(args);
      const metadata = this.manager.describe(input.pluginId);
      const commandId =
        input.commandId ?? metadata.spark233.commands.find((command) => !command.internal)?.id;
      if (!commandId) throw new Error("Plugin does not expose a command to open");
      await this.manager.activate(input.pluginId, { commandId });
      return this.list(caller);
    }
    if (command === "plugins_release_notes") {
      const { pluginId } = pluginIdArgs.parse(args);
      const installation = this.manager.list().find((item) => item.pluginId === pluginId);
      if (!installation) throw new Error("Plugin is not installed");
      this.manager.describe(pluginId);
      const notes = await readPluginReleaseNotes(installation.directory);
      if (
        !this.manager
          .list()
          .some(
            (item) =>
              item.pluginId === pluginId &&
              item.version === installation.version &&
              item.integrity === installation.integrity,
          )
      )
        throw new Error("Plugin version changed; load its notes again");
      return notes;
    }
    if (command === "plugins_prepare_registry") {
      const input = z
        .strictObject({
          name: z.string().min(1).max(214),
          registry: z.string().max(2048).optional(),
          channel: z.string().max(128).optional(),
        })
        .parse(args);
      return this.prepareRegistryTask(caller, input.name, input.registry, input.channel);
    }
    if (command === "plugins_prepare_update") {
      const { pluginId } = pluginIdArgs.parse(args);
      const installed = this.manager.list().find((record) => record.pluginId === pluginId);
      const source = installed && this.updateSource(installed);
      if (!installed || !source)
        throw new Error("This plugin has no configured registry update source");
      return this.prepareRegistryTask(
        caller,
        installed.packageName,
        source.registry,
        source.channel,
        { pluginId, name: installed.packageName, version: installed.version, ...source },
      );
    }
    const reserving = [
      "plugins_import",
      "plugins_import_directory",
      "plugins_prepare_bundled",
    ].includes(command);
    if (reserving) {
      this.ensurePreviewCapacity();
      this.offlineReservations++;
    }
    return this.serial(async () => {
      switch (command) {
        case "plugins_import": {
          const result = await dialog.showOpenDialog(parent, {
            title: "Import spark233 plugin",
            properties: ["openFile"],
            filters: [{ name: "npm plugin package", extensions: ["tgz"] }],
          });
          if (result.canceled || !result.filePaths[0]) return undefined;
          return this.addPreview(
            await stageLocalPluginPackage(result.filePaths[0], this.environment, this.paths, {
              signal: this.abort.signal,
            }),
          );
        }
        case "plugins_import_directory": {
          const result = await dialog.showOpenDialog(parent, {
            title: "Import spark233 development plugin directory",
            properties: ["openDirectory"],
          });
          if (result.canceled || !result.filePaths[0]) return undefined;
          return this.addPreview(
            await stageDevelopmentPluginPackage(result.filePaths[0], this.environment, this.paths, {
              signal: this.abort.signal,
            }),
          );
        }
        case "plugins_prepare_bundled": {
          const { pluginId } = pluginIdArgs.parse(args);
          const entry = this.bundledCatalog.get(pluginId);
          if (!entry || !this.options.bundledRoot)
            throw new Error("Official offline plugin is not in the bundled catalog");
          const installed = this.manager.list().find((item) => item.pluginId === pluginId);
          if (installed && !semver.gt(entry.version, installed.version))
            throw new Error("This bundled plugin version or a newer version is already installed");
          if (
            [...this.pending.values()].some((item) => item.staged.metadata.spark233.id === pluginId)
          )
            throw new Error("Confirm or cancel the pending package for this plugin first");
          return this.addPreview(
            await stageLocalPluginPackage(
              confined(this.options.bundledRoot, entry.file),
              this.environment,
              this.paths,
              {
                integrity: entry.integrity,
                expected: { name: entry.name, version: entry.version, pluginId },
                signal: this.abort.signal,
              },
            ),
          );
        }
        case "plugins_confirm_install": {
          const input = previewIdArgs.extend({ trustNative: z.boolean() }).parse(args);
          const record = this.pending.get(input.previewId);
          if (!record) throw new Error("Plugin install preview does not exist");
          const task = this.taskForPreview(record.previewId);
          this.assertTaskOwner(task, caller);
          this.validatePending(record);
          this.assertUpdateCurrent(record.staged, record.updateFrom);
          if (this.preview(record).requiresNativeTrust && !input.trustNative)
            throw new AppError("pluginTrustRequired", "第三方 Node 或原生执行需要显式信任");
          if (task) this.taskChanged(task, { stage: "saving" });
          try {
            await this.manager.install(
              record.staged,
              {
                capabilities: [...record.staged.metadata.spark233.capabilities],
                native: input.trustNative,
              },
              true,
              (stage) => {
                if (task) this.taskChanged(task, { stage });
              },
            );
          } catch (error) {
            if (task)
              this.taskChanged(task, {
                stage:
                  error instanceof AppError && error.code === "pluginRecoveryRequired"
                    ? "recovery-required"
                    : "failed",
                error: String(error),
              });
            throw error;
          }
          this.pending.delete(record.previewId);
          this.persistPreviews();
          if (task) this.taskChanged(task, { stage: "completed" });
          this.updates = this.updates.filter(
            (update) => update.pluginId !== record.staged.metadata.spark233.id,
          );
          return this.list(caller);
        }
        case "plugins_cancel_install": {
          const { previewId } = previewIdArgs.parse(args);
          const record = this.pending.get(previewId);
          if (!record) throw new Error("Plugin install preview does not exist");
          const task = this.taskForPreview(record.previewId);
          this.assertTaskOwner(task, caller);
          const directory = this.exactDirectory(record.staged);
          if (this.used(directory))
            throw new Error(
              "The plugin manager still owns this package; recover its transaction first",
            );
          if (
            ![...this.pending.values()].some(
              (other) =>
                other.previewId !== previewId &&
                canonical(other.staged.directory) === canonical(directory),
            )
          )
            fs.rmSync(directory, { recursive: true, force: true });
          this.pending.delete(previewId);
          this.persistPreviews();
          if (task) this.taskChanged(task, { stage: "cancelled" });
          return this.list(caller);
        }
        case "plugins_enable": {
          const input = pluginIdArgs.extend({ enabled: z.boolean() }).parse(args);
          await this.manager.setEnabled(input.pluginId, input.enabled);
          return this.list(caller);
        }
        case "plugins_uninstall": {
          const input = pluginIdArgs.extend({ deleteData: z.boolean() }).parse(args);
          if (
            [...this.pending.values()].some(
              (record) => record.staged.metadata.spark233.id === input.pluginId,
            )
          )
            throw new Error("Cancel pending packages for this plugin before uninstalling");
          await this.manager.uninstall(input.pluginId, input.deleteData);
          this.updates = this.updates.filter((update) => update.pluginId !== input.pluginId);
          return this.list(caller);
        }
        default:
          throw new Error(`Unknown plugin management command: ${command}`);
      }
    }).finally(() => {
      if (reserving) this.offlineReservations--;
    });
  }
  async pauseMutations(): Promise<() => void> {
    if (this.maintenance || this.stopped) throw new Error("插件宿主正忙");
    this.maintenance = true;
    this.maintenanceDrained = false;
    try {
      this.abort.abort();
      await Promise.allSettled([...this.packageTasks.values()].map((task) => task.promise));
      await this.operations.catch(() => {});
      await this.checking;
      this.maintenanceDrained = true;
      return () => {
        this.maintenanceDrained = false;
        this.abort = new AbortController();
        this.maintenance = false;
      };
    } catch (error) {
      this.maintenanceDrained = false;
      this.abort = new AbortController();
      this.maintenance = false;
      throw error;
    }
  }
  async shutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.stopped = true;
    this.abort.abort();
    await Promise.allSettled([...this.packageTasks.values()].map((task) => task.promise));
    await this.operations.catch(() => {});
    await this.checking;
    try {
      await this.manager.shutdown();
    } catch (error) {
      this.stopped = false;
      this.abort = new AbortController();
      this.timer = setInterval(() => {
        void this.checkUpdates();
      }, SIX_HOURS);
      this.timer.unref();
      throw error;
    }
  }
}

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import semver from "semver";
import { z } from "zod";
import {
  pluginCapabilitySchema,
  isPluginPackagePath,
  type JsonValue,
  type PluginActivation,
  type PluginCapability,
  type PluginPackageMetadata,
  type PluginOwner,
  type StopReason,
  type PluginDataMigration,
} from "../../packages/sdk/src/index.js";
import { AppError, atomicWrite, canonical, confined, inside, readJson } from "../store.js";
import { validatePluginDirectory, type HostEnvironment } from "./manifest.js";
import {
  getPluginVersionDirectory,
  type PluginPackagePaths,
  type StagedPluginPackage,
} from "./package-installer.js";
import { PluginResourceScope, samePluginOwner } from "./resources.js";

export const pluginTrustGrantSchema = z.strictObject({
  capabilities: z.array(pluginCapabilitySchema),
  native: z.boolean(),
});
const installationSchema = z.strictObject({
  pluginId: z.string(),
  packageName: z.string(),
  version: z.string(),
  directory: z.string(),
  enabled: z.boolean(),
  integrity: z.string(),
  manifestDigest: z.string(),
  source: z.strictObject({
    kind: z.enum(["registry", "file", "directory"]),
    location: z.string(),
    registry: z.string().optional(),
    channel: z.string().optional(),
  }),
  grant: pluginTrustGrantSchema,
  lastError: z.string().optional(),
});
export type PluginInstallation = z.infer<typeof installationSchema>;
const dataVersionSchema = z.strictObject({
  packageName: z
    .string()
    .min(1)
    .max(214)
    .regex(/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/),
  dataVersion: z.number().int().nonnegative().safe(),
  pluginVersion: z.string().refine((value) => !!semver.valid(value)),
});
const dataVersionsSchema = z.record(
  z
    .string()
    .max(80)
    .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/),
  dataVersionSchema,
);
export type PluginCommittedDataVersion = z.infer<typeof dataVersionSchema>;
export interface PluginTrustGrant {
  capabilities: PluginCapability[];
  native: boolean;
}
const journalSchema = z.strictObject({
  id: z.string(),
  pluginId: z.string(),
  phase: z.enum(["prepared", "backed-up", "migrating", "switched"]),
  before: installationSchema.optional(),
  after: installationSchema,
  backup: z.string(),
  dataExisted: z.boolean(),
  beforeDataVersion: dataVersionSchema.optional(),
  afterDataVersion: dataVersionSchema.optional(),
});
const stateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plugins: z.record(z.string(), installationSchema),
  transaction: journalSchema.optional(),
  dataVersions: dataVersionsSchema.default({}),
});
type PersistentState = z.infer<typeof stateSchema>;
type Journal = z.infer<typeof journalSchema>;
export interface ManagedPluginRuntime {
  activate(activation: PluginActivation): Promise<JsonValue | undefined>;
  query?(activation: PluginActivation): Promise<JsonValue | undefined>;
}
export interface PluginManagerOptions {
  stateFile: string;
  dataRoot: string;
  backupRoot: string;
  packages: PluginPackagePaths;
  environment: HostEnvironment;
  createRuntime: (
    installation: PluginInstallation,
    metadata: PluginPackageMetadata,
    scope: PluginResourceScope,
    startupCheckOnly: boolean,
  ) => Promise<ManagedPluginRuntime>;
  onChange?: () => void;
  /** Dedicated business storage can live outside the plugin code/config root. */
  resolveDataDirectory?: (pluginId: string) => string | undefined;
  migrateData?: (
    installation: PluginInstallation,
    metadata: PluginPackageMetadata,
    migration: PluginDataMigration,
  ) => Promise<void>;
}
export interface PluginManagerSnapshot {
  schemaVersion: 1;
  plugins: PluginInstallation[];
  dataVersions: Record<string, PluginCommittedDataVersion>;
}
export interface PluginMaintenanceAccess {
  snapshot(): PluginManagerSnapshot;
  replaceSnapshot(snapshot: unknown): void;
}
const backupStateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  plugins: z.array(installationSchema),
  dataVersions: dataVersionsSchema.default({}),
});

/**
 * Reuses npm package staging, semver and existing atomic storage. This class only
 * coordinates plugin ownership and the product's save/switch/rollback contract;
 * no existing note-specific window owner or npm dependency installer does that.
 */
export class PluginManager {
  private state: PersistentState;
  private instances = new Map<
    string,
    { scope: PluginResourceScope; runtime: ManagedPluginRuntime }
  >();
  private operations: Promise<unknown> = Promise.resolve();
  private readonly crashedInstances = new Set<string>();
  private readonly pendingCrashes = new Map<string, PluginOwner>();
  private readonly lifecycle = new Set<string>();
  private readonly starting = new Map<
    string,
    {
      record: PluginInstallation;
      scope: PluginResourceScope;
      protectedIds: Set<string>;
      promise: Promise<ManagedPluginRuntime>;
    }
  >();
  private readonly factoryContext = new AsyncLocalStorage<{
    owner: PluginOwner;
    active: boolean;
  }>();
  private exclusive = false;
  private ready = false;

  getBackupLayout() {
    return structuredClone({
      stateFile: this.options.stateFile,
      dataRoot: this.options.dataRoot,
      backupRoot: this.options.backupRoot,
      packages: this.options.packages,
      environment: this.options.environment,
    });
  }

  /** Validate all restored code/grants before any live data is replaced. Source
   * directory strings are informational; installed paths are recomputed locally. */
  validateBackupSnapshot(
    value: unknown,
    directoryFor?: (record: PluginInstallation) => string,
  ): PluginManagerSnapshot {
    const snapshot = backupStateSchema.parse(value);
    const identities = new Set<string>();
    for (const record of snapshot.plugins) {
      if (identities.has(record.pluginId))
        throw new AppError("invalidBackup", "备份包含重复插件身份");
      identities.add(record.pluginId);
      const directory =
        directoryFor?.(record) ??
        getPluginVersionDirectory(this.options.packages, record.pluginId, record.version);
      const metadata = validatePluginDirectory(directory, this.options.environment, {
        name: record.packageName,
        version: record.version,
        pluginId: record.pluginId,
      });
      if (this.digest(directory) !== record.manifestDigest)
        throw new AppError("invalidBackup", "备份插件清单散列与安装状态不一致");
      this.assertGrant(metadata, record.grant);
      const version = snapshot.dataVersions[record.pluginId];
      if (
        version &&
        (version.packageName !== record.packageName ||
          version.dataVersion !== metadata.spark233.dataVersion ||
          version.pluginVersion !== record.version)
      )
        throw new AppError("invalidBackup", "备份数据版本与插件清单不匹配");
      snapshot.dataVersions[record.pluginId] ??= {
        packageName: record.packageName,
        dataVersion: metadata.spark233.dataVersion,
        pluginVersion: record.version,
      };
      record.directory = getPluginVersionDirectory(
        this.options.packages,
        record.pluginId,
        record.version,
      );
    }
    for (const record of snapshot.plugins) {
      if (!record.enabled) continue;
      const directory = directoryFor?.(record) ?? record.directory;
      const manifest = validatePluginDirectory(directory, this.options.environment).spark233;
      for (const [id, range] of Object.entries(manifest.dependencies)) {
        const dependency = snapshot.plugins.find((item) => item.pluginId === id);
        if (
          !dependency?.enabled ||
          dependency.lastError ||
          !semver.satisfies(dependency.version, range)
        )
          throw new AppError("invalidBackup", `备份必需插件依赖不可用：${id}`);
      }
      for (const [id, range] of Object.entries(manifest.optionalDependencies)) {
        const dependency = snapshot.plugins.find((item) => item.pluginId === id);
        if (dependency?.enabled && !semver.satisfies(dependency.version, range))
          throw new AppError("invalidBackup", `备份可选插件依赖不兼容：${id}`);
      }
    }
    return structuredClone(snapshot);
  }

  /** One queue owns prepare/release, the snapshot operation and restart. Enabled
   * flags never become temporary disabled state, and callbacks never reenter it. */
  withQuiesced<T>(
    operation: (access: PluginMaintenanceAccess) => Promise<T>,
    rollbackAfterRestartFailure?: (access: PluginMaintenanceAccess) => Promise<void>,
  ): Promise<T> {
    return this.exclusiveSerial(async () => {
      if (this.state.transaction)
        throw new AppError("pluginRecoveryRequired", "需要先恢复未完成的插件更新");
      const previouslyRunning = new Set(this.instances.keys());
      const quiesce = async () => {
        const prepared: PluginResourceScope[] = [];
        for (const { scope } of this.instances.values()) {
          if (scope.state === "releasing" || scope.state === "released") continue;
          const decision = await scope.prepareStop(this.stopReason(scope, "update"));
          if (!decision.ok) {
            for (const previous of prepared) previous.cancelStop();
            throw new AppError("pluginSaveRefused", decision.reason);
          }
          prepared.push(scope);
        }
        for (const id of this.instances.keys()) await this.stop(id, "update");
      };
      const resume = async () => {
        const failures: string[] = [];
        for (const record of Object.values(this.state.plugins)) {
          if (!record.enabled || record.lastError) continue;
          if (this.instances.has(record.pluginId)) continue;
          try {
            const startup = this.metadata(record).spark233.activation === "on-startup";
            if (!startup && !previouslyRunning.has(record.pluginId)) continue;
            const runtime = await this.start(record, false, true);
            if (startup) await runtime.activate({});
          } catch (error) {
            await this.activationFailed(record, error);
            this.persist();
            failures.push(`${record.pluginId}: ${String(error)}`);
          }
        }
        if (failures.length) throw new AppError("pluginRestartFailed", failures.join("; "));
      };
      const access: PluginMaintenanceAccess = {
        snapshot: () =>
          structuredClone({
            schemaVersion: 1 as const,
            plugins: Object.values(this.state.plugins),
            dataVersions: this.state.dataVersions,
          }),
        replaceSnapshot: (snapshot) => {
          if (this.instances.size)
            throw new AppError("pluginBusy", "替换插件状态前必须停止全部实例");
          const next = this.validateBackupSnapshot(snapshot);
          this.state = {
            schemaVersion: 1,
            plugins: Object.fromEntries(next.plugins.map((record) => [record.pluginId, record])),
            dataVersions: next.dataVersions,
          };
          this.persist();
        },
      };
      // A refused prepare leaves all live instances intact. A partial release
      // failure still restarts already released instances before reporting it.
      try {
        await quiesce();
      } catch (error) {
        for (const { scope } of this.instances.values())
          if (scope.state === "prepared") scope.cancelStop();
        await resume().catch(() => {});
        throw error;
      }
      let result: T | undefined;
      let failure: unknown;
      let failed = false;
      try {
        result = await operation(access);
      } catch (error) {
        failure = error;
        failed = true;
      }
      try {
        await resume();
      } catch (restartError) {
        if (rollbackAfterRestartFailure && !failed) {
          try {
            await quiesce();
            await rollbackAfterRestartFailure(access);
            await resume();
          } catch (recoveryError) {
            throw new AppError(
              "backupRecoveryRequired",
              `恢复后的插件无法启动，回滚需要处理：${String(recoveryError)}`,
            );
          }
        }
        throw new AppError(
          "pluginRestartFailed",
          `${failure ? String(failure) + "; " : ""}${String(restartError)}`,
        );
      }
      if (failed) throw failure;
      return result as T;
    });
  }

  constructor(private options: PluginManagerOptions) {
    this.state = fs.existsSync(options.stateFile)
      ? stateSchema.parse(readJson(options.stateFile))
      : { schemaVersion: 1, plugins: {}, dataVersions: {} };
    for (const [id, record] of Object.entries(this.state.plugins)) {
      if (id !== record.pluginId) throw new AppError("invalidPluginState", "插件状态身份不一致");
      this.assertDirectory(record);
    }
  }

  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.catch(() => {}).then(operation);
    this.operations = next;
    return next;
  }
  private exclusiveSerial<T>(operation: () => Promise<T>): Promise<T> {
    if (this.factoryContext.getStore()?.active)
      return Promise.reject(new AppError("pluginStarting", "插件初始化期间不能重入全局维护"));
    return this.serial(async () => {
      this.exclusive = true;
      this.notifyChange();
      try {
        // Factories that entered before maintenance remain owned and must finish
        // cleanup/publication before the all-plugin save/snapshot boundary.
        await Promise.allSettled([...this.starting.values()].map((entry) => entry.promise));
        return await operation();
      } finally {
        this.exclusive = false;
        this.notifyChange();
      }
    });
  }
  private mutate<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    if (this.factoryContext.getStore()?.active)
      return Promise.reject(new AppError("pluginStarting", "插件初始化期间不能重入生命周期变更"));
    return this.serial(async () => {
      // Reject before state/data changes, rather than waiting on a factory that
      // may itself be awaiting a command provided by this lifecycle operation.
      if (
        this.pendingCrashes.has(pluginId) ||
        [...this.starting.values()].some((entry) => entry.protectedIds.has(pluginId))
      )
        throw new AppError("pluginStarting", "插件或依赖的初始化尚未结束，请稍后重试");
      this.lifecycle.add(pluginId);
      this.notifyChange();
      try {
        return await operation();
      } finally {
        this.lifecycle.delete(pluginId);
        this.notifyChange();
      }
    });
  }
  private protectedIds(
    metadata: PluginPackageMetadata,
    command?: PluginPackageMetadata["spark233"]["commands"][number],
    factory = false,
  ): Set<string> {
    const ids = new Set([metadata.spark233.id]);
    const visit = (current: PluginPackageMetadata, extra: string[] = []) => {
      for (const id of [...Object.keys(current.spark233.dependencies), ...extra]) {
        if (ids.has(id)) continue;
        ids.add(id);
        const record = this.find(id);
        if (record) {
          try {
            // An unavailable optional command provider must not prevent the
            // consumer's independent factory/commands from starting.
            if (
              !factory ||
              Object.hasOwn(current.spark233.dependencies, id) ||
              (record.enabled && !record.lastError)
            )
              visit(this.metadata(record));
          } catch (error) {
            if (!factory || Object.hasOwn(current.spark233.dependencies, id)) throw error;
          }
        }
      }
    };
    visit(
      metadata,
      factory
        ? metadata.spark233.commands.flatMap((entry) => entry.requiresPlugins ?? [])
        : (command?.requiresPlugins ?? []),
    );
    return ids;
  }
  private unavailable(pluginId: string): boolean {
    const instance = this.instances.get(pluginId);
    return (
      this.lifecycle.has(pluginId) ||
      this.pendingCrashes.has(pluginId) ||
      this.state.transaction?.pluginId === pluginId ||
      !!(instance && instance.scope.state !== "active")
    );
  }
  private assertDispatch(
    metadata: PluginPackageMetadata,
    command?: PluginPackageMetadata["spark233"]["commands"][number],
  ): void {
    if (!this.ready || this.exclusive)
      throw new AppError("pluginBusy", "插件正在全局维护，请稍后重试");
    if (this.unavailable(metadata.spark233.id))
      throw new AppError("pluginStopping", "插件正在变更或停止，请重新调用");
    this.dependencies(metadata);
    if (command && !this.commandDependenciesAvailable(metadata, command))
      throw new AppError(
        "pluginDependencyUnavailable",
        "该命令所需的插件不可用，请检查插件状态或版本",
      );
    for (const id of this.protectedIds(metadata, command)) {
      if (id === metadata.spark233.id) continue;
      if (this.unavailable(id) || this.starting.has(id))
        throw new AppError("pluginDependencyUnavailable", `依赖正在变更或初始化：${id}`);
    }
  }
  private assertMutationDependencies(metadata: PluginPackageMetadata): void {
    for (const id of this.protectedIds(metadata, undefined, true)) {
      if (id === metadata.spark233.id) continue;
      if (this.unavailable(id) || this.starting.has(id))
        throw new AppError("pluginStarting", `依赖正在变更或初始化：${id}`);
    }
  }
  private persist(): void {
    atomicWrite(this.options.stateFile, JSON.stringify(this.state, null, 2));
    this.notifyChange();
  }
  private notifyChange(): void {
    // Availability events keep the original observer contract: a committed
    // state file must exist before observers are asked to read it.
    if (!fs.existsSync(this.options.stateFile)) return;
    try {
      this.options.onChange?.();
    } catch (error) {
      console.error("plugin-state-notification", error);
    }
  }
  private assertDirectory(record: PluginInstallation): void {
    const expected = getPluginVersionDirectory(
      this.options.packages,
      record.pluginId,
      record.version,
    );
    if (canonical(expected) !== canonical(record.directory))
      throw new AppError("invalidPluginState", "插件代码目录与版本身份不一致");
  }
  private metadata(record: PluginInstallation): PluginPackageMetadata {
    this.assertDirectory(record);
    const metadata = validatePluginDirectory(record.directory, this.options.environment, {
      name: record.packageName,
      version: record.version,
      pluginId: record.pluginId,
    });
    if (this.digest(record.directory) !== record.manifestDigest)
      throw new AppError("pluginChanged", "已安装插件清单发生变化，请重新安装并确认能力");
    this.assertGrant(metadata, record.grant);
    return metadata;
  }
  private digest(directory: string): string {
    return createHash("sha256")
      .update(fs.readFileSync(confined(directory, "package.json")))
      .digest("hex");
  }
  private assertGrant(metadata: PluginPackageMetadata, grant: PluginTrustGrant): void {
    pluginTrustGrantSchema.parse(grant);
    if (
      metadata.spark233.capabilities.some((capability) => !grant.capabilities.includes(capability))
    ) {
      throw new AppError("pluginPermissionRequired", "插件申请的能力需要用户确认");
    }
    if (
      (metadata.spark233.backend ||
        metadata.spark233.migration ||
        Object.keys(metadata.spark233.native).length) &&
      !grant.native
    ) {
      throw new AppError("pluginTrustRequired", "第三方 Node 或原生执行需要显式信任");
    }
  }
  dataDirectory(pluginId: string): string {
    if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(pluginId) || !isPluginPackagePath(pluginId))
      throw new AppError("invalidPlugin", "插件身份不合法");
    const external = this.options.resolveDataDirectory?.(pluginId);
    if (external) {
      if (!path.isAbsolute(external) || path.parse(external).root === path.resolve(external))
        throw new AppError("unsafePath", "插件数据目录必须是独立业务目录");
      return canonical(external);
    }
    return confined(this.options.dataRoot, pluginId);
  }
  /** Host-owned schema state survives uninstall when its data is retained. */
  committedDataVersion(pluginId: string): PluginCommittedDataVersion | undefined {
    const value = Object.hasOwn(this.state.dataVersions, pluginId)
      ? this.state.dataVersions[pluginId]
      : undefined;
    return value ? structuredClone(value) : undefined;
  }
  private baselineDataVersion(record: PluginInstallation): PluginCommittedDataVersion {
    // metadata() validates both the package identity and persisted manifest hash.
    const metadata = this.metadata(record);
    const known = this.committedDataVersion(record.pluginId);
    if (
      known &&
      (known.packageName !== record.packageName ||
        known.dataVersion !== metadata.spark233.dataVersion ||
        known.pluginVersion !== record.version)
    )
      throw new AppError("pluginDataVersionMismatch", "已提交数据版本与插件代码不匹配");
    return (this.state.dataVersions[record.pluginId] ??= {
      packageName: record.packageName,
      dataVersion: metadata.spark233.dataVersion,
      pluginVersion: record.version,
    });
  }
  private async hasDataPayload(root: string): Promise<boolean> {
    // Hosts may create empty framework directories before first installation.
    // Any file (including zero bytes), link or special entry is real unknown
    // data. Bound this check and conservatively reject larger/unreadable trees.
    let visited = 0;
    const visit = async (directory: string, depth: number): Promise<boolean> => {
      if (++visited > 512 || depth > 16) return true;
      const info = await fs.promises.lstat(directory);
      if (info.isSymbolicLink() || !info.isDirectory()) return true;
      for await (const entry of await fs.promises.opendir(directory))
        if (await visit(path.join(directory, entry.name), depth + 1)) return true;
      return false;
    };
    try {
      return await visit(root, 0);
    } catch {
      return true;
    }
  }
  list(): Array<PluginInstallation & { status: string; instanceId?: string }> {
    return Object.values(this.state.plugins).map((record) => {
      const instance = this.instances.get(record.pluginId);
      return structuredClone({
        ...record,
        status: record.lastError
          ? "error"
          : instance
            ? instance.scope.state
            : record.enabled
              ? "enabled"
              : "disabled",
        ...(instance ? { instanceId: instance.scope.owner.instanceId } : {}),
      });
    });
  }
  describe(pluginId: string): PluginPackageMetadata {
    return structuredClone(this.metadata(this.record(pluginId)));
  }
  commandDependenciesAvailable(
    metadata: PluginPackageMetadata,
    command: PluginPackageMetadata["spark233"]["commands"][number],
  ): boolean {
    return (command.requiresPlugins ?? []).every((id) => {
      const range =
        metadata.spark233.dependencies[id] ?? metadata.spark233.optionalDependencies[id];
      const dependency = this.find(id);
      return (
        range !== undefined &&
        dependency?.enabled === true &&
        !dependency.lastError &&
        !this.unavailable(id) &&
        !this.starting.has(id) &&
        semver.satisfies(dependency.version, range)
      );
    });
  }
  commands(): Array<{
    pluginId: string;
    command: PluginPackageMetadata["spark233"]["commands"][number];
  }> {
    return Object.values(this.state.plugins)
      .filter(
        (record) =>
          this.ready &&
          !this.exclusive &&
          record.enabled &&
          !record.lastError &&
          !this.unavailable(record.pluginId),
      )
      .flatMap((record) => {
        try {
          const metadata = this.metadata(record);
          return metadata.spark233.commands
            .filter(
              (command) =>
                !command.internal && this.commandDependenciesAvailable(metadata, command),
            )
            .map((command) => ({
              pluginId: record.pluginId,
              command,
            }));
        } catch (error) {
          record.lastError = String(error);
          return [];
        }
      });
  }
  private record(pluginId: string): PluginInstallation {
    const record = this.find(pluginId);
    if (!record) throw new AppError("pluginNotInstalled", "插件未安装");
    return record;
  }
  private find(pluginId: string): PluginInstallation | undefined {
    return Object.hasOwn(this.state.plugins, pluginId) ? this.state.plugins[pluginId] : undefined;
  }
  private dependencies(metadata: PluginPackageMetadata): void {
    for (const [id, range] of Object.entries(metadata.spark233.dependencies)) {
      const dependency = this.find(id);
      if (
        !dependency?.enabled ||
        dependency.lastError ||
        !semver.satisfies(dependency.version, range)
      ) {
        throw new AppError("pluginDependencyUnavailable", `必需插件不可用：${id} (${range})`);
      }
    }
    for (const [id, range] of Object.entries(metadata.spark233.optionalDependencies)) {
      const dependency = this.find(id);
      if (dependency?.enabled && !semver.satisfies(dependency.version, range))
        throw new AppError("incompatiblePluginDependency", `可选插件版本不兼容：${id}`);
    }
  }
  private dependents(pluginId: string, nextVersion?: string): void {
    for (const record of Object.values(this.state.plugins)) {
      if (!record.enabled || record.pluginId === pluginId) continue;
      const manifest = this.metadata(record).spark233;
      const required = Object.hasOwn(manifest.dependencies, pluginId)
        ? manifest.dependencies[pluginId]
        : undefined;
      const optional = Object.hasOwn(manifest.optionalDependencies, pluginId)
        ? manifest.optionalDependencies[pluginId]
        : undefined;
      if (
        (required && (!nextVersion || !semver.satisfies(nextVersion, required))) ||
        (optional && nextVersion && !semver.satisfies(nextVersion, optional))
      ) {
        throw new AppError("pluginInUse", `插件 ${record.pluginId} 依赖当前版本，请先停用或更新它`);
      }
    }
  }
  private start(
    record: PluginInstallation,
    startupCheckOnly = false,
    internal = false,
  ): Promise<ManagedPluginRuntime> {
    if (!internal && this.exclusive)
      return Promise.reject(new AppError("pluginBusy", "插件正在全局维护"));
    const existing = this.instances.get(record.pluginId);
    if (existing) {
      if (existing.scope.state !== "active")
        throw new AppError("pluginStopping", "插件正在停止或需要恢复");
      return Promise.resolve(existing.runtime);
    }
    const pending = this.starting.get(record.pluginId);
    if (pending) {
      if (this.factoryContext.getStore()?.active)
        return Promise.reject(
          new AppError("pluginStarting", `嵌套初始化不能等待正在启动的插件：${record.pluginId}`),
        );
      if (pending.record !== record)
        return Promise.reject(new AppError("pluginStarting", "插件启动身份已变化"));
      return pending.promise;
    }
    const metadata = this.metadata(record);
    if (!startupCheckOnly) this.dependencies(metadata);
    fs.mkdirSync(this.dataDirectory(record.pluginId), { recursive: true });
    const scope = new PluginResourceScope({
      pluginId: record.pluginId,
      version: record.version,
      instanceId: randomUUID(),
    });
    const token = { owner: scope.owner, active: true };
    // Register ownership before invoking the factory. Concurrent callers share
    // setup only; no lock is held across the resulting business task.
    const entry = {
      record,
      scope,
      protectedIds: this.protectedIds(metadata, undefined, true),
      promise: undefined as unknown as Promise<ManagedPluginRuntime>,
    };
    this.starting.set(record.pluginId, entry);
    entry.promise = this.factoryContext.run(token, async () => {
      try {
        const runtime = await this.options.createRuntime(
          structuredClone(record),
          metadata,
          scope,
          startupCheckOnly,
        );
        const crashed = this.pendingCrashes.get(record.pluginId);
        if (
          this.find(record.pluginId) !== record ||
          (crashed && samePluginOwner(crashed, scope.owner))
        )
          throw new AppError("pluginStarting", "初始化期间插件身份或进程状态发生变化");
        this.instances.set(record.pluginId, { scope, runtime });
        return runtime;
      } catch (error) {
        const released = await scope.stop("crash");
        if (!released.ok) {
          // Keep failed resources reachable for diagnostics/retry instead of leaking
          // an unowned worker after a partially initialized runtime.
          this.instances.set(record.pluginId, {
            scope,
            runtime: {
              activate: async () => {
                throw new AppError("pluginFailed", "插件初始化失败，请先停止并恢复");
              },
            },
          });
        }
        throw error;
      } finally {
        token.active = false;
        if (this.starting.get(record.pluginId) === entry) this.starting.delete(record.pluginId);
        this.notifyChange();
      }
    });
    this.notifyChange();
    return entry.promise;
  }
  private async stop(pluginId: string, reason: StopReason): Promise<void> {
    const instance = this.instances.get(pluginId);
    if (!instance) return;
    if (instance.scope.state !== "releasing" && instance.scope.state !== "released") {
      const decision = await instance.scope.prepareStop(this.stopReason(instance.scope, reason));
      if (!decision.ok) throw new AppError("pluginSaveRefused", decision.reason);
    }
    const released = await instance.scope.release();
    if (!released.ok) throw new AppError("pluginReleaseFailed", released.errors.join("; "));
    this.instances.delete(pluginId);
    this.crashedInstances.delete(instance.scope.owner.instanceId);
  }

  private stopReason(scope: PluginResourceScope, reason: StopReason): StopReason {
    return this.crashedInstances.has(scope.owner.instanceId) ? "crash" : reason;
  }

  /** Only a matching live instance may report a terminal process failure. Save
   * surviving resources normally; the dead process cannot acknowledge a save. */
  reportCrash(owner: PluginOwner, error: Error): Promise<void> {
    const reportedRecord = this.find(owner.pluginId);
    const scope =
      this.instances.get(owner.pluginId)?.scope ?? this.starting.get(owner.pluginId)?.scope;
    if (!reportedRecord || !scope || !samePluginOwner(scope.owner, owner)) return Promise.resolve();
    // Fence the exact failed owner now, even while an unrelated mutation owns
    // the persistence queue. Its record is changed only inside that queue.
    this.pendingCrashes.set(owner.pluginId, owner);
    this.crashedInstances.add(owner.instanceId);
    this.notifyChange();
    return this.serial(async () => {
      try {
        const pending = this.starting.get(owner.pluginId);
        if (pending && samePluginOwner(pending.scope.owner, owner))
          await pending.promise.catch(() => {});
        const instance = this.instances.get(owner.pluginId),
          record = this.find(owner.pluginId);
        if (
          record !== reportedRecord ||
          record.version !== owner.version ||
          (instance && !samePluginOwner(instance.scope.owner, owner))
        )
          return;
        record.lastError = `Plugin runtime crashed: ${error.message}`;
        this.persist();
        try {
          await this.stop(owner.pluginId, "crash");
        } catch (cleanup) {
          record.lastError += `; resources awaiting recovery: ${String(cleanup)}`;
        }
        this.persist();
      } finally {
        if (this.pendingCrashes.get(owner.pluginId) === owner)
          this.pendingCrashes.delete(owner.pluginId);
        this.notifyChange();
      }
    });
  }

  initialize(): Promise<void> {
    return this.exclusiveSerial(async () => {
      this.ready = false;
      if (this.state.transaction) {
        const transaction = this.state.transaction;
        try {
          await this.recover(transaction);
        } catch (error) {
          const record = this.find(transaction.pluginId);
          if (record) record.lastError = `插件更新需要恢复：${String(error)}`;
        }
      }
      for (const record of Object.values(this.state.plugins)) {
        if (this.state.transaction?.pluginId !== record.pluginId) {
          try {
            this.baselineDataVersion(record);
          } catch (error) {
            record.lastError = String(error);
            continue;
          }
        }
        if (
          !record.enabled ||
          record.lastError ||
          this.state.transaction?.pluginId === record.pluginId
        )
          continue;
        try {
          const metadata = this.metadata(record);
          this.dependencies(metadata);
          if (metadata.spark233.activation === "on-startup")
            await (await this.start(record, false, true)).activate({});
        } catch (error) {
          await this.activationFailed(record, error);
        }
      }
      this.persist();
      this.ready = true;
    });
  }
  activate(pluginId: string, activation: PluginActivation): Promise<JsonValue | undefined> {
    return this.dispatch(pluginId, activation, false);
  }
  query(pluginId: string, activation: PluginActivation): Promise<JsonValue | undefined> {
    return this.dispatch(pluginId, activation, true);
  }
  private async dispatch(
    pluginId: string,
    activation: PluginActivation,
    query: boolean,
  ): Promise<JsonValue | undefined> {
    const record = this.record(pluginId);
    if (!record.enabled || record.lastError)
      throw new AppError("pluginDisabled", "插件已停用或存在错误");
    const metadata = this.metadata(record);
    const command = activation.commandId
      ? metadata.spark233.commands.find((command) => command.id === activation.commandId)
      : undefined;
    if (activation.commandId && !command)
      throw new AppError("unknownPluginCommand", "插件命令未注册");
    this.assertDispatch(metadata, command);
    const runtime = await this.start(record);
    if (this.find(pluginId) !== record || this.instances.get(pluginId)?.runtime !== runtime)
      throw new AppError("pluginStopping", "插件实例已变化，请重新调用");
    this.assertDispatch(this.metadata(record), command);
    return query && runtime.query ? runtime.query(activation) : runtime.activate(activation);
  }
  setEnabled(pluginId: string, enabled: boolean): Promise<void> {
    return this.mutate(pluginId, async () => {
      const record = this.record(pluginId);
      if (record.enabled === enabled && !record.lastError) return;
      if (enabled) {
        if (record.lastError) await this.stop(pluginId, "crash");
        const metadata = this.metadata(record);
        this.assertMutationDependencies(metadata);
        this.dependencies(metadata);
        if (metadata.spark233.activation === "on-startup") {
          try {
            await (await this.start(record, false, true)).activate({});
          } catch (error) {
            await this.activationFailed(record, error);
            this.persist();
            throw new AppError("pluginActivationFailed", record.lastError!);
          }
        }
        record.enabled = true;
        delete record.lastError;
      } else {
        this.dependents(pluginId);
        await this.stop(pluginId, "disable");
        record.enabled = false;
        delete record.lastError;
      }
      this.persist();
    });
  }

  private async activationFailed(record: PluginInstallation, error: unknown): Promise<void> {
    record.lastError = String(error);
    try {
      await this.stop(record.pluginId, "crash");
    } catch (cleanup) {
      record.lastError += `；后台尚未释放：${String(cleanup)}`;
    }
  }

  /** Caller presents package/version/capabilities and obtains this grant first. */
  install(staged: StagedPluginPackage, grant: PluginTrustGrant, enabled = true): Promise<void> {
    return this.mutate(staged.metadata.spark233.id, async () => {
      if (this.state.transaction)
        throw new AppError("pluginRecoveryRequired", "需要先恢复未完成的插件更新");
      const metadata = validatePluginDirectory(staged.directory, this.options.environment, {
        name: staged.metadata.name,
        version: staged.metadata.version,
        pluginId: staged.metadata.spark233.id,
      });
      const id = metadata.spark233.id;
      this.assertMutationDependencies(metadata);
      this.assertGrant(metadata, grant);
      const before = this.find(id);
      const beforeDataVersion = before
        ? this.baselineDataVersion(before)
        : this.committedDataVersion(id);
      const afterDataVersion = {
        packageName: metadata.name,
        dataVersion: metadata.spark233.dataVersion,
        pluginVersion: metadata.version,
      };
      const data = this.dataDirectory(id);
      if (beforeDataVersion && beforeDataVersion.packageName !== metadata.name)
        throw new AppError("pluginIdentityMismatch", "其他 npm 包不能接管保留的插件数据");
      if (!beforeDataVersion && fs.existsSync(data) && (await this.hasDataPayload(data)))
        throw new AppError(
          "pluginDataVersionUnknown",
          "已有插件数据缺少已提交版本，不能猜测兼容或迁移",
        );
      if (beforeDataVersion && afterDataVersion.dataVersion < beforeDataVersion.dataVersion)
        throw new AppError("pluginDataDowngrade", "不能将保留数据降级到较旧的数据版本");
      const migration =
        beforeDataVersion && afterDataVersion.dataVersion > beforeDataVersion.dataVersion
          ? {
              fromDataVersion: beforeDataVersion.dataVersion,
              toDataVersion: afterDataVersion.dataVersion,
              fromPluginVersion: beforeDataVersion.pluginVersion,
              toPluginVersion: metadata.version,
            }
          : undefined;
      if (migration && (!metadata.spark233.migration || !this.options.migrateData))
        throw new AppError("pluginMigrationRequired", "此数据版本升级需要声明可信迁移入口");
      if (before?.packageName !== undefined && before.packageName !== metadata.name)
        throw new AppError("pluginIdentityMismatch", "其他 npm 包不能覆盖已安装插件身份");
      if (before?.version === metadata.version)
        throw new AppError("pluginVersionExists", "同一版本不作为覆盖更新方式");
      this.dependents(id, metadata.version);
      if (before?.enabled ?? enabled) this.dependencies(metadata);
      const after: PluginInstallation = {
        pluginId: id,
        packageName: metadata.name,
        version: metadata.version,
        directory: staged.directory,
        enabled: before?.enabled ?? enabled,
        source: staged.source,
        integrity: staged.integrity,
        manifestDigest: this.digest(staged.directory),
        grant: structuredClone(grant),
      };
      this.assertDirectory(after);
      if (before) await this.stop(id, "update");
      const transactionId = randomUUID();
      const journal: Journal = {
        id: transactionId,
        pluginId: id,
        phase: "prepared",
        before,
        after,
        backup: confined(this.options.backupRoot, transactionId),
        dataExisted: fs.existsSync(this.dataDirectory(id)),
        beforeDataVersion,
        afterDataVersion,
      };
      this.state.transaction = journal;
      try {
        this.persist();
        if (journal.dataExisted)
          await this.copyData(this.dataDirectory(id), confined(journal.backup, "data"));
        journal.phase = "backed-up";
        this.persist();
        if (migration) {
          journal.phase = "migrating";
          this.persist();
          await this.options.migrateData!(after, metadata, migration);
        }
        this.state.plugins[id] = after;
        journal.phase = "switched";
        this.persist();
        {
          // A real runtime is created for startup validation even for on-command
          // plugins; activate is only sent for explicit on-startup policy.
          const runtime = await this.start(after, !after.enabled, true);
          if (after.enabled && metadata.spark233.activation === "on-startup")
            await runtime.activate({});
          if (!after.enabled) await this.stop(id, "update");
        }
        this.state.dataVersions[id] = afterDataVersion;
        delete this.state.transaction;
        this.persist();
      } catch (error) {
        try {
          await this.recover(journal);
        } catch (recovery) {
          throw new AppError("pluginRecoveryRequired", `${String(error)}; ${String(recovery)}`);
        }
        throw error;
      }
    });
  }
  private async copyData(source: string, destination: string): Promise<void> {
    await fs.promises.mkdir(path.dirname(destination), { recursive: true });
    await fs.promises.cp(source, destination, {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: async (file) => {
        if ((await fs.promises.lstat(file)).isSymbolicLink())
          throw new AppError("pluginBackupFailed", "插件数据包含链接，需要先明确备份范围");
        return true;
      },
    });
  }
  private async recover(journal: Journal): Promise<void> {
    if (
      journal.pluginId !== journal.after.pluginId ||
      (journal.before && journal.pluginId !== journal.before.pluginId)
    ) {
      throw new AppError("invalidPluginState", "恢复事务的插件身份不一致");
    }
    this.assertDirectory(journal.after);
    if (journal.before) this.assertDirectory(journal.before);
    const expectedBackup = confined(this.options.backupRoot, journal.id);
    if (
      !inside(canonical(this.options.backupRoot), canonical(journal.backup)) ||
      canonical(expectedBackup) !== canonical(journal.backup)
    )
      throw new AppError("invalidPluginState", "恢复目录不合法");
    if (journal.phase === "switched" || journal.phase === "migrating") {
      await this.stop(journal.pluginId, "update");
      const data = this.dataDirectory(journal.pluginId);
      // Move the uncommitted version's entire data aside before restoring. This
      // also makes an interrupted recovery repeatable without overwriting it.
      if (fs.existsSync(data)) {
        const preserved = confined(
          this.options.dataRoot,
          ".recovery",
          journal.pluginId,
          journal.id,
          randomUUID(),
        );
        fs.mkdirSync(path.dirname(preserved), { recursive: true });
        try {
          fs.renameSync(data, preserved);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
          // A user-selected notes directory may be on another volume. Preserve
          // the whole failed version before removing its uncommitted location.
          await this.copyData(data, preserved);
          fs.rmSync(data, { recursive: true, force: true });
        }
      }
      if (journal.dataExisted) await this.copyData(confined(journal.backup, "data"), data);
    }
    if (journal.before) this.state.plugins[journal.pluginId] = journal.before;
    else delete this.state.plugins[journal.pluginId];
    const previousDataVersion =
      journal.beforeDataVersion ??
      (journal.before
        ? {
            packageName: journal.before.packageName,
            dataVersion: this.metadata(journal.before).spark233.dataVersion,
            pluginVersion: journal.before.version,
          }
        : undefined);
    if (previousDataVersion) this.state.dataVersions[journal.pluginId] = previousDataVersion;
    else delete this.state.dataVersions[journal.pluginId];
    delete this.state.transaction;
    this.persist();
    if (
      journal.before?.enabled &&
      this.metadata(journal.before).spark233.activation === "on-startup"
    ) {
      await (await this.start(journal.before, false, true)).activate({});
    }
  }

  uninstall(pluginId: string, deleteData = false): Promise<void> {
    return this.mutate(pluginId, async () => {
      const record = this.record(pluginId);
      this.dependents(pluginId);
      await this.stop(pluginId, "uninstall");
      this.baselineDataVersion(record);
      // Persist the inactive identity before removing immutable code. A crash
      // cannot restart a version that is midway through being removed.
      delete this.state.plugins[pluginId];
      this.persist();
      const directory = path.dirname(
        getPluginVersionDirectory(this.options.packages, record.pluginId, record.version),
      );
      fs.rmSync(directory, { recursive: true, force: true });
      if (deleteData) {
        fs.rmSync(this.dataDirectory(pluginId), { recursive: true, force: true });
        delete this.state.dataVersions[pluginId];
        this.persist();
      }
    });
  }
  shutdown(): Promise<void> {
    return this.exclusiveSerial(async () => {
      const prepared: PluginResourceScope[] = [];
      for (const { scope } of this.instances.values()) {
        if (scope.state === "releasing" || scope.state === "released") continue;
        const decision = await scope.prepareStop(this.stopReason(scope, "quit"));
        if (!decision.ok) {
          for (const previous of prepared) previous.cancelStop();
          throw new AppError("pluginSaveRefused", decision.reason);
        }
        prepared.push(scope);
      }
      for (const [id] of this.instances) await this.stop(id, "quit");
      this.ready = false;
    });
  }
}

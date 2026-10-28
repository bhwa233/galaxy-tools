import { renameWithRetry } from "../filesystem.js";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import semver from "semver";
import { isPluginPackagePath } from "@spark233/sdk";
import { AppError, atomicWrite, canonical, confined, inside, readJson } from "../persistence.js";
import {
  PluginManager,
  pluginTrustGrantSchema,
  type PluginInstallation,
  type PluginMaintenanceAccess,
  type PluginManagerSnapshot,
} from "./manager.js";
import type { BackupInspection, BackupReport } from "../../src/features/backup/types.js";
export type { BackupInspection, BackupReport } from "../../src/features/backup/types.js";

export interface PluginBackupServiceOptions {
  manager: PluginManager;
  hostVersion: string;
  hostRoot: string;
  pluginRoot: string;
  /** Authorized plugin data domains, including retained/uninstalled plugins. */
  externalDataRoots: () => Readonly<Record<string, string>>;
  /** Compatibility aliases are product wiring, never business knowledge here. */
  legacyMountAliases?: Readonly<Record<string, string>>;
  /** Restore host-owned root pointers without interpreting a plugin's files. */
  rewriteHostConfig?: (value: unknown, roots: Readonly<Record<string, string>>) => unknown;
  recoveryRoot: string;
  configFile?: string;
  /** Persist exclusions and drain in-flight search before creating private copies. */
  protectRoots?: (roots: readonly string[]) => Promise<void>;
  /** Fence new host/config/CLI/admin writes while allowing existing save acks. */
  pauseHost: () => Promise<() => void | Promise<void>>;
  /** Reload host/store/layout memory from the restored files, before restart. */
  reloadHost: () => void | Promise<void>;
}
const relativePath = z.string().max(512).refine(isPluginPackagePath);
const entrySchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("directory"), path: relativePath }),
  z.strictObject({
    kind: z.literal("file"),
    path: relativePath,
    bytes: z.number().int().nonnegative().safe(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);
const mountSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9.-]{0,100}$/),
  originalPath: z.string(),
  exists: z.boolean(),
});
const manifestSchema = z.strictObject({
  schemaVersion: z.union([z.literal(1), z.literal(2)]),
  product: z.literal("com.spark233.desktop"),
  hostVersion: z.string().refine((value) => !!semver.valid(value)),
  platform: z.string(),
  arch: z.string(),
  createdAt: z.iso.datetime(),
  mounts: z.array(mountSchema).min(2).max(256),
  entries: z.array(entrySchema).max(200_000),
  manager: z.unknown(),
});
type Manifest = z.infer<typeof manifestSchema>;
type Entry = z.infer<typeof entrySchema>;
interface Mount {
  id: string;
  root: string;
  exclusions: string[];
}
interface VerifiedBackupInspection extends BackupInspection {
  manifestFingerprint: string;
}
const pluginIdSchema = z
  .string()
  .max(80)
  .regex(/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/);
const externalRootsSchema = z
  .record(pluginIdSchema, z.string())
  .refine((roots) => Object.keys(roots).length <= 254, "Too many external plugin data roots");
const journalBaseSchema = z.strictObject({
  id: z.uuid(),
  phase: z.enum(["prepared", "switching", "applied", "committed", "rolled-back"]),
  previous: z.unknown(),
  targets: z
    .array(
      z.strictObject({
        target: z.string(),
        stage: z.string(),
        previous: z.string(),
        failed: z.string(),
        existed: z.boolean(),
      }),
    )
    .min(1)
    .max(256),
});
const journalSchema = z.discriminatedUnion("schemaVersion", [
  journalBaseSchema.extend({
    schemaVersion: z.literal(1),
    roots: z.record(z.string(), z.string()).refine((value) => !!value.host && !!value.plugins),
  }),
  journalBaseSchema.extend({
    schemaVersion: z.literal(2),
    roots: z.strictObject({
      host: z.string(),
      plugins: z.string(),
      externalData: externalRootsSchema,
    }),
  }),
]);
type RestoreJournal = Omit<z.infer<typeof journalSchema>, "previous"> & {
  previous: PluginManagerSnapshot;
};

function journalDataRoots(
  journal: z.infer<typeof journalSchema>,
  aliases: Readonly<Record<string, string>> = {},
): Record<string, string> {
  if (journal.schemaVersion === 2) return externalRootsSchema.parse(journal.roots.externalData);
  const roots: Record<string, string> = {};
  for (const [mount, root] of Object.entries(journal.roots)) {
    if (mount === "host" || mount === "plugins") continue;
    const pluginId = aliases[mount];
    if (!pluginId || Object.hasOwn(roots, pluginId))
      throw new AppError("invalidBackup", "旧恢复日志缺少已授权的数据域别名或存在重复身份");
    roots[pluginIdSchema.parse(pluginId)] = root;
  }
  return roots;
}

function checkedRoot(root: string, missing = false): string {
  if (!path.isAbsolute(root) || path.resolve(root) === path.parse(root).root)
    throw new AppError("unsafeBackupPath", "备份范围必须是独立应用目录");
  let current = path.resolve(root);
  while (current !== path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new AppError("unsafeBackupPath", "备份路径不允许符号链接或目录联接");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    current = path.dirname(current);
  }
  if (!missing && (!fs.existsSync(root) || !fs.statSync(root).isDirectory()))
    throw new AppError("invalidBackup", "备份目录不存在");
  return canonical(root);
}
function readControlJson(file: string): unknown {
  const info = fs.lstatSync(file);
  if (info.isSymbolicLink() || !info.isFile() || info.size > 8 * 1024 * 1024)
    throw new AppError("invalidBackup", "恢复控制文件不合法或超过大小限制");
  return readJson(file);
}
export interface PendingBackupRootsOptions {
  hostRoot: string;
  pluginRoot: string;
  recoveryRoot: string;
  defaultDataRoots: Readonly<Record<string, string>>;
  /** Host adapter validates its own configuration format and pointer fields. */
  readHostDataRoots: (hostDirectory: string) => Readonly<Record<string, string>>;
  legacyMountAliases?: Readonly<Record<string, string>>;
}
/** Read before constructing host preferences: a power loss can leave their
 * directory temporarily at its recorded sibling. This does not move any data. */
export function readPendingBackupDataRoots(
  options: PendingBackupRootsOptions,
): Record<string, string> | undefined {
  const root = checkedRoot(options.recoveryRoot, true);
  const active = confined(root, "active.json");
  if (!fs.existsSync(active)) return;
  const { id } = z.strictObject({ id: z.uuid() }).parse(readControlJson(active));
  const journal = journalSchema.parse(readControlJson(confined(root, id, "journal.json")));
  if (
    journal.id !== id ||
    checkedRoot(journal.roots.host, true) !== checkedRoot(options.hostRoot, true) ||
    checkedRoot(journal.roots.plugins, true) !== checkedRoot(options.pluginRoot, true)
  )
    throw new AppError("unsafeBackupPath", "恢复日志与当前宿主目录不匹配");
  const roots = journalDataRoots(journal, options.legacyMountAliases);
  const checkedDataRoots = Object.values(roots).map((value) => checkedRoot(value, true));
  for (const [index, checked] of checkedDataRoots.entries()) {
    if (
      checkedDataRoots.some(
        (other, otherIndex) =>
          otherIndex !== index && (inside(other, checked) || inside(checked, other)),
      )
    )
      throw new AppError("unsafeBackupPath", "恢复插件数据域不能相互包含");
    for (const other of [root, options.hostRoot, options.pluginRoot])
      if (inside(canonical(other), checked) || inside(checked, canonical(other)))
        throw new AppError("unsafeBackupPath", "恢复插件数据目录与宿主范围重叠");
  }
  const index = journal.targets.findIndex(
    (target) => canonical(target.target) === canonical(options.hostRoot),
  );
  if (index < 0) throw new AppError("invalidBackup", "恢复日志缺少宿主配置目录");
  const target = journal.targets[index];
  const base = path.join(path.dirname(options.hostRoot), `.spark233-restore-${id}-${index}`);
  if (
    target.stage !== `${base}-stage` ||
    target.previous !== `${base}-previous` ||
    target.failed !== `${base}-failed`
  )
    throw new AppError("unsafeBackupPath", "宿主恢复目录名称不匹配");
  const candidates: Readonly<Record<string, string>>[] = [];
  for (const directory of [target.previous, target.target, target.stage]) {
    checkedRoot(directory, true);
    candidates.push(options.readHostDataRoots(directory));
  }
  for (const [pluginId, dataRoot] of Object.entries(roots)) {
    const checked = checkedRoot(dataRoot, true);
    const configured = candidates.filter((candidate) => Object.hasOwn(candidate, pluginId));
    // A known default is authority only when no persisted host configuration
    // candidate carries a pointer for this domain.
    const authorizedCandidates = configured.length ? configured : [options.defaultDataRoots];
    if (
      !authorizedCandidates.some((candidate) => {
        const authorized = Object.hasOwn(candidate, pluginId) ? candidate[pluginId] : undefined;
        return authorized && checkedRoot(authorized, true) === checked;
      })
    )
      throw new AppError("invalidBackup", "恢复日志中的插件数据目录缺少匹配的宿主配置");
  }
  return roots;
}

/** Reuses manager save/release ownership, standard directory copies and SHA-256.
 * Backups are explicit directory snapshots; no second archive parser is added. */
export class PluginBackupService {
  private operations: Promise<unknown> = Promise.resolve();
  constructor(private options: PluginBackupServiceOptions) {
    for (const root of [
      options.hostRoot,
      options.pluginRoot,
      options.recoveryRoot,
      ...Object.values(options.externalDataRoots()),
    ])
      this.safeRoot(root, true);
    // Keep all subsequent lexical mount comparisons in the same spelling as
    // the manager. Windows TEMP and persisted roots can use 8.3 aliases.
    this.options = {
      ...options,
      hostRoot: this.safeRoot(options.hostRoot, true),
      pluginRoot: this.safeRoot(options.pluginRoot, true),
      recoveryRoot: this.safeRoot(options.recoveryRoot, true),
    };
    this.disjoint(
      options.recoveryRoot,
      this.mounts().map((mount) => mount.root),
    );
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operations.catch(() => {}).then(operation);
    this.operations = next;
    return next;
  }
  private assertNoPendingRecovery(): void {
    if (fs.existsSync(confined(this.options.recoveryRoot, "active.json")))
      throw new AppError(
        "backupRecoveryRequired",
        "上次恢复尚未收尾，请重新启动 spark233 完成恢复后再操作",
      );
  }
  private safeRoot(root: string, missing = false): string {
    return checkedRoot(root, missing);
  }
  private safeFile(root: string, relative: string): string {
    if (!isPluginPackagePath(relative))
      throw new AppError("unsafeBackupPath", "备份中存在不安全相对路径");
    let file = root;
    for (const part of relative.split("/")) {
      file = path.join(file, part);
      try {
        if (fs.lstatSync(file).isSymbolicLink())
          throw new AppError("unsafeBackupPath", "备份文件不允许符号链接");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return confined(root, ...relative.split("/"));
  }
  private disjoint(root: string, sources: string[]): void {
    const target = canonical(root);
    if (
      sources.some(
        (source) => inside(canonical(source), target) || inside(target, canonical(source)),
      )
    )
      throw new AppError("unsafeBackupPath", "备份和恢复保护目录必须与应用源目录分离");
  }
  private mounts(
    records: Array<Pick<PluginInstallation, "pluginId">> = this.options.manager.list(),
  ): Mount[] {
    const initial = [
      { id: "host", root: this.safeRoot(this.options.hostRoot, true) },
      { id: "plugins", root: this.safeRoot(this.options.pluginRoot, true) },
      ...Object.entries(externalRootsSchema.parse(this.options.externalDataRoots())).map(
        ([pluginId, root]) => ({
          id: `plugin-data-${pluginId}`,
          root: this.safeRoot(root, true),
        }),
      ),
    ];
    for (let left = 0; left < initial.length; left++)
      for (let right = left + 1; right < initial.length; right++) {
        if (
          inside(initial[left].root, initial[right].root) ||
          inside(initial[right].root, initial[left].root)
        )
          throw new AppError(
            "unsafeBackupPath",
            "宿主、插件与外置数据域必须使用互不包含的独立目录",
          );
      }
    for (const record of records) {
      const root = this.safeRoot(this.options.manager.dataDirectory(record.pluginId), true);
      if (
        !inside(canonical(this.options.pluginRoot), root) &&
        !initial.some((item) => item.id === `plugin-data-${record.pluginId}` && item.root === root)
      )
        throw new AppError("invalidBackupLayout", "插件外置数据根必须由宿主登记后才能备份恢复");
    }
    const layout = this.options.manager.getBackupLayout();
    for (const file of [layout.stateFile, layout.packages.versionsRoot, layout.dataRoot])
      if (!inside(canonical(this.options.pluginRoot), canonical(file)))
        throw new AppError("invalidBackupLayout", "插件状态、代码和默认数据必须在注入的插件目录中");
    const omitted = [layout.packages.cacheRoot, layout.packages.stagingRoot, layout.backupRoot].map(
      (value) => canonical(value),
    );
    return initial.map((item) => ({
      ...item,
      exclusions: [
        ...initial
          .filter((other) => other.id !== item.id && inside(item.root, other.root))
          .map((other) => other.root),
        ...omitted.filter((value) => inside(item.root, value)),
      ],
    }));
  }
  private targetFor(id: string, manifest: Manifest): string {
    if (id === "host") return this.safeRoot(this.options.hostRoot, true);
    if (id === "plugins") return this.safeRoot(this.options.pluginRoot, true);
    const alias = manifest.schemaVersion === 1 ? this.options.legacyMountAliases?.[id] : undefined;
    const pluginId = alias ?? id.replace(/^plugin-data-/, "");
    const externalRoots = this.options.externalDataRoots();
    const externalRoot = Object.hasOwn(externalRoots, pluginId)
      ? externalRoots[pluginId]
      : undefined;
    if ((alias || id === `plugin-data-${pluginId}`) && externalRoot)
      return this.safeRoot(externalRoot, true);
    throw new AppError("invalidBackup", "备份的数据挂载身份未绑定当前授权的插件外置目录");
  }

  private async hash(file: string): Promise<string> {
    const digest = createHash("sha256");
    for await (const chunk of fs.createReadStream(file)) digest.update(chunk);
    return digest.digest("hex");
  }
  private async copyTree(
    source: string,
    destination: string,
    excluded: string[] = [],
    entryPrefix = "",
    entries: Entry[] = [],
  ): Promise<Entry[]> {
    this.safeRoot(source);
    const visit = async (relative: string) => {
      const input = relative ? this.safeFile(source, relative) : source;
      if (excluded.some((root) => inside(root, canonical(input)))) return;
      const info = await fsp.lstat(input);
      if (info.isSymbolicLink()) throw new AppError("unsafeBackupPath", "备份源包含链接");
      const output = relative ? this.safeFile(destination, relative) : destination;
      const key = [entryPrefix, relative].filter(Boolean).join("/");
      if (entries.length >= 200_000)
        throw new AppError("backupLimit", "备份文件数量超过当前快照上限");
      if (info.isDirectory()) {
        await fsp.mkdir(output, { recursive: true });
        if (key) entries.push({ kind: "directory", path: key });
        for (const name of (await fsp.readdir(input)).sort())
          await visit(relative ? `${relative}/${name}` : name);
      } else if (info.isFile()) {
        await fsp.mkdir(path.dirname(output), { recursive: true });
        await fsp.copyFile(input, output, fs.constants.COPYFILE_EXCL);
        const after = await fsp.lstat(input);
        if (
          after.isSymbolicLink() ||
          after.size !== info.size ||
          after.mtimeMs !== info.mtimeMs ||
          after.ino !== info.ino
        )
          throw new AppError("backupSourceChanged", "备份期间源文件发生变化，请重试");
        await fsp.chmod(output, info.mode & 0o777);
        if (key)
          entries.push({
            kind: "file",
            path: key,
            bytes: info.size,
            sha256: await this.hash(output),
          });
      } else throw new AppError("unsafeBackupPath", "备份只允许普通文件和目录");
    };
    await visit("");
    return entries;
  }
  private readManifest(directory: string): Manifest {
    const root = this.safeRoot(directory);
    const file = this.safeFile(root, "manifest.json");
    if (!fs.statSync(file).isFile() || fs.statSync(file).size > 64 * 1024 * 1024)
      throw new AppError("invalidBackup", "备份清单不是文件或超过大小限制");
    const manifest = manifestSchema.parse(readJson(file));
    if (manifest.platform !== process.platform || manifest.arch !== process.arch)
      throw new AppError("incompatibleBackup", "备份平台或架构与当前宿主不兼容");
    if (semver.gt(manifest.hostVersion, this.options.hostVersion))
      throw new AppError("incompatibleBackup", "备份由较新版本创建，请先升级 spark233");
    const ids = new Set(manifest.mounts.map((mount) => mount.id));
    if (ids.size !== manifest.mounts.length || !["host", "plugins"].every((id) => ids.has(id)))
      throw new AppError("invalidBackup", "备份挂载重复或不完整");
    const previous = z
      .object({ plugins: z.array(z.object({ pluginId: z.string() })) })
      .parse(manifest.manager);
    const aliases = this.options.legacyMountAliases ?? {};
    const logicalIds = new Set(
      manifest.mounts.map((mount) =>
        manifest.schemaVersion === 1 && aliases[mount.id]
          ? `plugin-data-${aliases[mount.id]}`
          : mount.id,
      ),
    );
    if (logicalIds.size !== ids.size) throw new AppError("invalidBackup", "备份包含重复插件数据域");
    const expectedMounts = this.mounts(previous.plugins).filter((mount) => {
      if (!mount.id.startsWith("plugin-data-")) return true;
      const pluginId = mount.id.slice("plugin-data-".length);
      return (
        previous.plugins.some((record) => record.pluginId === pluginId) ||
        (manifest.schemaVersion === 1 && Object.values(aliases).includes(pluginId))
      );
    });
    if (expectedMounts.some((mount) => !logicalIds.has(mount.id)))
      throw new AppError("invalidBackup", "备份挂载与插件数据范围不一致");
    for (const mount of manifest.mounts) {
      if (!path.isAbsolute(mount.originalPath))
        throw new AppError("invalidBackup", "源目录身份不合法");
      this.targetFor(mount.id, manifest);
    }
    for (const mount of manifest.mounts) {
      const present = manifest.entries.some(
        (entry) => entry.path === mount.id && entry.kind === "directory",
      );
      if (
        present !== mount.exists ||
        (!mount.exists && manifest.entries.some((entry) => entry.path.startsWith(`${mount.id}/`)))
      )
        throw new AppError("invalidBackup", "备份挂载存在状态与文件清单不一致");
    }
    return manifest;
  }
  private sourceCodeDirectory(directory: string, record: PluginInstallation): string {
    const layout = this.options.manager.getBackupLayout();
    const relative = path
      .relative(
        canonical(this.options.pluginRoot),
        path.join(
          layout.packages.versionsRoot,
          encodeURIComponent(record.pluginId),
          encodeURIComponent(record.version),
        ),
      )
      .split(path.sep)
      .join("/");
    return this.safeFile(path.join(directory, "files", "plugins"), relative);
  }
  private async verifyTrustedCode(root: string, manifest: Manifest): Promise<void> {
    const state = this.options.manager.validateBackupSnapshot(manifest.manager, (record) =>
      this.sourceCodeDirectory(root, record),
    );
    for (const record of state.plugins) {
      if (!record.grant.native) continue;
      const candidate = this.sourceCodeDirectory(root, record);
      const prefix = path.relative(path.join(root, "files"), candidate).split(path.sep).join("/");
      const expected = new Map(
        manifest.entries
          .filter((entry) => entry.path === prefix || entry.path.startsWith(prefix + "/"))
          .map((entry) => [entry.path.slice(prefix.length).replace(/^\//, ""), entry]),
      );
      const verify = async (relative: string): Promise<void> => {
        const file = relative
          ? this.safeFile(record.directory, relative)
          : this.safeRoot(record.directory);
        const info = await fsp.lstat(file);
        const entry = expected.get(relative);
        if (
          !entry ||
          info.isSymbolicLink() ||
          (entry.kind === "directory"
            ? !info.isDirectory()
            : !info.isFile() ||
              info.size !== entry.bytes ||
              (await this.hash(file)) !== entry.sha256)
        )
          throw new AppError(
            "backupTrustRequired",
            "备份执行代码与本机已信任版本不一致，请先安装确认：" + record.pluginId,
          );
        expected.delete(relative);
        if (info.isDirectory())
          for (const name of await fsp.readdir(file))
            await verify(relative ? relative + "/" + name : name);
      };
      await verify("");
      if (expected.size)
        throw new AppError("backupTrustRequired", "备份包含未确认的执行代码：" + record.pluginId);
    }
  }
  private summary(directory: string, manifest: Manifest): BackupInspection {
    const state = z
      .object({
        plugins: z.array(
          z.object({
            pluginId: z.string(),
            version: z.string(),
            enabled: z.boolean(),
            grant: pluginTrustGrantSchema,
          }),
        ),
      })
      .parse(manifest.manager);
    return {
      snapshotDirectory: directory,
      createdAt: manifest.createdAt,
      hostVersion: manifest.hostVersion,
      plugins: state.plugins,
      files: manifest.entries.filter((entry) => entry.kind === "file").length,
      bytes: manifest.entries.reduce(
        (sum, entry) => sum + (entry.kind === "file" ? entry.bytes : 0),
        0,
      ),
    };
  }
  async inspect(directory: string): Promise<VerifiedBackupInspection> {
    const root = this.safeRoot(directory);
    const manifest = this.readManifest(root);
    await this.options.protectRoots?.([root]);
    const inspection = await this.inspectManifest(root, manifest);
    return {
      ...inspection,
      manifestFingerprint: createHash("sha256").update(JSON.stringify(manifest)).digest("hex"),
    };
  }
  private async inspectManifest(root: string, manifest: Manifest): Promise<BackupInspection> {
    const expected = new Map<string, Entry>();
    const spellings = new Set<string>();
    for (const entry of manifest.entries) {
      const key = entry.path.normalize("NFC").toUpperCase();
      if (
        spellings.has(key) ||
        !manifest.mounts.some((mount) => mount.id === entry.path.split("/")[0])
      )
        throw new AppError("invalidBackup", "备份包含重复、冲突或未知挂载路径");
      spellings.add(key);
      expected.set(entry.path, entry);
    }
    const payload = this.safeFile(root, "files");
    this.safeRoot(payload);
    const visit = async (relative: string) => {
      const file = this.safeFile(payload, relative);
      const info = await fsp.lstat(file);
      const entry = expected.get(relative);
      if (
        !entry ||
        info.isSymbolicLink() ||
        (entry.kind === "directory" ? !info.isDirectory() : !info.isFile())
      )
        throw new AppError("invalidBackup", "备份文件类型或清单范围不一致");
      expected.delete(relative);
      if (entry.kind === "directory")
        for (const name of await fsp.readdir(file)) await visit(`${relative}/${name}`);
      else if (info.size !== entry.bytes || (await this.hash(file)) !== entry.sha256)
        throw new AppError("invalidBackup", "备份文件大小或 SHA-256 校验失败");
    };
    for (const name of await fsp.readdir(payload)) await visit(name);
    if (expected.size) throw new AppError("invalidBackup", "备份缺少清单中的文件");
    if ((await fsp.readdir(root)).some((name) => !["manifest.json", "files"].includes(name)))
      throw new AppError("invalidBackup", "快照根目录包含未登记内容");
    const state = this.options.manager.validateBackupSnapshot(manifest.manager, (record) =>
      this.sourceCodeDirectory(root, record),
    );
    const stateRelative = path
      .relative(
        canonical(this.options.pluginRoot),
        this.options.manager.getBackupLayout().stateFile,
      )
      .split(path.sep)
      .join("/");
    const stored = z
      .object({
        schemaVersion: z.literal(1),
        plugins: z.record(z.string(), z.unknown()),
        dataVersions: z.record(z.string(), z.unknown()).optional(),
      })
      .strict()
      .parse(readJson(this.safeFile(path.join(root, "files", "plugins"), stateRelative)));
    const storedState = this.options.manager.validateBackupSnapshot(
      {
        schemaVersion: 1,
        plugins: Object.values(stored.plugins),
        dataVersions: stored.dataVersions,
      },
      (record) => this.sourceCodeDirectory(root, record),
    );
    if (JSON.stringify(state) !== JSON.stringify(storedState))
      throw new AppError("invalidBackup", "插件状态文件与快照版本清单不一致");
    return this.summary(root, manifest);
  }
  create(destinationDirectory: string): Promise<BackupReport> {
    return this.serial(async () => {
      this.assertNoPendingRecovery();
      const parent = this.safeRoot(destinationDirectory);
      const snapshot = path.join(
        parent,
        `spark233-backup-${new Date().toISOString().replaceAll(/[:.]/g, "-")}-${randomUUID()}`,
      );
      this.disjoint(
        snapshot,
        this.mounts().map((mount) => mount.root),
      );
      const resumeHost = await this.options.pauseHost();
      try {
        return await this.options.manager.withQuiesced(async (access) => {
          const mounts = this.mounts();
          this.disjoint(
            snapshot,
            mounts.map((mount) => mount.root),
          );
          const entries: Entry[] = [];
          await this.options.protectRoots?.([snapshot]);
          await fsp.mkdir(path.join(snapshot, "files"), { recursive: true });
          try {
            for (const mount of mounts)
              if (fs.existsSync(mount.root))
                await this.copyTree(
                  mount.root,
                  path.join(snapshot, "files", mount.id),
                  mount.exclusions,
                  mount.id,
                  entries,
                );
            const manifest: Manifest = {
              schemaVersion: 2,
              product: "com.spark233.desktop",
              hostVersion: this.options.hostVersion,
              platform: process.platform,
              arch: process.arch,
              createdAt: new Date().toISOString(),
              mounts: mounts.map((mount) => ({
                id: mount.id,
                originalPath: mount.root,
                exists: fs.existsSync(mount.root),
              })),
              entries,
              manager: access.snapshot(),
            };
            atomicWrite(path.join(snapshot, "manifest.json"), JSON.stringify(manifest, null, 2));
            const inspection = await this.inspect(snapshot);
            return {
              snapshotDirectory: snapshot,
              files: inspection.files,
              bytes: inspection.bytes,
              warnings: [],
            };
          } catch (error) {
            await fsp.rm(snapshot, { recursive: true, force: true });
            throw error;
          }
        });
      } finally {
        await resumeHost();
      }
    });
  }
  private journalFile(id: string): string {
    return confined(this.options.recoveryRoot, id, "journal.json");
  }
  private persistJournal(journal: RestoreJournal): void {
    atomicWrite(this.journalFile(journal.id), JSON.stringify(journal, null, 2));
    atomicWrite(
      confined(this.options.recoveryRoot, "active.json"),
      JSON.stringify({ id: journal.id }),
    );
  }
  private async archivePrevious(journal: RestoreJournal, warnings: string[]): Promise<void> {
    for (let index = 0; index < journal.targets.length; index++) {
      for (const [label, source] of [
        ["previous", journal.targets[index].previous],
        ["failed", journal.targets[index].failed],
      ] as const) {
        if (!fs.existsSync(source)) continue;
        const destination = confined(this.options.recoveryRoot, journal.id, label, String(index));
        if (fs.existsSync(destination)) {
          warnings.push(`保护副本已存在，保留原目录：${source}`);
          continue;
        }
        try {
          await this.copyTree(source, destination);
          await fsp.rm(source, { recursive: true, force: true });
        } catch {
          warnings.push(`保护副本保留在原卷：${source}`);
        }
      }
    }
  }
  private async rollback(
    journal: RestoreJournal,
    access: PluginMaintenanceAccess,
    warnings: string[],
  ): Promise<void> {
    for (const target of [...journal.targets].reverse()) {
      if (fs.existsSync(target.previous)) {
        if (fs.existsSync(target.target)) {
          if (fs.existsSync(target.failed))
            throw new AppError(
              "backupRecoveryRequired",
              "恢复失败数据目录已存在，请保留并人工处理",
            );
          await renameWithRetry(target.target, target.failed);
        }
        await renameWithRetry(target.previous, target.target);
      } else if (!target.existed && fs.existsSync(target.target)) {
        if (fs.existsSync(target.failed))
          throw new AppError("backupRecoveryRequired", "恢复失败数据目录冲突");
        await renameWithRetry(target.target, target.failed);
      }
      if (fs.existsSync(target.stage)) await fsp.rm(target.stage, { recursive: true, force: true });
    }
    access.replaceSnapshot(journal.previous);
    await this.options.reloadHost();
    journal.phase = "rolled-back";
    this.persistJournal(journal);
    await this.archivePrevious(journal, warnings);
    await fsp.rm(confined(this.options.recoveryRoot, "active.json"), { force: true });
  }
  private remapKnownJson(value: unknown, manifest: Manifest): unknown {
    if (typeof value === "string" && path.isAbsolute(value)) {
      const match = [...manifest.mounts]
        .sort((left, right) => right.originalPath.length - left.originalPath.length)
        .find((mount) => inside(mount.originalPath, value));
      return match
        ? path.join(this.targetFor(match.id, manifest), path.relative(match.originalPath, value))
        : value;
    }
    if (Array.isArray(value)) return value.map((item) => this.remapKnownJson(item, manifest));
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.remapKnownJson(item, manifest)]),
      );
    return value;
  }
  restore(directory: string, expectedManifestFingerprint: string): Promise<BackupReport> {
    return this.serial(async () => {
      this.assertNoPendingRecovery();
      const root = this.safeRoot(directory);
      const manifest = this.readManifest(root);
      const manifestFingerprint = createHash("sha256")
        .update(JSON.stringify(manifest))
        .digest("hex");
      // Bind confirmation to the verified preview before saving/stopping any
      // live workspace. Validation and staging use this same manifest object.
      if (manifestFingerprint !== expectedManifestFingerprint)
        throw new AppError("backupSelectionChanged", "备份在预览后发生变化，请重新选择并验证备份");
      await this.options.protectRoots?.([root]);
      const inspection = await this.inspectManifest(root, manifest);
      this.options.manager.assertRestoreTrust(manifest.manager);
      await this.verifyTrustedCode(root, manifest);
      const id = randomUUID();
      const warnings: string[] = [];
      const resumeHost = await this.options.pauseHost();
      let journal: RestoreJournal | undefined;
      let recoveryRequired = false;
      const rollback = async (access: PluginMaintenanceAccess) => {
        if (journal && journal.phase !== "rolled-back") {
          try {
            await this.rollback(journal, access, warnings);
          } catch (error) {
            recoveryRequired = true;
            throw new AppError(
              "backupRecoveryRequired",
              "备份回滚未完成，已暂停插件和写入，请重启恢复：" + String(error),
            );
          }
        }
      };
      try {
        // A queued data-directory change may finish while source hashes are
        // checked. Resolve destinations only after the host has fenced writes.
        const mounts = manifest.mounts.map((mount) => ({
          ...mount,
          target: this.targetFor(mount.id, manifest),
        }));
        this.disjoint(
          root,
          mounts.map((mount) => mount.target),
        );
        this.disjoint(
          this.options.recoveryRoot,
          mounts.map((mount) => mount.target),
        );
        const result = await this.options.manager.withQuiesced(async (access) => {
          const roots = mounts.filter(
            (mount) =>
              !mounts.some((other) => other.id !== mount.id && inside(other.target, mount.target)),
          );
          const targets = roots.map((mount, index) => {
            const base = path.join(path.dirname(mount.target), `.spark233-restore-${id}-${index}`);
            return {
              target: mount.target,
              stage: `${base}-stage`,
              previous: `${base}-previous`,
              failed: `${base}-failed`,
              existed: fs.existsSync(mount.target),
            };
          });
          for (const target of targets) {
            const parent = path.dirname(target.target);
            const capacity = await fsp.statfs(parent, { bigint: true });
            if (capacity.bavail * capacity.bsize < BigInt(inspection.bytes))
              throw new AppError("backupInsufficientSpace", "目标磁盘空间不足，未开始替换数据目录");
          }
          journal = {
            schemaVersion: 2,
            id,
            phase: "prepared",
            roots: {
              host: canonical(this.options.hostRoot),
              plugins: canonical(this.options.pluginRoot),
              externalData: Object.fromEntries(
                mounts
                  .filter((mount) => mount.id !== "host" && mount.id !== "plugins")
                  .map((mount) => [
                    (manifest.schemaVersion === 1
                      ? this.options.legacyMountAliases?.[mount.id]
                      : undefined) ?? mount.id.slice("plugin-data-".length),
                    canonical(mount.target),
                  ]),
              ),
            },
            previous: access.snapshot(),
            targets,
          };
          await this.options.protectRoots?.(
            targets.flatMap((target) => [
              target.target,
              target.stage,
              target.previous,
              target.failed,
            ]),
          );
          this.persistJournal(journal);
          const stagedPath = (target: string) => {
            const owner = targets.find((item) => inside(item.target, target));
            if (!owner) throw new AppError("invalidBackup", "恢复挂载超出目标范围");
            return confined(owner.stage, path.relative(owner.target, target));
          };
          try {
            for (const target of targets) {
              await fsp.mkdir(path.dirname(target.stage), { recursive: true });
              await fsp.mkdir(target.stage);
            }
            const stagedEntries: Entry[] = [];
            for (const mount of mounts)
              if (mount.exists)
                await this.copyTree(
                  path.join(root, "files", mount.id),
                  stagedPath(mount.target),
                  [],
                  mount.id,
                  stagedEntries,
                );
            const byPath = (left: Entry, right: Entry) => left.path.localeCompare(right.path, "en");
            if (
              JSON.stringify(stagedEntries.sort(byPath)) !==
              JSON.stringify([...manifest.entries].sort(byPath))
            )
              throw new AppError("invalidBackup", "备份源在恢复准备期间发生变化");
            const configFile =
              this.options.configFile ?? path.join(this.options.hostRoot, "config.json");
            for (const file of [configFile, path.join(this.options.pluginRoot, "previews.json")]) {
              const staged = stagedPath(file);
              if (fs.existsSync(staged)) {
                const remapped = this.remapKnownJson(readJson(staged), manifest);
                const value =
                  file === configFile && this.options.rewriteHostConfig
                    ? this.options.rewriteHostConfig(remapped, this.options.externalDataRoots())
                    : remapped;
                atomicWrite(staged, JSON.stringify(value, null, 2));
              }
            }
            const next = this.options.manager.validateBackupSnapshot(manifest.manager, (record) =>
              stagedPath(
                path.join(
                  this.options.manager.getBackupLayout().packages.versionsRoot,
                  encodeURIComponent(record.pluginId),
                  encodeURIComponent(record.version),
                ),
              ),
            );
            for (const record of next.plugins) {
              const previous = journal.previous.plugins.find(
                (item) => item.pluginId === record.pluginId,
              );
              const expanded = record.grant.capabilities.some(
                (capability) => !previous?.grant.capabilities.includes(capability),
              );
              const newCodeTrust =
                record.grant.native &&
                (!previous?.grant.native ||
                  previous.integrity !== record.integrity ||
                  previous.manifestDigest !== record.manifestDigest);
              if (expanded || newCodeTrust)
                throw new AppError(
                  "backupTrustRequired",
                  "请先通过插件安装确认此版本及其权限，再恢复备份：" + record.pluginId,
                );
            }
            atomicWrite(
              stagedPath(this.options.manager.getBackupLayout().stateFile),
              JSON.stringify(
                {
                  schemaVersion: 1,
                  plugins: Object.fromEntries(
                    next.plugins.map((record) => [record.pluginId, record]),
                  ),
                  dataVersions: next.dataVersions,
                },
                null,
                2,
              ),
            );
            journal.phase = "switching";
            this.persistJournal(journal);
            for (const target of targets) {
              this.safeRoot(target.target, true);
              if (target.existed) await renameWithRetry(target.target, target.previous);
              await renameWithRetry(target.stage, target.target);
            }
            journal.phase = "applied";
            this.persistJournal(journal);
            access.replaceSnapshot(next);
            await this.options.reloadHost();
            return {
              snapshotDirectory: inspection.snapshotDirectory,
              recoveryDirectory: path.join(this.options.recoveryRoot, id),
              files: inspection.files,
              bytes: inspection.bytes,
              warnings,
            };
          } catch (error) {
            await rollback(access);
            throw error;
          }
        }, rollback);
        journal!.phase = "committed";
        this.persistJournal(journal!);
        await this.archivePrevious(journal!, warnings);
        await fsp.rm(confined(this.options.recoveryRoot, "active.json"), { force: true });
        return result;
      } finally {
        if (!recoveryRequired) await resumeHost();
      }
    });
  }
  /** Invoke before normal plugin initialization after an interrupted restore. */
  recoverInterrupted(): Promise<void> {
    return this.serial(async () => {
      const activeFile = confined(this.options.recoveryRoot, "active.json");
      if (!fs.existsSync(activeFile)) return;
      const { id } = z.strictObject({ id: z.uuid() }).parse(readControlJson(activeFile));
      const parsed = journalSchema.parse(readControlJson(this.journalFile(id)));
      if (parsed.id !== id) throw new AppError("invalidBackup", "恢复日志身份不一致");
      if (
        canonical(parsed.roots.host) !== canonical(this.options.hostRoot) ||
        canonical(parsed.roots.plugins) !== canonical(this.options.pluginRoot)
      )
        throw new AppError("unsafeBackupPath", "恢复日志与当前业务目录不匹配");
      const recordedDataRoots = journalDataRoots(parsed, this.options.legacyMountAliases);
      const currentDataRoots = this.options.externalDataRoots();
      for (const [pluginId, root] of Object.entries(recordedDataRoots))
        if (
          !currentDataRoots[pluginId] ||
          canonical(root) !== canonical(currentDataRoots[pluginId])
        )
          throw new AppError("unsafeBackupPath", "恢复日志的插件数据域不在当前授权位置");
      const previous = z
        .object({
          schemaVersion: z.literal(1),
          plugins: z.array(z.object({ pluginId: z.string() }).passthrough()),
        })
        .parse(parsed.previous);
      const allowed = this.mounts(previous.plugins)
        .filter(
          (mount) =>
            !mount.id.startsWith("plugin-data-") ||
            recordedDataRoots[mount.id.slice("plugin-data-".length)] ||
            (parsed.schemaVersion === 1 &&
              previous.plugins.some((record) => `plugin-data-${record.pluginId}` === mount.id)),
        )
        .map((mount) => mount.root);
      if (
        parsed.targets.length !== allowed.length ||
        new Set(parsed.targets.map((target) => canonical(target.target))).size !== allowed.length
      )
        throw new AppError("invalidBackup", "恢复日志的业务目录不完整或重复");
      for (const [index, target] of parsed.targets.entries()) {
        const base = path.join(path.dirname(target.target), `.spark233-restore-${id}-${index}`);
        if (
          !allowed.some((root) => canonical(root) === canonical(target.target)) ||
          target.stage !== `${base}-stage` ||
          target.previous !== `${base}-previous` ||
          target.failed !== `${base}-failed`
        )
          throw new AppError("unsafeBackupPath", "恢复日志目录超出授权范围");
        for (const file of [target.target, target.stage, target.previous, target.failed])
          this.safeRoot(file, true);
      }
      const journal = parsed as RestoreJournal;
      const warnings: string[] = [];
      const resumeHost = await this.options.pauseHost();
      try {
        await this.options.protectRoots?.(
          journal.targets.flatMap((target) => [
            target.target,
            target.stage,
            target.previous,
            target.failed,
          ]),
        );
        if (journal.phase === "committed" || journal.phase === "rolled-back")
          await this.archivePrevious(journal, warnings);
        else
          await this.options.manager.withQuiesced((access) =>
            this.rollback(journal, access, warnings),
          );
        await fsp.rm(activeFile, { force: true });
      } finally {
        await resumeHost();
      }
    });
  }
}

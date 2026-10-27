import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rename, rm, stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { setTimeout as retryDelay } from "node:timers/promises";
import npmFetch from "npm-registry-fetch";
import * as semver from "semver";
import * as ssri from "ssri";
import * as tar from "tar";
import { isPluginPackagePath, type PluginPackageMetadata } from "@spark233/sdk";
import { inside } from "../persistence.js";
import {
  validatePluginDirectory,
  type HostEnvironment,
  type PluginExpectation,
} from "./manifest.js";
import {
  extractPluginArchive,
  packageLimits,
  type PluginPackageLimits,
} from "./package-archive.js";
import { limitPackageBytes, registryPackageUrl, requirePackageIntegrity } from "./package-io.js";
import type { ResolvedRegistryPluginPackage } from "./package-source.js";

export { DEFAULT_PLUGIN_PACKAGE_LIMITS, type PluginPackageLimits } from "./package-archive.js";

export interface PluginPackagePaths {
  stagingRoot: string;
  versionsRoot: string;
  cacheRoot: string;
}

export interface PackageInstallOptions {
  expected?: PluginExpectation;
  signal?: AbortSignal;
  limits?: Partial<PluginPackageLimits>;
  /** Optional externally supplied SRI for a local import. */
  integrity?: string;
  onProgress?: (progress: { receivedBytes: number; totalBytes?: number }) => void;
  onPhase?: (phase: "downloading" | "verifying") => void;
}

export interface PluginReleaseNotes {
  status: "available" | "missing" | "error";
  content?: string;
  message?: string;
}

export interface StagedPluginPackage {
  metadata: PluginPackageMetadata;
  directory: string;
  integrity: string;
  releaseNotes?: PluginReleaseNotes;
  source: {
    kind: "registry" | "file" | "directory";
    location: string;
    registry?: string;
    channel?: string;
  };
}

/** Package-local display text only. Existing archive validation rejects links;
 * rereads still bound the opened regular file instead of following arbitrary paths. */
export async function readPluginReleaseNotes(directory: string): Promise<PluginReleaseNotes> {
  const maximum = 256 * 1024;
  try {
    const root = await realpath(directory);
    const filename = path.join(root, "CHANGELOG.md");
    const before = await lstat(filename);
    if (!before.isFile() || before.isSymbolicLink() || before.size > maximum)
      throw new Error("Release notes must be a bounded regular file");
    if (!inside(root, await realpath(filename))) throw new Error("Release notes escaped package");
    const file = await open(filename, "r");
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.size > maximum ||
        opened.dev !== before.dev ||
        opened.ino !== before.ino
      )
        throw new Error("Release notes changed while opening");
      const buffer = Buffer.alloc(maximum + 1);
      let received = 0;
      while (received < buffer.length) {
        const { bytesRead } = await file.read(buffer, received, buffer.length - received, received);
        if (!bytesRead) break;
        received += bytesRead;
      }
      if (received > maximum) throw new Error("Release notes exceed the size limit");
      return {
        status: "available",
        content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, received)),
      };
    } finally {
      await file.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT"
      ? { status: "missing" }
      : { status: "error", message: "Package CHANGELOG.md could not be read safely." };
  }
}

/** Exact code location only; lifecycle and active-version transactions are external. */
export function getPluginVersionDirectory(
  paths: Pick<PluginPackagePaths, "versionsRoot">,
  pluginId: string,
  version: string,
): string {
  if (!path.isAbsolute(paths.versionsRoot))
    throw new Error("Plugin versions root must be absolute");
  if (
    !/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/.test(pluginId) ||
    pluginId.length > 80 ||
    !semver.valid(version)
  ) {
    throw new Error("Invalid plugin identity for an exact version directory");
  }
  return path.join(paths.versionsRoot, encodeURIComponent(pluginId), encodeURIComponent(version));
}

async function privateDirectory(directory: string): Promise<string> {
  if (!path.isAbsolute(directory)) throw new Error("Plugin package roots must be absolute");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await lstat(directory)).isSymbolicLink())
    throw new Error("Plugin package roots cannot be symbolic links");
  return realpath(directory);
}

async function exactVersionParent(versionsRoot: string, directory: string): Promise<void> {
  const parent = path.dirname(directory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await lstat(parent)).isSymbolicLink())
    throw new Error("Plugin version parent cannot be a symbolic link");
  const relative = path.relative(versionsRoot, await realpath(parent));
  if (
    !relative ||
    relative.startsWith(`..${path.sep}`) ||
    relative === ".." ||
    path.isAbsolute(relative)
  ) {
    throw new Error("Plugin version parent escapes the versions root");
  }
  try {
    await lstat(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  throw new Error("This exact plugin version is already installed; it will not be overwritten");
}

type AcquireArchive = (
  archive: string,
  limits: PluginPackageLimits,
  cacheRoot: string,
) => Promise<void>;

async function stagePackage(
  acquire: AcquireArchive,
  environment: HostEnvironment,
  paths: PluginPackagePaths,
  options: PackageInstallOptions,
  source: StagedPluginPackage["source"],
  expectedIntegrity?: string,
): Promise<StagedPluginPackage> {
  options.signal?.throwIfAborted();
  const limits = packageLimits(options.limits);
  const stagingRoot = await privateDirectory(paths.stagingRoot);
  const versionsRoot = await privateDirectory(paths.versionsRoot);
  const cacheRoot = await privateDirectory(paths.cacheRoot);
  if (new Set([stagingRoot, versionsRoot, cacheRoot]).size !== 3)
    throw new Error("Plugin code, staging and cache roots must be distinct");
  const work = await mkdtemp(path.join(stagingRoot, "install-"));
  const archive = path.join(work, "package.tgz");
  const unpacked = path.join(work, "unpacked");
  let createdDirectory: string | undefined;
  let createdIdentity: { dev: number; ino: number } | undefined;
  const phase = (value: "downloading" | "verifying") => {
    try {
      options.onPhase?.(value);
    } catch {}
  };
  try {
    phase("downloading");
    await acquire(archive, limits, cacheRoot);
    options.signal?.throwIfAborted();
    phase("verifying");
    if (expectedIntegrity) {
      await ssri.checkStream(createReadStream(archive), expectedIntegrity, { strict: true });
    }
    const integrity = (
      await ssri.fromStream(createReadStream(archive), { algorithms: ["sha512"] })
    ).toString();
    await mkdir(unpacked, { mode: 0o700 });
    await extractPluginArchive(archive, unpacked, limits, options.signal);
    const metadata = validatePluginDirectory(unpacked, environment, options.expected);
    const releaseNotes = await readPluginReleaseNotes(unpacked);
    const directory = getPluginVersionDirectory(
      { versionsRoot },
      metadata.spark233.id,
      metadata.version,
    );
    // Staging and version roots should share a filesystem. EXDEV fails without
    // copying or exposing a partially validated package as a committed version.
    // Windows can temporarily deny this directory rename immediately after EXE
    // extraction (observed EPERM in the packaged first-install path). Node's
    // promise rename has no retry option. Retry only that platform's transient
    // access/busy errors, for at most 2.75 seconds of delay; never replace code.
    for (let attempt = 0; ; attempt++) {
      options.signal?.throwIfAborted();
      await exactVersionParent(versionsRoot, directory);
      options.signal?.throwIfAborted();
      try {
        const identity = await lstat(unpacked);
        await rename(unpacked, directory);
        createdDirectory = directory;
        createdIdentity = identity;
        break;
      } catch (error) {
        if (
          process.platform !== "win32" ||
          !["EPERM", "EACCES", "EBUSY"].includes((error as NodeJS.ErrnoException).code ?? "") ||
          attempt >= 8
        )
          throw error;
        await retryDelay(Math.min(50 * 2 ** attempt, 500), undefined, { signal: options.signal });
      }
    }
    options.signal?.throwIfAborted();
    return { metadata, directory, integrity, source, releaseNotes };
  } catch (error) {
    if (createdDirectory && createdIdentity) {
      const current = await lstat(createdDirectory).catch((failure: NodeJS.ErrnoException) => {
        if (failure.code !== "ENOENT") throw failure;
        return undefined;
      });
      if (
        current?.isDirectory() &&
        !current.isSymbolicLink() &&
        current.dev === createdIdentity.dev &&
        current.ino === createdIdentity.ino &&
        inside(versionsRoot, await realpath(createdDirectory))
      )
        await rm(createdDirectory, { recursive: true, force: true });
    }
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

export async function stageRegistryPluginPackage(
  selection: ResolvedRegistryPluginPackage,
  environment: HostEnvironment,
  paths: PluginPackagePaths,
  options: PackageInstallOptions = {},
): Promise<StagedPluginPackage> {
  const url = registryPackageUrl(selection.tarball).href;
  const integrity = requirePackageIntegrity(selection.integrity);
  for (const [key, value] of Object.entries({
    name: selection.name,
    version: selection.version,
    pluginId: selection.metadata.spark233.id,
  })) {
    if (
      options.expected?.[key as keyof PluginExpectation] !== undefined &&
      options.expected[key as keyof PluginExpectation] !== value
    ) {
      throw new Error(`Registry selection does not match expected ${key}`);
    }
  }
  const expected: PluginExpectation = {
    ...options.expected,
    name: selection.name,
    version: selection.version,
    pluginId: selection.metadata.spark233.id,
  };
  const registry = registryPackageUrl(selection.registry).href;
  return stagePackage(
    async (archive, limits, cacheRoot) => {
      const fetchOptions: npmFetch.Options & { signal?: AbortSignal } = {
        registry,
        cache: path.join(cacheRoot, "registry-http"),
        integrity,
        signal: options.signal,
        fetchRetries: 1,
        fetchRetryFactor: 2,
        fetchRetryMintimeout: 1_000,
        fetchRetryMaxtimeout: 2_000,
        timeout: 30_000,
      };
      const response = await npmFetch(url, fetchOptions);
      const length = response.headers.get("content-length");
      const encoding = response.headers.get("content-encoding");
      const declared = length && /^\d+$/.test(length) ? Number(length) : undefined;
      const totalBytes =
        (!encoding || encoding.toLowerCase() === "identity") &&
        Number.isSafeInteger(declared) &&
        declared! > 0 &&
        declared! <= limits.maxArchiveBytes
          ? declared
          : undefined;
      await pipeline(
        response.body,
        limitPackageBytes(limits.maxArchiveBytes, "Plugin tarball", (receivedBytes) =>
          options.onProgress?.({
            receivedBytes,
            ...(totalBytes !== undefined && receivedBytes <= totalBytes ? { totalBytes } : {}),
          }),
        ),
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        { signal: options.signal },
      );
    },
    environment,
    paths,
    { ...options, expected },
    { kind: "registry", location: url, registry, channel: selection.channel },
    integrity,
  );
}

export async function stageLocalPluginPackage(
  tarballPath: string,
  environment: HostEnvironment,
  paths: PluginPackagePaths,
  options: PackageInstallOptions = {},
): Promise<StagedPluginPackage> {
  const source = path.resolve(tarballPath);
  const info = await stat(source);
  if (!info.isFile()) throw new Error("Local plugin import must be a regular npm .tgz file");
  const expectedIntegrity =
    options.integrity === undefined ? undefined : requirePackageIntegrity(options.integrity);
  return stagePackage(
    async (archive, limits) => {
      await pipeline(
        createReadStream(source),
        limitPackageBytes(limits.maxArchiveBytes, "Local plugin tarball", (receivedBytes) =>
          options.onProgress?.({ receivedBytes, totalBytes: info.size }),
        ),
        createWriteStream(archive, { flags: "wx", mode: 0o600 }),
        { signal: options.signal },
      );
    },
    environment,
    paths,
    options,
    { kind: "file", location: source },
    expectedIntegrity,
  );
}

/** tar and the existing archive validator provide packaging and extraction;
 * this walk only bounds a mutable directory and rejects filesystem links before
 * converting it to the same immutable preview as every other install source. */
export async function stageDevelopmentPluginPackage(
  directory: string,
  environment: HostEnvironment,
  paths: PluginPackagePaths,
  options: PackageInstallOptions = {},
): Promise<StagedPluginPackage> {
  options.signal?.throwIfAborted();
  if (!path.isAbsolute(directory)) throw new Error("Development plugin directory must be absolute");
  const sourceInfo = await lstat(directory);
  if (sourceInfo.isSymbolicLink() || !sourceInfo.isDirectory())
    throw new Error("Development plugin source must be a real directory without links");
  const source = await realpath(directory);
  const roots = await Promise.all(
    [paths.stagingRoot, paths.versionsRoot, paths.cacheRoot].map(privateDirectory),
  );
  if (roots.some((root) => inside(root, source) || inside(source, root)))
    throw new Error("Development plugin source must not overlap plugin host storage");
  const limits = packageLimits(options.limits);
  const entries: Array<{
    relative: string;
    size: number;
    modified: number;
    inode: number;
    device: number;
  }> = [];
  let bytes = 0;
  const walk = async (relative: string) => {
    options.signal?.throwIfAborted();
    const file = path.join(source, relative);
    const info = await lstat(file);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error("Development plugin links and special files are forbidden");
    if (!inside(source, await realpath(file)))
      throw new Error("Development plugin path escaped its source");
    const archivePath = `package/${relative.split(path.sep).join("/")}`;
    if (!isPluginPackagePath(archivePath) || archivePath.split("/").length > limits.maxPathDepth)
      throw new Error("Development plugin contains an unsafe or overly deep path");
    if (entries.length + 1 > limits.maxEntries)
      throw new Error("Development plugin contains too many entries");
    if (
      !Number.isSafeInteger(info.size) ||
      info.size < 0 ||
      (info.isFile() && info.size > limits.maxFileBytes)
    )
      throw new Error("Development plugin file exceeds the size limit");
    bytes += info.isFile() ? info.size : 0;
    if (bytes > limits.maxExpandedBytes)
      throw new Error("Development plugin exceeds the expanded size limit");
    entries.push({
      relative,
      size: info.size,
      modified: info.mtimeMs,
      inode: info.ino,
      device: info.dev,
    });
    if (info.isDirectory())
      for await (const child of await opendir(file)) await walk(path.join(relative, child.name));
  };
  for await (const child of await opendir(source)) await walk(child.name);
  const work = await mkdtemp(path.join(roots[0], "development-"));
  try {
    const archive = path.join(work, "package.tgz");
    await pipeline(
      tar.c(
        {
          cwd: source,
          prefix: "package",
          gzip: true,
          portable: true,
          noDirRecurse: true,
          follow: false,
          strict: true,
        },
        entries.map((entry) => entry.relative),
      ),
      limitPackageBytes(limits.maxArchiveBytes, "Development plugin tarball"),
      createWriteStream(archive, { flags: "wx", mode: 0o600 }),
      { signal: options.signal },
    );
    for (const entry of entries) {
      options.signal?.throwIfAborted();
      const file = path.join(source, entry.relative),
        info = await lstat(file);
      if (
        info.isSymbolicLink() ||
        (!info.isDirectory() && !info.isFile()) ||
        !inside(source, await realpath(file)) ||
        info.size !== entry.size ||
        info.mtimeMs !== entry.modified ||
        info.ino !== entry.inode ||
        info.dev !== entry.device
      )
        throw new Error(
          "Development plugin source changed during packaging; retry after the build finishes",
        );
    }
    const staged = await stageLocalPluginPackage(archive, environment, paths, options);
    return { ...staged, source: { kind: "directory", location: source } };
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "node:path";
import npmFetch from "npm-registry-fetch";
import npa from "npm-package-arg";
import * as semver from "semver";
import type { PluginPackageMetadata } from "@spark233/sdk";
import {
  validatePluginMetadata,
  type HostEnvironment,
  type PluginExpectation,
} from "./manifest.js";
import { limitPackageBytes, registryPackageUrl, requirePackageIntegrity } from "./package-io.js";

export interface RegistryPluginRequest {
  name: string;
  registry?: string;
  channel?: string;
  range?: string;
  expected?: PluginExpectation;
  signal?: AbortSignal;
  cacheRoot?: string;
  maxMetadataBytes?: number;
}

export interface ResolvedRegistryPluginPackage {
  metadata: PluginPackageMetadata;
  name: string;
  version: string;
  registry: string;
  channel: string;
  tarball: string;
  integrity: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Malformed npm registry metadata");
  }
  return value as Record<string, unknown>;
}

/** Resolve a compatible, immutable registry version; this never executes code. */
export async function resolveRegistryPluginPackage(
  request: RegistryPluginRequest,
  environment: HostEnvironment,
): Promise<ResolvedRegistryPluginPackage> {
  request.signal?.throwIfAborted();
  if (request.expected?.name !== undefined && request.expected.name !== request.name) {
    throw new Error("Requested npm package does not match the expected package identity");
  }
  if (request.cacheRoot && !path.isAbsolute(request.cacheRoot))
    throw new Error("Registry cache root must be absolute");
  const channel = request.channel ?? "latest";
  const spec = npa.resolve(request.name, channel);
  if (spec.name !== request.name || !spec.registry || spec.type !== "tag" || !spec.escapedName) {
    throw new Error("Plugin source must be an explicit npm package name and dist-tag");
  }
  const registryUrl = registryPackageUrl(request.registry ?? "https://registry.npmjs.org/");
  if (registryUrl.search) throw new Error("Registry base URL cannot contain a query string");
  registryUrl.pathname = registryUrl.pathname.replace(/\/?$/, "/");
  const range = request.range ?? "*";
  if (!semver.validRange(range)) throw new Error("Invalid plugin version range");
  const maximum = request.maxMetadataBytes ?? 8 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum <= 0)
    throw new Error("Invalid registry metadata limit");
  const fetchOptions: npmFetch.Options & { signal?: AbortSignal } = {
    registry: registryUrl.href,
    signal: request.signal,
    cache: request.cacheRoot,
    preferOnline: true,
    fetchRetries: 1,
    fetchRetryFactor: 2,
    fetchRetryMintimeout: 1_000,
    fetchRetryMaxtimeout: 2_000,
    timeout: 30_000,
    headers: { accept: "application/json" },
  };
  const response = await npmFetch(new URL(spec.escapedName, registryUrl).href, fetchOptions);
  const chunks: Buffer[] = [];
  await pipeline(
    response.body,
    limitPackageBytes(maximum, "Registry metadata"),
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        chunks.push(chunk);
        callback();
      },
    }),
    { signal: request.signal },
  );
  const document = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!Object.hasOwn(document, "name") || document.name !== request.name)
    throw new Error("Registry package identity does not match the request");
  const versions = object(Object.hasOwn(document, "versions") ? document.versions : undefined);
  const tags = object(Object.hasOwn(document, "dist-tags") ? document["dist-tags"] : undefined);
  const head = Object.hasOwn(tags, channel) ? tags[channel] : undefined;
  if (typeof head !== "string" || !semver.valid(head))
    throw new Error(`Unknown plugin channel: ${channel}`);
  const includePrerelease = channel !== "latest";
  // A channel is a moving upper bound: fall back to an older compatible build,
  // while keeping stable users away from prerelease or newer unreleased builds.
  const candidates = Object.keys(versions)
    .filter(
      (version) =>
        semver.valid(version) &&
        semver.lte(version, head) &&
        (includePrerelease || !semver.prerelease(version)) &&
        semver.satisfies(version, range, { includePrerelease }) &&
        (request.expected?.version === undefined || version === request.expected.version),
    )
    .sort(semver.rcompare);
  for (const version of candidates) {
    request.signal?.throwIfAborted();
    const candidate = object(Object.hasOwn(versions, version) ? versions[version] : undefined);
    if (Object.hasOwn(candidate, "deprecated") && candidate.deprecated) continue;
    let metadata: PluginPackageMetadata;
    try {
      metadata = validatePluginMetadata(candidate, environment, {
        ...request.expected,
        name: request.name,
        version,
      });
    } catch {
      continue;
    }
    const dist = object(Object.hasOwn(candidate, "dist") ? candidate.dist : undefined);
    if (!Object.hasOwn(dist, "tarball") || typeof dist.tarball !== "string")
      throw new Error("Registry plugin is missing its tarball URL");
    const tarball = registryPackageUrl(dist.tarball).href;
    return {
      metadata,
      name: metadata.name,
      version: metadata.version,
      registry: registryUrl.href,
      channel,
      tarball,
      integrity: requirePackageIntegrity(
        Object.hasOwn(dist, "integrity") ? dist.integrity : undefined,
      ),
    };
  }
  throw new Error(`No compatible ${request.name} version in channel ${channel}`);
}

import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { atomicWrite } from "../persistence.js";
import {
  sortPluginMarketEntries,
  type UToolsCatalogEntry,
  type UToolsCatalogPage,
} from "../../shared/plugin-market.js";
import { commandSchemas } from "../../shared/command-schemas.js";
import { utoolsDetailURL, utoolsDownloadURL } from "../../shared/plugin-sources.js";
import type { UToolsRelease } from "./package-installer.js";
import semver from "semver";

const origin = "https://www.u-tools.cn";
const indexURL = origin + "/plugins-search-index.json";
const maximum = 8 * 1024 * 1024;
const lifetime = 6 * 60 * 60 * 1000;
const pageSize = 20;
const entrySchema = z.object({
  name: z.string().trim().min(1).max(160),
  pluginName: z.string().trim().min(1).max(256),
  description: z.string().max(16384).optional(),
  author: z.string().max(512).optional(),
  logo: z.string().max(4096).optional(),
  href: z.string().max(2048),
  rating: z.number().finite().min(0).max(5).optional(),
  voters: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
});

function iconURL(value: string | undefined): string | undefined {
  try {
    if (!value) return;
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      url.host === "res.u-tools.cn" &&
      !url.username &&
      !url.password &&
      !url.hash &&
      url.pathname.startsWith("/plugins/logo/")
    )
      return url.href;
  } catch {
    /* An invalid optional image must not hide the directory entry. */
  }
}
function normalize(document: unknown): UToolsCatalogEntry[] {
  if (!Array.isArray(document) || document.length > 20000)
    throw new Error("Invalid uTools catalog");
  const entries = new Map<string, UToolsCatalogEntry>();
  for (const raw of document) {
    const parsed = entrySchema.safeParse(raw);
    if (!parsed.success) continue;
    const item = parsed.data,
      pageURL = utoolsDetailURL(item.href);
    if (!pageURL || entries.has(item.name)) continue;
    entries.set(item.name, {
      pluginId: item.name,
      displayName: item.pluginName,
      author: item.author,
      description: item.description?.slice(0, 2000),
      rating: item.rating,
      voters: item.voters,
      pageURL,
      iconURL: iconURL(item.logo),
    });
  }
  if (!entries.size) throw new Error("uTools catalog contains no usable entries");
  return [...entries.values()];
}

/** Use the host's atomic cache writer and the shared market sorter. Only this
 * fixed public index is fetched; renderers cannot supply arbitrary source URLs. */
export class UToolsCatalog {
  private cache?: { items: UToolsCatalogEntry[]; fetchedAt: number };
  private loaded = false;
  private pending?: Promise<void>;
  constructor(
    private readonly options: {
      cacheFile: string;
      fetch?: typeof fetch;
      now?: () => number;
    },
  ) {}
  private now(): number {
    return (this.options.now ?? Date.now)();
  }
  async release(catalogId: string, signal?: AbortSignal): Promise<UToolsRelease> {
    await this.query({ query: "", sort: "auto", page: 1 }, signal);
    const entry = this.cache!.items.find((item) => item.pluginId === catalogId);
    if (!entry) throw new Error("uTools 目录中没有此插件，请刷新目录");
    const response = await (this.options.fetch ?? fetch)(entry.pageURL, {
      redirect: "error",
      signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
    });
    if (!response.ok || !response.body) throw new Error("uTools 详情暂时不可用");
    const chunks: Buffer[] = [],
      reader = response.body.getReader();
    let received = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.byteLength;
        if (received > 2 * 1024 * 1024) {
          await reader.cancel();
          throw new Error("uTools 详情超出大小限制");
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    signal?.throwIfAborted();
    const html = Buffer.concat(chunks).toString("utf8");
    // Read structured JSON only; no remote HTML/script is rendered or executed.
    const lower = html.toLowerCase();
    let cursor = 0;
    for (let scripts = 0; scripts < 128; scripts++) {
      const start = lower.indexOf("<script", cursor);
      if (start < 0) break;
      const opening = lower.indexOf(">", start + 7);
      if (opening < 0 || opening - start > 4096) break;
      const end = lower.indexOf("</script", opening + 1);
      if (end < 0) break;
      const closing = lower.indexOf(">", end + 8);
      if (closing < 0) break;
      cursor = closing + 1;
      if (!/\btype\s*=\s*["']application\/ld\+json["']/i.test(html.slice(start + 7, opening)))
        continue;
      let value: unknown;
      try {
        value = JSON.parse(html.slice(opening + 1, end));
      } catch {
        continue;
      }
      const records = Array.isArray(value) ? value : [value];
      for (const raw of records.slice(0, 64)) {
        if (
          !raw ||
          typeof raw !== "object" ||
          !("downloadUrl" in raw) ||
          typeof raw.downloadUrl !== "string"
        )
          continue;
        const downloadURL = utoolsDownloadURL(raw.downloadUrl);
        const version =
          "softwareVersion" in raw && typeof raw.softwareVersion === "string"
            ? (semver.valid(raw.softwareVersion) ?? undefined)
            : undefined;
        return {
          catalogId,
          pageURL: entry.pageURL,
          downloadURL,
          version,
          displayName: entry.displayName,
        };
      }
    }
    throw new Error("此条目没有可用的离线安装包；暂时不能在应用内安装");
  }
  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.statSync(this.options.cacheFile).size > maximum + 1024) return;
      const value = z
        .object({
          version: z.literal(1),
          fetchedAt: z.number().finite().nonnegative(),
          document: z.unknown(),
        })
        .parse(JSON.parse(fs.readFileSync(this.options.cacheFile, "utf8")));
      if (value.fetchedAt > this.now() + 60000) return;
      this.cache = { fetchedAt: value.fetchedAt, items: normalize(value.document) };
    } catch {
      /* A missing or invalid cache is replaced only by a valid response. */
    }
  }
  private async refresh(signal?: AbortSignal): Promise<void> {
    if (this.pending) return this.pending;
    const operation = (async () => {
      const response = await (this.options.fetch ?? fetch)(indexURL, {
        redirect: "error",
        headers: { accept: "application/json" },
        signal: AbortSignal.any([AbortSignal.timeout(15000), ...(signal ? [signal] : [])]),
      });
      if (!response.ok || !response.body) throw new Error("uTools catalog is unavailable");
      const reader = response.body.getReader(),
        chunks: Buffer[] = [];
      let received = 0;
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          received += value.byteLength;
          if (received > maximum) {
            await reader.cancel();
            throw new Error("uTools catalog exceeds its size limit");
          }
          chunks.push(Buffer.from(value));
        }
      } finally {
        reader.releaseLock();
      }
      signal?.throwIfAborted();
      const document: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const items = normalize(document),
        fetchedAt = this.now();
      this.cache = { items, fetchedAt };
      try {
        fs.mkdirSync(path.dirname(this.options.cacheFile), { recursive: true });
        atomicWrite(this.options.cacheFile, JSON.stringify({ version: 1, fetchedAt, document }));
      } catch {
        /* Cache persistence is optional; the valid in-memory index remains usable. */
      }
    })();
    this.pending = operation;
    try {
      await operation;
    } finally {
      if (this.pending === operation) this.pending = undefined;
    }
  }
  async query(input: unknown, signal?: AbortSignal): Promise<UToolsCatalogPage> {
    const request = commandSchemas.plugins_utools_catalog.parse(input);
    signal?.throwIfAborted();
    this.load();
    let stale = false;
    if (request.refresh || !this.cache) {
      try {
        await this.refresh(signal);
      } catch (error) {
        signal?.throwIfAborted();
        if (!this.cache) throw error;
        stale = true;
      }
    } else if (this.now() - this.cache.fetchedAt >= lifetime) {
      // Keep cached search/paging immediate while one refresh runs in the host.
      stale = true;
      void this.refresh(signal).catch(() => {});
    }
    signal?.throwIfAborted();
    const cache = this.cache!;
    const items = sortPluginMarketEntries(cache.items, request.sort, request.query);
    const page = Math.min(request.page, Math.max(1, Math.ceil(items.length / pageSize)));
    return {
      items: items.slice((page - 1) * pageSize, page * pageSize),
      total: items.length,
      page,
      pageSize,
      fetchedAt: cache.fetchedAt,
      stale: stale || this.now() - cache.fetchedAt >= lifetime,
    };
  }
}

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { sortPluginMarketEntries, type PluginMarketEntry } from "../../shared/plugin-market.js";
import { UToolsCatalog } from "./utools-catalog.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function cacheFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-catalog-"));
  directories.push(dir);
  return path.join(dir, "index.json");
}
const request = { query: "", sort: "auto" as const, page: 1 };
const entry = (name: string, extra: Record<string, unknown> = {}) => ({
  name,
  pluginName: name,
  href: "/plugins/detail/" + name + "/",
  ...extra,
});

it("resolves only catalog-owned detail pages and rejects download source changes", async () => {
  let downloadUrl = "https://res.u-tools.cn/plugins/fixture.upxs";
  const requested: string[] = [];
  const catalog = new UToolsCatalog({
    cacheFile: cacheFile(),
    fetch: async (input) => {
      const url = String(input);
      requested.push(url);
      return url.endsWith("plugins-search-index.json")
        ? new Response(JSON.stringify([entry("fixture")]))
        : new Response(
            '<script type="application/ld+json">' +
              JSON.stringify({ softwareVersion: "1.2.3", downloadUrl }) +
              "</script>",
          );
    },
  });
  await expect(catalog.release("unknown")).rejects.toThrow("目录中没有");
  expect(requested.some((url) => url.includes("unknown"))).toBe(false);
  expect(await catalog.release("fixture")).toMatchObject({
    catalogId: "fixture",
    version: "1.2.3",
    downloadURL: downloadUrl,
  });
  downloadUrl = "https://res.u-tools.cn.evil.example/plugins/fixture.upxs";
  await expect(catalog.release("fixture")).rejects.toThrow("官方 HTTPS");
});

it("ranks real scores and vote ties, leaves missing scores last and preserves input order", () => {
  const items: readonly PluginMarketEntry[] = Object.freeze(
    [
      { pluginId: "empty", displayName: "Empty", voters: 50000 },
      { pluginId: "low", displayName: "Low", rating: 4.8, voters: 800 },
      { pluginId: "b", displayName: "Same", rating: 5, voters: 200 },
      { pluginId: "a", displayName: "Same", rating: 5, voters: 200 },
      { pluginId: "small", displayName: "Small", rating: 5, voters: 2 },
      { pluginId: "zero", displayName: "Zero", rating: 0 },
    ].map((item) => Object.freeze(item)),
  );
  expect(sortPluginMarketEntries(items, "rating").map((p) => p.pluginId)).toEqual([
    "a",
    "b",
    "small",
    "low",
    "empty",
    "zero",
  ]);
  expect(sortPluginMarketEntries([...items].reverse(), "rating").map((p) => p.pluginId)).toEqual([
    "a",
    "b",
    "small",
    "low",
    "empty",
    "zero",
  ]);
  expect(sortPluginMarketEntries(items, "voters")[0]!.pluginId).toBe("empty");
  expect(items[0]!.pluginId).toBe("empty");
});

it("uses exact names before prefixes and other fields while explicit name sorting survives search", () => {
  const items = [
    { pluginId: "description", displayName: "Alpha", description: "notes" },
    { pluginId: "author", displayName: "Beta", author: "Notes" },
    { pluginId: "prefix", displayName: "Notes Pro" },
    { pluginId: "exact", displayName: "Notes" },
    { pluginId: "other", displayName: "Calculator" },
  ];
  expect(sortPluginMarketEntries(items, "auto", " ＮＯＴＥＳ ").map((p) => p.pluginId)).toEqual([
    "exact",
    "prefix",
    "author",
    "description",
  ]);
  expect(sortPluginMarketEntries(items, "name-asc", "notes").map((p) => p.pluginId)).toEqual([
    "description",
    "author",
    "exact",
    "prefix",
  ]);
  expect(sortPluginMarketEntries(items, "name-desc", "notes").map((p) => p.pluginId)).toEqual([
    "prefix",
    "exact",
    "author",
    "description",
  ]);
  expect(sortPluginMarketEntries(items, "auto", "notes alpha").map((p) => p.pluginId)).toEqual([
    "description",
  ]);
});

it("sorts the whole catalog before paging and shares a single fetch and durable cache", async () => {
  let finish!: (response: Response) => void,
    calls = 0;
  const response = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const file = cacheFile();
  const catalog = new UToolsCatalog({
    cacheFile: file,
    fetch: async () => {
      calls++;
      return response;
    },
  });
  const first = catalog.query({ ...request, sort: "voters" });
  const second = catalog.query({ ...request, sort: "name-asc", page: 2 });
  const document = Array.from({ length: 45 }, (_, i) => entry("Plugin" + i, { voters: i }));
  finish(Response.json(document));
  const [popular, next] = await Promise.all([first, second]);
  expect(calls).toBe(1);
  expect(popular.items[0]!.pluginId).toBe("Plugin44");
  expect(next.items[0]!.pluginId).toBe("Plugin20");
  expect(next.items.at(-1)!.pluginId).toBe("Plugin39");
  const snapshot = fs.readFileSync(file);
  const offline = new UToolsCatalog({
    cacheFile: file,
    fetch: async () => {
      throw new Error("offline");
    },
  });
  const preserved = await offline.query({ ...request, refresh: true });
  expect(preserved.stale).toBe(true);
  expect(preserved.total).toBe(45);
  expect(fs.readFileSync(file)).toEqual(snapshot);
  expect((await offline.query({ ...request, page: 500 })).page).toBe(3);
});

it("rejects renderer-supplied sources and filters unsafe detail and image URLs", async () => {
  let calls = 0;
  const catalog = new UToolsCatalog({
    cacheFile: cacheFile(),
    fetch: async () => {
      calls++;
      return Response.json([
        entry("safe", { logo: "data:image/svg+xml,unsafe", description: "plain text" }),
        entry("external", { href: "https://other.example/plugins/detail/external/" }),
        entry("traversal", { href: "/plugins/detail/%2e%2e/" }),
        entry("encoded-slash", { href: "/plugins/detail/foo%2fbar/" }),
      ]);
    },
  });
  await expect(catalog.query({ ...request, url: "https://other.example/" })).rejects.toThrow();
  expect(calls).toBe(0);
  const result = await catalog.query(request);
  expect(result.items.map((p) => p.pluginId)).toEqual(["safe"]);
  expect(result.items[0]!.iconURL).toBeUndefined();
  expect(result.items[0]!.pageURL).toBe("https://www.u-tools.cn/plugins/detail/safe/");
});

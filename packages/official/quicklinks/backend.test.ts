import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import quicklinksBackend from "./backend.js";
import type { BackendContext } from "../../../apps/desktop/electron/plugins/backend-worker.js";
import type { QuickLink, QuickLinksState } from "./contract.js";
import { assertQuickLinkUrl, resolveTemplate, validateQuickLinks } from "./templates.js";

const temporary: string[] = [];
afterEach(() => {
  for (const directory of temporary.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const website: QuickLink = {
  id: "example",
  title: "Example",
  keyword: "ex",
  kind: "url",
  target: "https://example.com/search?q={query}",
  args: [],
  cwd: "",
  enabled: true,
  description: "",
};

test("URL query values cannot add parameters or change the fixed target", () => {
  const result = resolveTemplate(website, "中文 &next=https://evil.example/#fragment");
  expect(new URL(result.url!).searchParams.get("q")).toBe(
    "中文 &next=https://evil.example/#fragment",
  );
  expect(new URL(result.url!).searchParams.has("next")).toBe(false);
  expect(new URL(result.url!).hostname).toBe("example.com");
  expect(() =>
    validateQuickLinks([{ ...website, target: "https://{host}/search?q={query}" }]),
  ).toThrow();
  expect(() => validateQuickLinks([{ ...website, target: "https:/{query}" }])).toThrow();
  expect(() => validateQuickLinks([{ ...website, target: "javascript:alert({query})" }])).toThrow();
  expect(() => assertQuickLinkUrl(`https://example.com/${"中".repeat(2000)}`)).toThrow("长度限制");
  const pathTemplate = { ...website, target: "https://example.com/fixed/{query}/end" };
  expect(() => resolveTemplate(pathTemplate, "..")).toThrow("目录跳转");
  expect(() => resolveTemplate(pathTemplate, ".")).toThrow("目录跳转");
  expect(resolveTemplate(pathTemplate, "../notes").url).toBe(
    "https://example.com/fixed/..%2Fnotes/end",
  );
});

test("named parameters prompt when absent and program arguments preserve a single literal argument", () => {
  const program: QuickLink = {
    ...website,
    kind: "program",
    target: "C:\\Tools\\editor.exe",
    args: ["--profile={profile}", "{query}"],
  };
  expect(resolveTemplate(program, "C:\\My Files\\a.txt").missing).toEqual(["profile"]);
  const result = resolveTemplate(program, 'a.txt" & calc.exe', {
    profile: "Work",
    query: "ignored override",
  });
  expect(result.args).toEqual(["--profile=Work", 'a.txt" & calc.exe']);
  expect(() =>
    resolveTemplate(program, "file", { __proto__: null, constructor: "evil" }),
  ).toThrow();
});

test("concurrent saves refuse stale revisions, drain on stop, and invalidate old search selections", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-quicklinks-test-"));
  temporary.push(directory);
  const context: BackendContext = {
    owner: { pluginId: "spark233.quicklinks", version: "0.1.0", instanceId: "test" },
    dataDir: directory,
    cacheDir: directory,
    signal: new AbortController().signal,
    startupCheckOnly: false,
    emit: () => {},
    callHost: async () => {
      throw new Error("No host effects in configuration tests");
    },
  };
  const backend = quicklinksBackend(context);
  const initial = (await backend.activate!(
    { commandId: "settings.get" },
    context,
  )) as unknown as QuickLinksState;
  const selection = (await backend.activate!(
    { commandId: "search", parameters: { query: "bd cats" } },
    context,
  )) as { items: Array<{ parameters: Record<string, string> }> };
  const changed = initial.entries.map((entry) => ({
    ...entry,
    target: entry.id === "baidu" ? "https://example.com/?q={query}" : entry.target,
  }));
  const saves = [
    backend.activate!(
      {
        commandId: "settings.save",
        parameters: { revision: initial.revision, entries: changed as never },
      },
      context,
    ),
    backend.activate!(
      { commandId: "settings.save", parameters: { revision: initial.revision, entries: [] } },
      context,
    ),
  ];
  const settled = await Promise.allSettled(saves);
  expect(settled.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
  expect(() =>
    backend.activate!({ commandId: "resolve", parameters: selection.items[0].parameters }, context),
  ).toThrow("已修改");
  const latest = (await backend.activate!(
    { commandId: "settings.get" },
    context,
  )) as unknown as QuickLinksState;
  const file = path.join(directory, "quicklinks.json");
  const external = JSON.parse(fs.readFileSync(file, "utf8"));
  external.entries[0].description = "Externally edited";
  const externalBytes = JSON.stringify(external);
  fs.writeFileSync(file, externalBytes);
  await expect(
    backend.activate!(
      { commandId: "settings.save", parameters: { revision: latest.revision, entries: [] } },
      context,
    ),
  ).rejects.toThrow("已更新");
  expect(fs.readFileSync(file, "utf8")).toBe(externalBytes);
  const refreshed = (await backend.activate!(
    { commandId: "settings.get" },
    context,
  )) as unknown as QuickLinksState;
  const lastSave = backend.activate!(
    { commandId: "settings.save", parameters: { revision: refreshed.revision, entries: [] } },
    context,
  );
  await backend.prepareStop("disable", context);
  await lastSave;
  await backend.stop?.(context);
  const restarted = quicklinksBackend(context);
  const restored = (await restarted.activate!(
    { commandId: "settings.get" },
    context,
  )) as unknown as QuickLinksState;
  expect(restored.entries).toEqual([]);
  await restarted.stop?.(context);
});

test("invalid saved configuration is preserved instead of replaced by defaults", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-quicklinks-corrupt-"));
  temporary.push(directory);
  const file = path.join(directory, "quicklinks.json");
  fs.writeFileSync(file, "{truncated");
  const context = { dataDir: directory, signal: new AbortController().signal } as BackendContext;
  const backend = quicklinksBackend(context);
  expect(() => backend.activate!({ commandId: "settings.get" }, context)).toThrow("原文件已保留");
  expect(fs.readFileSync(file, "utf8")).toBe("{truncated");
});

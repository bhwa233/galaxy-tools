// Isolated real-Everything smoke for the search runtime. Not part of `pnpm test`.
//
//   cd apps/desktop
//   npx vitest run --root ../../scripts/native-everything --pool=threads
//
// Starts the staged bundled Everything (packages/official/search/native) as
// instance "spark233-smoke" with ini/db under local-build/everything-smoke/data,
// no NTFS volumes (-no-auto-include, auto_include_*=0) and only
// local-build/everything-smoke/fixture folder- and content-indexed. The user's
// own Everything (if any) is asked for its version only.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { PluginResourceScope } from "../../apps/desktop/electron/plugins/resources.js";
import {
  EverythingClient,
  everythingPipeName,
} from "../../apps/desktop/electron/plugins/official/everything-ipc.js";
import { createSearchRuntime } from "../../apps/desktop/electron/plugins/official/search.js";

const project = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const smoke = path.join(project, "local-build/everything-smoke");
const fixture = path.join(smoke, "fixture");
const pluginRoot = path.join(project, "packages/official/search");
const instance = "spark233-smoke";
const log = (...values: unknown[]) => console.log("[smoke]", ...values);
type Page = { items: { title: string; description?: string; commandId: string }[]; hint?: string };

it("searches names and content through the bundled Everything", { timeout: 120_000 }, async () => {
  for (const name of [undefined, "1.5a"]) {
    try {
      const client = await EverythingClient.connect({ instance: name, timeoutMs: 1500 });
      log(`user instance ${name ?? "(default)"} version`, await client.version());
      client.close();
    } catch (error) {
      log(`user instance ${name ?? "(default)"}:`, (error as Error).message);
    }
  }
  fs.mkdirSync(path.join(fixture, "large"), { recursive: true });
  fs.writeFileSync(
    path.join(fixture, "large", "big-log.txt"),
    `persimmon-7731\n${"x".repeat(5 * 1024 * 1024)}\n`,
  );
  const dataDir = path.join(smoke, "data", "plugin");
  const scope = new PluginResourceScope({
    pluginId: "spark233.search",
    version: "0.2.0",
    instanceId: "smoke",
  });
  const runtime = createSearchRuntime({
    scope,
    pluginRoot,
    descriptor: { path: path.join(pluginRoot, "native", "Everything.exe"), args: [] },
    dataDir,
    cacheDir: path.join(smoke, "data", "cache"),
    approveTrust: () => true,
    privateRoots: () => [path.join(fixture, "private-root")],
    openPath: async () => undefined,
    fixture: { profileRoot: fixture, bundledInstance: instance, userInstances: [] },
  });
  const query = async (commandId: string, text: string): Promise<Page> =>
    (await runtime.query!(
      { commandId, parameters: { query: text, callerId: "smoke", limit: 20 } },
      new AbortController().signal,
    )) as Page;
  const files = (page: Page) =>
    page.items.filter((item) => item.commandId === "open").map((item) => item.description);
  const until = async (commandId: string, text: string, ready: (page: Page) => boolean) => {
    const started = Date.now();
    for (;;) {
      const page = await query(commandId, text);
      if (ready(page) || Date.now() - started > 30_000) {
        log(
          `${commandId} ${JSON.stringify(text)} (${Date.now() - started} ms)`,
          files(page),
          page.hint ?? "",
        );
        return page;
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
  };
  try {
    const started = Date.now();
    const names = await until("search", "alpha", (page) => files(page).length > 0);
    log("first result after start (ms)", Date.now() - started);
    expect(files(names)).toEqual([path.join(fixture, "notes", "alpha-notes.txt")]);
    expect(names.items.at(-1)?.commandId).toBe("open-everything");
    const chinese = await until("search", "设计", (page) => files(page).length > 0);
    expect(files(chinese)).toEqual([path.join(fixture, "notes", "设计记录.md")]);
    const zebra = await until("content", "zebra-orchid-4471", (page) => files(page).length > 0);
    // secret.txt holds the term too but lives in a host private root.
    expect(files(zebra)).toEqual([path.join(fixture, "notes", "alpha-notes.txt")]);
    const wisteria = await until("content", "紫藤萝-8812", (page) => files(page).length > 0);
    expect(files(wisteria)).toEqual([path.join(fixture, "notes", "设计记录.md")]);
    // node_modules/dep.txt holds the term too; it is excluded from content.
    const kumquat = await until("content", "kumquat-5590", (page) => files(page).length > 0);
    expect(files(kumquat)).toEqual([path.join(fixture, "code", "marker.ts")]);
    // The 5 MiB file is above the 4 MB content limit; the .bin is not a text type.
    expect(files(await query("content", "persimmon-7731"))).toEqual([]);
    log("persimmon-7731 (5 MiB file) content hits: none");
    expect(files(await query("search", "secret"))).toEqual([]);
    log("private-root file name hits: none");
    const ini = fs.readFileSync(path.join(dataDir, "everything", "Everything.ini"), "utf8");
    log(
      "ini",
      ini
        .split(/\r?\n/)
        .filter((line) =>
          /^(app_data|show_tray_icon|run_in_background|auto_include_fixed_volumes|folders|exclude_folders|content_indexing_(enabled|include_only_folders|exclude_folders|max_size|max_size_unit))=/.test(
            line,
          ),
        ),
    );
    await runtime.activate({ commandId: "workspace" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    const windows = execFileSync(
      "tasklist",
      ["/V", "/FO", "CSV", "/FI", "IMAGENAME eq Everything.exe"],
      { encoding: "utf8", windowsHide: true },
    );
    log("Everything processes after opening the window", windows.trim().split(/\r?\n/));
  } finally {
    await scope.stop("quit");
  }
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const pipes = fs.readdirSync("\\\\.\\pipe\\").filter((name) => name.includes(instance));
  log("pipes after stop", pipes, everythingPipeName(instance));
  expect(pipes).toEqual([]);
});

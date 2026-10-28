import { expect, it } from "vitest";
import type { MenuItem, MenuItemConstructorOptions } from "electron";
import { pluginManifestSchema } from "@spark233/sdk";
import { PluginResourceScope } from "../plugins/resources";
import { buildPluginTrayMenu, PluginTrayStateStore, type TrayPlugin } from "./plugin-tray";

const declaration = {
  schemaVersion: 1,
  id: "fixture.plugin",
  displayName: "Fixture",
  api: "^1.0.0",
  host: "^1.2.0",
  platforms: ["win32"],
  architectures: ["x64"],
  entry: "index.html",
  commands: [
    { id: "open", title: "Open" },
    { id: "pause", title: "Pause" },
    { id: "private", title: "Private", internal: true },
  ],
  tray: [
    { id: "open", commandId: "open" },
    { id: "pause", commandId: "pause", type: "checkbox" },
  ],
};

it("rejects undeclared, internal and duplicate tray command references at the package boundary", () => {
  for (const tray of [
    [{ id: "foreign", commandId: "another-plugin:open" }],
    [{ id: "private", commandId: "private" }],
    [{ id: "open", commandId: "missing" }],
    [
      { id: "same", commandId: "open" },
      { id: "same", commandId: "pause" },
    ],
  ])
    expect(pluginManifestSchema.safeParse({ ...declaration, tray }).success).toBe(false);
});

it("owns checkbox state by instance and removes it on stop without letting old cleanup erase a new instance", async () => {
  const states = new PluginTrayStateStore(() => {});
  const manifest = pluginManifestSchema.parse(declaration);
  const old = new PluginResourceScope({
    pluginId: manifest.id,
    version: "1.0.0",
    instanceId: "old",
  });
  const publish = states.attach(old, manifest);
  publish({ id: "pause", checked: true });
  expect(states.get(manifest.id, "pause").checked).toBe(true);
  expect(() => publish({ id: "open", checked: true })).toThrow();
  expect(() => publish({ id: "other", enabled: false })).toThrow();
  const current = new PluginResourceScope({ ...old.owner, instanceId: "current" });
  const update = states.attach(current, manifest);
  update({ id: "pause", checked: false });
  await old.stop("update");
  expect(() => publish({ id: "pause", checked: true })).toThrow();
  expect(states.get(manifest.id, "pause").checked).toBe(false);
  await current.stop("disable");
  expect(states.get(manifest.id, "pause")).toEqual({});
  expect(() => update({ id: "pause", checked: true })).toThrow();
});

it("applies visibility and ordering and rechecks old native menu callbacks against current plugin availability", async () => {
  const manifest = pluginManifestSchema.parse(declaration);
  let plugin: TrayPlugin = { ...manifest, pluginId: manifest.id, version: "1.0.0", enabled: true };
  let hidden: string[] = [];
  let blocked = false;
  const calls: string[] = [];
  const options = {
    plugins: () => [plugin],
    preferences: () => ({ hidden, order: ["fixture.plugin:pause"] }),
    available: () => plugin.enabled,
    state: () => ({ checked: false }),
    blocked: () => blocked,
    activate: async (_plugin: string, command: string) => {
      calls.push(command);
    },
    onError: (error: unknown) => {
      throw error;
    },
  };
  const submenu = buildPluginTrayMenu(options)[0].submenu as MenuItemConstructorOptions[];
  expect(submenu[0].label).toBe("Pause");
  const checkbox = { checked: true } as MenuItem;
  submenu[0].click!(checkbox, undefined, {} as Electron.KeyboardEvent);
  expect(checkbox.checked).toBe(false);
  await Promise.resolve();
  await Promise.resolve();
  expect(calls).toEqual(["pause"]);
  hidden = ["fixture.plugin:pause"];
  expect(
    (buildPluginTrayMenu(options)[0].submenu as MenuItemConstructorOptions[]).some(
      (item) => item.label === "Pause",
    ),
  ).toBe(false);
  submenu[0].click!(checkbox, undefined, {} as Electron.KeyboardEvent);
  plugin = { ...plugin, enabled: false };
  expect(buildPluginTrayMenu(options)).toEqual([]);
  submenu[1].click!({} as MenuItem, undefined, {} as Electron.KeyboardEvent);
  plugin = { ...plugin, enabled: true, version: "2.0.0" };
  submenu[1].click!({} as MenuItem, undefined, {} as Electron.KeyboardEvent);
  blocked = true;
  const disabled = buildPluginTrayMenu(options)[0].submenu as MenuItemConstructorOptions[];
  expect(disabled[0].enabled).toBe(false);
  await Promise.resolve();
  expect(calls).toEqual(["pause"]);
});

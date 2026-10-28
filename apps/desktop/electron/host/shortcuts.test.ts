import { beforeEach, expect, it, vi } from "vitest";
import { ShortcutManager, type HostShortcutCommand } from "./shortcuts";

const native = vi.hoisted(() => ({
  callbacks: new Map<string, () => void>(),
  blocked: new Set<string>(),
}));
vi.mock("electron", () => ({
  globalShortcut: {
    register: (shortcut: string, callback: () => void) => {
      if (native.blocked.has(shortcut) || native.callbacks.has(shortcut)) return false;
      native.callbacks.set(shortcut, callback);
      return true;
    },
    unregister: (shortcut: string) => {
      native.callbacks.delete(shortcut);
    },
  },
}));
beforeEach(() => {
  native.callbacks.clear();
  native.blocked.clear();
});

it("keeps working bindings on conflicts and releases disabled commands without losing other shortcuts", async () => {
  const invoked: string[] = [];
  let commands: HostShortcutCommand[] = [
    { pluginId: "fixture.plugin", command: { id: "open", title: "Open fixture" } },
  ];
  const manager = new ShortcutManager({
    commands: () => commands,
    activate: async (id, command) => {
      invoked.push(id + ":" + command);
    },
    showLauncher: () => {
      invoked.push("launcher");
    },
    toggleVisibility: () => {},
    onError: (error) => {
      throw error;
    },
  });
  const config = {
    globalShortcut: "Alt+Space",
    toggleVisibilityShortcut: "",
    commandShortcuts: { "fixture.plugin:open": "Ctrl+K" },
  };
  manager.configure(config);
  native.blocked.add("Ctrl+J");
  expect(() =>
    manager.configure({
      ...config,
      globalShortcut: "Alt+J",
      commandShortcuts: { "fixture.plugin:open": "Ctrl+J" },
    }),
  ).toThrow(/占用/);
  expect(native.callbacks.has("Alt+J")).toBe(false); // Partial registration is rolled back.
  native.callbacks.get("Alt+Space")!();
  native.callbacks.get("Ctrl+K")!();
  await Promise.resolve();
  expect(invoked).toEqual(["launcher", "fixture.plugin:open"]);
  expect(() => manager.configure({ ...config, globalShortcut: "Control+k" })).toThrow(
    /fixture.plugin/,
  );
  expect(native.callbacks.has("Alt+Space")).toBe(true);
  const expired = native.callbacks.get("Ctrl+K")!;
  commands = [];
  expired(); // A queued old callback must not activate a stopped plugin.
  expect(() => manager.configure({ ...config, globalShortcut: "Ctrl+J" })).toThrow();
  expect(native.callbacks.has("Ctrl+K")).toBe(false);
  expect(native.callbacks.has("Alt+Space")).toBe(true);
  manager.configure(config);
  expect(native.callbacks.has("Ctrl+K")).toBe(false);
  expect(manager.check("Ctrl+K").conflictType).toBe("none");
  commands = [{ pluginId: "fixture.plugin", command: { id: "open" } }];
  manager.configure(config);
  expect(native.callbacks.has("Ctrl+K")).toBe(true);
  expect(invoked).toEqual(["launcher", "fixture.plugin:open"]);
  manager.beginRecording();
  manager.configure(config);
  expect(native.callbacks.size).toBe(0);
  manager.endRecording(config);
  expect(native.callbacks.has("Ctrl+K")).toBe(true);
  manager.dispose();
});

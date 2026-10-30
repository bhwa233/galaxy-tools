import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it } from "vitest";
import { pluginPackageSchema } from "@spark233/sdk";
import { resolvePluginEntries } from "./manifest.js";

const declaration = () => ({
  name: "@fixture/presentation",
  version: "1.0.0",
  spark233: {
    schemaVersion: 1,
    id: "fixture.presentation",
    displayName: "Fixture",
    api: "^1.3.0",
    host: "^1.3.0",
    platforms: ["win32"],
    architectures: ["x64"],
    entry: "index.html",
    commands: [{ id: "open", title: "Open", window: "main", launcher: { role: "entry" } }],
    ui: {
      theme: "^1.0.0",
      icon: { png: "assets/icon.png" },
      windows: { main: { entry: "index.html" } },
    },
  },
});

it("rejects undeclared window references and resources outside the plugin package", () => {
  const missing = declaration();
  missing.spark233.commands[0].window = "missing";
  expect(pluginPackageSchema.safeParse(missing).success).toBe(false);
  for (const resource of ["../outside.png", "https://example.com/icon.png", "C:/outside.png"]) {
    const invalid = declaration();
    invalid.spark233.ui.icon.png = resource;
    expect(pluginPackageSchema.safeParse(invalid).success).toBe(false);
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-presentation-"));
  try {
    const plugin = path.join(root, "plugin"),
      outside = path.join(root, "outside");
    fs.mkdirSync(plugin);
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(plugin, "index.html"), "<html></html>");
    fs.writeFileSync(
      path.join(outside, "icon.png"),
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9l9WkAAAAASUVORK5CYII=",
        "base64",
      ),
    );
    fs.symlinkSync(
      outside,
      path.join(plugin, "assets"),
      process.platform === "win32" ? "junction" : "dir",
    );
    expect(() => resolvePluginEntries(plugin, pluginPackageSchema.parse(declaration()))).toThrow();
    fs.copyFileSync(path.join(outside, "icon.png"), path.join(plugin, "icon.png"));
    const original = declaration();
    const themed = pluginPackageSchema.parse({
      ...original,
      spark233: {
        ...original.spark233,
        ui: {
          ...original.spark233.ui,
          icon: {
            png: "icon.png",
            themes: { blue: { light: { png: "assets/icon.png" }, dark: { png: "icon.png" } } },
          },
        },
      },
    });
    // A valid default icon must not hide an escaping themed icon.
    expect(() => resolvePluginEntries(plugin, themed)).toThrow();
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

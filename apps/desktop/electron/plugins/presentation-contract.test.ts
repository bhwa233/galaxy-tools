import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { expect, it, vi } from "vitest";
import { pluginPackageSchema, parseDeclarativeTemplate, parseWidgetData } from "@spark233/sdk";
import { WidgetOpenMainGate } from "./widget-open-main.js";
import {
  resolvePluginEntries,
  validatePluginMetadata,
  defaultHostEnvironment,
} from "./manifest.js";

const declaration = () => ({
  name: "@fixture/presentation",
  version: "1.0.0",
  spark233: {
    schemaVersion: 1,
    id: "fixture.presentation",
    displayName: "Fixture",
    api: "^1.0.0",
    host: ">=0.0.1 <1",
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

it("rejects custom title bars whose API range includes hosts without sandboxed window controls", () => {
  const raw = declaration();
  const custom = {
    ...raw,
    spark233: {
      ...raw.spark233,
      api: ">=1.5.0 <2.0.0",
      ui: {
        ...raw.spark233.ui,
        windows: { main: { entry: "index.html", titleBar: "custom" } },
      },
    },
  };
  const environment = { ...defaultHostEnvironment("0.0.1"), platform: "win32", arch: "x64" };
  expect(validatePluginMetadata(custom, environment).spark233.ui!.windows!.main.titleBar).toBe(
    "custom",
  );
  expect(() =>
    validatePluginMetadata(
      {
        ...custom,
        spark233: { ...custom.spark233, api: ">=1.4.0 <2.0.0" },
      },
      environment,
    ),
  ).toThrow(/1.5.0/);
  expect(
    validatePluginMetadata(raw, environment).spark233.ui!.windows!.main.titleBar,
  ).toBeUndefined();
});

it("requires one fresh trusted-shell confirmation and retires cancelled, expired or stale candidates", async () => {
  vi.useFakeTimers();
  const closed: string[] = [];
  const gate = new WidgetOpenMainGate((candidate) => closed.push(candidate.candidateId));
  const input = {
    cardId: "card",
    surfaceId: "surface",
    requestId: "request",
    actionId: "open",
    binding: {
      pluginId: "fixture.widget",
      widgetDefinitionId: "clock",
      widgetInstanceId: "widget-instance",
      owner: { pluginId: "fixture.widget", version: "1.0.0", instanceId: "owner" },
      loadGeneration: 1,
    },
  };
  try {
    const controller = new AbortController();
    const pending = gate.request(input, controller.signal, () => true);
    const outcome = pending.confirmed.then(
      () => "confirmed",
      (error) => error.message,
    );
    expect(closed).toEqual([]);
    expect(() =>
      gate.confirm(pending.candidate.candidateId, "other-card", "surface", true, true),
    ).toThrow("widget.commandDenied");
    expect(() =>
      gate.confirm(pending.candidate.candidateId, "card", "surface", true, false),
    ).toThrow("widget.commandDenied");
    gate.confirm(pending.candidate.candidateId, "card", "surface", true, true);
    expect(await outcome).toBe("confirmed");
    expect(() =>
      gate.confirm(pending.candidate.candidateId, "card", "surface", true, true),
    ).toThrow("widget.commandDenied");

    const cancelled = gate.request(input, controller.signal, () => true);
    const cancelledOutcome = cancelled.confirmed.catch((error) => error.message);
    controller.abort();
    expect(await cancelledOutcome).toBe("widget.cancelled");
    expect(() =>
      gate.confirm(cancelled.candidate.candidateId, "card", "surface", true, true),
    ).toThrow("widget.commandDenied");

    const expired = gate.request(input, new AbortController().signal, () => true);
    const expiredOutcome = expired.confirmed.catch((error) => error.message);
    await vi.advanceTimersByTimeAsync(10000);
    expect(await expiredOutcome).toBe("widget.timeout");
    expect(() =>
      gate.confirm(expired.candidate.candidateId, "card", "surface", true, true),
    ).toThrow("widget.commandDenied");

    let current = true;
    const stale = gate.request(input, new AbortController().signal, () => current);
    const staleOutcome = stale.confirmed.catch((error) => error.message);
    current = false;
    expect(() => gate.confirm(stale.candidate.candidateId, "card", "surface", true, true)).toThrow(
      "widget.staleBinding",
    );
    expect(await staleOutcome).toBe("widget.staleBinding");
    expect(closed).toEqual(
      [pending, cancelled, expired, stale].map((value) => value.candidate.candidateId),
    );
  } finally {
    gate.dispose();
    vi.useRealTimers();
  }
});

it("confines widget-only templates and rejects unsafe bindings or misleading API ranges", () => {
  const widget = {
    kind: "declarative",
    title: "Clock",
    template: "widgets/clock.json",
    size: { width: 240, height: 80 },
    clickThrough: true,
    interactive: false,
    data: { data: { source: "host", format: "text", provider: "host.clock" } },
  };
  const raw = {
    name: "@fixture/widget",
    version: "1.0.0",
    spark233: {
      schemaVersion: 1,
      id: "fixture.widget",
      displayName: "Widget",
      api: ">=1.4.0 <2.0.0",
      host: ">=0.0.1 <2",
      platforms: ["win32"],
      architectures: ["x64"],
      ui: { theme: "^1.0.0", widgets: { clock: widget } },
    },
  };
  const environment = { ...defaultHostEnvironment("1.0.0"), platform: "win32", arch: "x64" };
  const metadata = validatePluginMetadata(raw, environment);
  const definition = metadata.spark233.ui!.widgets!.clock;
  const template = {
    version: 1,
    padding: 12,
    background: "card",
    root: { type: "text", value: { dataKey: "data" }, size: "title", tone: "default", maxLines: 1 },
  };
  expect(
    parseWidgetData({ revision: 1, at: 1, values: { data: "12:34" } }, definition.data).values.data,
  ).toBe("12:34");
  expect(() =>
    parseWidgetData({ revision: 1, at: 1, values: { extra: "private" } }, definition),
  ).toThrow();
  expect(() =>
    parseDeclarativeTemplate(
      { ...template, root: { ...template.root, style: { color: "red" } } },
      definition,
    ),
  ).toThrow();
  expect(() =>
    parseDeclarativeTemplate(
      { ...template, root: { ...template.root, value: { dataKey: "not-declared" } } },
      definition,
    ),
  ).toThrow();
  const obsolete = structuredClone(raw);
  obsolete.spark233.api = "^1.0.0";
  expect(() => validatePluginMetadata(obsolete, environment)).toThrow(/1.4.0/);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-widget-package-"));
  try {
    fs.mkdirSync(path.join(root, "widgets"));
    fs.writeFileSync(path.join(root, "widgets", "clock.json"), JSON.stringify(template));
    expect(resolvePluginEntries(root, metadata).widgets.clock.kind).toBe("declarative");
    let deep: unknown = template.root;
    for (let i = 0; i < 5; i++)
      deep = { type: "stack", direction: "column", gap: 4, align: "start", children: [deep] };
    fs.writeFileSync(
      path.join(root, "widgets", "clock.json"),
      JSON.stringify({ ...template, root: deep }),
    );
    expect(() => resolvePluginEntries(root, metadata)).toThrow(/模板/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

it("rejects URLs, duplicate handles and over-budget process rows in widget data", () => {
  const row = { id: "1234", label: "Browser", valueText: "12 KB/s", iconId: "process-1234" };
  const data = (rows: unknown) => ({ revision: 1, at: 1, values: { processes: rows } });
  expect(() =>
    parseWidgetData(data([{ ...row, iconId: "file:///private/process.png" }])),
  ).toThrow();
  expect(() => parseWidgetData(data([row, row]))).toThrow();
  expect(() => parseWidgetData(data([{ ...row, path: "C:/private/process.exe" }]))).toThrow();
  expect(() =>
    parseWidgetData(data(Array.from({ length: 4 }, (_, i) => ({ ...row, id: String(i) })))),
  ).toThrow();
  expect(parseWidgetData(data([row])).values.processes).toEqual([row]);
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

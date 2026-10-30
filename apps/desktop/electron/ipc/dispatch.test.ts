import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { BrowserWindow } from "electron";
import type { RuntimeContext } from "../runtime.js";
import { createDispatch } from "./dispatch.js";

it("distinguishes quitting from backup maintenance when rejecting workspace operations", async () => {
  const lifecycle = { isQuitting: true };
  const ctx = {
    grantsFor: () => ({}),
    pending: new Map(),
    hostShutdown: lifecycle,
    maintenance: false,
  } as unknown as RuntimeContext;
  const dispatch = createDispatch(ctx);
  const win = { id: 1 } as BrowserWindow;
  await expect(dispatch.handle(win, "screenshot_action", { action: "list" })).rejects.toMatchObject(
    { code: "hostStopping" },
  );
  lifecycle.isQuitting = false;
  ctx.maintenance = true;
  await expect(dispatch.handle(win, "screenshot_action", { action: "list" })).rejects.toMatchObject(
    { code: "maintenance" },
  );
});

// Screenshot history previously failed before its list handler due to a missing grant.
it("allows screenshot history only in its own plugin workspace", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "screenshot-dispatch-"));
  try {
    const win = { id: 1 } as BrowserWindow;
    const layout = { view: "launcher", pluginId: "spark233.screenshot" };
    const ctx = {
      grantsFor: () => ({}),
      pending: new Map(),
      preparedWindows: new Set(),
      hostShutdown: { isQuitting: false },
      capsules: { owns: () => false },
      labelOf: () => "history",
      layouts: new Map([["history", layout]]),
      isHostView: () => true,
      pluginHost: { manager: { dataDirectory: () => directory } },
      officialRenderers: new Map([["spark233.screenshot", { scope: { state: "active" } }]]),
      pluginImages: new Map(),
    } as unknown as RuntimeContext;
    const dispatch = createDispatch(ctx);
    await expect(dispatch.handle(win, "screenshot_action", { action: "list" })).resolves.toEqual(
      [],
    );
    await expect(dispatch.handle(win, "plugins_list", {})).rejects.toMatchObject({
      code: "permissionDenied",
    });
    layout.pluginId = "spark233.search";
    await expect(
      dispatch.handle(win, "screenshot_action", { action: "list" }),
    ).rejects.toMatchObject({
      code: "permissionDenied",
    });
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

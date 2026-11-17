import { expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createWindowClose } from "./window-close.js";
import type { Layout } from "../runtime.js";

it("closes windows without asking their renderer to approve saving", async () => {
  const ready = new Set([1]);
  const pending = new Map<string, { windowId: number; resolve: (saved: boolean) => void }>();
  const destroy = vi.fn();
  const win = { id: 1, isDestroyed: () => false, destroy } as unknown as BrowserWindow;
  const layout = { label: "launcher", view: "launcher", visible: true } as Layout;
  const hideHostWindow = vi.fn();
  const ctx = {
    ready,
    pending,
    layouts: new Map([["launcher", layout]]),
    crashedWindows: new Set<number>(),
    releasing: new Map(),
    labelOf: () => "launcher",
    emit: vi.fn(),
    remember: vi.fn(),
    capsules: { refresh: vi.fn() },
    persistLayout: async () => {
      throw new Error("Layout write failed");
    },
    hideHostWindow,
    refreshTray: vi.fn(),
    hostShutdown: { request: vi.fn() },
  } as unknown as Parameters<typeof createWindowClose>[0];
  const close = createWindowClose(ctx);
  await close.hideAndRelease(win);
  expect(hideHostWindow).toHaveBeenCalledOnce();
  expect(destroy).not.toHaveBeenCalled();
  expect(layout.visible).toBe(false);

  await close.hideAndRelease(win);
  expect(hideHostWindow).toHaveBeenCalledTimes(2);
  expect(ctx.emit).not.toHaveBeenCalled();
  expect(destroy).not.toHaveBeenCalled();

  layout.label = "translation";
  await close.hideAndRelease(win);
  expect(destroy).toHaveBeenCalledOnce();
});

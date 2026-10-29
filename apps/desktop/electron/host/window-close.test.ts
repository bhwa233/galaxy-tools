import { expect, it, vi } from "vitest";
import type { BrowserWindow } from "electron";
import { createWindowClose } from "./window-close.js";
import type { Layout } from "../runtime.js";

it("keeps a saved launcher resident while preserving failed-save and workspace release boundaries", async () => {
  const ready = new Set([1]);
  const pending = new Map<string, { windowId: number; resolve: (saved: boolean) => void }>();
  const destroy = vi.fn();
  const win = { id: 1, isDestroyed: () => false, destroy } as unknown as BrowserWindow;
  let saved = true;
  const layout = { label: "launcher", view: "launcher", visible: true } as Layout;
  const hideHostWindow = vi.fn();
  const ctx = {
    ready,
    pending,
    layouts: new Map([["launcher", layout]]),
    crashedWindows: new Set<number>(),
    releasing: new Map(),
    labelOf: () => "launcher",
    emit: (_name: string, payload: { requestId: string }) =>
      pending.get(payload.requestId)!.resolve(saved),
    remember: vi.fn(),
    capsules: { refresh: vi.fn() },
    persistLayout: async () => {},
    hideHostWindow,
    refreshTray: vi.fn(),
    hostShutdown: { request: vi.fn() },
  } as unknown as Parameters<typeof createWindowClose>[0];
  const close = createWindowClose(ctx);
  await close.hideAndRelease(win);
  expect(hideHostWindow).toHaveBeenCalledOnce();
  expect(destroy).not.toHaveBeenCalled();
  expect(layout.visible).toBe(false);

  saved = false;
  await expect(close.hideAndRelease(win)).rejects.toThrow(/保存/);
  expect(hideHostWindow).toHaveBeenCalledOnce();
  expect(destroy).not.toHaveBeenCalled();

  saved = true;
  layout.label = "translation";
  await close.hideAndRelease(win);
  expect(destroy).toHaveBeenCalledOnce();
});

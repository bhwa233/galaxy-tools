import { expect, test, vi } from "vitest";
import { ShutdownCoordinator } from "./shutdown.js";

test("a failed save prevents plugin shutdown and exit", async () => {
  const shutdownPlugins = vi.fn();
  const onCommit = vi.fn();
  const onError = vi.fn();
  const coordinator = new ShutdownCoordinator({
    isBlocked: () => false,
    awaitWrites: () => {},
    awaitReleases: () => {},
    windows: () => ["unsaved", "saved"],
    prepare: (window: string) => window === "saved",
    describe: (window: string) => window,
    remember: () => {},
    persist: () => {},
    shutdownPlugins,
    onCommit,
    onError,
  });

  await coordinator.request();
  expect(onError).toHaveBeenCalledOnce();
  // The decision dialog must be able to name the window that did not save.
  expect(String(onError.mock.calls[0]![0])).toMatch(/: unsaved$/);
  expect(shutdownPlugins).not.toHaveBeenCalled();
  expect(onCommit).not.toHaveBeenCalled();
  expect(coordinator.isQuitting).toBe(false);
});

test("restores interaction before waiting for the failed-save decision", async () => {
  let dismiss!: () => void;
  const decision = new Promise<void>((resolve) => {
    dismiss = resolve;
  });
  const shutdownPlugins = vi.fn();
  const onCommit = vi.fn();
  const onError = vi.fn(() => decision);
  const coordinator = new ShutdownCoordinator({
    isBlocked: () => false,
    awaitWrites: () => {},
    awaitReleases: () => {},
    windows: () => ["unsaved"],
    prepare: () => false,
    remember: () => {},
    persist: () => {},
    shutdownPlugins,
    onCommit,
    onError,
  });
  const quitting = coordinator.request();
  try {
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    expect(coordinator.isQuitting).toBe(false);
    expect(coordinator.request()).toBe(quitting);
    expect(shutdownPlugins).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  } finally {
    dismiss();
    await quitting;
  }
});

test("keeps the fence up after a committed shutdown and does not run it twice", async () => {
  const shutdownPlugins = vi.fn();
  const onCommit = vi.fn();
  const coordinator = new ShutdownCoordinator({
    isBlocked: () => false,
    awaitWrites: () => {},
    awaitReleases: () => {},
    windows: () => ["saved"],
    prepare: () => true,
    remember: () => {},
    persist: () => {},
    shutdownPlugins,
    onCommit,
    onError: vi.fn(),
  });
  await coordinator.request();
  // app.quit() is asynchronous; until the process exits nothing may reach the
  // plugins that were just shut down.
  expect(coordinator.isQuitting).toBe(true);
  await coordinator.request();
  expect(shutdownPlugins).toHaveBeenCalledOnce();
  expect(onCommit).toHaveBeenCalledOnce();
});

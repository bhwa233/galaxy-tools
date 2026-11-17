import { expect, test, vi } from "vitest";
import { ShutdownCoordinator } from "./shutdown.js";

test("cleanup failures cannot cancel a user-requested exit", async () => {
  const shutdownPlugins = vi.fn(() => {
    throw new Error("Plugin save refused");
  });
  const onCommit = vi.fn();
  const onError = vi.fn();
  const coordinator = new ShutdownCoordinator({
    awaitWrites: () => {
      throw new Error("Write failed");
    },
    awaitReleases: () => {},
    windows: () => ["settings"],
    remember: () => {},
    persist: () => {},
    shutdownPlugins,
    onCommit,
    onError,
  });
  await coordinator.request();
  expect(onError).toHaveBeenCalledTimes(2);
  expect(shutdownPlugins).toHaveBeenCalledOnce();
  expect(onCommit).toHaveBeenCalledOnce();
  expect(coordinator.isQuitting).toBe(true);
  await coordinator.request();
  expect(onCommit).toHaveBeenCalledOnce();
});

test("an unanswered cleanup cannot trap the process or duplicate concurrent exits", async () => {
  vi.useFakeTimers();
  const onCommit = vi.fn();
  const coordinator = new ShutdownCoordinator({
    awaitWrites: () => new Promise<void>(() => {}),
    awaitReleases: () => {},
    windows: () => [],
    remember: () => {},
    persist: () => {},
    shutdownPlugins: () => {},
    onCommit,
    onError: vi.fn(),
  });
  try {
    const quitting = coordinator.request();
    expect(coordinator.request()).toBe(quitting);
    await vi.runAllTimersAsync();
    await quitting;
    expect(onCommit).toHaveBeenCalledOnce();
    expect(coordinator.isQuitting).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});

import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { ContextPanelCoordinator, type ContextPanelMaterialized } from "./context-panel.js";
import type {
  ContextPanelNativeConfig,
  ContextPanelNativeDriver,
  ContextPanelNativeOptions,
  ContextPanelNativeTrigger,
} from "./context-panel-native.js";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
const config: ContextPanelNativeConfig = {
  enabled: true,
  button: "middle",
  holdMs: 0,
  excludedApps: [],
};
const trigger = (): ContextPanelNativeTrigger => ({
  sourceToken: randomUUID(),
  sourceApp: "fixture.exe",
  point: { x: 20, y: 30 },
});
function fixture(
  materialize?: (
    capture: Parameters<ContextPanelNativeDriver["capture"]>[0],
    signal: AbortSignal,
  ) => Promise<ContextPanelMaterialized>,
  isBlocked?: () => boolean,
) {
  const disposals = new Map<string, ReturnType<typeof vi.fn>>();
  const capture = vi.fn<ContextPanelNativeDriver["capture"]>(async (sourceToken) => ({
    kind: "text",
    sourceToken,
    sourceApp: "fixture.exe",
    text: sourceToken,
    method: "uia",
  }));
  const driver: ContextPanelNativeDriver = {
    capture,
    update: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    restoreSource: vi.fn(async () => ({ ok: true })),
  };
  let nativeOptions!: ContextPanelNativeOptions;
  const startNative = vi.fn(async (options: ContextPanelNativeOptions) => {
    nativeOptions = options;
    return driver;
  });
  const publish = vi.fn(),
    focus = vi.fn(),
    clearQuery = vi.fn(),
    closeView = vi.fn();
  const openView = vi.fn(() => "same-host-caller");
  const coordinator = new ContextPanelCoordinator({
    supported: true,
    isBlocked,
    nativeOptions: {
      assetDirectory: "unused-fixture-assets",
      cacheDirectory: "unused-fixture-cache",
    },
    startNative,
    async materialize(value, signal) {
      if (value.kind !== "text") return { dispose() {} };
      if (materialize) return materialize(value.sourceToken, signal);
      const dispose = vi.fn();
      disposals.set(value.sourceToken, dispose);
      return { context: { kind: "text", text: value.text }, label: "选中文字", dispose };
    },
    openView,
    publish,
    focusView: focus,
    closeView,
    clearQuery,
  });
  return {
    coordinator,
    driver,
    capture,
    startNative,
    publish,
    focus,
    openView,
    clearQuery,
    closeView,
    disposals,
    get nativeOptions() {
      return nativeOptions;
    },
  };
}

// These exercise the production coordinator with controllable IO, not Windows hooks/UIA/clipboard.
describe("context panel host session lifecycle", () => {
  it("keeps source focus until materialization and disposes late A without publishing over B", async () => {
    const first = trigger(),
      second = trigger(),
      entered = deferred<void>(),
      late = deferred<ContextPanelMaterialized>();
    const disposeA = vi.fn(),
      disposeB = vi.fn();
    let firstSignal!: AbortSignal;
    let blocked = true;
    const f = fixture(
      async (token, signal) => {
        if (token === first.sourceToken) {
          firstSignal = signal;
          entered.resolve();
          return late.promise;
        }
        return { context: { kind: "text", text: "B" }, label: "word", dispose: disposeB };
      },
      () => blocked,
    );
    await f.coordinator.configure(config);
    await f.coordinator.trigger(first);
    expect(f.capture).not.toHaveBeenCalled();
    expect(() => f.coordinator.openCommon(first.point)).toThrow();
    blocked = false;
    const a = f.coordinator.trigger(first);
    await entered.promise;
    expect(f.openView).not.toHaveBeenCalled();
    await f.coordinator.trigger(second);
    expect(firstSignal.aborted).toBe(true);
    expect(f.coordinator.context("same-host-caller")).toEqual({ kind: "text", text: "B" });
    const session = f.coordinator.state("same-host-caller");
    late.resolve({ context: { kind: "text", text: "A" }, dispose: disposeA });
    await a;
    expect(disposeA).toHaveBeenCalledOnce();
    expect(disposeB).not.toHaveBeenCalled();
    expect(f.publish).toHaveBeenCalledOnce();
    expect(f.coordinator.state("same-host-caller")).toEqual(session);
    expect(f.capture.mock.calls.every((call) => /^[0-9a-f-]{36}$/u.test(call[1]))).toBe(true);
    await f.coordinator.shutdown();
    expect(disposeB).toHaveBeenCalledOnce();
  });

  it("scopes and clears context while retaining it on failed source restore", async () => {
    const f = fixture(),
      source = trigger();
    await f.coordinator.configure(config);
    f.capture.mockResolvedValueOnce({
      kind: "text",
      text: "hello",
      sourceToken: source.sourceToken,
      sourceApp: "fixture.exe",
      method: "uia",
    });
    await f.coordinator.trigger(source);
    const before = f.coordinator.state("same-host-caller")!;
    expect(before.suggestedQuery).toBe("hello");
    expect(f.coordinator.context("another-caller")).toBeUndefined();
    expect(f.coordinator.contextRevision("another-caller")).toBe(0);
    await f.coordinator.close("another-caller");
    expect(f.coordinator.contextLabel("same-host-caller")).toBe("选中文字");
    vi.mocked(f.driver.restoreSource).mockResolvedValueOnce({ ok: false });
    expect(await f.coordinator.returnToSource("same-host-caller")).toEqual({ restored: false });
    expect(f.coordinator.context("same-host-caller")).toEqual({ kind: "text", text: "hello" });
    expect(f.coordinator.state("same-host-caller")).toEqual(before);
    expect(f.disposals.get(source.sourceToken)).not.toHaveBeenCalled();
    expect(f.clearQuery).not.toHaveBeenCalled();
    expect(f.closeView).not.toHaveBeenCalled();
    f.coordinator.clearContext("same-host-caller");
    expect(f.coordinator.context("same-host-caller")).toBeUndefined();
    expect(f.coordinator.contextRevision("same-host-caller")).toBeGreaterThan(before.revision);
    expect(f.coordinator.state("same-host-caller")).toMatchObject({
      sessionId: before.sessionId,
      status: "no-context",
      returnAvailable: true,
    });
    expect(f.disposals.get(source.sourceToken)).toHaveBeenCalledOnce();
    f.closeView.mockImplementation((caller) => {
      void f.coordinator.close(caller, { retired: true });
    });
    expect(await f.coordinator.returnToSource("same-host-caller")).toEqual({ restored: true });
    expect(f.driver.restoreSource).toHaveBeenCalledWith(source.sourceToken);
    expect(await f.coordinator.returnToSource("same-host-caller")).toEqual({ restored: false });
    expect(f.closeView).toHaveBeenCalledOnce();
    for (const text of ["a".repeat(121), "中文正文"]) {
      const next = trigger();
      f.capture.mockResolvedValueOnce({
        kind: "text",
        text,
        sourceToken: next.sourceToken,
        sourceApp: "fixture.exe",
        method: "uia",
      });
      await f.coordinator.trigger(next);
      expect(f.coordinator.contextLabel("same-host-caller")).toBe("选中文字");
      expect(f.coordinator.state("same-host-caller")?.suggestedQuery).toBeUndefined();
    }
    const restore = deferred<{ ok: boolean }>();
    vi.mocked(f.driver.restoreSource).mockImplementationOnce(() => restore.promise);
    const returning = f.coordinator.returnToSource("same-host-caller");
    f.coordinator.openCommon(source.point);
    const replacement = f.coordinator.state("same-host-caller");
    restore.resolve({ ok: true });
    expect(await returning).toEqual({ restored: true });
    expect(f.coordinator.state("same-host-caller")).toEqual(replacement);
    const capturesBeforeCommon = f.capture.mock.calls.length;
    await f.coordinator.configure({ ...config, enabled: false });
    f.coordinator.openCommon(source.point);
    expect(f.coordinator.state("same-host-caller")).toMatchObject({
      status: "no-context",
      returnAvailable: false,
    });
    expect(await f.coordinator.returnToSource("same-host-caller")).toEqual({ restored: false });
    expect(f.capture).toHaveBeenCalledTimes(capturesBeforeCommon);
    await f.coordinator.shutdown();
  });

  it("defers execution blur, retains failed save context, fences old completion and awaits real driver stop", async () => {
    const f = fixture(),
      first = trigger(),
      second = trigger();
    await f.coordinator.configure(config);
    await f.coordinator.trigger(first);
    const failed = f.coordinator.beginExecution("same-host-caller")!;
    f.coordinator.blur("same-host-caller");
    expect(f.disposals.get(first.sourceToken)).not.toHaveBeenCalled();
    f.coordinator.endExecution("same-host-caller", { executionId: failed, success: false });
    expect(f.coordinator.context("same-host-caller")).toEqual({
      kind: "text",
      text: first.sourceToken,
    });
    expect(f.focus).toHaveBeenLastCalledWith("same-host-caller");
    const old = f.coordinator.beginExecution("same-host-caller")!;
    expect(f.coordinator.canPresent("same-host-caller", old)).toBe(true);
    await f.coordinator.trigger(second);
    expect(f.coordinator.canPresent("same-host-caller", old)).toBe(false);
    f.coordinator.endExecution("same-host-caller", { executionId: old, success: true });
    expect(f.coordinator.context("same-host-caller")).toEqual({
      kind: "text",
      text: second.sourceToken,
    });
    const preview = f.coordinator.beginExecution("same-host-caller")!;
    f.coordinator.endExecution("same-host-caller", {
      executionId: preview,
      success: true,
      keepOpen: true,
    });
    expect(f.disposals.get(second.sourceToken)).not.toHaveBeenCalled();
    const handoff = f.coordinator.beginExecution("same-host-caller")!;
    f.coordinator.blur("same-host-caller");
    f.coordinator.endExecution("same-host-caller", { executionId: handoff, success: true });
    // An accepted result may become ready after its own panel closes. A later
    // trigger/cancel must still prevent that old window from stealing focus.
    expect(f.coordinator.canPresent("same-host-caller", handoff)).toBe(true);
    expect(f.disposals.get(second.sourceToken)).toHaveBeenCalledOnce();
    expect(f.coordinator.state("same-host-caller")).toBeUndefined();
    f.coordinator.openCommon(first.point);
    expect(f.coordinator.canPresent("same-host-caller", handoff)).toBe(false);
    const stopped = deferred<void>();
    vi.mocked(f.driver.stop).mockImplementation(() => stopped.promise);
    const disabled = f.coordinator.configure({ ...config, enabled: false });
    let drained = false;
    void disabled.then(() => {
      drained = true;
    });
    await vi.waitFor(() => expect(f.driver.stop).toHaveBeenCalled());
    expect(drained).toBe(false);
    stopped.resolve();
    await disabled;
    await f.coordinator.trigger(trigger());
    expect(f.capture).toHaveBeenCalledTimes(2);
    await f.coordinator.shutdown();
    const unsupported = new ContextPanelCoordinator({
      nativeOptions: { assetDirectory: "unused", cacheDirectory: "unused" },
      supported: false,
      startNative: f.startNative,
      materialize: async () => ({ dispose() {} }),
      openView: () => "common",
      publish: f.publish,
      closeView: f.closeView,
      clearQuery: f.clearQuery,
    });
    await unsupported.configure(config);
    expect(unsupported.status.phase).toBe("unavailable");
    expect(unsupported.openCommon(first.point)).toBe("common");
    await unsupported.shutdown();
    expect(f.startNative).toHaveBeenCalledOnce();
  });
});

import { expect, it, vi } from "vitest";
import { createWindowCommands } from "./window-commands.js";
import { createLauncherCommands } from "./launcher-commands.js";
import type { CommandInvocation } from "./invocation.js";

it("hands off a pending selection at readiness without revealing a preloaded window", async () => {
  const payload = { kind: "launcher-input", result: { text: "pending", revision: 1 } };
  const emit = vi.fn();
  const win = { id: 1, isVisible: () => false, show: vi.fn(), focus: vi.fn() };
  const workspaceRequests = new Map([["launcher", payload]]);
  const ready = new Set<number>();
  const handlers = createWindowCommands({ ready, emit, workspaceRequests } as unknown as Parameters<
    typeof createWindowCommands
  >[0]);
  const invocation = {
    win,
    command: "desktop_ready",
    args: {},
    layout: { label: "launcher", visible: false },
  } as unknown as CommandInvocation;
  await handlers.desktop_ready(invocation);
  expect(ready.has(1)).toBe(true);
  expect(emit).toHaveBeenCalledWith("open-workspace", payload, win);
  expect(win.show).not.toHaveBeenCalled();
  expect(workspaceRequests.get("launcher")).toBe(payload);
});

it("rejects a late query from a hidden launcher before starting providers", async () => {
  const query = vi.fn();
  const handlers = createLauncherCommands({
    isHostView: () => true,
    launcher: { query },
  } as unknown as Parameters<typeof createLauncherCommands>[0]);
  await expect(
    handlers.launcher_query({
      win: { isVisible: () => false },
      layout: { label: "launcher" },
      command: "launcher_query",
      args: { query: "late", sessionId: "hidden" },
    } as unknown as CommandInvocation),
  ).rejects.toThrow(/隐藏/);
  expect(query).not.toHaveBeenCalled();
});

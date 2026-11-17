import { AsyncLocalStorage } from "node:async_hooks";
import type { WindowBinding, WindowEnvironment, PluginActivation } from "@spark233/sdk";
import type { WindowOpenRequest } from "./plugin-window-coordinator.js";

/** Invocation-local provenance survives async backend work without a mutable
 * global 'current desktop'. Only host-owned senders enter this context. */
export const windowOpenContext = new AsyncLocalStorage<{
  environment: WindowEnvironment;
  coordinated?: boolean;
  instanceId?: string;
  assertActive?: () => void;
  signal?: AbortSignal;
  presentation?: () => boolean;
}>();

// Page tasks belong to a window instance, not to its plugin's background scope.
// Kept here beside the trusted invocation context so pages cannot choose owners.
const pageTasks = new Map<string, Set<AbortController>>();

export async function awaitPluginTask<T>(operation: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return operation;
  let abort!: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try {
    return await Promise.race([operation, cancelled]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function runWindowTask<T>(instanceId: string, run: () => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const tasks = pageTasks.get(instanceId) ?? new Set<AbortController>();
  pageTasks.set(instanceId, tasks);
  tasks.add(controller);
  const parent = windowOpenContext.getStore();
  try {
    return await windowOpenContext.run(
      {
        ...parent,
        environment: parent?.environment ?? "desktop",
        signal: controller.signal,
        assertActive: () => {
          controller.signal.throwIfAborted();
          parent?.assertActive?.();
        },
      },
      () => awaitPluginTask(run(), controller.signal),
    );
  } finally {
    tasks.delete(controller);
    if (!tasks.size && pageTasks.get(instanceId) === tasks) pageTasks.delete(instanceId);
  }
}

export function cancelWindowTasks(instanceId: string): void {
  const tasks = pageTasks.get(instanceId);
  pageTasks.delete(instanceId);
  for (const task of tasks ?? []) task.abort(new Error("Window task cancelled"));
}
let route: ((request: WindowOpenRequest) => Promise<void>) | undefined;
export function registerWindowRouter(handler: typeof route): void {
  route = handler;
}
export async function routePluginWindow(
  pluginId: string,
  binding: WindowBinding,
  action: "open" | "create" = "open",
  activation?: PluginActivation,
): Promise<boolean> {
  if (!route || windowOpenContext.getStore()?.coordinated) return false;
  const assertActive = windowOpenContext.getStore()?.assertActive;
  assertActive?.();
  await route({
    pluginId,
    windowId: binding.windowId,
    ...(action === "create" && !binding.contentId ? {} : { binding }),
    environment: windowOpenContext.getStore()?.environment ?? "desktop",
    action,
    ...(activation ? { activation } : {}),
    ...(assertActive ? { assertActive } : {}),
  });
  return true;
}

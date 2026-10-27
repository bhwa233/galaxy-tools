type DesktopBridge = NonNullable<Window["spark233Desktop"]>;
type Handler = (args: unknown) => unknown | Promise<unknown>;
export interface DesktopCall {
  command: string;
  args: unknown;
}

// Reuse the production window bridge contract. Browser components cannot start
// Electron, so only this transport is controlled; feature APIs stay unchanged.
// No additional mocking framework or component-specific bridge is needed.
export function installDesktopBridge(handlers: Record<string, Handler>) {
  const previous = window.spark233Desktop;
  const calls: DesktopCall[] = [];
  const unexpected = new Set<string>();
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  const emit = (name: string, payload?: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener(payload);
  };
  const bridge: DesktopBridge = {
    label: "launcher",
    async invoke(command, args) {
      calls.push({ command, args });
      try {
        const handler = handlers[command];
        if (!handler) {
          unexpected.add(command);
          throw new Error(`Unexpected desktop command: ${command}`);
        }
        return { ok: true, value: await handler(args) };
      } catch (error) {
        return {
          ok: false,
          error:
            error instanceof Error ? { code: "testDesktopFailure", message: error.message } : error,
        };
      }
    },
    async emit(name, payload) {
      emit(name, payload);
    },
    on(name, callback) {
      const callbacks = listeners.get(name) ?? new Set();
      callbacks.add(callback);
      listeners.set(name, callbacks);
      return () => {
        callbacks.delete(callback);
        if (!callbacks.size) listeners.delete(name);
      };
    },
    async droppedPaths() {
      throw new Error("File drops are outside these UI cases");
    },
    async droppedApplicationEntries() {
      throw new Error("Application drops are outside these UI cases");
    },
  };
  window.spark233Desktop = bridge;
  return {
    calls,
    emit,
    restore() {
      listeners.clear();
      if (window.spark233Desktop !== bridge) return;
      if (previous) window.spark233Desktop = previous;
      else delete window.spark233Desktop;
      if (unexpected.size)
        throw new Error(`Unexpected desktop commands: ${[...unexpected].join(", ")}`);
    },
  };
}

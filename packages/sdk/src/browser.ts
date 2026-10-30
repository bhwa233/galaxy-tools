import type {
  JsonValue,
  PluginActivation,
  PluginCapability,
  PluginOwner,
  PluginSessionContext,
  PluginTheme,
  StopReason,
  PluginLauncherPage,
} from "./index.js";

export type PluginWindowStopReason = StopReason | "window-close";
/** A refusal reason is limited to 1000 characters on the wire. */
export type PluginSaveDecision = { ok: true } | { ok: false; reason: string };
export interface PluginWebContext extends PluginSessionContext {
  activationId?: string;
}
export type PluginWebEvent = { owner: PluginOwner } & (
  | { type: "activation"; activationId: string; activation: PluginActivation }
  | { type: "theme"; theme: PluginTheme }
  | { type: "query"; requestId: string; activation: PluginActivation }
  | { type: "query-cancel"; requestId: string }
  | { type: "prepareStop"; requestId: string; reason: PluginWindowStopReason }
);
export type PluginWebOperation =
  | "context.get"
  | "storage.get"
  | "storage.set"
  | "storage.remove"
  | "command.register"
  | "window.close"
  | "capability.invoke"
  | "lifecycle.result"
  | "query.result";
export interface PluginBrowserBridge {
  request(operation: PluginWebOperation, payload?: JsonValue): Promise<JsonValue | undefined>;
  subscribe(listener: (event: PluginWebEvent) => void): () => void;
}
export interface PluginBrowserClient {
  context(): Promise<PluginWebContext>;
  storage: {
    get(key: string): Promise<JsonValue | undefined>;
    set(key: string, value: JsonValue): Promise<void>;
    remove(key: string): Promise<void>;
  };
  registerCommand(
    id: string,
    handler: (activation: PluginActivation) => void | Promise<void>,
  ): Promise<() => void>;
  registerQuery(
    id: string,
    handler: (
      activation: PluginActivation,
      signal: AbortSignal,
    ) => PluginLauncherPage | Promise<PluginLauncherPage>,
  ): Promise<() => void>;
  onActivation(handler: (activation: PluginActivation) => void): () => void;
  onTheme(handler: (theme: PluginTheme) => void): () => void;
  onPrepareStop(
    handler: (reason: PluginWindowStopReason) => PluginSaveDecision | Promise<PluginSaveDecision>,
  ): () => void;
  capability(
    capability: PluginCapability,
    operation: string,
    payload?: JsonValue,
  ): Promise<JsonValue | undefined>;
  close(): Promise<void>;
  dispose(): void;
}

/** A browser-only client: no Electron/Node imports or arbitrary IPC channel access. */
export function createPluginClient(bridge?: PluginBrowserBridge): PluginBrowserClient {
  bridge ??= (globalThis as typeof globalThis & { spark233?: PluginBrowserBridge }).spark233;
  if (!bridge) throw new Error("spark233 plugin preload is unavailable");
  const transport = bridge;
  let active = true;
  let current: PluginWebContext | undefined;
  const queued: PluginWebEvent[] = [];
  const activations = new Map<(activation: PluginActivation) => void, string | undefined>();
  const themes = new Set<(theme: PluginTheme) => void>();
  const saves = new Set<
    (reason: PluginWindowStopReason) => PluginSaveDecision | Promise<PluginSaveDecision>
  >();
  const commands = new Map<string, (activation: PluginActivation) => void | Promise<void>>();
  const queries = new Map<
    string,
    (
      activation: PluginActivation,
      signal: AbortSignal,
    ) => PluginLauncherPage | Promise<PluginLauncherPage>
  >();
  const pendingQueries = new Map<string, AbortController>();
  const queryWaiters = new Map<string, Set<() => void>>();
  const request = (operation: PluginWebOperation, payload?: JsonValue) => {
    if (!active) return Promise.reject(new Error("Plugin browser client was released"));
    return transport.request(operation, payload);
  };
  const matches = (owner: PluginOwner) =>
    !!current &&
    owner.pluginId === current.owner.pluginId &&
    owner.version === current.owner.version &&
    owner.instanceId === current.owner.instanceId;
  const deliver = (handler: (activation: PluginActivation) => void) => {
    if (
      !active ||
      !current?.activation ||
      !current.activationId ||
      activations.get(handler) === current.activationId
    )
      return;
    activations.set(handler, current.activationId);
    handler(current.activation);
  };
  const receive = (event: PluginWebEvent) => {
    if (!active) return;
    if (!current) {
      queued.push(event);
      return;
    }
    if (!matches(event.owner)) return;
    if (event.type === "activation") {
      current.activation = event.activation;
      current.activationId = event.activationId;
      for (const handler of activations.keys()) deliver(handler);
    } else if (event.type === "theme") {
      current.theme = event.theme;
      for (const handler of themes) handler(event.theme);
    } else if (event.type === "query-cancel") {
      pendingQueries.get(event.requestId)?.abort();
      pendingQueries.delete(event.requestId);
    } else if (event.type === "query") {
      const controller = new AbortController();
      pendingQueries.set(event.requestId, controller);
      void (async () => {
        let result: { value: PluginLauncherPage } | { error: string };
        try {
          const id = event.activation.commandId;
          if (id && !queries.has(id))
            await new Promise<void>((resolve) => {
              const waiting = queryWaiters.get(id) ?? new Set<() => void>();
              const finish = () => {
                clearTimeout(timer);
                waiting.delete(finish);
                if (!waiting.size) queryWaiters.delete(id);
                controller.signal.removeEventListener("abort", finish);
                resolve(undefined);
              };
              const timer = setTimeout(finish, 250);
              waiting.add(finish);
              queryWaiters.set(id, waiting);
              controller.signal.addEventListener("abort", finish, { once: true });
              if (controller.signal.aborted) finish();
            });
          controller.signal.throwIfAborted();
          const handler = id ? queries.get(id) : undefined;
          if (!handler) throw new Error("Plugin query handler is not registered");
          result = { value: await handler(event.activation, controller.signal) };
        } catch (error) {
          result = {
            error:
              error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000),
          };
        }
        if (active && !controller.signal.aborted)
          await request("query.result", {
            requestId: event.requestId,
            ...result,
          } as unknown as JsonValue).catch(() =>
            request("query.result", {
              requestId: event.requestId,
              error: "Plugin query result is invalid or exceeds the payload limit",
            }),
          );
      })()
        .catch(() => {})
        .finally(() => {
          if (pendingQueries.get(event.requestId) === controller)
            pendingQueries.delete(event.requestId);
        });
    } else {
      void (async () => {
        let decision: PluginSaveDecision = { ok: true };
        try {
          for (const handler of saves) {
            decision = await handler(event.reason);
            if (!decision.ok) break;
          }
        } catch (error) {
          decision = { ok: false, reason: error instanceof Error ? error.message : String(error) };
        }
        if (!decision.ok) decision = { ok: false, reason: String(decision.reason).slice(0, 1000) };
        if (active) await request("lifecycle.result", { requestId: event.requestId, decision });
      })().catch(() => {}); // A released host fences late save acknowledgements.
    }
  };
  const unsubscribe = transport.subscribe(receive);
  const ready = request("context.get").then((value) => {
    if (!active) throw new Error("Plugin browser client was released");
    current = value as unknown as PluginWebContext;
    if (!current?.owner?.instanceId) throw new Error("Invalid plugin session context");
    for (const event of queued.splice(0)) receive(event);
    return current;
  });
  const onActivation = (handler: (activation: PluginActivation) => void) => {
    activations.set(handler, undefined);
    void ready
      .then(() => {
        if (activations.has(handler)) deliver(handler);
      })
      .catch(() => {});
    return () => {
      activations.delete(handler);
    };
  };
  onActivation((activation) => {
    const handler = activation.commandId ? commands.get(activation.commandId) : undefined;
    if (handler) void Promise.resolve(handler(activation)).catch(() => {});
  });
  return {
    context: async () => {
      await ready;
      return structuredClone(current!);
    },
    storage: {
      get: (key) => request("storage.get", { key }),
      set: async (key, value) => {
        await request("storage.set", { key, value });
      },
      remove: async (key) => {
        await request("storage.remove", { key });
      },
    },
    registerCommand: async (id, handler) => {
      await ready;
      await request("command.register", { id });
      commands.set(id, handler);
      if (current?.activation?.commandId === id) await handler(current.activation);
      return () => {
        if (commands.get(id) === handler) commands.delete(id);
      };
    },
    registerQuery: async (id, handler) => {
      queries.set(id, handler);
      for (const notify of [...(queryWaiters.get(id) ?? [])]) notify();
      try {
        await ready;
        await request("command.register", { id });
      } catch (error) {
        if (queries.get(id) === handler) queries.delete(id);
        throw error;
      }
      return () => {
        if (queries.get(id) === handler) queries.delete(id);
      };
    },
    onActivation,
    onTheme: (handler) => {
      themes.add(handler);
      return () => {
        themes.delete(handler);
      };
    },
    onPrepareStop: (handler) => {
      saves.add(handler);
      return () => {
        saves.delete(handler);
      };
    },
    capability: (capability, operation, payload) =>
      request("capability.invoke", {
        capability,
        operation,
        ...(payload === undefined ? {} : { payload }),
      }),
    close: async () => {
      await request("window.close");
    },
    dispose: () => {
      active = false;
      unsubscribe();
      queued.length = 0;
      activations.clear();
      themes.clear();
      saves.clear();
      commands.clear();
      queries.clear();
      for (const controller of pendingQueries.values()) controller.abort();
      pendingQueries.clear();
    },
  };
}

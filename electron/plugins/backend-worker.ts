import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import type {
  JsonValue,
  PluginActivation,
  PluginOwner,
  StopReason,
  PluginDataMigration,
  PluginMigrationContext,
  PluginMigrationResult,
} from "../../packages/sdk/src/index.js";
import type { StopDecision } from "./resources.js";

export interface BackendContext {
  owner: PluginOwner;
  dataDir: string;
  cacheDir: string;
  signal: AbortSignal;
  startupCheckOnly: boolean;
  emit: (name: string, payload?: JsonValue) => void;
  /** Scoped platform effect; once issued, await its final result before committing data. */
  callHost: (call: BackendHostCall) => Promise<void>;
}
export interface BackendHostCall {
  operation: "file.trash";
  path: string;
}
export interface BackendPlugin {
  activate?: (
    activation: PluginActivation,
    context: BackendContext,
  ) => JsonValue | undefined | Promise<JsonValue | undefined>;
  prepareStop: (
    reason: StopReason,
    context: BackendContext,
  ) => StopDecision | Promise<StopDecision>;
  stop?: (context: BackendContext) => void | Promise<void>;
}
export type BackendRequest = { owner: PluginOwner; requestId: string } & (
  | {
      type: "init";
      entryPath: string;
      dataDir: string;
      cacheDir: string;
      migration?: PluginDataMigration;
      startupCheckOnly?: boolean;
    }
  | { type: "activate"; activation: PluginActivation }
  | { type: "prepareStop"; reason: StopReason }
  | { type: "cancel" }
  | { type: "stop" }
  | { type: "exit" }
  | { type: "host-reply"; callId: string; ok: boolean; error?: string }
);
export type BackendMessage = { owner: PluginOwner; requestId: string } & (
  | { type: "response"; ok: true; value?: JsonValue }
  | { type: "response"; ok: false; error: string; code?: string; details?: Record<string, string> }
  | { type: "event"; name: string; payload?: JsonValue }
  | { type: "host-call"; callId: string; call: BackendHostCall }
);

// Utility processes reuse Electron's embedded Node; no plugin code executes in
// the host main process. This is crash isolation, not a Node permissions sandbox.
const port = process.parentPort;
if (port) {
  let owner: PluginOwner | undefined;
  let plugin: BackendPlugin | undefined;
  let lifetime: BackendContext | undefined;
  let initialized = false;
  let saveAcknowledged = false;
  let stopping = false;
  let stopped = false;
  const lifecycle = new AbortController();
  const requests = new Map<string, AbortController>();
  const hostCalls = new Map<
    string,
    { requestId: string; resolve: () => void; reject: (error: Error) => void }
  >();

  const matches = (candidate: PluginOwner) =>
    !!owner &&
    candidate.pluginId === owner.pluginId &&
    candidate.version === owner.version &&
    candidate.instanceId === owner.instanceId;
  const send = (message: BackendMessage) => port.postMessage(message);
  function context(message: BackendRequest, signal: AbortSignal): BackendContext {
    return {
      owner: Object.freeze({ ...message.owner }),
      dataDir: message.type === "init" ? message.dataDir : lifetime!.dataDir,
      cacheDir: message.type === "init" ? message.cacheDir : lifetime!.cacheDir,
      signal,
      startupCheckOnly:
        message.type === "init" ? (message.startupCheckOnly ?? false) : lifetime!.startupCheckOnly,
      emit: (name, payload) => {
        if (stopping || signal.aborted) return;
        send({ type: "event", owner: message.owner, requestId: message.requestId, name, payload });
      },
      callHost: (call) => {
        signal.throwIfAborted();
        if (stopping || hostCalls.size >= 32)
          return Promise.reject(new Error("Host effects unavailable"));
        const callId = randomUUID();
        // An accepted trash operation is irreversible. A cancelled activation
        // still drains this acknowledgement so metadata reflects the OS result.
        return new Promise<void>((resolve, reject) => {
          hostCalls.set(callId, { requestId: message.requestId, resolve, reject });
          send({
            type: "host-call",
            owner: message.owner,
            requestId: message.requestId,
            callId,
            call,
          });
        });
      },
    };
  }

  async function dispatch(message: BackendRequest): Promise<void> {
    if (!message || typeof message.requestId !== "string" || !message.owner) return;
    if (message.type === "init") {
      if (owner) return;
      owner = Object.freeze({ ...message.owner });
    } else if (!matches(message.owner)) return;
    if (message.type === "host-reply") {
      const pending = hostCalls.get(message.callId);
      if (!pending || pending.requestId !== message.requestId) return;
      hostCalls.delete(message.callId);
      if (message.ok) pending.resolve();
      else pending.reject(new Error(message.error ?? "Host platform action refused"));
      return;
    }
    if (message.type === "cancel") {
      requests.get(message.requestId)?.abort();
      return;
    }
    if (message.type === "exit") {
      if (stopped) process.exit(0);
      return;
    }
    try {
      let value: JsonValue | undefined;
      switch (message.type) {
        case "init": {
          lifetime = context(message, lifecycle.signal);
          const module = await import(pathToFileURL(message.entryPath).href);
          if (message.migration) {
            if (typeof module.migrate !== "function")
              throw new Error("Migration module must export migrate");
            const migrate = module.migrate as (
              context: PluginMigrationContext,
            ) => PluginMigrationResult | Promise<PluginMigrationResult>;
            const migrated = await migrate({
              ...message.migration,
              dataDir: message.dataDir,
              signal: lifecycle.signal,
            });
            if (!migrated || migrated.dataVersion !== message.migration.toDataVersion)
              throw new Error("Migration did not acknowledge the requested data version");
            value = { dataVersion: migrated.dataVersion };
            // Only the completed migration worker's own lifecycle is registered.
            // Its module's default export is deliberately never constructed.
            plugin = { prepareStop: () => ({ ok: true }) };
            initialized = true;
            break;
          }
          const exported = module.default ?? module;
          const candidate = typeof exported === "function" ? await exported(lifetime) : exported;
          if (!candidate || typeof candidate.prepareStop !== "function")
            throw new Error("Backend must export prepareStop to acknowledge durable shutdown");
          plugin = candidate as BackendPlugin;
          initialized = true;
          break;
        }
        case "activate": {
          if (!initialized || stopping) throw new Error("Backend is not accepting activation");
          saveAcknowledged = false;
          const controller = new AbortController();
          requests.set(message.requestId, controller);
          try {
            value = await plugin!.activate?.(
              message.activation,
              context(message, controller.signal),
            );
            if (controller.signal.aborted || stopping) return;
          } finally {
            requests.delete(message.requestId);
          }
          break;
        }
        case "prepareStop": {
          if (!initialized || stopping) throw new Error("Backend cannot prepare shutdown");
          // Do not abort tasks here: a save refusal must leave the live instance intact.
          const decision = await plugin!.prepareStop(message.reason, lifetime!);
          if (
            !decision ||
            typeof decision.ok !== "boolean" ||
            (!decision.ok && typeof decision.reason !== "string")
          )
            throw new Error("Invalid backend prepareStop response");
          saveAcknowledged = decision.ok;
          value = decision;
          break;
        }
        case "stop": {
          if (!initialized || !saveAcknowledged)
            throw new Error("Backend requires save acknowledgement before shutdown");
          stopping = true;
          lifecycle.abort();
          for (const controller of requests.values()) controller.abort();
          await plugin!.stop?.(lifetime!);
          stopped = true;
          break;
        }
      }
      send({
        type: "response",
        owner: message.owner,
        requestId: message.requestId,
        ok: true,
        value,
      });
    } catch (error) {
      const record = error && typeof error === "object" ? (error as Record<string, unknown>) : {};
      const code =
        typeof record.code === "string" && /^[a-zA-Z][a-zA-Z0-9_-]{0,79}$/.test(record.code)
          ? record.code
          : undefined;
      const details =
        record.details &&
        typeof record.details === "object" &&
        !Array.isArray(record.details) &&
        Object.entries(record.details).length <= 32 &&
        Object.entries(record.details).every(
          ([key, value]) => key.length <= 128 && typeof value === "string" && value.length <= 4096,
        )
          ? (record.details as Record<string, string>)
          : undefined;
      send({
        type: "response",
        owner: message.owner,
        requestId: message.requestId,
        ok: false,
        error: (error instanceof Error ? error.message : String(error)).slice(0, 8192),
        ...(code ? { code, ...(details ? { details } : {}) } : {}),
      });
    }
  }
  port.on("message", (event) => {
    void dispatch(event.data as BackendRequest);
  });
}

import type { JsonValue, PluginOwner } from "./index.js";

export type WidgetDefinitionId = string;
export type WidgetInstanceId = string;
export interface WidgetBinding {
  pluginId: string;
  widgetDefinitionId: WidgetDefinitionId;
  widgetInstanceId: WidgetInstanceId;
  owner: PluginOwner;
  loadGeneration: number;
}
export interface WidgetRankRow {
  id: string;
  label: string;
  valueText: string;
  iconId?: string;
}
export type WidgetValue =
  | string
  | number
  | boolean
  | null
  | readonly number[]
  | readonly WidgetRankRow[];
export interface WidgetDataFrame {
  revision: number;
  at: number;
  values: Readonly<Record<string, WidgetValue>>;
}
export type WidgetTone =
  | "default"
  | "muted"
  | "accent"
  | "warning"
  | "danger"
  | "upload"
  | "download";
export type WidgetIconName = "clock" | "network" | "arrow-up" | "arrow-down" | "warning";
export type BoundText = { text: string } | { dataKey: string };
export type DeclarativeNode =
  | {
      type: "stack";
      direction: "row" | "column";
      gap: 0 | 4 | 8 | 12;
      align: "start" | "center" | "end";
      children: DeclarativeNode[];
    }
  | {
      type: "text";
      value: BoundText;
      size: "caption" | "body" | "title";
      tone: WidgetTone;
      maxLines: 1 | 2 | 3;
    }
  | { type: "number"; dataKey: string; decimals: 0 | 1 | 2; unit?: string; tone: WidgetTone }
  | { type: "progress"; dataKey: string; tone: WidgetTone }
  | {
      type: "icon";
      name?: WidgetIconName;
      dataKey?: string;
      resourceId?: string;
      size: 16 | 20 | 24;
      tone: WidgetTone;
    }
  | { type: "sparkline"; dataKey: string; min?: number; max?: number; tone: WidgetTone }
  | { type: "rank-list"; dataKey: string; tone: WidgetTone }
  | { type: "button"; label: string; actionId: string; tone: WidgetTone };
export interface DeclarativeTemplate {
  version: 1;
  padding: 0 | 2 | 4 | 8 | 12 | 16;
  background: "card" | "transparent";
  root: DeclarativeNode;
}
export interface WidgetInit {
  binding: WidgetBinding;
  locale: string;
  theme: "light" | "dark";
  scaleFactor: number;
  size: { width: number; height: number };
  interactive: boolean;
  actions: Readonly<Record<string, { mode: "query" | "action" | "open-main" }>>;
  dataKeys: readonly string[];
}
export type WidgetMessageType =
  | "init"
  | "ready"
  | "heartbeat"
  | "data"
  | "visibility"
  | "size"
  | "theme"
  | "invoke"
  | "open-main"
  | "resize"
  | "cancel"
  | "result"
  | "diag";
export interface WidgetEnvelope {
  protocol: 1;
  widgetDefinitionId: string;
  widgetInstanceId: string;
  owner: PluginOwner;
  loadGeneration: number;
  seq: number;
  type: WidgetMessageType;
  requestId?: string;
  payload?: JsonValue;
}
export interface WidgetConnectMessage extends WidgetBinding {
  type: "spark233-widget-connect";
  protocol: 1;
  nonce: string;
}
export interface WidgetApi {
  onInit(cb: (init: WidgetInit) => void): () => void;
  onData(cb: (frame: WidgetDataFrame) => void): () => void;
  onVisibility(cb: (visible: boolean) => void): () => void;
  onSize(cb: (size: { width: number; height: number }) => void): () => void;
  invoke(
    actionId: string,
    input?: JsonValue,
    options?: { signal?: AbortSignal },
  ): Promise<JsonValue | undefined>;
  openMain(actionId: string): Promise<void>;
  resize(size: { width: number; height: number }): Promise<void>;
  dispose(): void;
}

const reserved = new Set(["__proto__", "prototype", "constructor"]);
const idPattern = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const encoder = new TextEncoder();
/** A bounded display-only list; never contains paths, URLs or executable markup. */
export function isWidgetRankRows(value: unknown): value is WidgetRankRow[] {
  return (
    Array.isArray(value) &&
    value.length <= 3 &&
    value.every((row) => {
      if (!row || typeof row !== "object" || Array.isArray(row)) return false;
      const r = row as Record<string, unknown>;
      return (
        Object.keys(r).every((key) => ["id", "label", "valueText", "iconId"].includes(key)) &&
        typeof r.id === "string" &&
        r.id.length > 0 &&
        r.id.length <= 80 &&
        typeof r.label === "string" &&
        r.label.length > 0 &&
        r.label.length <= 160 &&
        typeof r.valueText === "string" &&
        r.valueText.length <= 40 &&
        (r.iconId === undefined ||
          (typeof r.iconId === "string" &&
            r.iconId.length <= 80 &&
            idPattern.test(r.iconId) &&
            !reserved.has(r.iconId))) &&
        value.filter((item) => item?.id === r.id).length === 1
      );
    })
  );
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected widget object");
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key) || reserved.has(key)))
    throw new Error("Unknown widget field");
}
function shortString(value: unknown, max = 80): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}
function safeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
/** Bounds are applied before schema recursion or delivering JSON to plugin code. */
export function assertWidgetJson(
  value: unknown,
  maxBytes = 16 * 1024,
  maxDepth = 8,
  maxNodes = 512,
  maxStringLength = 2048,
): void {
  const pending = [{ value, depth: 0 }];
  const seen = new Set<unknown>();
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    if (++count > maxNodes || item.depth > maxDepth)
      throw new Error("Widget JSON complexity exceeded");
    const v = item.value;
    if (v === null || typeof v === "boolean") continue;
    if (typeof v === "string") {
      if (v.length > maxStringLength) throw new Error("Widget string exceeds limit");
      continue;
    }
    if (typeof v === "number") {
      if (!Number.isFinite(v)) throw new Error("Widget number must be finite");
      continue;
    }
    if (typeof v !== "object" || seen.has(v)) throw new Error("Widget value must be acyclic JSON");
    seen.add(v);
    if (Array.isArray(v))
      for (const child of v) pending.push({ value: child, depth: item.depth + 1 });
    else
      for (const [key, child] of Object.entries(v)) {
        if (key.length > 80 || reserved.has(key))
          throw new Error("Reserved or oversized widget key");
        pending.push({ value: child, depth: item.depth + 1 });
      }
  }
  if (encoder.encode(JSON.stringify(value)).byteLength > maxBytes)
    throw new Error("Widget payload exceeds byte limit");
}
export function isWidgetBinding(value: unknown): value is WidgetBinding {
  try {
    const b = object(value),
      owner = object(b.owner);
    return (
      shortString(b.pluginId) &&
      shortString(b.widgetDefinitionId) &&
      idPattern.test(b.widgetDefinitionId) &&
      shortString(b.widgetInstanceId, 128) &&
      uuidPattern.test(b.widgetInstanceId) &&
      safeInteger(b.loadGeneration) &&
      owner.pluginId === b.pluginId &&
      shortString(owner.version, 128) &&
      shortString(owner.instanceId, 128)
    );
  } catch {
    return false;
  }
}
export function sameWidgetBinding(a: WidgetBinding, b: WidgetBinding): boolean {
  return (
    a.pluginId === b.pluginId &&
    a.widgetDefinitionId === b.widgetDefinitionId &&
    a.widgetInstanceId === b.widgetInstanceId &&
    a.loadGeneration === b.loadGeneration &&
    a.owner.pluginId === b.owner.pluginId &&
    a.owner.version === b.owner.version &&
    a.owner.instanceId === b.owner.instanceId
  );
}
/** Zod remains in widget-schema: the standalone virtual browser asset cannot
 * resolve bare runtime imports. The host reuses this same bounded wire parser. */
export function parseWidgetWire(wire: unknown): WidgetEnvelope {
  if (typeof wire !== "string" || encoder.encode(wire).byteLength > 20 * 1024)
    throw new Error("Invalid widget wire size");
  const raw = object(JSON.parse(wire));
  keys(raw, [
    "protocol",
    "widgetDefinitionId",
    "widgetInstanceId",
    "owner",
    "loadGeneration",
    "seq",
    "type",
    "requestId",
    "payload",
  ]);
  const owner = object(raw.owner);
  keys(owner, ["pluginId", "version", "instanceId"]);
  if (
    raw.protocol !== 1 ||
    !isWidgetBinding({ ...raw, pluginId: owner.pluginId }) ||
    !safeInteger(raw.seq)
  )
    throw new Error("Invalid widget identity");
  const shapes: Record<WidgetMessageType, readonly string[]> = {
    init: ["locale", "theme", "scaleFactor", "size", "interactive", "actions", "dataKeys"],
    ready: [],
    heartbeat: [],
    data: ["revision", "at", "values"],
    visibility: ["visible"],
    size: ["width", "height"],
    theme: ["theme", "locale", "scaleFactor"],
    invoke: ["actionId", "input"],
    "open-main": ["actionId"],
    resize: ["width", "height"],
    cancel: [],
    result: ["ok", "value", "code", "message"],
    diag: ["level", "message"],
  };
  if (typeof raw.type !== "string" || !Object.hasOwn(shapes, raw.type))
    throw new Error("Unknown widget message");
  const type = raw.type as WidgetMessageType;
  const rpc = ["invoke", "open-main", "resize", "cancel", "result"].includes(type);
  if (
    rpc
      ? !shortString(raw.requestId, 128) || !uuidPattern.test(raw.requestId)
      : raw.requestId !== undefined
  )
    throw new Error("Invalid widget request identity");
  if (raw.payload !== undefined) {
    assertWidgetJson(raw.payload);
    keys(object(raw.payload), shapes[type]);
  } else if (shapes[type].length) throw new Error("Missing widget payload");
  const payload = raw.payload as Record<string, unknown> | undefined;
  const id = (value: unknown) =>
    shortString(value) && idPattern.test(value) && !reserved.has(value);
  const size = (value: unknown) => {
    const s = object(value);
    keys(s, ["width", "height"]);
    return safeInteger(s.width) && s.width <= 1200 && safeInteger(s.height) && s.height <= 900;
  };
  if (type === "ready" || type === "heartbeat" || type === "cancel") {
    if (payload !== undefined) throw new Error("Unexpected widget payload");
  } else if (type === "init") {
    if (
      !payload ||
      !shortString(payload.locale, 64) ||
      !["light", "dark"].includes(String(payload.theme)) ||
      typeof payload.scaleFactor !== "number" ||
      payload.scaleFactor <= 0 ||
      payload.scaleFactor > 8 ||
      !size(payload.size) ||
      typeof payload.interactive !== "boolean" ||
      !Array.isArray(payload.dataKeys) ||
      payload.dataKeys.length > 16 ||
      payload.dataKeys.some((key) => !id(key)) ||
      new Set(payload.dataKeys).size !== payload.dataKeys.length
    )
      throw new Error("Invalid widget init payload");
    const actions = object(payload.actions);
    if (Object.keys(actions).length > 8) throw new Error("Widget action limit exceeded");
    for (const [key, value] of Object.entries(actions)) {
      const action = object(value);
      keys(action, ["mode"]);
      if (!id(key) || !["query", "action", "open-main"].includes(String(action.mode)))
        throw new Error("Invalid widget action");
    }
  } else if (type === "data") {
    if (
      !payload ||
      typeof payload.revision !== "number" ||
      !Number.isSafeInteger(payload.revision) ||
      payload.revision < 0 ||
      typeof payload.at !== "number" ||
      !Number.isSafeInteger(payload.at) ||
      payload.at < 0
    )
      throw new Error("Invalid widget data header");
    const values = object(payload.values);
    let samples = 0,
      rows = 0;
    if (Object.keys(values).length > 16) throw new Error("Widget data key limit exceeded");
    for (const [key, value] of Object.entries(values)) {
      if (
        !id(key) ||
        !(
          value === null ||
          typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Math.abs(value) <= 1e15) ||
          (Array.isArray(value) &&
            value.length <= 120 &&
            value.every(
              (v) => typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e15,
            )) ||
          isWidgetRankRows(value)
        )
      )
        throw new Error("Invalid widget data value");
      if (Array.isArray(value) && value.every((v) => typeof v === "number"))
        samples += value.length;
      else if (isWidgetRankRows(value)) rows += value.length;
    }
    if (samples > 480) throw new Error("Widget series budget exceeded");
    if (rows > 6) throw new Error("Widget row budget exceeded");
  } else if (type === "visibility") {
    if (typeof payload?.visible !== "boolean") throw new Error("Invalid widget visibility");
  } else if (type === "size" || type === "resize") {
    if (!size(payload)) throw new Error("Invalid widget size");
  } else if (type === "theme") {
    if (
      !payload ||
      !["light", "dark"].includes(String(payload.theme)) ||
      !shortString(payload.locale, 64) ||
      typeof payload.scaleFactor !== "number" ||
      payload.scaleFactor <= 0 ||
      payload.scaleFactor > 8
    )
      throw new Error("Invalid widget theme");
  } else if (type === "invoke" || type === "open-main") {
    if (!id(payload?.actionId)) throw new Error("Invalid widget action ID");
  } else if (type === "result") {
    if (payload?.ok === true) keys(payload, ["ok", "value"]);
    else if (payload?.ok === false) {
      keys(payload, ["ok", "code", "message"]);
      if (!shortString(payload.code, 80) || !shortString(payload.message, 512))
        throw new Error("Invalid widget error");
    } else throw new Error("Invalid widget result");
  } else if (type === "diag") {
    if (
      !payload ||
      !["warn", "error"].includes(String(payload.level)) ||
      !shortString(payload.message, 512)
    )
      throw new Error("Invalid widget diagnostic");
  }
  return raw as unknown as WidgetEnvelope;
}

/** Connects only to the immediate parent and a host-created, single-use port. */
export function connectWidget(): Promise<WidgetApi> {
  if (typeof window === "undefined" || window.parent === window)
    return Promise.reject(new Error("Widget SDK requires a widget frame"));
  return new Promise((resolve, reject) => {
    let port: MessagePort | undefined,
      binding: WidgetBinding | undefined,
      init: WidgetInit | undefined;
    let outgoing = 0,
      incoming = 0,
      disposed = false,
      lastReceived = Date.now();
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let latestData: WidgetDataFrame | undefined;
    const initHandlers = new Set<(v: WidgetInit) => void>(),
      dataHandlers = new Set<(v: WidgetDataFrame) => void>();
    const visibilityHandlers = new Set<(v: boolean) => void>(),
      sizeHandlers = new Set<(v: { width: number; height: number }) => void>();
    const pending = new Map<
      string,
      {
        resolve: (v: JsonValue | undefined) => void;
        reject: (e: Error) => void;
        cleanup: () => void;
      }
    >();
    const notify = <T>(handlers: Set<(v: T) => void>, value: T) => {
      for (const handler of handlers) {
        try {
          handler(value);
        } catch {
          /* Widget callbacks cannot alter the bridge. */
        }
      }
    };
    const send = (type: WidgetMessageType, payload?: JsonValue, requestId?: string) => {
      if (disposed || !port || !binding) throw new Error("Widget bridge is not active");
      const message: WidgetEnvelope = {
        protocol: 1,
        widgetDefinitionId: binding.widgetDefinitionId,
        widgetInstanceId: binding.widgetInstanceId,
        owner: binding.owner,
        loadGeneration: binding.loadGeneration,
        seq: ++outgoing,
        type,
        ...(payload === undefined ? {} : { payload }),
        ...(requestId ? { requestId } : {}),
      };
      if (payload !== undefined) assertWidgetJson(payload);
      port.postMessage(JSON.stringify(message));
    };
    const close = (error = new Error("Widget bridge released")) => {
      if (disposed) return;
      disposed = true;
      clearTimeout(connectionTimer);
      if (heartbeat) clearInterval(heartbeat);
      window.removeEventListener("message", bootstrap);
      port?.close();
      for (const request of pending.values()) {
        request.cleanup();
        request.reject(error);
      }
      pending.clear();
      initHandlers.clear();
      dataHandlers.clear();
      visibilityHandlers.clear();
      sizeHandlers.clear();
      reject(error);
    };
    const rpc = (
      type: "invoke" | "open-main" | "resize",
      payload: JsonValue,
      signal?: AbortSignal,
    ): Promise<JsonValue | undefined> => {
      if (signal?.aborted)
        return Promise.reject(signal.reason ?? new Error("Widget request cancelled"));
      if (!init || disposed || !init.interactive)
        return Promise.reject(new Error("Widget action is unavailable"));
      if (pending.size >= 4) return Promise.reject(new Error("Widget request limit exceeded"));
      return new Promise((done, fail) => {
        const id = crypto.randomUUID();
        const cancel = (error: Error) => {
          const request = pending.get(id);
          if (!request) return;
          pending.delete(id);
          request.cleanup();
          try {
            send("cancel", undefined, id);
          } catch {
            /* Already revoked. */
          }
          fail(error);
        };
        const abort = () => cancel(new Error("Widget request cancelled"));
        const timer = setTimeout(() => cancel(new Error("widget.timeout")), 10000);
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        pending.set(id, { resolve: done, reject: fail, cleanup });
        signal?.addEventListener("abort", abort, { once: true });
        try {
          send(type, payload, id);
        } catch (error) {
          pending.delete(id);
          cleanup();
          fail(error);
        }
      });
    };
    const subscribe = <T>(set: Set<(v: T) => void>, cb: (v: T) => void, value?: T) => {
      set.add(cb);
      if (value !== undefined) cb(value);
      return () => {
        set.delete(cb);
      };
    };
    const api: WidgetApi = {
      onInit: (cb) => subscribe(initHandlers, cb, init),
      onData: (cb) => subscribe(dataHandlers, cb, latestData),
      onVisibility: (cb) => subscribe(visibilityHandlers, cb),
      onSize: (cb) => subscribe(sizeHandlers, cb, init?.size),
      invoke(actionId, input, options) {
        const action = init?.actions[actionId];
        if (!action || action.mode === "open-main")
          return Promise.reject(new Error("widget.commandDenied"));
        return rpc(
          "invoke",
          { actionId, ...(input === undefined ? {} : { input }) },
          options?.signal,
        );
      },
      async openMain(actionId) {
        if (init?.actions[actionId]?.mode !== "open-main" || !navigator.userActivation?.isActive)
          throw new Error("widget.commandDenied");
        await rpc("open-main", { actionId });
      },
      async resize(size) {
        await rpc("resize", size);
      },
      dispose: () => close(),
    };
    const receive = (event: MessageEvent) => {
      try {
        const message = parseWidgetWire(event.data);
        const candidate = {
          pluginId: message.owner.pluginId,
          widgetDefinitionId: message.widgetDefinitionId,
          widgetInstanceId: message.widgetInstanceId,
          owner: message.owner,
          loadGeneration: message.loadGeneration,
        };
        if (!binding || !sameWidgetBinding(binding, candidate) || message.seq <= incoming) return;
        incoming = message.seq;
        lastReceived = Date.now();
        const payload = message.payload as Record<string, JsonValue> | undefined;
        switch (message.type) {
          case "init": {
            if (
              init ||
              !payload ||
              !shortString(payload.locale) ||
              !["light", "dark"].includes(String(payload.theme)) ||
              typeof payload.scaleFactor !== "number" ||
              !Number.isFinite(payload.scaleFactor) ||
              payload.scaleFactor <= 0 ||
              typeof payload.interactive !== "boolean" ||
              !Array.isArray(payload.dataKeys)
            )
              throw new Error("Invalid widget init");
            const size = object(payload.size),
              actions = object(payload.actions);
            keys(size, ["width", "height"]);
            if (
              !safeInteger(size.width) ||
              !safeInteger(size.height) ||
              Object.keys(actions).length > 8 ||
              payload.dataKeys.length > 16 ||
              payload.dataKeys.some((key) => typeof key !== "string" || !idPattern.test(key))
            )
              throw new Error("Invalid widget init fields");
            for (const [key, value] of Object.entries(actions)) {
              const a = object(value);
              keys(a, ["mode"]);
              if (
                !idPattern.test(key) ||
                !["query", "action", "open-main"].includes(String(a.mode))
              )
                throw new Error("Invalid widget action");
            }
            init = { ...payload, binding } as unknown as WidgetInit;
            clearTimeout(connectionTimer);
            send("ready");
            heartbeat = setInterval(() => {
              if (Date.now() - lastReceived > 5000)
                close(new Error("Widget host heartbeat expired"));
              else {
                try {
                  send("heartbeat");
                } catch (error) {
                  close(error as Error);
                }
              }
            }, 1000);
            notify(initHandlers, init);
            resolve(api);
            break;
          }
          case "data": {
            if (
              !init ||
              !payload ||
              !Number.isSafeInteger(payload.revision) ||
              typeof payload.at !== "number" ||
              !Number.isFinite(payload.at)
            )
              throw new Error("Invalid widget data");
            const values = object(payload.values);
            if (
              Object.keys(values).length !== init.dataKeys.length ||
              init.dataKeys.some((key) => !Object.hasOwn(values, key))
            )
              throw new Error("Unexpected widget data key");
            const frame = payload as unknown as WidgetDataFrame;
            if (latestData && frame.revision <= latestData.revision) return;
            latestData = frame;
            notify(dataHandlers, frame);
            break;
          }
          case "visibility":
            if (typeof payload?.visible !== "boolean") throw new Error("Invalid visibility");
            notify(visibilityHandlers, payload.visible);
            break;
          case "size": {
            const size = payload as unknown as { width: number; height: number };
            if (!safeInteger(size?.width) || !safeInteger(size?.height))
              throw new Error("Invalid size");
            if (init) init = { ...init, size };
            notify(sizeHandlers, size);
            break;
          }
          case "theme":
            if (init && payload) {
              init = { ...init, ...payload } as WidgetInit;
              notify(initHandlers, init);
            }
            break;
          case "heartbeat":
            break;
          case "result": {
            const request = pending.get(message.requestId!);
            if (!request) return;
            pending.delete(message.requestId!);
            request.cleanup();
            if (payload?.ok === true) request.resolve(payload.value);
            else
              request.reject(
                new Error(
                  typeof payload?.code === "string" ? payload.code : "widget.protocolError",
                ),
              );
            break;
          }
          default:
            throw new Error("Widget received client-only message");
        }
      } catch (error) {
        close(error as Error);
      }
    };
    const bootstrap = (event: MessageEvent) => {
      if (event.source !== window.parent || port || disposed) return;
      const value = event.data;
      if (
        !value ||
        value.type !== "spark233-widget-connect" ||
        value.protocol !== 1 ||
        typeof value.nonce !== "string" ||
        !/^[0-9a-f]{32}$/i.test(value.nonce) ||
        event.ports.length !== 1
      )
        return;
      const candidate = value.binding ?? value;
      if (!isWidgetBinding(candidate)) return;
      binding = {
        pluginId: candidate.pluginId,
        widgetDefinitionId: candidate.widgetDefinitionId,
        widgetInstanceId: candidate.widgetInstanceId,
        owner: { ...candidate.owner },
        loadGeneration: candidate.loadGeneration,
      };
      port = event.ports[0];
      window.removeEventListener("message", bootstrap);
      port.onmessage = receive;
      port.onmessageerror = () => close(new Error("widget.protocolError"));
      port.start();
    };
    const connectionTimer = setTimeout(() => close(new Error("Widget connection timed out")), 5000);
    window.addEventListener("message", bootstrap);
    window.parent.postMessage({ type: "spark233-widget-boot", protocol: 1 }, "*");
  });
}

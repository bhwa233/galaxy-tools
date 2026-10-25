import type { JsonValue, PluginActivation, PluginOwner, StopReason } from "./index.js";

export const NATIVE_PLUGIN_PROTOCOL = 1;
export interface NativePluginIdentity {
  protocol: 1;
  owner: PluginOwner;
  sessionId: string;
  requestId: string;
}
export type NativePluginRequest = NativePluginIdentity &
  (
    | { type: "init"; entryId: string; dataDir: string; cacheDir: string }
    | { type: "activate" | "query"; activation: PluginActivation }
    | { type: "cancel" }
    | { type: "prepareStop"; reason: StopReason }
    | { type: "stop" }
  );
export type NativePluginMessage = NativePluginIdentity &
  (
    | { type: "response"; ok: true; value?: JsonValue }
    | { type: "response"; ok: false; error: string }
    | { type: "event"; name: string; payload?: JsonValue }
  );

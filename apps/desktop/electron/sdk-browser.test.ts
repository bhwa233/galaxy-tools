import { expect, it } from "vitest";
import {
  createPluginClient,
  type PluginBrowserBridge,
  type PluginWebEvent,
} from "../../../packages/sdk/src/browser.ts";
import type { JsonValue } from "@spark233/sdk";

function fixture() {
  const owner = { pluginId: "fixture.web", version: "1.0.0", instanceId: "owned-instance" };
  let receive!: (event: PluginWebEvent) => void;
  const replies = new Map<string, Record<string, JsonValue>>();
  const bridge: PluginBrowserBridge = {
    subscribe: (listener) => {
      receive = listener;
      return () => {};
    },
    request: async (operation, payload) => {
      if (operation === "context.get")
        return { owner, theme: { version: "1.0.0", preference: "system", effective: "light" } };
      if (operation === "query.result" || operation === "lifecycle.result") {
        if (Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024)
          throw new Error("Host payload limit");
        const response = payload as Record<string, JsonValue>;
        replies.set(response.requestId as string, response);
      }
      return undefined;
    },
  };
  return {
    owner,
    replies,
    client: createPluginClient(bridge),
    emit: (event: PluginWebEvent) => receive(event),
  };
}

// A context handshake previously let the first query outrun its handler registration.
it("waits for a cold query handler and reports rejected large results without timing out", async () => {
  const f = fixture();
  try {
    await f.client.context();
    f.emit({
      owner: f.owner,
      type: "query",
      requestId: "first",
      activation: { commandId: "search" },
    });
    await Promise.resolve();
    await f.client.registerQuery("search", async () => ({ items: [] }));
    await expect.poll(() => f.replies.get("first")?.value).toEqual({ items: [] });
    await f.client.registerQuery("search", async () => ({
      items: [],
      hint: "x".repeat(300 * 1024),
    }));
    f.emit({
      owner: f.owner,
      type: "query",
      requestId: "large",
      activation: { commandId: "search" },
    });
    await expect.poll(() => f.replies.get("large")?.error).toBeTypeOf("string");
  } finally {
    f.client.dispose();
  }
});

// An oversized refusal previously disappeared at the host boundary and became a timeout.
it("sends a bounded refusal when a save handler throws a long error", async () => {
  const f = fixture();
  try {
    await f.client.context();
    f.client.onPrepareStop(() => {
      throw new Error("cannot save ".repeat(1000));
    });
    f.emit({ owner: f.owner, type: "prepareStop", requestId: "save", reason: "quit" });
    await expect.poll(() => f.replies.get("save")).toBeDefined();
    const decision = f.replies.get("save")!.decision as Record<string, JsonValue>;
    expect(decision.ok).toBe(false);
    expect(String(decision.reason).length).toBeLessThanOrEqual(1000);
    expect(String(decision.reason)).toContain("cannot save");
  } finally {
    f.client.dispose();
  }
});

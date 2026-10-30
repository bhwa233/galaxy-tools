import { expect, it } from "vitest";
import { PluginWindowActivations } from "./plugin-window-activations.js";

it("isolates window handoffs and prevents a replaced owner consuming its successor's input", () => {
  const queue = new PluginWindowActivations();
  const owner = { pluginId: "fixture.tools", version: "1.0.0", instanceId: "old" };
  const successor = { ...owner, instanceId: "new" };
  queue.enqueue(1, owner, { query: "old" });
  queue.enqueue(2, owner, { query: "other window" });
  const payload = { query: "latest" };
  const latest = queue.enqueue(1, successor, payload);
  payload.query = "mutated after handoff";
  expect(queue.take(1, owner)).toBeUndefined();
  expect(queue.take(1, successor)).toEqual({ ...latest, payload: { query: "latest" } });
  expect(queue.take(1, successor)).toBeUndefined();
  expect(queue.take(2, owner)?.payload).toEqual({ query: "other window" });
  queue.enqueue(1, successor, { query: "closed" });
  queue.revoke(1);
  expect(queue.take(1, successor)).toBeUndefined();
});

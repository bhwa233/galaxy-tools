import fs from "node:fs";
import path from "node:path";
import type { JsonValue } from "../../sdk/src/index.js";
import type {
  BackendContext,
  BackendPlugin,
} from "../../../apps/desktop/electron/plugins/backend-worker.js";
import { atomicWrite } from "../../../apps/desktop/electron/persistence.js";
import { TrafficSampler } from "./traffic-sampler.js";
import { TrafficProcesses } from "./traffic-process.js";
import { TrafficPages } from "./traffic-pages.js";
import {
  formatTrafficRate,
  type TrafficScope,
  type TrafficSnapshot,
  type TrafficState,
} from "./traffic-contract.js";
export function hudValues(
  snapshot: TrafficSnapshot,
  process?: Pick<TrafficState, "process" | "processes">,
): Record<string, JsonValue> {
  const labels = {
    warming: "正在建立基线",
    complete: "网卡总量 · 含 LAN",
    gap: "采集中断 · 重新建立基线",
    paused: "采集已暂停",
    unavailable: "采集不可用",
  };
  return {
    rx: snapshot.rxBytesPerSecond,
    tx: snapshot.txBytesPerSecond,
    "rx-text": formatTrafficRate(snapshot.rxBytesPerSecond),
    "tx-text": formatTrafficRate(snapshot.txBytesPerSecond),
    "rx-series": snapshot.rxSeries,
    "tx-series": snapshot.txSeries,
    status: labels[snapshot.coverage],
    scope: "物理网卡总量 · 非按进程",
    "process-status":
      process?.process.status === "collecting"
        ? process.process.coverage === "gap"
          ? "采样有缺口"
          : ""
        : process?.process.status === "paused"
          ? "采集已暂停"
          : process?.process.status === "starting"
            ? "正在连接…"
            : process?.process.status === "not-installed"
              ? "未启用进程采集"
              : "采集不可用",
    "upload-top": [...(process?.processes ?? [])]
      .filter((row) => row.txBytesPerSecond !== null && row.txBytesPerSecond > 0)
      .sort((a, b) => b.txBytesPerSecond! - a.txBytesPerSecond!)
      .slice(0, 3)
      .map((row) => ({
        id: row.id,
        label: row.name.slice(0, 160),
        valueText: formatTrafficRate(row.txBytesPerSecond),
        ...(row.iconId ? { iconId: row.iconId } : {}),
      })),
    "download-top": [...(process?.processes ?? [])]
      .filter((row) => row.rxBytesPerSecond !== null && row.rxBytesPerSecond > 0)
      .sort((a, b) => b.rxBytesPerSecond! - a.rxBytesPerSecond!)
      .slice(0, 3)
      .map((row) => ({
        id: row.id,
        label: row.name.slice(0, 160),
        valueText: formatTrafficRate(row.rxBytesPerSecond),
        ...(row.iconId ? { iconId: row.iconId } : {}),
      })),
  };
}
export default function trafficBackend(lifetime: BackendContext): BackendPlugin {
  const preferencesFile = path.join(lifetime.dataDir, "preferences.json");
  let paused = false;
  let processScopes: TrafficScope[] = [];
  let selectedScope: TrafficScope = "own";
  if (fs.existsSync(preferencesFile)) {
    const value: unknown = JSON.parse(fs.readFileSync(preferencesFile, "utf8"));
    if (
      !value ||
      typeof value !== "object" ||
      !("paused" in value) ||
      typeof value.paused !== "boolean"
    )
      throw new Error("Traffic preferences could not be read; original file preserved");
    paused = value.paused;
    if ("processScopes" in value) {
      if (
        !Array.isArray(value.processScopes) ||
        value.processScopes.length > 2 ||
        value.processScopes.some((scope) => scope !== "own" && scope !== "machine")
      )
        throw new Error("Traffic scope preferences are invalid; original file preserved");
      processScopes = value.processScopes;
    }
    if ("scope" in value) {
      if (value.scope !== "own" && value.scope !== "machine")
        throw new Error("Traffic scope preference is invalid; original file preserved");
      selectedScope = value.scope;
    }
  }
  const subscriptions = new Set<string>();
  let preparing = false;
  let mutating = false;
  const pages = new TrafficPages();
  let timer: ReturnType<typeof setInterval> | undefined;
  const publish = () => {
    if (preparing) return;
    const state = processes.snapshot();
    const values = hudValues(sampler.snapshot(), state);
    const iconIds = new Set(
      [
        ...(values["upload-top"] as { iconId?: string }[]),
        ...(values["download-top"] as { iconId?: string }[]),
      ].map((row) => row.iconId),
    );
    const icons = Object.fromEntries(
      Object.entries(state.icons)
        .filter(([id]) => iconIds.has(id))
        .slice(0, 6)
        .map(([id, url]) => [id, url.slice("data:image/png;base64,".length)]),
    );
    for (const widgetInstanceId of subscriptions)
      lifetime.emit("traffic.snapshot", { widgetInstanceId, values, icons });
  };
  const sampler = new TrafficSampler(publish);
  const processes = new TrafficProcesses(lifetime, publish, paused, processScopes, selectedScope);
  const save = () => {
    fs.mkdirSync(lifetime.dataDir, { recursive: true });
    atomicWrite(
      preferencesFile,
      JSON.stringify({ paused, scope: processes.scope, processScopes: processes.processScopes }),
    );
  };
  const snapshot = (): TrafficState => ({
    ...sampler.snapshot(),
    paused,
    collectorPid: sampler.pid ?? null,
    ...processes.snapshot(),
  });
  const poll = () => {
    if (!preparing && !paused && !mutating) void processes.refresh();
  };
  const startPolling = () => {
    if (!timer) timer = setInterval(poll, 1000);
    poll();
  };
  const stopPolling = () => {
    if (timer) clearInterval(timer);
    timer = undefined;
  };
  if (!lifetime.startupCheckOnly) {
    if (paused) void sampler.stop(true);
    else sampler.start();
    startPolling();
    if (paused) void processes.refresh();
  }
  return {
    async activate(activation, context) {
      context.signal.throwIfAborted();
      const parameters = activation.parameters;
      const input =
        parameters && typeof parameters === "object" && !Array.isArray(parameters)
          ? parameters
          : {};
      const command = activation.commandId ?? "snapshot";
      if (input.cursor !== undefined) return pages.next(command, input.cursor);
      const result = () => pages.pack(command, snapshot());
      if (activation.commandId === "subscribe") {
        const widgetInstanceId = input.widgetInstanceId;
        const operationInput = input.input;
        const operation =
          operationInput && typeof operationInput === "object" && !Array.isArray(operationInput)
            ? operationInput.operation
            : undefined;
        if (
          typeof widgetInstanceId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(widgetInstanceId) ||
          !["attach", "detach", "remove"].includes(String(operation))
        )
          throw new Error("Invalid traffic widget subscription");
        if (operation === "attach") subscriptions.add(widgetInstanceId);
        else subscriptions.delete(widgetInstanceId);
        publish();
        return { values: hudValues(sampler.snapshot(), processes.snapshot()) };
      }
      if (activation.commandId === "pause") {
        if (typeof input.paused !== "boolean")
          throw new Error("Explicit paused preference required");
        const previous = paused;
        await processes.pause(input.paused);
        paused = input.paused;
        try {
          save();
        } catch (error) {
          paused = previous;
          await processes.pause(previous);
          throw error;
        }
        if (paused) await sampler.stop(true);
        else sampler.start();
        pages.clear();
        return result();
      }
      if (activation.commandId === "retry") {
        await sampler.stop(paused);
        if (!paused) sampler.start();
        await processes.retry();
        pages.clear();
        return result();
      }
      const readScope = (): TrafficScope => {
        if (input.scope !== "own" && input.scope !== "machine")
          throw new Error("Explicit traffic scope required");
        return input.scope;
      };
      if (activation.commandId === "process.scope") {
        await processes.select(readScope());
        save();
        pages.clear();
        return result();
      }
      if (activation.commandId === "process.enable") {
        if (paused) throw new Error("Resume collection before enabling process traffic");
        mutating = true;
        try {
          await processes.enable(readScope(), context.signal);
          save();
        } finally {
          mutating = false;
        }
        pages.clear();
        return result();
      }
      if (activation.commandId === "history") {
        const scope = readScope();
        if (
          typeof input.from !== "string" ||
          typeof input.to !== "string" ||
          !Number.isFinite(Date.parse(input.from)) ||
          !Number.isFinite(Date.parse(input.to)) ||
          Date.parse(input.from) >= Date.parse(input.to)
        )
          throw new Error("Valid traffic history range required");
        return pages.pack(
          command,
          await processes.history({ scope, from: input.from, to: input.to }, context.signal),
        );
      }
      if (activation.commandId === "history.clear") {
        if (input.confirmed !== true)
          throw new Error("History clearing requires explicit confirmation");
        await processes.clearHistory(readScope(), context.signal);
        pages.clear();
        return { ok: true };
      }
      if (activation.commandId === "connections") {
        if (typeof input.appId !== "string" || !/^[a-f0-9]{32}$/.test(input.appId))
          throw new Error("Valid process selection required");
        return pages.pack(
          command,
          await processes.connections(input.appId, readScope(), context.signal),
        );
      }
      if (!activation.commandId || ["open", "snapshot"].includes(activation.commandId))
        return result();
      throw new Error("Unknown traffic command");
    },
    async prepareStop(reason) {
      save();
      preparing = true;
      stopPolling();
      await sampler.stop(paused);
      return processes.prepareStop(reason);
    },
    async cancelStop() {
      await processes.cancelStop();
      preparing = false;
      if (!paused) sampler.start();
      startPolling();
    },
    async stop() {
      subscriptions.clear();
      pages.clear();
      stopPolling();
      await sampler.stop();
      await processes.stop();
    },
  };
}

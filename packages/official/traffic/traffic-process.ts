import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import type { JsonValue, StopReason } from "../../sdk/src/index.js";
import type { BackendContext } from "../../../apps/desktop/electron/plugins/backend-worker.js";
import {
  createNativePluginRuntime,
  type NativePluginRuntime,
} from "../../../apps/desktop/electron/plugins/native-runtime.js";
import { PluginResourceScope } from "../../../apps/desktop/electron/plugins/resources.js";
import type {
  TrafficConnectionsResult,
  TrafficHistoryResult,
  TrafficProcessInstance,
  TrafficProcessRow,
  TrafficProcessStatus,
  TrafficScope,
} from "./traffic-contract.js";
import { trafficCoverage as coverage, trafficHistoryCoverage } from "./traffic-quality.js";

type ObjectValue = Record<string, unknown>;
const object = (value: unknown): ObjectValue =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as ObjectValue) : {};
const array = (value: unknown): ObjectValue[] => (Array.isArray(value) ? value.map(object) : []);
const text = (value: unknown, fallback = "") => (typeof value === "string" ? value : fallback);
const bytes = (value: unknown): string | null => {
  if (value === null) return null;
  if (typeof value !== "string" || !/^\d{1,20}$/.test(value))
    throw new Error("Invalid native byte counter");
  return value;
};
const rate = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
const idFor = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 32);
const sumBytes = (a: string | null, b: string | null) =>
  a === null || b === null ? null : String(BigInt(a) + BigInt(b));

// Reuse the host's bounded native protocol, fixed entry validation and resource
// scope inside the already trusted utility worker. No second process transport,
// renderer-supplied executable or shell command is introduced.
export class TrafficProcesses {
  private resources: PluginResourceScope;
  private runtime?: Promise<NativePluginRuntime>;
  private current: TrafficScope = "own";
  private generation = 0;
  private groups: TrafficProcessRow[] = [];
  private images: Record<string, string> = {};
  private status: TrafficProcessStatus = {
    status: "starting",
    scope: "own",
    canEnable: true,
    canMachine: true,
    coverage: "warming",
  };
  private refreshPromise?: Promise<void>;
  private refreshAbort?: AbortController;
  private lastIcons = 0;
  private iconMisses = new Set<string>();
  private suspended: boolean;
  private enabledScopes = new Set<TrafficScope>();

  constructor(
    private lifetime: BackendContext,
    private changed: () => void,
    paused = false,
    scopes: TrafficScope[] = [],
    scope: TrafficScope = "own",
  ) {
    this.resources = new PluginResourceScope(lifetime.owner);
    this.suspended = paused;
    this.enabledScopes = new Set(scopes);
    this.current = scope;
    this.status.scope = scope;
  }
  get scope() {
    return this.current;
  }
  get processScopes() {
    return [...this.enabledScopes];
  }
  snapshot() {
    return { process: { ...this.status }, processes: this.groups, icons: this.images };
  }
  private native() {
    if (!this.runtime) {
      const root = fileURLToPath(new URL("./", import.meta.url));
      this.runtime = createNativePluginRuntime({
        scope: this.resources,
        pluginRoot: root,
        entries: {
          traffic: {
            path: path.join(root, "native", "spark233.TrafficClient.exe"),
            args: ["--bridge"],
          },
        },
        capabilities: ["native.process"],
        approveTrust: () => true,
        dataDir: this.lifetime.dataDir,
        cacheDir: this.lifetime.cacheDir,
        timeoutMs: 120_000,
        onCrash: (error) => this.failed(error),
      });
    }
    return this.runtime;
  }
  private async call(
    command: string,
    params: Record<string, JsonValue> = {},
    signal?: AbortSignal,
  ) {
    const runtime = await this.native();
    return object(
      await runtime.query(
        { commandId: "traffic", parameters: { command, scope: this.current, ...params } },
        signal,
      ),
    );
  }
  private failed(error: unknown) {
    this.groups = [];
    this.status = {
      ...this.status,
      status: "error",
      coverage: "unavailable",
      message: error instanceof Error ? error.message : String(error),
    };
    this.changed();
  }
  async refresh() {
    if (this.refreshPromise) return this.refreshPromise;
    const generation = this.generation;
    const abort = new AbortController();
    this.refreshAbort = abort;
    const signal = AbortSignal.any([abort.signal, this.lifetime.signal, AbortSignal.timeout(8000)]);
    this.refreshPromise = (async () => {
      try {
        let service = await this.call("status", {}, signal);
        if (generation !== this.generation) return;
        this.status = {
          status: !service.installed
            ? "not-installed"
            : !service.serviceAvailable
              ? "unavailable"
              : this.suspended
                ? "paused"
                : service.collecting
                  ? "collecting"
                  : "unavailable",
          scope: this.current,
          canEnable: true,
          canMachine: true,
          coverage:
            !service.installed || !service.serviceAvailable
              ? "unavailable"
              : service.collecting
                ? coverage(service)
                : "paused",
          message: !service.installed
            ? "启用进程采集后可查看程序排行、连接和历史流量"
            : !service.enabled && !this.suspended
              ? "当前范围尚未启用采集；启用后开始记录程序流量"
              : text(object(service.quality).reason) || undefined,
        };
        // Reacquire only an already persisted intent; status itself never enables
        // capture, installs a service or expands the user's granted scope.
        if (!this.suspended && service.serviceAvailable && service.enabled && !service.hasLease) {
          await this.call("enable", {}, signal);
          this.enabledScopes.add(this.current);
          service = await this.call("status", {}, signal);
        }
        if (!service.serviceAvailable || !service.enabled || this.suspended) {
          this.groups = [];
          return;
        }
        const raw = await this.pages("snapshot", { limit: 100 }, signal);
        if (generation !== this.generation) return;
        this.groups = this.group(array(raw.processes));
        this.status = {
          ...this.status,
          status:
            coverage(raw) === "unavailable"
              ? "unavailable"
              : service.collecting
                ? "collecting"
                : "starting",
          coverage: coverage(raw),
          message: text(object(raw.quality).reason) || this.status.message,
        };
        if (Date.now() - this.lastIcons > 2000) await this.loadIcons(generation, signal);
      } catch (error) {
        if (generation === this.generation) this.failed(error);
      } finally {
        this.changed();
      }
    })().finally(() => {
      this.refreshPromise = undefined;
      this.refreshAbort = undefined;
    });
    return this.refreshPromise;
  }
  private async pages(
    command: "snapshot" | "history" | "connections" | "icons",
    params: Record<string, JsonValue>,
    signal?: AbortSignal,
  ) {
    const result = await this.call(command, params, signal);
    const key =
      command === "snapshot"
        ? "processes"
        : command === "connections"
          ? "endpoints"
          : command === "icons"
            ? "icons"
            : "rows";
    const rows = array(result[key]);
    let cursor = text(result.nextCursor);
    const cursors = new Set<string>();
    while (cursor) {
      signal?.throwIfAborted();
      if (cursors.has(cursor) || rows.length > 200_000)
        throw new Error("Traffic query exceeds its bounded result window; narrow the date range");
      cursors.add(cursor);
      const page = await this.call(command, { ...params, cursor }, signal);
      if (command === "snapshot" && page.snapshotId !== result.snapshotId)
        throw new Error("Process snapshot expired; retry the query");
      rows.push(...array(page[key]));
      if (coverage(page) !== "complete") result.quality = { state: "partial" };
      cursor = text(page.nextCursor);
    }
    return { ...result, [key]: rows };
  }
  private group(rows: ObjectValue[], includeInstances = true): TrafficProcessRow[] {
    const groups = new Map<string, TrafficProcessRow>();
    const seenRuns = new Set<string>();
    for (const row of rows) {
      if (includeInstances && row.alive === false) continue;
      const id = text(row.processInstanceId);
      if (!id || !Number.isInteger(row.pid)) throw new Error("Invalid native process identity");
      const fullPath = text(row.imagePath);
      const appId = idFor(fullPath ? fullPath.toLocaleLowerCase("en-US") : id);
      const executable = fullPath.slice(0, 2048);
      const instance: TrafficProcessInstance = {
        id,
        pid: Number(row.pid),
        name: text(row.name, "未知进程").slice(0, 160),
        executable,
        rxBytes: bytes(row.rxBytes),
        txBytes: bytes(row.txBytes),
        ...(includeInstances
          ? {
              runRxBytes: row.runRxBytes === undefined ? null : bytes(row.runRxBytes),
              runTxBytes: row.runTxBytes === undefined ? null : bytes(row.runTxBytes),
              ...(text(row.observedSince) ? { observedSince: text(row.observedSince) } : {}),
            }
          : {}),
        rxBytesPerSecond: rate(row.rxBytesPerSec),
        txBytesPerSecond: rate(row.txBytesPerSec),
        tcpConnections: rate(row.tcpConnections),
        udpFlows: rate(row.udpFlows),
      };
      let group = groups.get(appId);
      if (!group) {
        group = {
          ...instance,
          id: appId,
          appId,
          category: !executable
            ? "unknown"
            : /[\\/]windows[\\/]/i.test(executable)
              ? "system"
              : "application",
          instances: [],
          iconId: `app-${appId}`,
        };
        group.rxBytes = "0";
        group.txBytes = "0";
        group.runRxBytes = undefined;
        group.runTxBytes = undefined;
        group.rxBytesPerSecond = 0;
        group.txBytesPerSecond = 0;
        group.tcpConnections = 0;
        group.udpFlows = 0;
        groups.set(appId, group);
      }
      if (includeInstances) group.instances.push(instance);
      group.rxBytes = sumBytes(group.rxBytes, instance.rxBytes);
      group.txBytes = sumBytes(group.txBytes, instance.txBytes);
      group.tcpConnections =
        group.tcpConnections === null || instance.tcpConnections === null
          ? null
          : group.tcpConnections + instance.tcpConnections;
      group.udpFlows =
        group.udpFlows === null || instance.udpFlows === null
          ? null
          : group.udpFlows + instance.udpFlows;
      group.rxBytesPerSecond =
        group.rxBytesPerSecond === null || instance.rxBytesPerSecond === null
          ? null
          : group.rxBytesPerSecond + instance.rxBytesPerSecond;
      group.txBytesPerSecond =
        group.txBytesPerSecond === null || instance.txBytesPerSecond === null
          ? null
          : group.txBytesPerSecond + instance.txBytesPerSecond;
      const runId = text(row.appRunId);
      const runKey = `${appId}:${runId}`;
      if (includeInstances && runId && !seenRuns.has(runKey)) {
        seenRuns.add(runKey);
        // Native repeats the application run total on each live member. Count
        // each run once, retaining bytes from members that have already exited.
        group.runRxBytes = sumBytes(
          group.runRxBytes === undefined ? "0" : group.runRxBytes,
          bytes(row.appRunRxBytes),
        );
        group.runTxBytes = sumBytes(
          group.runTxBytes === undefined ? "0" : group.runTxBytes,
          bytes(row.appRunTxBytes),
        );
        const started = text(row.appRunStartedAt);
        const observed = text(row.appRunObservedSince);
        if (started && (!group.runStartedAt || started < group.runStartedAt))
          group.runStartedAt = started;
        if (observed && (!group.runObservedSince || observed < group.runObservedSince))
          group.runObservedSince = observed;
        group.runCoverage =
          group.runCoverage === "gap" || row.appRunCoverage !== "complete" ? "gap" : "complete";
      }
    }
    return [...groups.values()];
  }
  private async loadIcons(generation: number, signal?: AbortSignal) {
    const top = [...this.groups]
      .filter((row) => !this.images[row.iconId!] && !this.iconMisses.has(row.appId))
      .sort(
        (a, b) =>
          (b.rxBytesPerSecond ?? 0) +
          (b.txBytesPerSecond ?? 0) -
          (a.rxBytesPerSecond ?? 0) -
          (a.txBytesPerSecond ?? 0),
      )
      .slice(0, 20);
    if (!top.length) {
      this.lastIcons = Date.now();
      return;
    }
    const result = await this.pages(
      "icons",
      { processInstanceIds: top.map((row) => row.instances[0]!.id) },
      signal,
    );
    if (generation !== this.generation) return;
    const current = new Set(this.groups.map((group) => group.iconId));
    const images: Record<string, string> = Object.fromEntries(
      Object.entries(this.images)
        .filter(([id]) => current.has(id))
        .slice(0, 236),
    );
    for (const group of top) this.iconMisses.add(group.appId);
    for (const row of array(result.icons)) {
      const group = top.find((candidate) => candidate.instances[0]!.id === row.processInstanceId);
      const png = text(row.pngBase64);
      if (group && png.length <= 87_384 && /^[A-Za-z0-9+/]+={0,2}$/.test(png)) {
        const data = Buffer.from(png, "base64");
        if (
          data.length >= 24 &&
          data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) &&
          data.readUInt32BE(16) <= 256 &&
          data.readUInt32BE(20) <= 256
        )
          images[group.iconId!] = `data:image/png;base64,${png}`;
      }
    }
    this.images = images;
    this.lastIcons = Date.now();
  }
  async select(scope: TrafficScope) {
    if (scope !== this.current) {
      this.generation++;
      this.refreshAbort?.abort();
      this.current = scope;
      this.groups = [];
      this.images = {};
      this.lastIcons = 0;
      this.iconMisses.clear();
      this.status = { ...this.status, scope, status: "starting", coverage: "warming" };
      await this.refreshPromise;
    }
    await this.refresh();
  }
  async enable(scope: TrafficScope, signal?: AbortSignal) {
    await this.invalidate();
    let state = await this.call("status", { scope: "own" }, signal);
    if (!state.installed || !state.serviceAvailable) await this.call("install", {}, signal);
    state = await this.call("status", { scope: "own" }, signal);
    if (
      scope === "machine" &&
      !(Array.isArray(state.grantedScopes) && state.grantedScopes.includes("machine"))
    )
      await this.call("grantMachine", {}, signal);
    this.current = scope;
    await this.call("enable", {}, signal);
    this.enabledScopes.add(scope);
    await this.refresh();
  }
  async pause(paused: boolean) {
    await this.invalidate();
    this.suspended = paused;
    const state = await this.call("status", { scope: "own" });
    if (state.serviceAvailable) {
      if (state.enabled) this.enabledScopes.add("own");
      for (const scope of this.enabledScopes)
        await this.call(paused ? "disable" : "enable", { scope });
    }
    await this.refresh();
  }
  async history(
    input: { from: string; to: string; scope: TrafficScope },
    signal?: AbortSignal,
  ): Promise<TrafficHistoryResult> {
    const requestedTo = Math.min(Date.parse(input.to), Date.now());
    const requestedFrom = Date.parse(input.from);
    if (requestedFrom >= requestedTo) throw new Error("所选时间尚未开始采集");
    const age = Date.now() - requestedFrom;
    const resolutionSec = age < 47 * 3600_000 ? 60 : age < 89 * 86400_000 ? 3600 : 86400;
    const bucket = resolutionSec * 1000;
    const from = Math.floor(requestedFrom / bucket) * bucket;
    const to = Math.min(Date.now(), Math.ceil(requestedTo / bucket) * bucket);
    const raw = await this.pages(
      "history",
      {
        ...input,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        resolutionSec,
        groupBy: "path",
        limit: 100,
      },
      signal,
    );
    const grouped = this.group(
      array(raw.rows).map((row) => ({
        ...row,
        processInstanceId: text(row.processInstanceId, idFor(text(row.imagePath))),
        pid: row.pid ?? 0,
      })),
      false,
    );
    const end = Math.min(to, Date.parse(text(raw.durableThrough)) || to);
    const quality = trafficHistoryCoverage(raw, from, end);
    const hasCoverage = quality !== "unavailable";
    return {
      ...input,
      from: new Date(from).toISOString(),
      to: new Date(to).toISOString(),
      coverage: quality,
      rows: grouped.map(({ appId, name, executable, category, rxBytes, txBytes, iconId }) => ({
        appId,
        name,
        executable,
        category,
        rxBytes: bytes(rxBytes)!,
        txBytes: bytes(txBytes)!,
        iconId,
      })),
      totals: {
        rxBytes: hasCoverage
          ? String(grouped.reduce((sum, row) => sum + BigInt(row.rxBytes!), 0n))
          : null,
        txBytes: hasCoverage
          ? String(grouped.reduce((sum, row) => sum + BigInt(row.txBytes!), 0n))
          : null,
      },
      durableThrough: text(raw.durableThrough) || undefined,
      earliestAvailable: text(raw.earliestAvailable) || undefined,
      resolutionSec: Number(raw.resolutionSec) || undefined,
      message:
        quality === "unavailable"
          ? "所选时间内没有已保存的采集覆盖"
          : quality === "gap"
            ? "所选时间内存在未覆盖区间，累计值仅包含已采集数据"
            : undefined,
    };
  }
  async clearHistory(scope: TrafficScope, signal?: AbortSignal) {
    await this.call("clearHistory", { scope, confirm: true }, signal);
  }
  async connections(
    appId: string,
    scope: TrafficScope,
    signal?: AbortSignal,
  ): Promise<TrafficConnectionsResult> {
    if (scope !== this.current) throw new Error("Process scope changed; select the program again");
    const group = this.groups.find((candidate) => candidate.appId === appId);
    if (!group) throw new Error("The process instance is no longer available");
    const rows: TrafficConnectionsResult["rows"] = [];
    for (const instance of group.instances)
      for (const kind of ["tcp", "udp-local", "udp-observed"] as const) {
        const raw = await this.pages(
          "connections",
          { scope, processInstanceId: instance.id, kind, limit: 100 },
          signal,
        );
        for (const row of array(raw.endpoints))
          rows.push({
            id: idFor(JSON.stringify([instance.id, kind, row])),
            pid: instance.pid,
            protocol: kind === "tcp" ? "TCP" : "UDP",
            kind,
            localAddress: text(row.localAddress),
            localPort: Number(row.localPort),
            remoteAddress: kind === "udp-local" ? null : text(row.remoteAddress) || null,
            remotePort:
              kind === "udp-local" || row.remotePort == null ? null : Number(row.remotePort),
            state: text(row.state, kind === "udp-local" ? "本地端点" : "观测流"),
          });
      }
    return {
      rows,
      coverage: "complete",
      message: "UDP 本地端点和 ETW 观测流分别展示；观测流不等同于持久连接",
    };
  }
  private async invalidate() {
    this.generation++;
    this.refreshAbort?.abort();
    await this.refreshPromise;
  }
  async retry() {
    await this.invalidate();
    const result = await this.resources.stop("crash");
    if (!result.ok) throw new Error(result.errors.join("; "));
    this.resources = new PluginResourceScope(this.lifetime.owner);
    this.runtime = undefined;
    this.lastIcons = 0;
    this.iconMisses.clear();
    await this.refresh();
  }
  async prepareStop(reason: StopReason) {
    await this.invalidate();
    return this.resources.prepareStop(reason);
  }
  async cancelStop() {
    await this.resources.cancelStop();
  }
  async stop() {
    const result = await this.resources.release();
    if (!result.ok) throw new Error(result.errors.join("; "));
  }
}

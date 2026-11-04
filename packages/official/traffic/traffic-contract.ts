export interface InterfaceCounter {
  id: string;
  index: number;
  name: string;
  description: string;
  addresses: string[];
  rx: string;
  tx: string;
}
export interface InterfaceFrame {
  at: number;
  elapsedMs: number;
  adapters: InterfaceCounter[];
}
export type TrafficCoverage = "warming" | "complete" | "gap" | "paused" | "unavailable";
export interface TrafficSnapshot {
  source: "interface-totals";
  scope: "active-physical-adapters";
  collectorEpoch: string;
  coverage: TrafficCoverage;
  at: number;
  intervalMs: number | null;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
  adapters: InterfaceCounter[];
  rxSeries: number[];
  txSeries: number[];
  message?: string;
}

export type TrafficScope = "own" | "machine";
export type TrafficCategory = "application" | "system" | "unknown";
export type TrafficProcessAction = "reveal" | "properties" | "terminate";
export interface TrafficProcessActionResult {
  results: {
    instanceId: string;
    status: "opened" | "terminated" | "exited" | "failed";
    message?: string;
  }[];
}
export interface TrafficProcessInstance {
  id: string;
  pid: number;
  name: string;
  executable: string;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
  rxBytes: string | null;
  txBytes: string | null;
  runRxBytes?: string | null;
  runTxBytes?: string | null;
  observedSince?: string;
  tcpConnections: number | null;
  udpFlows: number | null;
}
export interface TrafficProcessRow {
  id: string;
  appId: string;
  name: string;
  executable: string;
  category: TrafficCategory;
  rxBytesPerSecond: number | null;
  txBytesPerSecond: number | null;
  rxBytes: string | null;
  txBytes: string | null;
  runRxBytes?: string | null;
  runTxBytes?: string | null;
  runStartedAt?: string;
  runObservedSince?: string;
  runCoverage?: "complete" | "gap";
  tcpConnections: number | null;
  udpFlows: number | null;
  instances: TrafficProcessInstance[];
  iconId?: string;
}
export interface TrafficProcessStatus {
  status: "not-installed" | "starting" | "collecting" | "paused" | "unavailable" | "error";
  scope: TrafficScope;
  message?: string;
  canEnable: boolean;
  canMachine: boolean;
  coverage: TrafficCoverage;
}
export interface TrafficState extends TrafficSnapshot {
  paused: boolean;
  collectorPid: number | null;
  process: TrafficProcessStatus;
  processes: TrafficProcessRow[];
  icons: Record<string, string>;
}
export interface TrafficHistoryRow {
  appId: string;
  name: string;
  executable: string;
  category: TrafficCategory;
  rxBytes: string;
  txBytes: string;
  iconId?: string;
}
export interface TrafficHistoryResult {
  from: string;
  to: string;
  scope: TrafficScope;
  coverage: TrafficCoverage;
  message?: string;
  rows: TrafficHistoryRow[];
  totals: { rxBytes: string | null; txBytes: string | null };
  durableThrough?: string;
  earliestAvailable?: string;
  resolutionSec?: number;
}
export interface TrafficConnection {
  id: string;
  pid: number;
  protocol: "TCP" | "UDP";
  localAddress: string;
  localPort: number;
  remoteAddress: string | null;
  remotePort: number | null;
  state: string;
  kind: "tcp" | "udp-local" | "udp-observed";
}
export interface TrafficConnectionsResult {
  rows: TrafficConnection[];
  coverage: TrafficCoverage;
  message?: string;
}

/** Familiar Windows display labels; retain binary scaling and raw byte counters. */
export function formatTrafficBytes(value: string | number | null): string {
  if (value === null) return "—";
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB", "EB"];
  const index = Math.min(6, Math.max(0, Math.floor(Math.log2(Math.max(1, number)) / 10)));
  return `${(number / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

/** Shared traffic display units; backend HUD and main page use the same value. */
export function formatTrafficRate(value: number | null): string {
  if (value === null) return "—";
  const units = ["B/s", "KB/s", "MB/s", "GB/s"];
  const index = Math.min(3, Math.max(0, Math.floor(Math.log2(Math.max(1, value)) / 10)));
  return `${(value / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}

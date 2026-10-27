export const DIAGNOSTIC_LEVELS = ["debug", "info", "warn", "error"] as const;
export const DIAGNOSTIC_KINDS = [
  "host",
  "lifecycle",
  "backend",
  "native",
  "search",
  "ocr",
  "translation",
  "package",
  "output",
] as const;
export const DIAGNOSTIC_CODES = [
  "started",
  "completed",
  "cancelled",
  "failed",
  "crashed",
  "enabled",
  "disabled",
  "uninstalled",
  "stopped",
  "output",
  "queued",
  "resolving",
  "downloading",
  "verifying",
  "awaiting-confirmation",
  "saving",
  "backing-up",
  "migrating",
  "switching",
  "starting",
  "recovering",
  "recovery-required",
] as const;
export const DIAGNOSTIC_ERROR_CODES = [
  "unknownFailure",
  "timeout",
  "permissionDenied",
  "unavailable",
  "invalidData",
  "saveRefused",
  "recoveryRequired",
  "networkFailure",
  "integrityMismatch",
  "incompatible",
  "diskUnavailable",
  "protocolFailure",
] as const;
export type DiagnosticLevel = (typeof DIAGNOSTIC_LEVELS)[number];
export type DiagnosticKind = (typeof DIAGNOSTIC_KINDS)[number];
export type DiagnosticCode = (typeof DIAGNOSTIC_CODES)[number];
export type DiagnosticErrorCode = (typeof DIAGNOSTIC_ERROR_CODES)[number];
export interface DiagnosticTarget {
  pluginId: string;
  version: string;
}
export interface DiagnosticOwner extends DiagnosticTarget {
  instanceId: string;
}
export interface DiagnosticEvent {
  kind: DiagnosticKind;
  code: DiagnosticCode;
  level: DiagnosticLevel;
  owner?: DiagnosticOwner;
  target?: DiagnosticTarget;
  taskId?: string;
  durationMs?: number;
  byteCount?: number;
  count?: number;
  stream?: "stdout" | "stderr";
  errorCode?: DiagnosticErrorCode;
}
export interface DiagnosticEntry extends DiagnosticEvent {
  epoch: string;
  sequence: number;
  at: number;
  source: "host" | "plugin";
}
export interface DiagnosticFilter {
  source?: "host" | "plugin";
  pluginId?: string;
  levels?: DiagnosticLevel[];
  from?: number;
  to?: number;
  afterSequence?: number;
  limit?: number;
}
export interface DiagnosticDropped {
  invalid: number;
  history: number;
  queue: number;
  disk: number;
  output: number;
  subscribers: number;
}
export interface DiagnosticLimits {
  historyEntries: number;
  historyBytes: number;
  queueEntries: number;
  queueBytes: number;
  diskFiles: number;
  diskFileBytes: number;
  entryBytes: number;
  subscribers: number;
  outputGroups: number;
  batchEntries: number;
  batchIntervalMs: number;
}
export interface DiagnosticSnapshot {
  epoch: string;
  entries: DiagnosticEntry[];
  firstSequence: number;
  lastSequence: number;
  dropped: DiagnosticDropped;
  limits: DiagnosticLimits;
  diskStatus: "ready" | "unavailable";
}
export interface DiagnosticBatch extends DiagnosticSnapshot {
  reset: boolean;
  cursor: number;
}
export interface DiagnosticExport extends DiagnosticSnapshot {
  schemaVersion: 1;
  generatedAt: number;
  filter: DiagnosticFilter;
}

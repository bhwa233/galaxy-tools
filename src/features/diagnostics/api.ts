import { invoke, listen } from "../../platform/desktop";
import type { DiagnosticBatch, DiagnosticFilter, DiagnosticSnapshot } from "./types";

export function listDiagnostics(filter?: DiagnosticFilter): Promise<DiagnosticSnapshot> {
  return invoke("diagnostics_list", filter ? { filter } : undefined);
}

export function subscribeDiagnostics(): Promise<DiagnosticSnapshot> {
  return invoke("diagnostics_subscribe");
}

export function unsubscribeDiagnostics(): Promise<void> {
  return invoke("diagnostics_unsubscribe");
}

export function watchDiagnostics(callback: (batch: DiagnosticBatch) => void): Promise<() => void> {
  return listen<DiagnosticBatch>("diagnostics-batch", ({ payload }) => callback(payload));
}

export function clearDiagnostics(): Promise<DiagnosticSnapshot> {
  return invoke("diagnostics_clear");
}

export function exportDiagnostics(filter?: DiagnosticFilter): Promise<{ exported: boolean }> {
  return invoke("diagnostics_export", filter ? { filter } : undefined);
}

import { invoke } from "../../platform/desktop";
import type { BackupReport, BackupSelection } from "./types";

export function createBackup(): Promise<BackupReport | undefined> {
  return invoke("backup_create");
}
export function inspectBackup(): Promise<BackupSelection | undefined> {
  return invoke("backup_inspect");
}
export function restoreBackup(selectionId: string): Promise<BackupReport> {
  return invoke("backup_restore", { selectionId });
}

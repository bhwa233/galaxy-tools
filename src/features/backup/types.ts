export interface BackupInspection {
  snapshotDirectory: string;
  createdAt: string;
  hostVersion: string;
  plugins: Array<{ pluginId: string; version: string; enabled: boolean }>;
  files: number;
  bytes: number;
}
export interface BackupSelection extends BackupInspection {
  selectionId: string;
}
export interface BackupReport {
  snapshotDirectory: string;
  recoveryDirectory?: string;
  files: number;
  bytes: number;
  warnings: string[];
}

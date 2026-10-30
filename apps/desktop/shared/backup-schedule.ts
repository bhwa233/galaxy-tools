export interface BackupSchedule {
  enabled: boolean;
  directory: string;
  intervalDays: number;
  keep: number;
  lastSuccess?: string;
  lastAttempt?: string;
  lastError?: string;
  running: boolean;
}

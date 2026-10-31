import fs from "node:fs";
import path from "node:path";
import type { UpdateSettings } from "../../src/features/update/types.js";
import { atomicWrite, readJson } from "../persistence.js";

export function defaultUpdateSettings(): UpdateSettings {
  return {
    autoCheck: true,
    autoDownload: false,
    checkIntervalHours: 24,
    checkSourcePreference: "githubFirst",
    downloadSourcePreference: "githubFirst",
    channel: "stable",
    allowPrerelease: false,
    lastAutoCheckAt: null,
    hasMirrorChyanCdk: false,
    mirrorChyanCdkLength: null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Host updates are GitHub-only for now: source preferences and MirrorChyan
 * credentials are normalized away instead of being persisted.
 */
export function normalizeUpdateSettings(value: unknown): UpdateSettings {
  const defaults = defaultUpdateSettings();
  if (!isRecord(value)) return defaults;
  const interval =
    typeof value.checkIntervalHours === "number" && Number.isFinite(value.checkIntervalHours)
      ? Math.min(24 * 30, Math.max(1, Math.round(value.checkIntervalHours)))
      : defaults.checkIntervalHours;
  return {
    autoCheck: typeof value.autoCheck === "boolean" ? value.autoCheck : defaults.autoCheck,
    autoDownload:
      typeof value.autoDownload === "boolean" ? value.autoDownload : defaults.autoDownload,
    checkIntervalHours: interval,
    checkSourcePreference: "githubFirst",
    downloadSourcePreference: "githubFirst",
    channel: value.channel === "beta" ? "beta" : "stable",
    allowPrerelease:
      typeof value.allowPrerelease === "boolean" ? value.allowPrerelease : defaults.allowPrerelease,
    lastAutoCheckAt:
      typeof value.lastAutoCheckAt === "string" && value.lastAutoCheckAt
        ? value.lastAutoCheckAt
        : null,
    hasMirrorChyanCdk: false,
    mirrorChyanCdkLength: null,
  };
}

export class UpdateSettingsStore {
  value: UpdateSettings;
  readonly file: string;
  constructor(readonly configDir: string) {
    this.file = path.join(configDir, "update.json");
    this.value = normalizeUpdateSettings(readIfPresent(this.file));
  }
  save(next: UpdateSettings): void {
    atomicWrite(this.file, `${JSON.stringify(next, null, 2)}\n`);
    this.value = next;
  }
}

function readIfPresent(file: string): unknown {
  if (!fs.existsSync(file)) return undefined;
  try {
    return readJson<unknown>(file);
  } catch {
    return undefined;
  }
}

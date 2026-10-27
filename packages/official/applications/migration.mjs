import path from "node:path";
import { readSettingsFile, writeSettingsFile } from "./custom-entries.mjs";

/** Only migrate this plugin's configuration. Referenced targets are not opened. */
export async function migrate({ fromDataVersion, toDataVersion, dataDir, signal }) {
  if (fromDataVersion !== 0 || toDataVersion !== 1)
    throw new Error("Unsupported custom application data migration");
  signal.throwIfAborted();
  const filename = path.join(dataDir, "custom-entries.json");
  const saved = await readSettingsFile(filename);
  signal.throwIfAborted();
  if (saved?.version === 1) await writeSettingsFile(filename, saved.entries, signal);
  return { dataVersion: 1 };
}

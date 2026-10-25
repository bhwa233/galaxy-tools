import { randomUUID } from "node:crypto";
import type { PluginDataMigration } from "../../packages/sdk/src/index.js";
import { createTrustedBackend } from "./backend.js";
import { resolvePluginEntries } from "./manifest.js";
import type { PluginInstallation } from "./manager.js";
import type { PluginPackageMetadata } from "../../packages/sdk/src/index.js";
import { PluginResourceScope } from "./resources.js";

/** Reuse the utility worker's identity, timeout, startup failure cleanup and
 * durable stop/exit protocol. Migration runs independently of ordinary init. */
export async function runPluginDataMigration(options: {
  installation: PluginInstallation;
  metadata: PluginPackageMetadata;
  migration: PluginDataMigration;
  dataDir: string;
  cacheDir: string;
}): Promise<void> {
  const entry = resolvePluginEntries(options.installation.directory, options.metadata).migration;
  if (
    !entry ||
    !options.installation.grant.native ||
    !options.installation.grant.capabilities.includes("node.backend")
  )
    throw new Error("Data migration requires its declared trusted Node entry");
  const scope = new PluginResourceScope({
    pluginId: options.installation.pluginId,
    version: options.installation.version,
    instanceId: randomUUID(),
  });
  try {
    await createTrustedBackend({
      scope,
      pluginRoot: options.installation.directory,
      entryPath: entry.entry,
      dataDir: options.dataDir,
      cacheDir: options.cacheDir,
      approveTrust: () => options.installation.grant.native,
      migration: options.migration,
      timeoutMs: 120_000,
    });
    const stopped = await scope.stop("update");
    if (!stopped.ok) throw new Error(`Migration worker did not exit: ${stopped.errors.join("; ")}`);
  } catch (error) {
    // Failed initialization already terminates its incomplete worker. A failed
    // normal exit remains a failed update; never acknowledge it as migration.
    await scope.stop("crash");
    throw error;
  }
}

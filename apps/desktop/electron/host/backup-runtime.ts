import { app } from "electron";
import path from "node:path";
import type { AppConfig } from "../../src/features/settings/types.js";
import { HostConfigStore } from "../host-config.js";
import { LauncherController } from "../launcher.js";
import { AppError, inside } from "../persistence.js";
import type { PluginManagerSnapshot } from "../plugins/manager.js";
import type { RuntimeContext } from "../runtime.js";

/** backup-runtime owns this domain; shared state remains in the composition root. */
export function createBackupRuntime(
  ctx: Pick<
    RuntimeContext,
    | "notesRecoveryPending"
    | "ui"
    | "maintenance"
    | "hostShutdown"
    | "setMaintenance"
    | "pluginHost"
    | "mcpServer"
    | "mutations"
    | "windows"
    | "layouts"
    | "labelOf"
    | "prepare"
    | "preparedWindows"
    | "syncMcp"
    | "refreshTray"
    | "requireNotes"
    | "pendingNotesMigration"
    | "hostConfig"
    | "emit"
    | "cancelSelection"
    | "launcher"
    | "hostConfigDir"
    | "commandMatcher"
    | "shortcutWarning"
    | "deliverLauncherQueryUpdate"
    | "contextForCaller"
    | "contextRevisionForCaller"
    | "launcherAvailabilityRevision"
    | "notesActive"
    | "layoutsRestored"
    | "capsules"
    | "clearLauncherContext"
    | "registerShortcuts"
    | "publishPluginTheme"
  >,
) {
  async function pauseForBackup(): Promise<() => void> {
    if (ctx.notesRecoveryPending)
      throw new AppError(
        "pluginRecoveryRequired",
        ctx.ui(
          "请先恢复便签后台并保存保留的编辑窗口",
          "Recover notes and save the retained editors first",
        ),
      );
    if (ctx.maintenance || ctx.hostShutdown.isQuitting)
      throw new AppError("maintenance", "已有备份或恢复任务正在运行");
    ctx.setMaintenance(true);
    let resumePlugins: (() => void) | undefined;
    try {
      resumePlugins = await ctx.pluginHost?.pauseMutations();
      ctx.mcpServer?.stop();
      await ctx.mutations.catch(() => {});
      const saved = await Promise.all(
        [...ctx.windows.values()]
          .filter((win) => ctx.layouts.get(ctx.labelOf(win))?.view === "launcher")
          .map(ctx.prepare),
      );
      if (!saved.every(Boolean))
        throw new AppError("saveFailed", "工作区尚未保存，已取消备份或恢复");
      return () => {
        resumePlugins?.();
        ctx.setMaintenance(false);
        ctx.preparedWindows.clear();
        ctx.syncMcp();
        ctx.refreshTray();
      };
    } catch (error) {
      resumePlugins?.();
      ctx.setMaintenance(false);
      ctx.preparedWindows.clear();
      ctx.syncMcp();
      throw error;
    }
  }

  async function migrateNotesDirectory(directory: string): Promise<AppConfig> {
    ctx.requireNotes();
    if (!ctx.pluginHost) throw new AppError("pluginHostUnavailable", "插件宿主尚未就绪");
    if (ctx.maintenance || ctx.hostShutdown.isQuitting || ctx.pendingNotesMigration)
      throw new AppError("maintenance", "已有数据维护任务正在运行");
    ctx.setMaintenance(true);
    let previous = ctx.hostConfig.value;
    let previousPlugins: PluginManagerSnapshot | undefined;
    let resumeHost: (() => void) | undefined;
    const migration = { directory } as { directory: string; copiedRoot?: string };
    try {
      resumeHost = await ctx.pluginHost.pauseMutations();
      ctx.mcpServer.stop();
      await ctx.mutations.catch(() => {});
      previous = ctx.hostConfig.value;
      ctx.pendingNotesMigration = migration;
      await ctx.pluginHost.manager.withQuiesced(
        async (access) => {
          if (!migration.copiedRoot)
            throw new AppError("migrationFailed", "便签引擎未完成数据目录复制");
          previousPlugins = access.snapshot();
          // Restart/rollback preparation must not attempt to copy this root again.
          ctx.pendingNotesMigration = undefined;
          ctx.hostConfig.save({
            ...previous,
            dataDir: migration.copiedRoot,
            backgroundImagePath:
              previous.backgroundImagePath && inside(previous.dataDir, previous.backgroundImagePath)
                ? path.join(
                    migration.copiedRoot,
                    path.relative(previous.dataDir, previous.backgroundImagePath),
                  )
                : previous.backgroundImagePath,
          });
        },
        async (access) => {
          ctx.hostConfig.save(previous);
          // Failed startup persists lastError. Restore the pre-switch installation
          // state as well as its root, so resume actually restarts the old engine.
          if (previousPlugins) access.replaceSnapshot(previousPlugins);
        },
      );
      ctx.emit("config-changed", ctx.hostConfig.value);
      return ctx.hostConfig.value;
    } finally {
      ctx.pendingNotesMigration = undefined;
      resumeHost?.();
      ctx.setMaintenance(false);
      ctx.preparedWindows.clear();
      ctx.syncMcp();
      ctx.refreshTray();
    }
  }

  async function reloadHostAfterRestore(): Promise<void> {
    const dataDir = ctx.hostConfig.value.dataDir;
    const previousAutostart = ctx.hostConfig.value.autostart;
    ctx.cancelSelection();
    ctx.launcher.clear();
    ctx.pluginHost?.reloadAfterRestore();
    ctx.hostConfig = new HostConfigStore(ctx.hostConfigDir, dataDir);
    ctx.launcher = new LauncherController({
      commandMatcher: ctx.commandMatcher,
      getWarnings: () => (ctx.shortcutWarning ? [ctx.shortcutWarning] : []),
      stateFile: path.join(ctx.hostConfigDir, "launcher.json"),
      manager: () => ctx.pluginHost?.manager,
      onQueryUpdate: ctx.deliverLauncherQueryUpdate,
      onPreferencesChanged: () => ctx.emit("launcher-status-changed"),
      onLearningChanged: (learning) => ctx.emit("launcher-learning-changed", learning),
      getContext: ctx.contextForCaller,
      getContextRevision: ctx.contextRevisionForCaller,
      getAvailabilityRevision: () => ctx.launcherAvailabilityRevision,
      getLocale: () => ctx.hostConfig.value.locale,
    });
    ctx.notesActive = false;
    ctx.layoutsRestored = false;
    for (const [label, layout] of ctx.layouts)
      if (layout.view !== "launcher") ctx.layouts.delete(label);
    ctx.capsules.queues.clear();
    ctx.clearLauncherContext();
    try {
      ctx.registerShortcuts(ctx.hostConfig.value);
    } catch (error) {
      console.error("restored-shortcut-warning", error);
    }
    if (ctx.hostConfig.value.autostart !== previousAutostart)
      app.setLoginItemSettings({
        openAtLogin: ctx.hostConfig.value.autostart,
        path: process.execPath,
      });
    ctx.emit("config-changed", ctx.hostConfig.value);
    ctx.publishPluginTheme();
  }
  return { pauseForBackup, migrateNotesDirectory, reloadHostAfterRestore };
}

import { shouldHideLauncher } from "./host/launcher-presentation.js";
import { readApplicationSettings } from "./application-settings.js";
import { PluginSettingsService, type PluginSettingsAdapter } from "./plugins/settings.js";
import {
  readTranslationSettings,
  writeTranslationSettings,
} from "./plugins/translation-settings.js";
import { ClipboardHistory } from "./plugins/official/clipboard-history.js";
import { settingsSchema as clipboardSettingsSchema } from "./plugins/official/clipboard-history.js";
import {
  settingsSchema as searchSettingsSchema,
  validateSettings as validateSearchSettings,
} from "./plugins/official/search-settings.js";
import {
  noteSettingsFields,
  clipboardSettingsFields,
  searchSettingsFields,
  translationSettingsFields,
} from "../src/features/plugins/settingsFields.js";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  net,
  nativeTheme,
  nativeImage,
  Notification,
  protocol,
  screen,
  session,
  safeStorage,
  shell,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod";
import { sourceApplicationSchema } from "@spark233/sdk";
import { BackupSelections } from "./backup-selections.js";
import { DiagnosticsStore, diagnosticErrorCode, type DiagnosticFilter } from "./diagnostics.js";
import { AppError, atomicWrite, confined, canonical, inside } from "./persistence.js";
import { PluginBackupService, readPendingBackupDataRoots } from "./plugins/backup.js";
import type { PluginResourceScope } from "./plugins/resources.js";
import type { PluginManagerSnapshot } from "./plugins/manager.js";
import { externalUrl, FileGrants } from "./security.js";
import { ApplicationEntryAdmissions } from "./application-entries.js";
import { ContextPanelCoordinator, type ContextPanelMaterialized } from "./context-panel.js";
import type {
  ContextPanelNativeCapture,
  ContextPanelNativeConfig,
} from "./context-panel-native.js";
import type { AppConfig } from "../src/features/settings/types.js";
import type { NoteMetadata, SaveNoteRequest } from "../src/features/notes/types.js";
import type { PluginManagementState } from "../src/features/plugins/types.js";

import { initializeWindowsRuntime, watchFullscreen } from "./windows.js";
import { ShortcutManager } from "./host/shortcuts.js";
import { ShutdownCoordinator } from "./host/shutdown.js";
import { createHostWindow } from "./host/windows.js";
import { TrayController } from "./host/tray.js";
import { Capsules } from "./capsules.js";
import { parseCliArgs, type CliCommand } from "./cli-args.js";
import type { ReminderNotification } from "./reminders.js";
import { REMINDER_PRESETS } from "../src/features/reminders/presets.js";
import type { ReminderItem } from "../src/features/reminders/types.js";
import { runMcpLauncher } from "./mcp-launcher.js";
import { McpServer } from "./mcp-server.js";
import type { McpOps } from "./mcp-protocol.js";
import { deriveNoteWindowState } from "./note-window-state.js";
import { HostConfigStore, configPatchSchema } from "./host-config.js";
import { HostPrivateDataRootsStore } from "./private-data-roots.js";
import { LauncherController } from "./launcher.js";
import { createCommandPinyinMatcher } from "./launcher-command-matcher.js";
import { createNotesRuntime } from "./plugins/official/notes.js";
import { NotesDataClient } from "./plugins/official/notes-data-client.js";
import {
  performIndexedApplicationAction,
  decorateApplicationResults,
  clearApplicationIconCache,
} from "./plugins/official/applications.js";
import { createSearchRuntime } from "./plugins/official/search.js";
import { createClipboardRuntime, type ClipboardRuntime } from "./plugins/official/clipboard.js";
import type { ClipboardRequest } from "../src/features/clipboard/types.js";
import { DesktopPluginHost, type DesktopPluginHostOptions } from "./plugins/desktop-host.js";
import { resolvePluginEntries } from "./plugins/manifest.js";
import {
  createCaptureRuntime,
  createOcrRuntime,
  type CaptureImage,
} from "./plugins/official/capture.js";
import { registerPluginProtocolScheme } from "./plugins/web-host.js";
import type { PluginTheme, PluginContext, PluginOwner } from "@spark233/sdk";
import {
  NOTE_WINDOW_STATES_CHANGED,
  type NoteWindowSnapshot,
} from "../src/features/windows/noteWindowState.js";
import type { CapsuleEntry, CapsuleQueue } from "../src/features/capsules/types.js";

const startupWorkingDirectory = process.cwd();
initializeWindowsRuntime();
let gpuCrashCount = 0;
app.on("child-process-gone", (_event, details) => {
  if (
    details.type === "GPU" &&
    ["crashed", "abnormal-exit", "oom", "launch-failed", "integrity-failure"].includes(
      details.reason,
    )
  ) {
    gpuCrashCount += 1;
    console.error("gpu-process-gone", details.reason, details.exitCode);
    diagnostics?.record({
      kind: "host",
      code: "crashed",
      level: "error",
      errorCode: "unknownFailure",
    });
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, "../../dist");
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (devUrl && new URL(devUrl).origin !== "http://127.0.0.1:1420")
  throw new Error("Unexpected renderer dev server");
registerPluginProtocolScheme([
  {
    scheme: "spark233",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
app.setName("spark233");
const configDir = path.resolve(
  process.env.SPARK233_CONFIG_DIR || path.join(app.getPath("appData"), "spark233"),
);
const hostConfigDir = path.join(configDir, "host");
const commandMatcher = createCommandPinyinMatcher({
  assetDirectory: app.isPackaged
    ? path.join(process.resourcesPath, "command-matcher")
    : path.resolve(here, "../../../../dist-host/command-matcher"),
  cacheDirectory: path.join(configDir, "cache", "command-matcher"),
});
const backupRecoveryDir = path.join(
  path.dirname(configDir),
  `${path.basename(configDir)}-recovery`,
);
app.setPath("userData", path.join(configDir, "electron-profile"));
app.setAppUserModelId("com.spark233.desktop");
const smokeOutput = process.argv.find((arg) => arg.startsWith("--smoke-output="))?.slice(15);
if (
  smokeOutput &&
  (!process.env.SPARK233_CONFIG_DIR ||
    !process.env.SPARK233_DATA_DIR ||
    process.env.SPARK233_SMOKE !== "1")
)
  throw new Error("Smoke probes require explicit opt-in and isolated profile paths");
const cliArgs = parseCliArgs(process.argv);
let pendingCliCommand: CliCommand | undefined;
if (cliArgs.mcp) {
  // --mcp：stdio MCP 服务进程，不参与单实例锁与正常启动。
  void runMcpLauncher({ exe: process.execPath, here, configDir })
    .then((code) => app.exit(code))
    .catch((error) => {
      process.stderr.write(`spark233 MCP 启动失败: ${String(error)}\n`);
      app.exit(1);
    });
} else if (!app.requestSingleInstanceLock()) app.exit(0);
const grants = new FileGrants();
const applicationEntries = new ApplicationEntryAdmissions();
const windows = new Map<string, BrowserWindow>();
interface Layout extends CapsuleEntry {
  hostPage?: "settings";
  settingsTarget?: { page: string; pluginId?: string; tab?: string };
  everOpened?: boolean;
  label: string;
  view: "main" | "launcher" | "notepad" | "tile";
  noteId?: string;
  bounds: Electron.Rectangle;
  visible: boolean;
  topmost: boolean;
  workspace?: "clipboard" | "translation" | "ocr";
  compact?: boolean;
  pluginId?: string;
}
const layouts = new Map<string, Layout>();
const pending = new Map<string, { windowId: number; resolve: (result: boolean) => void }>();
const ready = new Set<number>();
let pendingManagerOpen:
  | { windowId: number; payload: string | { noteId: string; taskText?: string } }
  | undefined;
const crashedWindows = new Set<number>();
let hostConfig: HostConfigStore;
let privateDataRoots: HostPrivateDataRootsStore;
let diagnostics: DiagnosticsStore | undefined;
const diagnosticSubscriptions = new Map<string, () => void>();
const notesClient = new NotesDataClient(() => pluginHost?.manager);
// Only the factory may use its own startup transport before manager registration.
let notesStartupClient: NotesDataClient | undefined;
let notesMaintenanceClient: NotesDataClient | undefined;
// A utility crash must not destroy the host's surviving editors or overwrite
// their in-memory placement with the last layout acknowledged by the dead worker.
let notesRecoveryPending = false;
let pendingNotesMigration: { directory: string; copiedRoot?: string } | undefined;
let backupService: PluginBackupService | undefined;
const backupSelections = new BackupSelections();
let maintenance = false;
let launcherAvailabilityRevision = 0;
function setMaintenance(value: boolean): void {
  if (maintenance === value) return;
  maintenance = value;
  launcherAvailabilityRevision++;
  if (value) {
    launcher?.clear();
    void contextPanel?.close().catch(() => {});
  }
  // Entering maintenance keeps visible choices available for a clear rejected
  // action. Recovery must refresh even if the UI never read the entering state.
  if (!value) emit("launcher-status-changed");
}
let notesScope: PluginResourceScope | undefined;
const preparedWindows = new Set<number>();
const workspaceRequests = new Map<string, { kind: string; result?: unknown }>();
const officialRenderers = new Map<string, { directory: string; scope: PluginResourceScope }>();
const officialWindows = new Map<number, PluginOwner>();
function bindOfficialRenderer(
  pluginId: string,
  directory: string,
  scope: PluginResourceScope,
): void {
  const renderer = confined(directory, "renderer");
  if (!fs.statSync(confined(renderer, "index.html")).isFile())
    throw new Error(`Plugin renderer is missing: ${pluginId}`);
  officialRenderers.set(pluginId, { directory: renderer, scope });
  scope.own("window", {
    prepareStop: async () => {
      const saved = await Promise.all(
        [...windows.values()]
          .filter((win) => officialWindows.get(win.id)?.instanceId === scope.owner.instanceId)
          .map(prepare),
      );
      return saved.every(Boolean)
        ? { ok: true }
        : {
            ok: false,
            reason: ui("插件工作区尚未保存", "The plugin workspace has not finished saving"),
          };
    },
    dispose: () => {
      for (const win of windows.values())
        if (officialWindows.get(win.id)?.instanceId === scope.owner.instanceId) win.destroy();
      if (officialRenderers.get(pluginId)?.scope.owner.instanceId === scope.owner.instanceId)
        officialRenderers.delete(pluginId);
    },
  });
}
let launcher: LauncherController;
const launcherExecutions = new AsyncLocalStorage<{
  callerId: string;
  active: boolean;
  panelExecution?: string;
  query?: { sessionId: string; requestId: string };
}>();
const windowPresentations = new WeakMap<BrowserWindow, () => boolean>();
function launcherPresentationGuard(): () => boolean {
  const execution = launcherExecutions.getStore();
  if (!execution?.panelExecution) return () => true;
  const { callerId, panelExecution } = execution;
  return () => contextPanel?.canPresent(callerId, panelExecution) === true;
}
function endLauncherExecutionQuery(): void {
  const execution = launcherExecutions.getStore();
  if (execution?.active && execution.query)
    launcher.clear(
      execution.callerId,
      execution.query.sessionId,
      execution.query.requestId,
      "execution",
    );
}
const launcherCallers = new Map<number, string>();
const launcherHides = new Map<number, { caller: string; sessionId: string; requestId: string }>();
function launcherCaller(win: BrowserWindow): string {
  const id = win.webContents.id;
  let caller = launcherCallers.get(id);
  if (!caller) {
    caller = `${id}:${randomUUID()}`;
    launcherCallers.set(id, caller);
  }
  if (windows.get("context-panel") === win) contextPanelCallers.add(caller);
  return caller;
}
// Capture the execution before Electron dispatches a possibly asynchronous hide
// event; AsyncLocalStorage alone need not survive a native event boundary.
function hideHostWindow(win: BrowserWindow): void {
  const id = win.webContents.id;
  const caller = launcherCallers.get(id);
  const execution = launcherExecutions.getStore();
  if (
    win.isVisible() &&
    caller &&
    execution?.active &&
    execution.callerId === caller &&
    execution.query
  )
    launcherHides.set(id, { caller, ...execution.query });
  else launcherHides.delete(id);
  win.hide();
}
function revokeLauncherCaller(id: number): void {
  const caller = launcherCallers.get(id);
  if (caller) backupSelections.revokeCaller(caller);
  if (caller) launcher?.clear(caller);
  if (caller) applicationEntries.revoke(caller);
  if (caller) pluginHost?.releaseCaller(caller);
  if (caller && contextPanelCallers.delete(caller))
    void contextPanel?.close(caller, { retired: true }).catch(() => {});
  if (caller) {
    diagnosticSubscriptions.get(caller)?.();
    diagnosticSubscriptions.delete(caller);
  }
  launcherCallers.delete(id);
  launcherHides.delete(id);
}
function deliverLauncherQueryUpdate(
  caller: string,
  result: import("../src/features/launcher/types.js").LauncherQueryResult,
): void {
  for (const win of windows.values())
    if (
      !win.isDestroyed() &&
      !win.webContents.isDestroyed() &&
      launcherCallers.get(win.webContents.id) === caller
    )
      emit("launcher-query-updated", result, win);
}
let notesActive = false;
let notesRendererRoot: string | undefined;
let layoutsRestored = false;
let clipboardRuntime: ClipboardRuntime | undefined;
let launcherContext: { context: PluginContext; label: string } | undefined;
let launcherContextRevision = 0;
const pluginImages = new Map<string, CaptureImage>();
const pluginFiles = new Map<string, string>();
const resourceRevocations = new Set<(ids: readonly string[]) => void>();
function notifyResourceRevocations(ids: readonly string[]): void {
  if (!ids.length) return;
  for (const listener of resourceRevocations)
    try {
      listener(ids);
    } catch {
      console.warn("context-resource-revocation-failed");
    }
}
function clearLauncherContext(): void {
  const previous = launcherContext;
  const revoked =
    previous?.context.kind === "image"
      ? [previous.context.resource.id]
      : previous?.context.kind === "files"
        ? previous.context.resources.map((resource) => resource.id)
        : [];
  const image =
    previous?.context.kind === "image" ? pluginImages.get(previous.context.resource.id) : undefined;
  launcherContextRevision++;
  launcherContext = undefined;
  if (image?.owner.pluginId === "spark233.host") pluginImages.delete(image.resource.id);
  if (previous?.context.kind === "files")
    for (const resource of previous.context.resources) pluginFiles.delete(resource.id);
  notifyResourceRevocations(revoked);
  if (image?.owner.pluginId === "spark233.host")
    try {
      fs.rmSync(confined(configDir, "launcher-resources", `${image.sessionId}.png`), {
        force: true,
      });
    } catch {
      diagnostics?.record({
        kind: "host",
        code: "failed",
        level: "warn",
        errorCode: "diskUnavailable",
      });
    }
  if (launcher) {
    launcher.pluginsChanged();
    emit("launcher-status-changed");
  }
}
let contextPanel: ContextPanelCoordinator | undefined;
const contextPanelCallers = new Set<string>();
const contextPanelDialogs = new Set<number>();
const launcherComposition = new Map<number, number>();
const nativeDialogDepth = new Map<number, number>();
const contextPanelNativeRoot = path.join(configDir, "cache", "context-panel-native");
const contextPanelImageRoot = path.join(configDir, "context-panel-resources");
function panelConfiguration(config: AppConfig): ContextPanelNativeConfig {
  return {
    enabled: config.superPanelEnabled,
    button: config.superPanelButton,
    holdMs: config.superPanelTrigger === "click" ? 0 : config.superPanelHoldMs,
    excludedApps: [...config.superPanelExcludedApps],
    copyFallback: config.superPanelCopyFallback,
  };
}
function contextForCaller(caller?: string): { context: PluginContext; label: string } | undefined {
  // Retired document identities have no context, including the normal launcher's.
  // Window role is established by the host; a replacement panel document cannot
  // inherit the global context merely because its previous caller was revoked.
  if (caller && ![...launcherCallers.values()].includes(caller)) return;
  if (caller && contextPanelCallers.has(caller)) {
    const context = contextPanel?.context(caller);
    return context
      ? {
          context,
          label: contextPanel?.contextLabel(caller) ?? ui("当前选区", "Current selection"),
        }
      : undefined;
  }
  return launcherContext;
}
function contextRevisionForCaller(caller?: string): number {
  if (caller && ![...launcherCallers.values()].includes(caller)) return 0;
  return caller && contextPanelCallers.has(caller)
    ? (contextPanel?.contextRevision(caller) ?? 0)
    : launcherContextRevision;
}
function contextForCommand(
  caller: string,
  pluginId: string,
  commandId: string,
  context: PluginContext,
): PluginContext | undefined {
  if (
    !contextPanelCallers.has(caller) ||
    context.kind !== "files" ||
    pluginId !== "spark233.notes" ||
    commandId !== "new"
  )
    return context;
  const files = context.resources.map((resource) => pluginFiles.get(resource.id));
  if (files.some((file) => !file)) return;
  // Send selected references as literal text, without reading file bodies or
  // adding an attachment/Office parser. Absolute paths cannot start a fence line.
  const text = `${ui("所选文件路径", "Selected file paths")}\n\n\`\`\`text\n${files.join("\n")}\n\`\`\``;
  return text.length <= 65536
    ? {
        kind: "text",
        text,
        ...(context.sourceApplication ? { sourceApplication: context.sourceApplication } : {}),
      }
    : undefined;
}
async function materializePanelContext(
  capture: ContextPanelNativeCapture,
  signal: AbortSignal,
  sourceApplication?: string,
): Promise<ContextPanelMaterialized> {
  signal.throwIfAborted();
  const application = sourceApplicationSchema.safeParse(sourceApplication);
  const sourceContext = application.success ? { sourceApplication: application.data } : {};
  const windowContext: ContextPanelMaterialized = {
    ...(application.success
      ? {
          context: { kind: "window", sourceApplication: application.data },
          label: ui("当前程序", "Source application"),
        }
      : {}),
    dispose() {},
  };
  if (capture.kind === "none")
    // The helper rechecks its source identity before returning these content-
    // only failures. They do not authorize reading selection/clipboard data.
    return [
      "emptySelection",
      "unsupported",
      "protectedSource",
      "tooLarge",
      "inputBusy",
      "inputRejected",
      "clipboardUnavailable",
      "clipboardBusy",
      "clipboardUnchanged",
      "clipboardOwnerChanged",
    ].includes(capture.reason)
      ? windowContext
      : { dispose() {} };
  if (capture.kind === "text") {
    if (!capture.text.trim()) return windowContext;
    if (capture.text.length > 65536) throw new AppError("invalidPayload", "选区文字过长");
    return {
      context: { kind: "text", text: capture.text, ...sourceContext },
      label: ui("选中文字", "Selected text"),
      dispose() {},
    };
  }
  const ids: string[] = [];
  let imageFile: string | undefined;
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    // Revoke authority before disk cleanup: EPERM must not preserve a readable handle.
    for (const id of ids) {
      pluginImages.delete(id);
      pluginFiles.delete(id);
    }
    notifyResourceRevocations(ids);
    if (imageFile)
      try {
        fs.rmSync(imageFile, { force: true });
      } catch {
        diagnostics?.record({
          kind: "host",
          code: "failed",
          level: "warn",
          errorCode: "diskUnavailable",
        });
      }
  };
  try {
    if (capture.kind === "files") {
      if (!capture.paths.length || capture.paths.length > 100)
        throw new AppError("invalidPayload", "选区文件数不合法");
      const resources = capture.paths.map((filename) => {
        if (!path.isAbsolute(filename) || /\p{Cc}/u.test(filename))
          throw new AppError("invalidPayload", "选区文件引用不合法");
        const real = canonical(filename),
          stat = fs.statSync(real);
        if (!stat.isFile()) throw new AppError("invalidPayload", "选区仅支持文件授权点");
        const id = randomUUID();
        ids.push(id);
        pluginFiles.set(id, real);
        return { id, kind: "file" as const, size: stat.size };
      });
      signal.throwIfAborted();
      return {
        context: { kind: "files", resources, ...sourceContext },
        label: ui(
          `${resources.length} 个文件（发送便签时保存路径）`,
          `${resources.length} files (send paths to notes)`,
        ),
        dispose,
      };
    }
    const source = canonical(capture.file);
    if (
      !inside(canonical(contextPanelNativeRoot), source) ||
      fs.lstatSync(capture.file).isSymbolicLink()
    )
      throw new AppError("permissionDenied", "选区图片不属于捕获缓存");
    const stat = fs.statSync(source);
    if (!stat.isFile() || stat.size !== capture.bytes || stat.size > 32 * 1024 * 1024)
      throw new AppError("invalidPayload", "选区图片大小不合法");
    const image = nativeImage.createFromPath(source),
      size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 100_000_000)
      throw new AppError("invalidPayload", "选区图片尺寸不合法");
    const png = image.toPNG();
    if (png.length > 32 * 1024 * 1024) throw new AppError("invalidPayload", "选区图片超过大小上限");
    signal.throwIfAborted();
    const id = randomUUID();
    ids.push(id);
    imageFile = path.join(contextPanelImageRoot, `${id}.png`);
    atomicWrite(imageFile, png);
    const resource = { id, kind: "image" as const, mimeType: "image/png", size: png.length };
    pluginImages.set(id, {
      owner: { pluginId: "spark233.host", version: app.getVersion(), instanceId: id },
      sessionId: id,
      path: imageFile,
      resource,
      width: size.width,
      height: size.height,
    });
    return {
      context: { kind: "image", resource, ...sourceContext },
      label: ui("选中图片", "Selected image"),
      dispose,
    };
  } catch (error) {
    dispose();
    throw error;
  }
}
function panelWindow(caller: string): BrowserWindow | undefined {
  const win = windows.get("context-panel");
  return win && !win.isDestroyed() && launcherCallers.get(win.webContents.id) === caller
    ? win
    : undefined;
}
function initializeContextPanel(): void {
  contextPanel = new ContextPanelCoordinator({
    isBlocked: () => maintenance || hostShutdown.isQuitting || exiting,
    nativeOptions: {
      assetDirectory: path.join(here, "assets"),
      cacheDirectory: contextPanelNativeRoot,
    },
    materialize: materializePanelContext,
    openView: (physicalPoint) => {
      if (maintenance || hostShutdown.isQuitting || exiting)
        throw new AppError("maintenance", "当前不能打开面板");
      const point =
        process.platform === "win32" ? screen.screenToDipPoint(physicalPoint) : physicalPoint;
      const layout: Layout = {
        label: "context-panel",
        view: "launcher",
        compact: true,
        bounds: safeBounds({ x: point.x + 8, y: point.y + 8, width: 520, height: 440 }),
        visible: true,
        topmost: false,
      };
      const win = launcherExecutions.exit(() => createWindow(layout)),
        caller = launcherCaller(win);
      contextPanelCallers.add(caller);
      return caller;
    },
    publish: (caller, state) => {
      const win = panelWindow(caller);
      if (win) emit("super-panel-state", state, win);
    },
    closeView: (caller) => {
      const win = panelWindow(caller);
      if (win) win.destroy();
    },
    focusView: (caller) => {
      const win = panelWindow(caller);
      if (win) {
        win.show();
        win.focus();
      }
    },
    clearQuery: (caller) => launcher?.clear(caller),
    onStatus: (status) => {
      emit("super-panel-status", status);
      diagnostics?.record({
        kind: "host",
        code:
          status.phase === "ready"
            ? "started"
            : status.phase === "unavailable"
              ? "failed"
              : "stopped",
        level: status.phase === "unavailable" ? "warn" : "info",
        ...(status.phase === "unavailable" ? { errorCode: "unavailable" } : {}),
      });
    },
  });
  void contextPanel
    .configure(panelConfiguration(hostConfig.value))
    .catch(() => console.warn("context-panel-configuration-failed"));
}
let pluginHost: DesktopPluginHost | undefined;
let pluginHostStartupError: string | undefined;
const pluginThemeListeners = new Set<() => void>();
// Native menus use the same two locale choices as renderer workspaces.
const ui = (chinese: string, english: string): string =>
  hostConfig?.value.locale.startsWith("en") ? english : chinese;
const getPluginTheme = (): PluginTheme => ({
  version: "1.0.0",
  preference: hostConfig.value.theme,
  effective:
    hostConfig.value.theme === "system"
      ? nativeTheme.shouldUseDarkColors
        ? "dark"
        : "light"
      : hostConfig.value.theme,
});
function publishPluginTheme(): void {
  for (const listener of pluginThemeListeners) listener();
}
nativeTheme.on("updated", publishPluginTheme);
const createOfficialRuntime: NonNullable<
  DesktopPluginHostOptions["createOfficialRuntime"]
> = async (installation, metadata, scope, backend, startupCheckOnly = false) => {
  const id = metadata.spark233.id;
  // The installed npm identity and its explicit native grant are both checked;
  // a Web page cannot select an adapter or supply an executable path.
  const expectedPackages: Record<string, string> = {
    "spark233.notes": "@spark233/plugin-notes",
    "spark233.applications": "@spark233/plugin-applications",
    "spark233.screenshot": "@spark233/plugin-screenshot",
    "spark233.ocr": "@spark233/plugin-ocr",
    "spark233.translation": "@spark233/plugin-translation",
    "spark233.search": "@spark233/plugin-search",
    "spark233.clipboard": "@spark233/plugin-clipboard",
  };
  if (!Object.hasOwn(expectedPackages, id) || metadata.name !== expectedPackages[id]) return;
  if (!installation.grant.native)
    throw new AppError("pluginTrustRequired", "官方原生适配需要已确认的执行权限");
  if (startupCheckOnly) {
    // Disabled updates validate the package/backend without attaching business
    // adapters: constructing the clipboard adapter would begin recording and
    // constructing notes would restore windows. The factory has already resolved
    // manifest paths and initialized any backend without sending activation.
    for (const descriptor of Object.values(metadata.spark233.native)) {
      const file = fs.openSync(confined(installation.directory, descriptor.path), "r");
      try {
        const signature = Buffer.alloc(2);
        if (fs.readSync(file, signature, 0, 2, 0) !== 2 || signature.toString("ascii") !== "MZ")
          throw new Error("Official native entry is not a Windows executable");
      } finally {
        fs.closeSync(file);
      }
    }
    return {
      activate: async () => {
        throw new AppError("pluginDisabled", "停用插件的启动校验不接受业务命令");
      },
    };
  }
  if (id === "spark233.notes") {
    if (!backend) throw new Error("Notes backend entry is required");
    let started = false;
    const renderer = confined(installation.directory, "renderer");
    if (!fs.statSync(confined(renderer, "index.html")).isFile())
      throw new Error("Notes renderer is missing from its package");
    const lifecycleData = NotesDataClient.fromTransport((activation) => {
      if (!scope.accepts(scope.owner))
        throw new AppError("pluginDisabled", "便签插件运行实例已失效");
      return backend.activate(activation);
    });
    const maintenanceData = NotesDataClient.fromTransport((activation) => {
      if (scope.state !== "preparing")
        throw new AppError("pluginStopping", "便签维护通道仅用于当前实例的最终保存");
      return backend.maintenance(activation);
    });
    return createNotesRuntime({
      scope,
      backend,
      openManager: () => {
        if (launcherPresentationGuard()()) showMain();
      },
      newNote: async (activation) => {
        if (activation.context?.kind === "text") {
          const note = await enqueueMutation(() =>
            notesClient.save({
              title: "",
              content: activation.context!.kind === "text" ? activation.context!.text : "",
              category: "",
            }),
          );
          changed();
          if (launcherPresentationGuard()()) await openNote(note.id);
        } else if (activation.context?.kind === "image") {
          const image = pluginImages.get(activation.context.resource.id);
          if (!image) throw new Error("图片资源已失效");
          // Snapshot the accepted input before it waits behind a host write or
          // maintenance. Closing the panel may revoke/delete its temporary file.
          const acceptedImage = fs.readFileSync(image.path).toString("base64");
          const note = await enqueueMutation(() =>
            notesClient.createFromImage(acceptedImage, "png"),
          );
          changed();
          if (launcherPresentationGuard()()) await openNote(note.id);
        } else if (launcherPresentationGuard()()) await openNote();
      },
      openNote: (id) => openNoteWithAnchor(id),
      showOnDesktop: async (id) => {
        await openNote(id);
      },
      search: async (query, signal) => ({
        items: (
          await (
            signal
              ? NotesDataClient.fromTransport((activation) => backend.activate(activation, signal))
              : notesClient
          ).search(query, 60)
        ).map((meta) => ({
          id: meta.id,
          title: meta.title || ui("无标题便签", "Untitled note"),
          description: meta.preview,
          commandId: "open-note",
          parameters: { id: meta.id },
          kind: "note",
          actions: [
            {
              title: ui("在便签管理器打开", "Open in note manager"),
              commandId: "open-note",
              parameters: { id: meta.id },
            },
            {
              title: ui("贴到桌面", "Show on desktop"),
              commandId: "desktop-note",
              parameters: { id: meta.id },
            },
          ],
        })),
      }),
      prepare: async (reason) => {
        if (reason === "crash" && !backend.running) {
          if (notesScope === scope) {
            notesRecoveryPending = true;
            for (const [label, win] of windows)
              if (layouts.get(label)?.view !== "launcher" && !win.isDestroyed()) remember(win);
          }
          // The failed utility cannot acknowledge another write. Release its
          // owner while retaining live renderer buffers for an explicit retry.
          return { ok: true };
        }
        // Failed construction owns no active note UI; do not ask retained
        // editors to save through a manager that has not registered this owner.
        if (!started) return { ok: true };
        for (const [label, win] of windows)
          if (layouts.get(label)?.view !== "launcher") preparedWindows.delete(win.id);
        await mutations.catch(() => {});
        const notes = [...windows.values()].filter(
          (win) => layouts.get(labelOf(win))?.view !== "launcher",
        );
        const saved = await Promise.all(notes.map(prepare));
        if (!saved.every(Boolean)) return { ok: false, reason: "便签尚未保存，已保留窗口和插件" };
        for (const win of notes) remember(win);
        await persistLayout(maintenanceData);
        if (pendingNotesMigration)
          pendingNotesMigration.copiedRoot = await maintenanceData.migrate(
            pendingNotesMigration.directory,
          );
        return { ok: true };
      },
      stop: () => {
        if (notesScope !== scope) return;
        notesActive = false;
        notesRendererRoot = undefined;
        if (notesScope === scope) {
          notesScope = undefined;
          notesStartupClient = undefined;
          notesMaintenanceClient = undefined;
        }
        capsules.setEnabled(false);
        mcpServer?.stop();
        if (!notesRecoveryPending)
          for (const [label, win] of windows)
            if (layouts.get(label)?.view !== "launcher") win.destroy();
        refreshTray();
        publishNoteStates();
      },
      start: async () => {
        layoutsRestored = false;
        await lifecycleData.initialize(hostConfig.value.locale);
        if (!notesRecoveryPending) await restoreNotesLayout(lifecycleData);
        layoutsRestored = true;
        notesScope = scope;
        notesStartupClient = lifecycleData;
        notesMaintenanceClient = maintenanceData;
        notesActive = true;
        notesRendererRoot = renderer;
        try {
          capsules.setEnabled(true);
          await capsules.refresh();
        } finally {
          notesStartupClient = undefined;
        }
        // A dead renderer has no buffer to preserve; keep its layout but let
        // normal window creation recreate it when recovering a utility owner.
        for (const [label, win] of windows)
          if (layouts.get(label)?.view !== "launcher" && crashedWindows.has(win.id)) win.destroy();
        for (const layout of layouts.values())
          if (
            layout.view !== "launcher" &&
            layout.visible &&
            !layout.folded &&
            // Initial startup restores desktop notes; reopening the manager is
            // reserved for an explicit later enable or restore.
            (layout.noteId || (tray && layout.view === "main"))
          )
            createWindow(layout);
        for (const [label, win] of windows)
          if (layouts.get(label)?.view !== "launcher") preparedWindows.delete(win.id);
        await lifecycleData.startReminders();
        if (notesRecoveryPending) await persistLayout(lifecycleData);
        notesRecoveryPending = false;
        started = true;
        syncMcp();
        refreshTray();
      },
    });
  }
  if (id === "spark233.applications") {
    if (!backend) throw new Error("Applications backend entry is required");
    scope.own("event", { dispose: clearApplicationIconCache });
    return {
      query: async (activation, signal) => {
        const parameters =
          activation.parameters &&
          typeof activation.parameters === "object" &&
          !Array.isArray(activation.parameters)
            ? activation.parameters
            : {};
        const value = await backend.activate(
          { ...activation, parameters: { ...parameters, locale: hostConfig.value.locale } },
          signal,
        );
        signal?.throwIfAborted();
        const result = await decorateApplicationResults(value);
        signal?.throwIfAborted();
        return result;
      },
      activate: async (activation) => {
        const parameters =
          activation.parameters &&
          typeof activation.parameters === "object" &&
          !Array.isArray(activation.parameters)
            ? activation.parameters
            : {};
        const value = await backend.activate({
          ...activation,
          parameters: { ...parameters, locale: hostConfig.value.locale },
        });
        if (["launch", "reveal", "copy-path"].includes(activation.commandId ?? "")) {
          await performIndexedApplicationAction(value);
          return;
        }
        return decorateApplicationResults(value);
      },
    };
  }
  if (id === "spark233.translation") {
    if (!backend) throw new Error("Translation backend entry is required");
    bindOfficialRenderer(id, installation.directory, scope);
    return {
      query: (activation, signal) =>
        backend.activate(
          {
            ...activation,
            parameters: {
              ...(activation.parameters as Record<string, never>),
              hostConfiguration: translationSettings() as never,
            },
          },
          signal,
        ),
      activate: async (activation) => {
        // Entering the workspace does not send a request. Its explicit Translate
        // button uses translation_action with the chosen source/target language.
        if (activation.commandId === "translate" && !activation.parameters) {
          await showOfficialWorkspace("translation", {
            kind: "translate-input",
            text: activation.context?.kind === "text" ? activation.context.text : "",
          });
          return;
        }
        const result = await backend.activate({
          ...activation,
          parameters: {
            ...(activation.parameters as Record<string, never>),
            hostConfiguration: translationSettings() as never,
          },
        });
        const parameters =
          activation.parameters &&
          typeof activation.parameters === "object" &&
          !Array.isArray(activation.parameters)
            ? activation.parameters
            : {};
        if (activation.commandId === "detail" && parameters.hostWorkspace !== false)
          await showOfficialWorkspace("translation", result);
        return result;
      },
    };
  }
  const entries = resolvePluginEntries(installation.directory, metadata);
  const common = {
    scope,
    pluginRoot: installation.directory,
    dataDir: pluginHost!.manager.dataDirectory(id),
    cacheDir: path.join(configDir, "plugins", "cache", "runtime", id),
    approveTrust: () => installation.grant.native,
    onOutputBytes: (stream: "stdout" | "stderr", byteCount: number) => {
      if (scope.accepts(scope.owner)) diagnostics?.output(scope.owner, stream, byteCount, "native");
    },
  };
  if (id === "spark233.search") {
    if (!entries.native.search) throw new Error("Search executable entry is required");
    return createSearchRuntime({
      ...common,
      descriptor: entries.native.search,
      getLocale: () => hostConfig.value.locale,
      privateRoots: () => privateDataRoots.list(),
      subscribePrivateRoots: (listener) => privateDataRoots.subscribe(listener),
      openPath: (filename) => shell.openPath(filename),
      revealPath: (filename) => {
        shell.showItemInFolder(filename);
      },
      copyPath: (filename) => {
        clipboard.writeText(filename);
      },
      confirmServiceAction: async (action) => {
        const english = hostConfig.value.locale.startsWith("en");
        const title =
          action === "configure"
            ? ui("修改文件索引范围", "Change file index scope")
            : action === "rebuild"
              ? ui("重建文件索引", "Rebuild file index")
              : ui("安装或更新文件搜索服务", "Install or update file search");
        const answer = await dialog.showMessageBox({
          type: "question",
          title,
          message:
            action !== "install"
              ? title
              : english
                ? "Install or update the spark233 filename index service?"
                : "安装或更新 spark233 文件名索引服务？",
          detail: english
            ? "Windows administrator approval is required. File contents are searched only when you query them."
            : "此操作会请求 Windows 管理员授权。正文只在你查询时按需搜索。",
          buttons: english ? ["Cancel", "Continue"] : ["取消", "继续"],
          defaultId: 0,
          cancelId: 0,
        });
        return answer.response === 1;
      },
    });
  }
  if (id === "spark233.clipboard") {
    if (!entries.native.clipboard) throw new Error("Clipboard executable entry is required");
    if (!backend) throw new Error("Clipboard backend entry is required");
    bindOfficialRenderer(id, installation.directory, scope);
    const runtime = await createClipboardRuntime({
      ...common,
      descriptor: entries.native.clipboard,
      backend,
      onChange: () => emit("clipboard-changed"),
      onError: (error) => console.error("clipboard-runtime", error.message),
      renderThumbnail: (bytes) => {
        const image = nativeImage.createFromBuffer(Buffer.from(bytes)),
          size = image.getSize();
        if (image.isEmpty() || size.width * size.height > 100_000_000)
          throw new Error("图片尺寸不受支持");
        const ratio = Math.min(1, 320 / Math.max(size.width, size.height));
        return image
          .resize({
            width: Math.max(1, Math.round(size.width * ratio)),
            height: Math.max(1, Math.round(size.height * ratio)),
            quality: "good",
          })
          .toPNG();
      },
      beforePaste: () => {
        for (const [label, win] of windows)
          if (
            layouts.get(label)?.view === "launcher" &&
            layouts.get(label)?.hostPage !== "settings"
          )
            hideHostWindow(win);
      },
      openWorkspace: async (presentation) => {
        await showClipboardWorkspace(presentation);
      },
      prepareWorkspace: async () => {
        const saved = await Promise.all(
          [...windows.values()]
            .filter((win) => layouts.get(labelOf(win))?.pluginId === id)
            .map(prepare),
        );
        return saved.every(Boolean)
          ? { ok: true }
          : { ok: false, reason: "剪贴板工作区草稿尚未保存" };
      },
      pickImages: async () => {
        const chosen = await dialog.showOpenDialog({
          title: hostConfig.value.locale.startsWith("en")
            ? "Import gallery images"
            : "导入图库图片",
          properties: ["openFile", "multiSelections"],
          filters: [{ name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] }],
        });
        if (chosen.canceled) return [];
        return chosen.filePaths.slice(0, 100).map((filename) => {
          if (fs.statSync(filename).size > 32 * 1024 * 1024) throw new Error("图片超过 32 MiB");
          const image = nativeImage.createFromPath(filename),
            size = image.getSize();
          if (image.isEmpty() || size.width * size.height > 100_000_000)
            throw new Error("图片尺寸不受支持");
          return { name: path.basename(filename), png: image.toPNG() };
        });
      },
    });
    clipboardRuntime = runtime;
    scope.own("event", {
      dispose: () => {
        if (clipboardRuntime === runtime) clipboardRuntime = undefined;
        for (const [key, image] of pluginImages)
          if (image.owner.instanceId === scope.owner.instanceId) pluginImages.delete(key);
      },
    });
    return runtime;
  }
  if (id === "spark233.ocr") {
    if (!entries.native.ocr) throw new Error("OCR executable entry is required");
    bindOfficialRenderer(id, installation.directory, scope);
    const runtime = await createOcrRuntime({
      ...common,
      descriptor: entries.native.ocr,
      resolveImage: (resource) => {
        const image = pluginImages.get(resource.id);
        if (!image || resource.kind !== "image")
          throw new AppError("invalidResource", "图片资源已失效");
        return image.path;
      },
      onImage: (image) => {
        pluginImages.set(image.resource.id, image);
      },
      onImageReleased: (image) => {
        if (pluginImages.get(image.resource.id)?.path === image.path)
          pluginImages.delete(image.resource.id);
      },
      onResult: async (result) => {
        await showOfficialWorkspace("ocr", result);
      },
    });
    scope.own("event", {
      dispose: () => {
        for (const [key, image] of pluginImages)
          if (image.owner.instanceId === scope.owner.instanceId) pluginImages.delete(key);
      },
    });
    return {
      activate: async (activation) => {
        if (activation.commandId === "cancel") return runtime.activate(activation);
        if (!activation.context) {
          const chosen = await dialog.showOpenDialog({
            title: ui("选择需要取字的图片", "Choose an image for OCR"),
            properties: ["openFile"],
            filters: [{ name: "PNG / JPEG", extensions: ["png", "jpg", "jpeg"] }],
          });
          if (chosen.canceled || !chosen.filePaths[0]) return;
          if (scope.state !== "active") throw new Error("OCR 插件正在停止");
          const filename = chosen.filePaths[0];
          if (fs.statSync(filename).size > 32 * 1024 * 1024) throw new Error("图片超过 32 MiB");
          const image = nativeImage.createFromPath(filename),
            size = image.getSize();
          if (image.isEmpty() || size.width * size.height > 100_000_000)
            throw new Error("图片尺寸不受支持");
          const id = randomUUID(),
            normalized = path.join(common.dataDir, "images", `${id}.png`);
          atomicWrite(normalized, image.toPNG());
          const imported: CaptureImage = {
            owner: scope.owner,
            sessionId: id,
            path: normalized,
            width: size.width,
            height: size.height,
            resource: { id, kind: "image", mimeType: "image/png" },
          };
          pluginImages.set(id, imported);
          return runtime.recognize(imported);
        }
        return runtime.activate(activation);
      },
    };
  }
  if (id === "spark233.screenshot") {
    if (!entries.native.capture) throw new Error("Screenshot executable entry is required");
    scope.own("event", {
      dispose: () => {
        for (const [key, image] of pluginImages)
          if (image.owner.instanceId === scope.owner.instanceId) pluginImages.delete(key);
      },
    });
    const runtime = await createCaptureRuntime({
      ...common,
      descriptor: entries.native.capture,
      getLocale: () => hostConfig.value.locale,
      getOcrStatus: () => ({
        available: !!pluginHost?.manager
          .list()
          .some(
            (record) => record.pluginId === "spark233.ocr" && record.enabled && !record.lastError,
          ),
        reason: "请先启用 OCR 插件",
      }),
      onResult: (image) => {
        pluginImages.set(image.resource.id, image);
        emit("screenshot-result", {
          resource: image.resource,
          width: image.width,
          height: image.height,
        });
      },
      recognize: async (image) => {
        pluginImages.set(image.resource.id, image);
        return pluginHost!.manager.activate("spark233.ocr", {
          commandId: "ocr",
          context: { kind: "image", resource: image.resource },
        });
      },
    });
    return {
      activate: async (activation) => {
        if (activation.commandId !== "cancel") {
          const launcherWindow = windows.get("launcher");
          if (launcherWindow) hideHostWindow(launcherWindow);
        }
        try {
          return await runtime.activate(activation);
        } finally {
          if (!hostShutdown.isQuitting && !exiting && scope.state === "active") requestLauncher();
        }
      },
    };
  }
};
let tray: TrayController;
let capsules: Capsules;
let mcpServer: McpServer;
let lastBalloonReminder: ReminderItem | undefined;
let stopFullscreen = () => {};
const releasing = new Map<number, Promise<void>>();
let exiting = false;
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
let startupFile: string | null = null;
let shortcutWarning: string | undefined;
let mutations: Promise<unknown> = Promise.resolve();
const hostShortcuts = new ShortcutManager({
  showLauncher,
  toggleVisibility: toggleAllSurfaces,
  commands: () => pluginHost?.manager.commands() ?? [],
  activate: (pluginId, commandId) => pluginHost?.manager.activate(pluginId, { commandId }),
  onError: reportError,
  isBlocked: () => maintenance || hostShutdown.isQuitting,
  getLocale: () => hostConfig?.value.locale ?? "zh-CN",
});
const hostShutdown = new ShutdownCoordinator<BrowserWindow>({
  isBlocked: () => maintenance,
  awaitWrites: async () => {
    await contextPanel?.close();
    await mutations.catch(() => {});
  },
  awaitReleases: () => Promise.all(releasing.values()),
  windows: () => windows.values(),
  prepare,
  remember,
  persist: persistLayout,
  shutdownPlugins: async () => {
    await pluginHost?.shutdown();
    await contextPanel?.shutdown();
    await commandMatcher.stop();
    diagnostics?.record({ kind: "host", code: "stopped", level: "info" });
    await diagnostics?.shutdown();
  },
  onCommit: () => {
    exiting = true;
    app.quit();
  },
  onError: reportError,
  getLocale: () => hostConfig?.value.locale ?? "zh-CN",
});
// MCP 写操作与 IPC 写操作共用同一条磁盘事务串行链。
function enqueueMutation<T>(run: () => T | Promise<T>): Promise<T> {
  if (maintenance || hostShutdown.isQuitting)
    return Promise.reject(new AppError("maintenance", "正在备份或恢复，请稍后重试"));
  return (mutations = mutations.catch(() => {}).then(run)) as Promise<T>;
}
let noteStateVersion = 0;
let noteStateFingerprint = "";
let fullscreenRects: Electron.Rectangle[] = [];
const emit = (name: string, payload?: unknown, target?: BrowserWindow) => {
  for (const win of target
    ? [target]
    : [
        ...windows.values(),
        ...[...(capsules?.surfaces.values() ?? [])].map((surface) => surface.win),
      ])
    if (!win.isDestroyed()) win.webContents.send(`spark233:event:${name}`, payload);
};
function noteWindowSnapshot(): NoteWindowSnapshot {
  // Desktop state belongs to layouts. Do not read/recover Markdown metadata while publishing
  // a move, hide or pin event; ordinary notes without a layout use the renderer's unopened default.
  const entries = new Map(
    [...layouts.values()]
      .filter((entry) => entry.noteId && entry.view !== "main")
      .map((entry) => [entry.noteId!, entry]),
  );
  const notes = [...entries].map(([noteId, layout]) => {
    const win = windows.get(layout.label);
    return deriveNoteWindowState(
      noteId,
      layout,
      !!win && !win.isDestroyed() && win.isVisible(),
      capsules?.isHidden() ?? false,
    );
  });
  return { version: noteStateVersion, notes };
}
function publishNoteStates(): void {
  if (!hostConfig) return;
  const snapshot = noteWindowSnapshot(),
    fingerprint = JSON.stringify(snapshot.notes);
  if (fingerprint === noteStateFingerprint) return;
  noteStateFingerprint = fingerprint;
  snapshot.version = ++noteStateVersion;
  emit(NOTE_WINDOW_STATES_CHANGED, snapshot);
}
function applyNoteTopmost(win: BrowserWindow, layout: Layout): void {
  const b = win.getBounds(),
    blocked = fullscreenRects.some(
      (r) =>
        b.x < r.x + r.width && b.x + b.width > r.x && b.y < r.y + r.height && b.y + b.height > r.y,
    );
  // The default Windows level restacks behind the primary taskbar and can lose
  // topmost on another monitor. This level skips that restack; fullscreen still wins.
  win.setAlwaysOnTop(
    layout.topmost && !blocked,
    process.platform === "win32" ? "pop-up-menu" : "floating",
  );
}
async function setNotePinned(id: string, pinned: boolean): Promise<void> {
  await notesClient.get(id);
  let layout = [...layouts.values()].find((e) => e.noteId === id && e.view !== "main");
  const created = !layout;
  if (!layout) {
    layout = {
      label: `notepad-${id}`,
      view: "notepad",
      noteId: id,
      bounds: safeBounds({
        width: hostConfig.value.surfaceWidth,
        height: hostConfig.value.surfaceHeight,
      }),
      visible: false,
      folded: false,
      topmost: false,
      everOpened: false,
    };
    layouts.set(layout.label, layout);
  }
  const before = layout.topmost,
    win = windows.get(layout.label);
  try {
    layout.topmost = pinned;
    if (win && !win.isDestroyed()) applyNoteTopmost(win, layout);
    await persistLayout();
  } catch (error) {
    layout.topmost = before;
    if (created) layouts.delete(layout.label);
    if (win && !win.isDestroyed()) applyNoteTopmost(win, layout);
    publishNoteStates();
    throw error;
  }
}
async function hideNoteOnDesktop(id: string): Promise<void> {
  await notesClient.get(id);
  const layout = [...layouts.values()].find((e) => e.noteId === id && e.view !== "main");
  if (!layout) return;
  const win = windows.get(layout.label);
  if (win) {
    await hideAndRelease(win);
    return;
  }
  const wasVisible = layout.visible;
  layout.visible = false;
  try {
    await persistLayout();
  } catch (error) {
    layout.visible = wasVisible;
    throw error;
  }
  capsules.refresh();
  refreshTray();
  publishNoteStates();
}
async function restoreNotesLayout(data: NotesDataClient): Promise<void> {
  for (const [label, layout] of layouts) if (layout.view !== "launcher") layouts.delete(label);
  capsules.queues.clear();
  const value = await data.getState("layout");
  if (value !== null) {
    if (typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.windows))
      throw new AppError("invalidLayout", "布局文件格式无效，请检查 electron-layout.json");
    const saved = value as unknown as { windows: Layout[]; capsuleQueues?: CapsuleQueue[] };
    const noteIds = new Set((await data.list()).map((note) => note.id));
    capsules.restore(saved.capsuleQueues);
    for (const entry of saved.windows) {
      if (
        !entry ||
        typeof entry.label !== "string" ||
        !["main", "tile", "notepad"].includes(entry.view) ||
        !entry.bounds
      )
        throw new AppError("invalidLayout", "布局文件格式无效，请检查 electron-layout.json");
      if (entry.noteId && !noteIds.has(entry.noteId)) continue;
      if (
        entry.capsule &&
        (!Number.isFinite(entry.capsule.x) ||
          !Number.isFinite(entry.capsule.y) ||
          !Number.isFinite(entry.capsule.order) ||
          !["left", "right", "top"].includes(entry.capsule.edge) ||
          !["floating", "docked"].includes(entry.capsule.kind) ||
          typeof entry.capsule.displayId !== "string")
      )
        throw new AppError("invalidLayout", "胶囊布局格式无效，请检查 electron-layout.json");
      if (entry.folded && !entry.capsule) entry.folded = false;
      layouts.set(entry.label, entry);
    }
    capsules.refresh();
  }
}
async function persistLayout(data = notesClient): Promise<void> {
  // Screen/plugin callbacks can run before the saved layout has been read.
  // Never replace it with the still-empty startup map, including on early quit.
  if (!layoutsRestored || !notesActive) return;
  if (layoutTimer) clearTimeout(layoutTimer);
  await data.putState(
    "layout",
    JSON.parse(
      JSON.stringify({
        version: 2,
        capsuleQueues: [...(capsules?.queues.values() ?? [])],
        windows: [...layouts.values()].filter((entry) => entry.view === "main" || entry.noteId),
      }),
    ),
  );
  publishNoteStates();
}
function scheduleLayout(): void {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    void persistLayout().catch((error) => console.error("layout-save", error));
  }, 250);
}
function labelOf(win: BrowserWindow): string {
  return [...windows].find(([, value]) => value === win)?.[0] ?? "";
}
function remember(win: BrowserWindow): void {
  const layout = layouts.get(labelOf(win));
  if (!layout || win.isDestroyed()) return;
  layout.bounds = win.getBounds();
  if (layout.hostPage === "settings") return;
  applyNoteTopmost(win, layout);
  scheduleLayout();
}
function safeBounds(bounds: Partial<Electron.Rectangle> = {}, main = false): Electron.Rectangle {
  const fallback = { width: main ? 1180 : 360, height: main ? 760 : 420 };
  const point = screen.getCursorScreenPoint();
  const display =
    Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
      ? screen.getDisplayNearestPoint({ x: bounds.x!, y: bounds.y! })
      : screen.getDisplayNearestPoint(point);
  const area = display.workArea;
  const width = Math.min(
    area.width,
    Math.max(main ? 900 : 160, Number(bounds.width) || fallback.width),
  );
  const height = Math.min(
    area.height,
    Math.max(main ? 620 : 60, Number(bounds.height) || fallback.height),
  );
  return {
    x: Math.round(
      Math.max(area.x, Math.min(area.x + area.width - width, bounds.x ?? point.x - width / 2)),
    ),
    y: Math.round(
      Math.max(area.y, Math.min(area.y + area.height - height, bounds.y ?? point.y - 24)),
    ),
    width: Math.round(width),
    height: Math.round(height),
  };
}
function isHostView(layout: Layout): boolean {
  return layout.view === "main" || layout.view === "launcher";
}
function isAdminView(layout: Layout): boolean {
  return isHostView(layout) && !layout.pluginId;
}
function createWindow(layout: Layout): BrowserWindow {
  const presentation = launcherPresentationGuard();
  if (!presentation()) throw new AppError("cancelled", "面板操作已失效");
  const existing = windows.get(layout.label);
  if (existing && !existing.isDestroyed()) {
    windowPresentations.set(existing, presentation);
    layout.visible = true;
    existing.show();
    existing.focus();
    return existing;
  }
  layout.bounds = safeBounds(layout.bounds, layout.view === "main");
  layouts.set(layout.label, layout);
  if (!isHostView(layout)) layout.everOpened = true;
  const area = screen.getDisplayMatching(layout.bounds).workArea;
  const win = createHostWindow({
    bounds: layout.bounds,
    title: "spark233",
    preload: path.join(here, "preload.cjs"),
    icon: path.join(here, "assets/icon.ico"),
    minWidth:
      layout.hostPage === "settings"
        ? Math.min(800, area.width)
        : layout.compact
          ? 320
          : layout.view === "launcher"
            ? 640
            : layout.view === "main"
              ? 900
              : 160,
    minHeight:
      layout.hostPage === "settings"
        ? Math.min(600, area.height)
        : layout.compact
          ? 240
          : layout.view === "launcher"
            ? 420
            : layout.view === "main"
              ? 620
              : 60,
    skipTaskbar: layout.label === "launcher" || !isHostView(layout),
    alwaysOnTop: layout.topmost,
    hasShadow: isHostView(layout),
    label: layout.label,
  });
  if (layout.pluginId) {
    const renderer = officialRenderers.get(layout.pluginId);
    if (!renderer || renderer.scope.state !== "active") {
      win.destroy();
      throw new Error("Plugin renderer is not available");
    }
    officialWindows.set(win.id, { ...renderer.scope.owner });
  }
  windows.set(layout.label, win);
  windowPresentations.set(win, presentation);
  const launcherContentsId = win.webContents.id;
  let initialNavigation = true;
  win.webContents.on("did-start-navigation", (_event, _url, inPlace, mainFrame) => {
    if (!mainFrame || inPlace) return;
    const first = initialNavigation;
    initialNavigation = false;
    // The first load belongs to the capture-to-window handoff already in flight.
    if (layout.label === "context-panel" && first) return;
    launcherComposition.delete(win.id);
    nativeDialogDepth.delete(win.id);
    revokeLauncherCaller(launcherContentsId);
    if (layout.label === "context-panel" && !win.isDestroyed()) win.destroy();
  });
  win.webContents.on("render-process-gone", (_event, details) => {
    revokeLauncherCaller(launcherContentsId);
    crashedWindows.add(win.id);
    ready.delete(win.id);
    const owner =
      officialWindows.get(win.id) ?? (layout.view !== "launcher" ? notesScope?.owner : undefined);
    const error = new Error(
      `Plugin renderer exited: ${details.reason} (${details.exitCode}); last saved data was retained`,
    );
    if (owner) void pluginHost?.manager.reportCrash(owner, error).catch(console.error);
    else console.error("host-renderer-crash", error);
    if (layout.label === "context-panel" && !win.isDestroyed()) win.destroy();
  });
  applyNoteTopmost(win, layout);
  win.webContents.on("before-input-event", (_event, input) => {
    if (
      !hostShortcuts.isRecording ||
      input.type !== "keyDown" ||
      ["Control", "Alt", "Shift", "Meta"].includes(input.key)
    )
      return;
    emit(
      "shortcut-hook-key",
      {
        key: input.key === " " ? "Space" : input.key,
        ctrl: input.control,
        alt: input.alt,
        shift: input.shift,
        meta: input.meta,
      },
      win,
    );
  });
  win.on("system-context-menu", (event) => {
    if (!isHostView(layout)) {
      event.preventDefault();
      void paperMenu(win)
        .then((menu) => {
          if (!win.isDestroyed()) menu.popup({ window: win });
        })
        .catch((error) => reportError(error, win));
    }
  });
  win.on("move", () => remember(win));
  win.on("resize", () => {
    remember(win);
    emit("window-resized", null, win);
  });
  win.on("show", () => {
    layout.visible = true;
    applyNoteTopmost(win, layout);
    if (layout.hostPage !== "settings") scheduleLayout();
    publishNoteStates();
  });
  win.on("hide", () => {
    const caller = launcherCallers.get(launcherContentsId);
    const handoff = launcherHides.get(launcherContentsId);
    launcherHides.delete(launcherContentsId);
    if (caller) {
      const execution = launcherExecutions.getStore();
      if (handoff?.caller === caller)
        launcher.clear(caller, handoff.sessionId, handoff.requestId, "execution");
      else if (execution?.active && execution.callerId === caller && execution.query)
        launcher.clear(caller, execution.query.sessionId, execution.query.requestId, "execution");
      else launcher.clear(caller);
    }
    publishNoteStates();
  });
  win.on("blur", () => {
    if (layout.label === "launcher") {
      setTimeout(() => {
        if (
          !win.isDestroyed() &&
          shouldHideLauncher({
            label: layout.label,
            visible: win.isVisible(),
            focused: win.isFocused(),
            ownedDialog: contextPanelDialogs.has(win.id) || nativeDialogDepth.has(win.id),
            composingUntil: launcherComposition.get(win.id) ?? 0,
            devToolsFocused: win.webContents.isDevToolsFocused(),
          })
        ) {
          hideHostWindow(win);
        }
      }, 160);
    }
    const caller = launcherCallers.get(launcherContentsId);
    if (layout.label === "context-panel" && caller && !contextPanelDialogs.has(win.id))
      contextPanel?.blur(caller);
  });
  win.on("close", (event) => {
    if (exiting) return;
    if (layout.label === "context-panel") {
      event.preventDefault();
      const caller = launcherCallers.get(launcherContentsId);
      if (caller) void contextPanel?.close(caller).catch(() => {});
      else win.destroy();
      return;
    }
    event.preventDefault();
    if (
      isAdminView(layout) &&
      layout.hostPage !== "settings" &&
      !layout.compact &&
      !hostConfig.value.closeToTray
    )
      void quit();
    else
      void (isHostView(layout) ? hideAndRelease(win) : foldAndRelease(win)).catch((error) =>
        reportError(error, win),
      );
  });
  win.on("closed", () => {
    revokeLauncherCaller(launcherContentsId);
    if (pendingManagerOpen?.windowId === win.id) pendingManagerOpen = undefined;
    ready.delete(win.id);
    crashedWindows.delete(win.id);
    preparedWindows.delete(win.id);
    officialWindows.delete(win.id);
    if (windows.get(layout.label) === win) {
      workspaceRequests.delete(layout.label);
      windows.delete(layout.label);
    }
    publishNoteStates();
  });
  const params = new URLSearchParams({
    view: layout.hostPage ?? layout.view,
    ...layout.settingsTarget,
    ...(layout.noteId ? { noteId: layout.noteId } : {}),
    ...(layout.workspace ? { workspace: layout.workspace } : {}),
    ...(layout.compact ? { compact: "1" } : {}),
  });
  void win
    .loadURL(
      `${layout.pluginId ? `spark233://workspace/${encodeURIComponent(layout.pluginId)}/index.html` : devUrl || (layout.view === "launcher" ? "spark233://app/index.html" : "spark233://notes/index.html")}?${params}`,
    )
    .catch((error) => reportError(error));
  return win;
}
function requireNotes(): void {
  if (maintenance || hostShutdown.isQuitting)
    throw new AppError("maintenance", "正在备份或恢复，请稍后重试");
  if (!notesActive) throw new AppError("pluginDisabled", "便签插件已停用，请从插件管理启用");
}
async function showLauncher(): Promise<BrowserWindow> {
  if (maintenance || hostShutdown.isQuitting)
    throw new AppError("maintenance", "正在备份或恢复，请稍后重试");
  if (
    clipboardRuntime &&
    ![
      ...windows.values(),
      ...[...(capsules?.surfaces.values() ?? [])].map((surface) => surface.win),
    ].some((win) => win.isFocused())
  ) {
    try {
      await clipboardRuntime.rememberTarget();
    } catch (error) {
      console.error("clipboard-target", error);
    }
  }
  const layout: Layout = layouts.get("launcher") ?? {
    label: "launcher",
    view: "launcher",
    bounds: safeBounds({ width: 760, height: 560 }),
    visible: true,
    topmost: false,
  };
  layout.visible = true;
  const win = createWindow(layout);
  if (ready.has(win.id)) emit("launcher-shown", undefined, win);
  return win;
}
function requestLauncher(): void {
  void showLauncher().catch((error) => reportError(error));
}
async function showOfficialWorkspace(kind: "translation" | "ocr", result: unknown): Promise<void> {
  if (!launcherPresentationGuard()()) return;
  endLauncherExecutionQuery();
  if (maintenance || hostShutdown.isQuitting)
    throw new AppError(
      "maintenance",
      ui("正在备份或恢复，请稍后重试", "A backup or restore is running. Try again shortly."),
    );
  const pluginId = `spark233.${kind}`;
  if (officialRenderers.get(pluginId)?.scope.state !== "active")
    throw new Error("The plugin workspace is not available");
  const layout: Layout = layouts.get(kind) ?? {
    label: kind,
    view: "launcher",
    pluginId,
    workspace: kind,
    bounds: safeBounds({ width: 1040, height: 700 }),
    visible: true,
    topmost: false,
  };
  layout.visible = true;
  const win = createWindow(layout),
    payload = { kind, result };
  workspaceRequests.set(labelOf(win), payload);
  emit("open-workspace", payload, win);
}
async function showClipboardWorkspace(presentation?: {
  compact: boolean;
  position: "cursor" | "edge";
}): Promise<void> {
  if (!launcherPresentationGuard()()) return;
  endLauncherExecutionQuery();
  if (maintenance || hostShutdown.isQuitting)
    throw new AppError("maintenance", "正在备份或恢复，请稍后重试");
  if (presentation?.compact) {
    if (clipboardRuntime && !windows.get("clipboard-quick")?.isFocused())
      await clipboardRuntime
        .rememberTarget()
        .catch((error) => console.error("clipboard-target", error));
    if (!launcherPresentationGuard()()) return;
    const point = screen.getCursorScreenPoint(),
      area = screen.getDisplayNearestPoint(point).workArea;
    const layout: Layout = layouts.get("clipboard-quick") ?? {
      label: "clipboard-quick",
      view: "launcher",
      pluginId: "spark233.clipboard",
      workspace: "clipboard",
      compact: true,
      bounds: safeBounds({ width: 450, height: 400 }),
      visible: true,
      topmost: false,
    };
    layout.bounds = safeBounds({
      ...layout.bounds,
      x: presentation.position === "edge" ? area.x + area.width - layout.bounds.width : point.x,
      y: point.y,
    });
    layout.visible = true;
    createWindow(layout);
    return;
  }
  if (clipboardRuntime && !windows.get("clipboard")?.isFocused())
    await clipboardRuntime
      .rememberTarget()
      .catch((error) => console.error("clipboard-target", error));
  if (!launcherPresentationGuard()()) return;
  const layout: Layout = layouts.get("clipboard") ?? {
    label: "clipboard",
    view: "launcher",
    pluginId: "spark233.clipboard",
    workspace: "clipboard",
    bounds: safeBounds({ width: 1040, height: 700 }),
    visible: true,
    topmost: false,
  };
  layout.visible = true;
  createWindow(layout);
}
function showMain(): BrowserWindow {
  endLauncherExecutionQuery();
  requireNotes();
  const layout = layouts.get("main") ?? {
    label: "main",
    view: "main",
    bounds: safeBounds({}, true),
    visible: true,
    topmost: false,
  };
  layout.visible = true;
  const win = createWindow(layout);
  if (ready.has(win.id)) {
    win.show();
    win.focus();
  }
  return win;
}
async function openNote(
  noteId?: string,
  view?: "notepad" | "tile",
  bounds?: Electron.Rectangle,
): Promise<string> {
  requireNotes();
  if (noteId) await notesClient.get(noteId);
  endLauncherExecutionQuery();
  const found = noteId
    ? [...layouts.values()].find(
        (entry) => entry.noteId === noteId && (entry.view === "notepad" || entry.view === "tile"),
      )
    : undefined;
  const label = found?.label ?? `${view ?? "notepad"}-${noteId || randomUUID()}`;
  if (!launcherPresentationGuard()()) return label;
  const layout: Layout = found ?? {
    label,
    view: view ?? "notepad",
    noteId,
    bounds: safeBounds(
      bounds ?? { width: hostConfig.value.surfaceWidth, height: hostConfig.value.surfaceHeight },
    ),
    visible: true,
    topmost: false,
  };
  layout.visible = true;
  layout.folded = false;
  const modeChanged = !!view && layout.view !== view;
  if (modeChanged && view) {
    layout.view = view;
    if (!windows.has(label) && !bounds)
      layout.bounds = safeBounds({
        ...layout.bounds,
        width: 360,
        height: view === "tile" ? 240 : 420,
      });
  }
  if (bounds) layout.bounds = safeBounds(bounds);
  const win = createWindow(layout);
  if (modeChanged && ready.has(win.id))
    emit("surface-mode-request", view === "tile" ? "tile" : "pad", win);
  if (ready.has(win.id)) {
    win.show();
    win.focus();
  }
  scheduleLayout();
  refreshTray();
  capsules?.refresh();
  return label;
}
async function prepare(win: BrowserWindow): Promise<boolean> {
  if (win.isDestroyed()) return true;
  // A dead renderer cannot acknowledge saving. Its plugin has already been
  // marked failed; preserve the last durable state and let live owners save.
  if (crashedWindows.has(win.id)) return true;
  if (!ready.has(win.id)) return false;
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(
      () => {
        pending.delete(requestId);
        resolve(false);
      },
      layouts.get(labelOf(win))?.hostPage === "settings" ? 120000 : 10000,
    );
    pending.set(requestId, {
      windowId: win.id,
      resolve: (result) => {
        clearTimeout(timer);
        pending.delete(requestId);
        resolve(result);
      },
    });
    emit("desktop:prepare-close", { requestId }, win);
  });
}
function hideAndRelease(win: BrowserWindow): Promise<void> {
  return releaseWindow(win, false);
}
function foldAndRelease(win: BrowserWindow): Promise<void> {
  return releaseWindow(win, true);
}
function releaseWindow(win: BrowserWindow, fold: boolean): Promise<void> {
  const existing = releasing.get(win.id);
  if (existing) return existing;
  const operation = (async () => {
    if (!(await prepare(win)))
      throw new AppError("saveFailed", "保存未完成，已保留窗口，请先保存再收起");
    const layout = layouts.get(labelOf(win));
    if (!layout || win.isDestroyed()) return;
    remember(win);
    if (fold && layout.view !== "main" && layout.noteId) await capsules.fold(layout);
    else {
      layout.visible = false;
      layout.folded = false;
      if (layout.hostPage !== "settings") await persistLayout();
    }
    hideHostWindow(win);
    if (layout.noteId) emit("tile-window-closed", layout.noteId);
    win.destroy();
    capsules.refresh();
    refreshTray();
  })();
  releasing.set(win.id, operation);
  void operation.finally(() => releasing.delete(win.id)).catch(() => {});
  return operation;
}
function quit(): Promise<void> {
  return hostShutdown.request();
}
function reportError(error: unknown, win?: BrowserWindow): void {
  diagnostics?.record({
    kind: "host",
    code: "failed",
    level: "error",
    errorCode: diagnosticErrorCode(error),
  });
  console.error(error);
  const options: Electron.MessageBoxOptions = {
    type: "error",
    title: "spark233",
    message: error instanceof Error ? error.message : String(error),
  };
  if (win && !win.isDestroyed()) void dialog.showMessageBox(win, options);
  else void dialog.showMessageBox(options);
}
function refreshTray(): void {
  if (!tray) return;
  tray.refresh();
}
async function globalMenu(): Promise<Electron.Menu> {
  let notesAvailable = notesActive && notesScope?.state === "active" && !maintenance;
  let notes: NoteMetadata[] = [];
  if (notesAvailable) {
    try {
      notes = await notesClient.list();
    } catch (error) {
      // A menu requested just before prepare may reach the manager after its
      // fence. Keep host actions available and refresh again on manager change.
      notesAvailable = false;
      if (!(error instanceof AppError && error.code.startsWith("plugin")))
        console.error("tray-notes", error);
    }
  }
  return Menu.buildFromTemplate([
    { label: ui("打开启动器", "Open launcher"), click: requestLauncher },
    { label: ui("打开便签列表", "Manage notes"), enabled: notesAvailable, click: () => showMain() },
    {
      label: ui("新建便签", "New note"),
      enabled: notesAvailable,
      click: () => void openNote().catch(reportError),
    },
    { type: "separator" },
    {
      label: ui("找回便签", "Recover a note"),
      submenu: notes.length
        ? notes.map((note) => ({
            label: (note.title || note.preview || ui("无标题便签", "Untitled note"))
              .slice(0, 50)
              .replace(/&/g, "&&"),
            click: () => void openNote(note.id).catch(reportError),
          }))
        : [{ label: ui("暂无便签", "No notes"), enabled: false }],
    },
    { type: "separator" },
    { label: ui("退出（保存后关闭）", "Quit after saving"), click: () => void quit() },
  ]);
}
async function openNoteWithAnchor(noteId: string, taskText?: string): Promise<void> {
  await notesClient.get(noteId);
  if (!launcherPresentationGuard()()) return;
  const main = showMain();
  // 旧载荷是纯 id 字符串；带任务锚点的提醒用对象载荷，渲染端两者都接受。
  const payload: string | { noteId: string; taskText?: string } = taskText
    ? { noteId, taskText }
    : noteId;
  if (ready.has(main.id)) emit("open-note", payload, main);
  else pendingManagerOpen = { windowId: main.id, payload };
}
function fireReminderNotification({ item, noteTitle, body }: ReminderNotification): void {
  const open = () => {
    void openNoteWithAnchor(item.noteId, item.taskText).catch((error) => reportError(error));
  };
  if (Notification.isSupported()) {
    const notification = new Notification({
      title: noteTitle,
      body,
      silent: !hostConfig.value.reminderSound,
    });
    notification.on("click", open);
    notification.show();
    return;
  }
  lastBalloonReminder = item;
  tray?.displayBalloon({ iconType: "info", title: noteTitle, content: body });
}
async function paperMenu(win: BrowserWindow): Promise<Electron.Menu> {
  const layout = layouts.get(labelOf(win))!;
  const noteReminders = layout.noteId ? await notesClient.listReminders(layout.noteId) : [];
  return Menu.buildFromTemplate([
    ...(layout.view === "tile"
      ? [
          {
            label: ui("切回便签", "Edit note"),
            click: () => emit("surface-mode-request", "pad", win),
          },
        ]
      : []),
    {
      label: ui("折叠成胶囊", "Fold into capsule"),
      click: () => void foldAndRelease(win).catch((error) => reportError(error, win)),
    },
    {
      label: ui("隐藏到托盘", "Hide to tray"),
      click: () => void hideAndRelease(win).catch((error) => reportError(error, win)),
    },
    { type: "separator" },
    ...(layout.noteId
      ? [
          {
            label: ui("设置提醒", "Set reminder"),
            submenu: REMINDER_PRESETS.map((preset) => ({
              label: ui(
                preset.label,
                {
                  "15m": "15 minutes",
                  "30m": "30 minutes",
                  "1h": "1 hour",
                  "3h": "3 hours",
                  "today-evening": "Today at 18:00",
                  "tomorrow-morning": "Tomorrow at 09:00",
                }[preset.id],
              ),
              click: () => {
                void notesClient
                  .setReminderPreset({ noteId: layout.noteId!, preset: preset.id })
                  .catch((error) => reportError(error, win));
              },
            })),
          },
          ...(noteReminders.length
            ? [
                {
                  label: ui(
                    `取消提醒（${noteReminders.length} 条）`,
                    `Cancel ${noteReminders.length} reminders`,
                  ),
                  click: () => {
                    if (layout.noteId)
                      void notesClient
                        .cancelRemindersForNote(layout.noteId)
                        .catch((error) => reportError(error, win));
                  },
                },
              ]
            : []),
          { type: "separator" as const },
        ]
      : []),
    {
      label: ui("置顶", "Always on top"),
      type: "checkbox",
      checked: layout.topmost,
      click: (item) => {
        if (layout.noteId)
          void setNotePinned(layout.noteId, item.checked).catch((error) => reportError(error, win));
      },
    },
  ]);
}
function visibleSurfaceWindows(): BrowserWindow[] {
  return [
    ...windows.values(),
    ...[...(capsules?.surfaces.values() ?? [])].map((surface) => surface.win),
  ].filter((win) => win.isVisible());
}
function hideAllSurfaces(): void {
  for (const win of visibleSurfaceWindows()) hideHostWindow(win);
  capsules.setHidden(true);
}
function showAllSurfaces(): void {
  const notes = [...layouts.values()].filter((entry) => entry.visible && entry.view !== "main");
  capsules.setHidden(false);
  if (notes.length)
    for (const entry of notes)
      if (!entry.folded) createWindow(entry).show();
      else showMain();
  else showMain();
}
function toggleAllSurfaces(): void {
  if (visibleSurfaceWindows().length) hideAllSurfaces();
  else showAllSurfaces();
}
function executeCliCommand(command: CliCommand): void {
  if (maintenance || hostShutdown.isQuitting) {
    console.error("正在备份或恢复，CLI 操作未执行");
    return;
  }
  switch (command) {
    case "new":
      void openNote().catch(reportError);
      return;
    case "show":
      requestLauncher();
      return;
    case "hide":
      hideAllSurfaces();
      return;
    case "toggle":
      toggleAllSurfaces();
      return;
    case "list":
      showMain();
      return;
    case "exit":
      void quit();
      return;
  }
}
function registerShortcuts(config: AppConfig): void {
  try {
    hostShortcuts.configure(config);
    shortcutWarning = undefined;
  } catch (error) {
    shortcutWarning = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    emit("launcher-status-changed");
  }
}
function sender(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  const owner = win ? officialWindows.get(win.id) : undefined;
  const ownedRenderer = owner ? officialRenderers.get(owner.pluginId) : undefined;
  if (owner && (!ownedRenderer || !ownedRenderer.scope.accepts(owner)))
    throw new AppError("permissionDenied", "Plugin window instance has expired");
  const expectedOrigin = owner
    ? "spark233://workspace"
    : devUrl
      ? new URL(devUrl).origin
      : win && layouts.get(labelOf(win))?.view === "launcher"
        ? "spark233://app"
        : "spark233://notes";
  if (
    !win ||
    (!windows.has(labelOf(win)) && !capsules?.owns(win)) ||
    !frame ||
    frame !== event.sender.mainFrame ||
    frame.origin !== expectedOrigin
  )
    throw new AppError("permissionDenied", "拒绝非应用窗口 IPC");
  return win;
}
function text(value: unknown): string {
  if (typeof value !== "string") throw new AppError("invalidPayload", "需要字符串参数");
  return value;
}
const TEXT_FILE = /\.(md|markdown|txt)$/i;
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;
const changed = () => {
  emit("notes-changed");
  refreshTray();
  capsules?.refresh();
};
function toMcpNote(note: {
  id: string;
  title: string;
  category: string;
  updatedAt: string;
  wordCount: number;
  content: string;
}) {
  const { id, title, category, updatedAt, wordCount, content } = note;
  return { id, title, category, updatedAt, wordCount, content };
}
// MCP and renderer writes share the host queue; the notes utility owns data I/O.
const mcpOps: McpOps = {
  version: () => app.getVersion(),
  listCategories: () => notesClient.categories(),
  listNotes: async (category) =>
    (await notesClient.list(category)).map(({ id, title, category, updatedAt, wordCount }) => ({
      id,
      title,
      category,
      updatedAt,
      wordCount,
    })),
  readNote: async (id) => toMcpNote(await notesClient.get(id)),
  searchNotes: async (query, limit) =>
    (await notesClient.search(query, limit)).map(({ id, title, snippet }) => ({
      id,
      title,
      snippet,
    })),
  createNote: (input) =>
    enqueueMutation(async () => {
      const note = await notesClient.save({
        title: input.title ?? "",
        content: input.content ?? "",
        category: input.category ?? "",
      });
      changed();
      return toMcpNote(note);
    }),
  writeNote: (id, mode, content) =>
    enqueueMutation(async () => {
      const note = mode === "replace" ? await notesClient.get(id) : undefined;
      const saved = note
        ? await notesClient.save({ title: note.title, content, category: note.category }, id)
        : await notesClient.append(id, content);
      changed();
      return toMcpNote(saved);
    }),
  deleteNote: (id) =>
    enqueueMutation(async () => {
      const editors = [...layouts.values()].filter(
        (entry) => entry.noteId === id && windows.has(entry.label),
      );
      if (editors.length) throw new AppError("noteInUse", "该便签有独立窗口打开，请先关闭后再删除");
      await notesClient.delete(id);
      await notesClient.cancelRemindersForNote(id);
      for (const entry of layouts.values()) if (entry.noteId === id) layouts.delete(entry.label);
      await persistLayout();
      changed();
    }),
  setReminder: (input) =>
    enqueueMutation(async () => {
      let noteId = input.noteId;
      if (!noteId && input.title) {
        const found = (await notesClient.list()).find((note) => note.title === input.title);
        if (!found) throw new AppError("noteNotFound", `找不到标题为「${input.title}」的便签`);
        noteId = found.id;
      }
      if (!noteId) throw new AppError("invalidPayload", "需要 noteId 或 title 定位便签");
      const fireAt =
        input.fireAt ??
        (input.minutes && input.minutes > 0
          ? new Date(Date.now() + input.minutes * 60_000).toISOString()
          : undefined);
      if (!fireAt) throw new AppError("invalidPayload", "需要 minutes 或 fireAt 指定提醒时间");
      return notesClient.setReminder({ noteId, fireAt, taskText: input.taskText });
    }),
};
function syncMcp(): void {
  if (!mcpServer) return;
  if (!maintenance && notesActive && hostConfig.value.mcpEnabled) mcpServer.start();
  else mcpServer.stop();
}
async function pauseForBackup(): Promise<() => void> {
  if (notesRecoveryPending)
    throw new AppError(
      "pluginRecoveryRequired",
      ui(
        "请先恢复便签后台并保存保留的编辑窗口",
        "Recover notes and save the retained editors first",
      ),
    );
  if (maintenance || hostShutdown.isQuitting)
    throw new AppError("maintenance", "已有备份或恢复任务正在运行");
  setMaintenance(true);
  let resumePlugins: (() => void) | undefined;
  try {
    resumePlugins = await pluginHost?.pauseMutations();
    mcpServer?.stop();
    await mutations.catch(() => {});
    const saved = await Promise.all(
      [...windows.values()]
        .filter((win) => layouts.get(labelOf(win))?.view === "launcher")
        .map(prepare),
    );
    if (!saved.every(Boolean)) throw new AppError("saveFailed", "工作区尚未保存，已取消备份或恢复");
    return () => {
      resumePlugins?.();
      setMaintenance(false);
      preparedWindows.clear();
      syncMcp();
      refreshTray();
    };
  } catch (error) {
    resumePlugins?.();
    setMaintenance(false);
    preparedWindows.clear();
    syncMcp();
    throw error;
  }
}
async function migrateNotesDirectory(directory: string): Promise<AppConfig> {
  requireNotes();
  if (!pluginHost) throw new AppError("pluginHostUnavailable", "插件宿主尚未就绪");
  if (maintenance || hostShutdown.isQuitting || pendingNotesMigration)
    throw new AppError("maintenance", "已有数据维护任务正在运行");
  setMaintenance(true);
  let previous = hostConfig.value;
  let previousPlugins: PluginManagerSnapshot | undefined;
  let resumeHost: (() => void) | undefined;
  const migration = { directory } as { directory: string; copiedRoot?: string };
  try {
    resumeHost = await pluginHost.pauseMutations();
    mcpServer.stop();
    await mutations.catch(() => {});
    previous = hostConfig.value;
    pendingNotesMigration = migration;
    await pluginHost.manager.withQuiesced(
      async (access) => {
        if (!migration.copiedRoot)
          throw new AppError("migrationFailed", "便签引擎未完成数据目录复制");
        previousPlugins = access.snapshot();
        // Restart/rollback preparation must not attempt to copy this root again.
        pendingNotesMigration = undefined;
        hostConfig.save({
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
        hostConfig.save(previous);
        // Failed startup persists lastError. Restore the pre-switch installation
        // state as well as its root, so resume actually restarts the old engine.
        if (previousPlugins) access.replaceSnapshot(previousPlugins);
      },
    );
    emit("config-changed", hostConfig.value);
    return hostConfig.value;
  } finally {
    pendingNotesMigration = undefined;
    resumeHost?.();
    setMaintenance(false);
    preparedWindows.clear();
    syncMcp();
    refreshTray();
  }
}
async function reloadHostAfterRestore(): Promise<void> {
  const dataDir = hostConfig.value.dataDir;
  const previousAutostart = hostConfig.value.autostart;
  await contextPanel?.close();
  launcher.clear();
  pluginHost?.reloadAfterRestore();
  hostConfig = new HostConfigStore(hostConfigDir, dataDir);
  await contextPanel?.configure(panelConfiguration(hostConfig.value));
  launcher = new LauncherController({
    commandMatcher,
    getWarnings: () => (shortcutWarning ? [shortcutWarning] : []),
    stateFile: path.join(hostConfigDir, "launcher.json"),
    manager: () => pluginHost?.manager,
    onQueryUpdate: deliverLauncherQueryUpdate,
    onPreferencesChanged: () => emit("launcher-status-changed"),
    onLearningChanged: (learning) => emit("launcher-learning-changed", learning),
    getContext: contextForCaller,
    adaptContext: contextForCommand,
    getContextRevision: contextRevisionForCaller,
    getAvailabilityRevision: () => launcherAvailabilityRevision,
    getLocale: () => hostConfig.value.locale,
  });
  notesActive = false;
  layoutsRestored = false;
  for (const [label, layout] of layouts) if (layout.view !== "launcher") layouts.delete(label);
  capsules.queues.clear();
  clearLauncherContext();
  registerShortcuts(hostConfig.value);
  if (hostConfig.value.autostart !== previousAutostart)
    app.setLoginItemSettings({ openAtLogin: hostConfig.value.autostart, path: process.execPath });
  emit("config-changed", hostConfig.value);
  publishPluginTheme();
}
function translationSettingsFile(): string {
  if (!pluginHost) throw new Error("Plugin host is not ready");
  return path.join(
    pluginHost.manager.dataDirectory("spark233.translation"),
    "provider-settings.json",
  );
}
function translationSettings(): Record<string, unknown> {
  return readTranslationSettings(translationSettingsFile(), (bytes) =>
    safeStorage.decryptString(bytes),
  );
}
let settingsCaller: BrowserWindow | undefined;
const pluginSettings = new PluginSettingsService(
  (id): PluginSettingsAdapter => {
    if (!pluginHost) throw new Error("Plugin host is not ready");
    const manager = pluginHost.manager;
    manager.describe(id);
    const directory = manager.dataDirectory(id);
    if (id === "spark233.notes")
      return {
        fields: noteSettingsFields,
        read: () =>
          Object.fromEntries(
            noteSettingsFields
              .filter((field) => hostConfig.value[field.key as keyof AppConfig] !== undefined)
              .map((field) => [field.key, hostConfig.value[field.key as keyof AppConfig]]),
          ),
        save: async (values) => {
          if (!settingsCaller || settingsCaller.isDestroyed())
            throw new Error("Settings document closed");
          await handle(settingsCaller, "config_patch", { patch: values });
        },
      };
    if (id === "spark233.translation")
      return {
        fields: translationSettingsFields,
        read: translationSettings,
        save: (values) =>
          writeTranslationSettings(translationSettingsFile(), values, (key) => {
            if (!safeStorage.isEncryptionAvailable())
              throw new Error("系统密钥加密暂不可用，未保存密钥");
            return safeStorage.encryptString(key);
          }),
      };
    if (id === "spark233.search") {
      const file = path.join(directory, "search-scope.json");
      return {
        fields: searchSettingsFields,
        read: () =>
          fs.existsSync(file)
            ? validateSearchSettings(JSON.parse(fs.readFileSync(file, "utf8")))
            : searchSettingsSchema.parse({ excludedRoots: [] }),
        save: async (values) => {
          const next = validateSearchSettings(values);
          const active =
            manager.list().find((plugin) => plugin.pluginId === id)?.status === "active";
          if (active)
            await manager.activate(id, {
              commandId: "settings",
              parameters: { action: "save", ...next },
            });
          else atomicWrite(file, JSON.stringify(next));
          launcher.clear();
          emit("search-scope-changed");
        },
      };
    }
    if (id === "spark233.clipboard") {
      const withHistory = <T>(action: (history: ClipboardHistory) => T): T => {
        const history = new ClipboardHistory(directory);
        try {
          return action(history);
        } finally {
          history.close();
        }
      };
      return {
        fields: clipboardSettingsFields,
        read: () => withHistory((history) => ({ ...history.settings() })),
        save: async (values) => {
          const next = clipboardSettingsSchema.parse(values);
          if (clipboardRuntime) await clipboardRuntime.request({ action: "settings", patch: next });
          else withHistory((history) => history.saveSettings(next));
          emit("clipboard-changed");
        },
      };
    }
    return { fields: [], read: () => ({}), save: () => {} };
  },
  (id) => {
    const record = pluginHost?.manager.list().find((plugin) => plugin.pluginId === id);
    if (!record) throw new Error("Plugin is not installed");
    return JSON.stringify([record.packageName, record.version, record.integrity]);
  },
);
async function handle(
  win: BrowserWindow,
  command: string,
  args: Record<string, any>,
): Promise<unknown> {
  const preparing = [...pending.values()].some((request) => request.windowId === win.id);
  const preparationWrite =
    preparing &&
    (/^(notes_(create|update|set_editor_mode)|images_save|save_external_file)$/.test(command) ||
      (command === "clipboard_action" && args.action === "draft.save") ||
      ["config_patch", "plugin_settings_save"].includes(command));
  const readOnly = [
    "desktop_ready",
    "desktop_prepare_report",
    "config_get",
    "app_version",
    "app_name",
    "app_exec_path",
    "plugins_list",
    "diagnostics_list",
    "diagnostics_subscribe",
    "diagnostics_unsubscribe",
    "super_panel_status",
    "super_panel_state",
    "super_panel_close",
    "backup_selection_release",
    "launcher_state",
    "notes_get",
    "notes_list",
    "categories_list",
    "images_get_base_dir",
    "note_window_states",
    "reminders_list",
    "take_startup_file",
  ];
  const windowRead =
    command === "window_control" &&
    ["bounds", "position", "size", "isMaximized", "isAlwaysOnTop"].includes(args.action);
  const restoredSurface =
    command === "surface_state" && layouts.get(labelOf(win))?.noteId === args.noteId;
  if (
    (maintenance || hostShutdown.isQuitting) &&
    !readOnly.includes(command) &&
    !windowRead &&
    !restoredSurface &&
    !preparationWrite
  )
    throw new AppError("maintenance", "正在备份或恢复，请稍后重试");
  if (
    notesScope &&
    notesScope.state !== "active" &&
    preparedWindows.has(win.id) &&
    /^(notes_(create|update|set_editor_mode)|images_save)/.test(command)
  )
    throw new AppError("pluginStopping", "便签已确认保存，正在停止，请稍后重试");
  if (
    command === "clipboard_action" &&
    args.action === "draft.save" &&
    preparedWindows.has(win.id) &&
    officialRenderers.get("spark233.clipboard")?.scope.state !== "active"
  )
    throw new AppError("pluginStopping", "The clipboard workspace has already acknowledged saving");
  if (capsules.owns(win)) return capsules.handle(win, command, args);
  const label = labelOf(win),
    layout = layouts.get(label)!;
  if (layout.pluginId) {
    const common = [
      "desktop_ready",
      "settings_open",
      "desktop_prepare_report",
      "config_get",
      "app_version",
      "app_name",
      "app_exec_path",
      "launcher_state",
      "launcher_take_workspace",
      "launcher_return",
      "window_control",
      "text_action",
      "clipboard_write",
    ];
    const business: Record<string, string[]> = {
      "spark233.clipboard": ["clipboard_action", "clipboard_image_ocr"],
      "spark233.translation": ["translation_action", "translation_configure"],
      "spark233.ocr": [],
    };
    if (!common.includes(command) && !business[layout.pluginId]?.includes(command))
      throw new AppError("permissionDenied", "此插件工作区不能调用宿主管理接口");
  }
  if (command === "launcher_composition") {
    if (layout.label !== "launcher") throw new AppError("permissionDenied", "此窗口不是启动器");
    const input = z.strictObject({ active: z.boolean() }).parse(args);
    if (input.active) launcherComposition.set(win.id, Date.now() + 10000);
    else launcherComposition.delete(win.id);
    return;
  }
  if (command === "plugin_settings_get" || command === "plugin_settings_save") {
    if (!isAdminView(layout)) throw new AppError("permissionDenied", "插件配置仅限宿主管理界面");
    const input = z
      .strictObject({
        pluginId: z.string().regex(/^[a-z][a-z0-9.-]*$/),
        revision: z.string().length(64).optional(),
        patch: z.unknown().optional(),
      })
      .parse(args);
    if (command === "plugin_settings_get") return pluginSettings.get(input.pluginId);
    if (!input.revision) throw new AppError("invalidPayload", "缺少配置版本");
    settingsCaller = win;
    try {
      const result = await pluginSettings.save(input.pluginId, input.revision, input.patch);
      emit("plugin-settings-changed", { pluginId: input.pluginId });
      return result;
    } finally {
      settingsCaller = undefined;
    }
  }
  if (command === "settings_open") {
    if (
      !isAdminView(layout) &&
      !(layout.pluginId && args.page === "plugins" && args.pluginId === layout.pluginId)
    )
      throw new AppError("permissionDenied", "只能定位当前插件的设置");
    const target = z
      .strictObject({
        page: z.enum(["general", "entries", "plugins", "backup", "diagnostics"]).default("general"),
        pluginId: z
          .string()
          .regex(/^[a-z][a-z0-9.-]*$/)
          .optional(),
        tab: z.enum(["config", "functions", "matching", "info"]).optional(),
      })
      .parse(args);
    if (target.pluginId) pluginHost?.manager.describe(target.pluginId);
    const previous = windows.get("settings");
    if (previous && ready.has(previous.id) && !(await prepare(previous))) return;
    const existingLayout = layouts.get("settings");
    const bounds =
      existingLayout?.bounds ??
      (() => {
        const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
        const width = Math.min(1080, area.width),
          height = Math.min(760, area.height);
        return {
          x: Math.round(area.x + (area.width - width) / 2),
          y: Math.round(area.y + (area.height - height) / 2),
          width,
          height,
        };
      })();
    const settingsLayout: Layout = {
      label: "settings",
      view: "launcher",
      hostPage: "settings",
      settingsTarget: target,
      bounds,
      visible: true,
      topmost: false,
    };
    const settings = createWindow(settingsLayout);
    const current = layouts.get("settings")!;
    current.settingsTarget = target;
    if (settings.isMinimized()) settings.restore();
    if (ready.has(settings.id)) emit("settings-navigate", target, settings);
    if (layout.label === "launcher") hideHostWindow(win);
    return;
  }
  if (command.startsWith("super_panel_")) {
    if (!isAdminView(layout)) throw new AppError("permissionDenied", "超级面板仅限宿主界面");
    z.strictObject({}).parse(args);
    if (!contextPanel) throw new AppError("pluginHostUnavailable", "超级面板尚未就绪");
    if (command === "super_panel_status") return contextPanel.status;
    if (command === "super_panel_retry") {
      await contextPanel.configure(panelConfiguration(hostConfig.value));
      return contextPanel.status;
    }
    if (command === "super_panel_open") {
      const point = screen.getCursorScreenPoint();
      contextPanel.openCommon(
        process.platform === "win32" ? screen.dipToScreenPoint(point) : point,
      );
      return;
    }
    const caller = launcherCaller(win);
    if (layout.label !== "context-panel" || !contextPanelCallers.has(caller))
      throw new AppError("permissionDenied", "此操作不属于当前面板");
    if (command === "super_panel_state") return contextPanel.state(caller);
    if (command === "super_panel_close") {
      await contextPanel.close(caller);
      return;
    }
    if (command === "super_panel_return") return contextPanel.returnToSource(caller);
    throw new AppError("unknownCommand", "未知超级面板操作");
  }
  if (command.startsWith("diagnostics_")) {
    if (!isAdminView(layout)) throw new AppError("permissionDenied", "诊断记录仅限宿主管理界面");
    if (!diagnostics) {
      try {
        diagnostics = new DiagnosticsStore(path.join(configDir, "diagnostics"));
        diagnostics.record({ kind: "host", code: "started", level: "info" });
      } catch {
        /* A retry may recover after an operator repairs the dedicated log directory. */
      }
    }
    if (!diagnostics) throw new AppError("diagnosticsUnavailable", "诊断记录暂不可用");
    const caller = launcherCaller(win);
    if (command === "diagnostics_list") {
      const input = z.strictObject({ filter: z.unknown().optional() }).parse(args);
      return diagnostics.snapshot(input.filter as DiagnosticFilter | undefined);
    }
    if (command === "diagnostics_subscribe") {
      z.strictObject({}).parse(args);
      diagnosticSubscriptions.get(caller)?.();
      diagnosticSubscriptions.delete(caller);
      const stop = diagnostics.subscribe((batch) => {
        if (
          !win.isDestroyed() &&
          !win.webContents.isDestroyed() &&
          launcherCallers.get(win.webContents.id) === caller
        )
          emit("diagnostics-batch", batch, win);
      });
      diagnosticSubscriptions.set(caller, stop);
      return diagnostics.snapshot();
    }
    if (command === "diagnostics_unsubscribe") {
      z.strictObject({}).parse(args);
      diagnosticSubscriptions.get(caller)?.();
      diagnosticSubscriptions.delete(caller);
      return;
    }
    if (command === "diagnostics_clear") {
      z.strictObject({}).parse(args);
      return diagnostics.clear();
    }
    if (command === "diagnostics_export") {
      const input = z.strictObject({ filter: z.unknown().optional() }).parse(args);
      const snapshot = diagnostics.export(input.filter as DiagnosticFilter | undefined);
      const chosen = await dialog.showSaveDialog(win, {
        title: ui("导出诊断记录", "Export diagnostics"),
        defaultPath: path.join(
          app.getPath("documents"),
          `spark233-diagnostics-${new Date().toISOString().replace(/[:.]/g, "-")}.json`,
        ),
        filters: [{ name: "JSON", extensions: ["json"] }],
      });
      if (chosen.canceled || !chosen.filePath) return { exported: false };
      if (win.isDestroyed() || launcherCallers.get(win.webContents.id) !== caller)
        throw new AppError("permissionDenied", "导出窗口文档已失效");
      const destination = canonical(chosen.filePath);
      if (
        [configDir, hostConfig.value.dataDir, backupRecoveryDir, ...privateDataRoots.list()].some(
          (root) => inside(canonical(root), destination),
        )
      )
        throw new AppError("permissionDenied", "不能将诊断导出覆盖到应用私有数据目录");
      atomicWrite(destination, snapshot);
      return { exported: true };
    }
    throw new AppError("unknownCommand", "未知诊断操作");
  }
  if (command.startsWith("plugins_")) {
    if (!isAdminView(layout)) throw new AppError("permissionDenied", "插件管理仅限宿主主界面");
    if (!pluginHost)
      throw new AppError("pluginHostUnavailable", pluginHostStartupError || "插件宿主尚未就绪");
    if (notesRecoveryPending) {
      const state =
        command === "plugins_confirm_install"
          ? ((await pluginHost.handle(
              "plugins_list",
              undefined,
              win,
              launcherCaller(win),
            )) as PluginManagementState)
          : undefined;
      const replacesRetainedNotes =
        (args.pluginId === "spark233.notes" &&
          (command === "plugins_uninstall" ||
            (command === "plugins_enable" && args.enabled === false))) ||
        state?.pending.some(
          (preview) =>
            preview.previewId === args.previewId &&
            preview.metadata.spark233.id === "spark233.notes",
        );
      if (replacesRetainedNotes)
        throw new AppError(
          "pluginRecoveryRequired",
          ui(
            "请先恢复便签后台并保存保留的编辑窗口",
            "Recover notes and save the retained editors first",
          ),
        );
    }
    const result = await pluginHost.handle(command, args, win, launcherCaller(win));
    if (
      command === "plugins_list" &&
      pluginHostStartupError &&
      result &&
      typeof result === "object"
    ) {
      return { ...result, error: pluginHostStartupError };
    }
    return result;
  }
  if (command.startsWith("launcher_")) {
    if (!isHostView(layout)) throw new AppError("permissionDenied", "启动器操作仅限宿主界面");
    switch (command) {
      case "launcher_state":
        return launcher.state(launcherCaller(win));
      case "launcher_preference_update":
        return launcher.updatePreference(args, launcherCaller(win));
      case "launcher_learning_update":
        if (!isAdminView(layout))
          throw new AppError("permissionDenied", "关键词学习仅限宿主管理界面");
        return launcher.updateLearning(args, launcherCaller(win));
      case "launcher_enter_mode":
        return launcher.enterMode(args, launcherCaller(win));
      case "launcher_take_workspace": {
        const value = workspaceRequests.get(label);
        workspaceRequests.delete(label);
        return value;
      }
      case "launcher_return":
        await showLauncher();
        await hideAndRelease(win);
        return;
      case "launcher_query":
        if (args.directory !== undefined) {
          const directory = grants.assert(args.directory);
          if (!fs.statSync(directory).isDirectory())
            throw new Error("Search directory is not a directory");
          args = { ...args, directory };
        }
        return launcher.query(args, launcherCaller(win));
      case "launcher_cancel_query": {
        if (
          typeof args.sessionId !== "string" ||
          args.sessionId.length > 100 ||
          (args.requestId !== undefined &&
            (typeof args.requestId !== "string" || args.requestId.length > 100))
        )
          throw new Error("Invalid query cancellation");
        launcher.clear(launcherCaller(win), args.sessionId, args.requestId);
        return;
      }
      case "launcher_pick_directory": {
        contextPanelDialogs.add(win.id);
        try {
          const picked = await dialog.showOpenDialog(win, {
            title: ui("选择搜索目录", "Choose a search directory"),
            properties: ["openDirectory"],
          });
          if (picked.canceled || !picked.filePaths[0]) return;
          grants.grant(picked.filePaths[0], true);
          return picked.filePaths[0];
        } finally {
          contextPanelDialogs.delete(win.id);
        }
      }
      case "launcher_execute": {
        const callerId = launcherCaller(win);
        const panelExecution = contextPanelCallers.has(callerId)
          ? contextPanel?.beginExecution(callerId)
          : undefined;
        const execution = {
          callerId,
          active: true,
          panelExecution,
          query: launcher.queryIdentity(callerId),
        };
        return launcherExecutions.run(execution, async () => {
          try {
            const result = await launcher.execute(args, execution.callerId);
            if (panelExecution) {
              const object =
                result && typeof result === "object" && !Array.isArray(result) ? result : undefined;
              const success =
                result !== false &&
                object?.ok !== false &&
                object?.cancelled !== true &&
                object?.canceled !== true &&
                !["cancelled", "canceled", "closed"].includes(String(object?.status ?? ""));
              contextPanel?.endExecution(callerId, {
                executionId: panelExecution,
                success,
                keepOpen: !!object && ("launcherResults" in object || "searchPreview" in object),
              });
            }
            return result;
          } catch (error) {
            if (panelExecution)
              contextPanel?.endExecution(callerId, { executionId: panelExecution, success: false });
            throw error;
          } finally {
            execution.active = false;
          }
        });
      }
      case "launcher_complete_onboarding":
        launcher.completeOnboarding();
        return launcher.state();
      case "launcher_hide":
        launcher.clear(launcherCaller(win));
        await hideAndRelease(win);
        return;
      case "launcher_context_clear":
        if (contextPanelCallers.has(launcherCaller(win)))
          contextPanel?.clearContext(launcherCaller(win));
        else clearLauncherContext();
        return launcher.state(launcherCaller(win));
      case "launcher_context_files": {
        if (contextPanelCallers.has(launcherCaller(win)))
          throw new AppError("permissionDenied", "面板捕获不能改写通用启动器上下文");
        if (!Array.isArray(args.paths) || !args.paths.length || args.paths.length > 100)
          throw new Error("拖入文件不合法");
        const files = args.paths.map((value) => grants.assert(value));
        clearLauncherContext();
        if (files.length === 1 && IMAGE_FILE.test(files[0])) {
          if (fs.statSync(files[0]).size > 32 * 1024 * 1024) throw new Error("图片超过 32 MiB");
          const image = nativeImage.createFromPath(files[0]),
            size = image.getSize();
          if (image.isEmpty() || size.width * size.height > 100_000_000)
            throw new Error("无法读取此图片");
          const id = randomUUID(),
            filename = path.join(configDir, "launcher-resources", `${id}.png`);
          atomicWrite(filename, image.toPNG());
          const resource = { id, kind: "image" as const, mimeType: "image/png" };
          pluginImages.set(id, {
            owner: { pluginId: "spark233.host", version: app.getVersion(), instanceId: id },
            sessionId: id,
            path: filename,
            resource,
            width: size.width,
            height: size.height,
          });
          launcherContext = {
            context: { kind: "image", resource },
            label: path.basename(files[0]),
          };
        } else {
          launcherContext = {
            context: {
              kind: "files",
              resources: files.map((file) => {
                const id = randomUUID();
                pluginFiles.set(id, file);
                return { id, kind: "file" as const, size: fs.statSync(file).size };
              }),
            },
            label: ui(`${files.length} 个文件`, `${files.length} files`),
          };
        }
        return launcher.state();
      }
      default:
        throw new AppError("invalidPayload", "未知启动器命令");
    }
  }
  if (command.startsWith("applications_entries_")) {
    if (!isAdminView(layout))
      throw new AppError("permissionDenied", "Custom application settings require the host view");
    if (!pluginHost) throw new Error("Plugin host is not ready");
    if (command === "applications_entries_pick") {
      if (
        (args.purpose !== "target" && args.purpose !== "cwd") ||
        (args.directory !== undefined && typeof args.directory !== "boolean")
      )
        throw new AppError("invalidPayload", "Unknown entry selection purpose");
      const caller = launcherCaller(win);
      const picked = await dialog.showOpenDialog(win, {
        title:
          args.purpose === "cwd"
            ? ui("选择程序工作目录", "Choose the working directory")
            : args.directory
              ? ui("选择文件夹入口", "Choose a folder shortcut")
              : ui("选择文件或程序入口", "Choose a file or application"),
        properties: [args.directory || args.purpose === "cwd" ? "openDirectory" : "openFile"],
      });
      if (picked.canceled || !picked.filePaths[0]) return;
      if (win.isDestroyed() || launcherCallers.get(win.webContents.id) !== caller)
        throw new AppError("permissionDenied", "Entry selection belongs to a closed document");
      return applicationEntries.admit(
        caller,
        picked.filePaths[0],
        args.directory || args.purpose === "cwd" ? "directory" : undefined,
      );
    }
    const installation = pluginHost.manager
      .list()
      .find((plugin) => plugin.pluginId === "spark233.applications");
    if (!installation) throw new Error("Applications plugin is not installed");
    pluginHost.manager.describe("spark233.applications");
    const file = path.join(
      pluginHost.manager.dataDirectory("spark233.applications"),
      "custom-entries.json",
    );
    const identity = JSON.stringify([
      installation.packageName,
      installation.version,
      installation.integrity,
    ]);
    if (command === "applications_entries_get") return readApplicationSettings(file, identity);
    if (command === "applications_entries_save") {
      const current = readApplicationSettings(file, identity);
      if (args.revision !== current.revision)
        throw new AppError("settingsConflict", "应用入口已发生变化，请重新加载后核对");
      const entries = applicationEntries.validate(
        launcherCaller(win),
        current.entries,
        args.entries,
      );
      if (Buffer.byteLength(JSON.stringify(entries)) > 2 * 1024 * 1024)
        throw new Error("Application settings exceed size limit");
      launcher.clear();
      if (installation.status === "active")
        await pluginHost.manager.activate("spark233.applications", {
          commandId: "settings",
          parameters: { action: "save", entries: entries.map((entry) => ({ ...entry })) },
        });
      else atomicWrite(file, JSON.stringify({ version: 2, entries }));
      launcher.invalidateApplicationAvailability();
      launcher.clear();
      launcherAvailabilityRevision++;
      emit("plugins-changed");
      emit("launcher-status-changed");
      return readApplicationSettings(file, identity);
    }
    throw new AppError("invalidPayload", "Unknown custom application command");
  }
  if (command.startsWith("search_scope_")) {
    if (!isAdminView(layout))
      throw new AppError("permissionDenied", "Search scope settings require the host view");
    if (!pluginHost) throw new Error("Plugin host is not ready");
    if (command === "search_scope_pick") {
      const picked = await dialog.showOpenDialog(win, {
        title: ui("选择要排除的目录或卷", "Choose a directory or volume to exclude"),
        properties: ["openDirectory"],
      });
      return picked.canceled ? undefined : picked.filePaths[0];
    }
    if (command === "search_scope_get")
      return pluginHost.manager.activate("spark233.search", {
        commandId: "settings",
        parameters: { action: "get" },
      });
    if (command === "search_scope_save") {
      if (
        !Array.isArray(args.excludedRoots) ||
        args.excludedRoots.some((root: unknown) => typeof root !== "string")
      )
        throw new AppError("invalidPayload", "Expected excluded directory paths");
      launcher.clear();
      const result = await pluginHost.manager.activate("spark233.search", {
        commandId: "settings",
        parameters: {
          action: "save",
          excludedRoots: args.excludedRoots,
          ...(args.extensions !== undefined ? { extensions: args.extensions } : {}),
          ...(args.maxFileMiB !== undefined ? { maxFileMiB: args.maxFileMiB } : {}),
          ...(args.includeHidden !== undefined ? { includeHidden: args.includeHidden } : {}),
        },
      });
      launcher.clear();
      emit("search-scope-changed");
      return result;
    }
    throw new AppError("invalidPayload", "Unknown search scope command");
  }
  if (command.startsWith("search_service_")) {
    if (!isAdminView(layout))
      throw new AppError("permissionDenied", "Search service settings require the host view");
    if (!pluginHost) throw new Error("Plugin host is not ready");
    const actions: Record<string, string> = {
      search_service_status: "status",
      search_service_configure: "configure",
      search_service_rebuild: "rebuild",
    };
    const action = actions[command];
    if (!action) throw new AppError("invalidPayload", "Unknown search service action");
    const result = await pluginHost.manager.activate("spark233.search", {
      commandId: "service",
      parameters: {
        action,
        ...(action === "configure"
          ? { excludedRoots: args.excludedRoots, volumeEnabled: args.volumeEnabled }
          : {}),
      },
    });
    if (action !== "status") {
      launcher.clear();
      emit("search-scope-changed");
    }
    return result;
  }
  if (command.startsWith("backup_")) {
    if (!isAdminView(layout)) throw new AppError("permissionDenied", "备份恢复仅限宿主界面");
    if (!backupService) throw new Error("备份服务尚未就绪");
    if (command === "backup_create") {
      const picked = await dialog.showOpenDialog(win, {
        title: ui("选择备份保存位置", "Choose a backup destination"),
        properties: ["openDirectory", "createDirectory"],
      });
      if (picked.canceled || !picked.filePaths[0]) return;
      return backupService.create(picked.filePaths[0]);
    }
    if (command === "backup_inspect") {
      const caller = launcherCaller(win);
      const request = backupSelections.beginInspection(caller);
      const current = () =>
        !win.isDestroyed() &&
        launcherCallers.get(win.webContents.id) === caller &&
        backupSelections.isInspectionCurrent(caller, request);
      const picked = await dialog.showOpenDialog(win, {
        title: ui("选择 spark233 备份目录", "Choose a spark233 backup"),
        properties: ["openDirectory"],
      });
      if (!current()) throw new AppError("backupSelectionChanged", "备份选择已失效，请重新检查");
      if (picked.canceled || !picked.filePaths[0]) return;
      const { manifestFingerprint, ...inspection } = await backupService.inspect(
        picked.filePaths[0],
      );
      if (!current()) throw new AppError("backupSelectionChanged", "备份选择已失效，请重新检查");
      const selectionId = backupSelections.register(caller, request, {
        directory: inspection.snapshotDirectory,
        manifestFingerprint,
      });
      return { ...inspection, selectionId };
    }
    if (command === "backup_selection_release") {
      const { selectionId } = z.strictObject({ selectionId: z.string().uuid() }).parse(args);
      backupSelections.release(launcherCaller(win), selectionId);
      return;
    }
    if (command === "backup_restore") {
      const { selectionId } = z.strictObject({ selectionId: z.string().uuid() }).parse(args);
      return backupSelections.restore(launcherCaller(win), selectionId, (directory, fingerprint) =>
        backupService!.restore(directory, fingerprint),
      );
    }
    throw new Error("未知备份操作");
  }
  if (command === "text_action") {
    if (!isHostView(layout)) throw new AppError("permissionDenied", "文本动作仅限宿主工作区");
    if (!pluginHost) throw new Error("插件宿主尚未就绪");
    const content = text(args.text);
    if (!content.trim() || content.length > 1024 * 1024) throw new Error("文本为空或超过 1 MiB");
    if (args.target === "notes")
      return pluginHost.manager.activate("spark233.notes", {
        commandId: "new",
        context: { kind: "text", text: content },
      });
    if (args.target === "dictionary") {
      const result = await pluginHost.manager.activate("spark233.translation", {
        commandId: "search",
        parameters: { action: "search", query: content, limit: 20 },
      });
      await showOfficialWorkspace("translation", result);
      return;
    }
    if (args.target === "translate") {
      if (
        !pluginHost.manager
          .list()
          .some(
            (record) =>
              record.pluginId === "spark233.translation" && record.enabled && !record.lastError,
          )
      )
        throw new Error("翻译插件已停用或不可用");
      await pluginHost.manager.activate("spark233.translation", {
        commandId: "status",
        parameters: { action: "config_status" },
      });
      await showOfficialWorkspace("translation", { kind: "translate-input", text: content });
      return;
    }
    throw new Error("未知文本动作");
  }
  if (command === "translation_action" || command === "translation_configure") {
    if (!isHostView(layout)) throw new AppError("permissionDenied", "翻译设置和工作区仅限宿主界面");
    if (!pluginHost) throw new Error("插件宿主尚未就绪");
    if (command === "translation_configure")
      throw new AppError("obsoleteClient", "请在插件管理中保存翻译配置");
    if (args.action === "config_status") {
      const config = translationSettings();
      return {
        kind: "translation-config",
        configured: !!config.endpoint && !!config.model,
        endpoint: config.endpoint,
        model: config.model,
        hasKey: !!config.key,
      };
    }
    const actions: Record<string, string> = {
      search: "search",
      detail: "detail",
      translate: "translate",
      cancel: "cancel",
      config_status: "status",
    };
    const action = text(args.action);
    if (!Object.hasOwn(actions, action)) throw new Error("未知翻译操作");
    if (
      action === "cancel" &&
      officialRenderers.get("spark233.translation")?.scope.state === "preparing"
    )
      return { cancelled: true };
    const result = await pluginHost.manager.activate("spark233.translation", {
      commandId: actions[action],
      parameters: { ...args, hostWorkspace: false },
    });
    // The workspace expects the business response, not its routing envelope.
    return result &&
      typeof result === "object" &&
      !Array.isArray(result) &&
      result.workspace === "translation"
      ? result.result
      : result;
  }
  if (command === "clipboard_action") {
    if (!isHostView(layout)) throw new AppError("permissionDenied", "剪贴板工作区仅限宿主界面");
    if (!clipboardRuntime) throw new Error("剪贴板插件已停用或不可用");
    return clipboardRuntime.request(args as ClipboardRequest);
  }
  if (command === "clipboard_image_ocr") {
    if (!isHostView(layout)) throw new AppError("permissionDenied", "图片动作仅限宿主工作区");
    if (!clipboardRuntime || !pluginHost) throw new Error("剪贴板插件不可用");
    if (
      !pluginHost.manager
        .list()
        .some((record) => record.pluginId === "spark233.ocr" && record.enabled && !record.lastError)
    )
      throw new Error("请先启用 OCR 插件");
    const source = await clipboardRuntime.imageResource(text(args.id));
    const image = nativeImage.createFromPath(source.path),
      size = image.getSize();
    if (image.isEmpty() || size.width * size.height > 100_000_000)
      throw new Error("剪贴板图片尺寸不受支持");
    const id = randomUUID(),
      filename = path.join(pluginHost.manager.dataDirectory("spark233.ocr"), "images", `${id}.png`);
    atomicWrite(filename, image.toPNG());
    const resource = { id, kind: "image" as const, mimeType: "image/png" };
    pluginImages.set(id, {
      owner: clipboardRuntime.owner,
      sessionId: id,
      path: filename,
      resource,
      width: size.width,
      height: size.height,
    });
    return pluginHost.manager.activate("spark233.ocr", {
      commandId: "ocr",
      context: { kind: "image", resource },
    });
  }
  if (
    !notesActive &&
    /^(notes_|categories_|images_|reminders_|note_|open_notepad|open_tile|show_note|hide_note|toggle_tile|open_note)/.test(
      command,
    )
  )
    requireNotes();
  const data =
    preparationWrite &&
    notesScope?.state === "preparing" &&
    layout.view !== "launcher" &&
    !preparedWindows.has(win.id)
      ? (notesMaintenanceClient ?? notesClient)
      : notesClient;
  switch (command) {
    case "desktop_ready":
      ready.add(win.id);
      if (layout.hostPage === "settings" && layout.settingsTarget)
        emit("settings-navigate", layout.settingsTarget, win);
      if (pendingManagerOpen?.windowId === win.id) {
        const { payload } = pendingManagerOpen;
        pendingManagerOpen = undefined;
        emit("open-note", payload, win);
      }
      if (layout.visible && (windowPresentations.get(win)?.() ?? true)) {
        win.show();
        win.focus();
      }
      return;
    case "app_version":
      return app.getVersion();
    case "app_name":
      return "spark233";
    case "app_exec_path":
      return process.execPath;
    case "app_mcp_command":
      return {
        command: process.execPath,
        args: app.isPackaged ? ["--mcp"] : [app.getAppPath(), "--mcp"],
      };
    case "notes_list":
      return data.list();
    case "notes_get":
      return data.get(text(args.id));
    case "notes_create": {
      const note = await data.save(args.request as SaveNoteRequest);
      if ((layout.view === "notepad" || layout.view === "tile") && !layout.noteId)
        layout.noteId = note.id;
      changed();
      return note;
    }
    case "notes_set_editor_mode": {
      const note = await data.setEditorMode(text(args.id), args.mode);
      changed();
      return note;
    }
    case "notes_update": {
      const note = await data.save(args.request as SaveNoteRequest, text(args.id));
      changed();
      return note;
    }
    case "notes_delete": {
      const id = text(args.id);
      const editors = [...layouts.values()].filter(
        (entry) => entry.noteId === id && windows.has(entry.label),
      );
      if (editors.length) throw new AppError("noteInUse", "请先关闭该便签的独立窗口再删除");
      await data.delete(id);
      for (const entry of layouts.values()) if (entry.noteId === id) layouts.delete(entry.label);
      await persistLayout();
      changed();
      return;
    }
    case "categories_list":
      return data.categories();
    case "categories_create":
      await data.createCategory(text(args.name));
      changed();
      return;
    case "categories_rename":
      await data.renameCategory(text(args.oldName), text(args.newName));
      changed();
      return;
    case "categories_delete":
      await data.deleteCategory(text(args.name));
      changed();
      return;
    case "notes_move_category": {
      const meta = await data.move(text(args.id), text(args.category));
      changed();
      return meta;
    }
    case "notes_import_markdown": {
      const file = grants.assert(args.path, /\.md$/i),
        content = fs.readFileSync(file, "utf8");
      const note = await data.save({
        title:
          content.match(/^\s*# (.+)$/m)?.[1]?.trim() || path.basename(file, path.extname(file)),
        content,
        category: args.category || "",
      });
      changed();
      return note;
    }
    case "notes_export_markdown":
      atomicWrite(grants.assert(args.path, /\.md$/i), (await data.get(text(args.id))).content);
      return;
    case "read_external_file":
      return fs.readFileSync(grants.assert(args.path, TEXT_FILE), "utf8");
    case "get_file_modified_time":
      return fs.statSync(grants.assert(args.path, TEXT_FILE)).mtimeMs;
    case "save_external_file":
      atomicWrite(grants.assert(args.path, TEXT_FILE), text(args.content));
      return;
    case "images_get_base_dir":
      return hostConfig.value.dataDir;
    case "images_save":
      return data.saveImage(
        text(args.headers?.["x-note-id"]),
        args.data,
        text(args.headers?.["x-image-ext"]),
      );
    case "images_save_from_path": {
      const file = grants.assert(args.filePath, IMAGE_FILE);
      return data.saveImage(text(args.noteId), fs.readFileSync(file), path.extname(file).slice(1));
    }
    case "images_clean_unused":
      return data.cleanImages(text(args.noteId), text(args.content));
    case "copy_background_image": {
      const file = grants.assert(args.sourcePath, IMAGE_FILE);
      return data.saveBackgroundImage(fs.readFileSync(file), path.extname(file).slice(1));
    }
    case "config_get":
      return hostConfig.value;
    case "config_save":
      throw new AppError(
        "obsoleteClient",
        "设置页面或便签插件版本过旧，请重新加载页面或更新便签插件",
      );
    case "config_patch": {
      const previous = hostConfig.value;
      const parsed = configPatchSchema.safeParse(args.patch);
      if (!parsed.success) throw new AppError("invalidPayload", "设置补丁包含不支持的字段或值");
      const patch = parsed.data;
      if (args.expectedCommandShortcuts !== undefined) {
        const expected = z
          .record(z.string(), z.string().max(100))
          .parse(args.expectedCommandShortcuts);
        if (
          Object.keys(expected).length > 128 ||
          Object.entries(expected).some(
            ([key, value]) => (previous.commandShortcuts?.[key] ?? "") !== value,
          )
        )
          throw new AppError("settingsConflict", "快捷键设置已变化，请重新加载并核对");
      }
      const config = {
        ...previous,
        ...patch,
        ...(patch.commandShortcuts
          ? {
              commandShortcuts: { ...previous.commandShortcuts, ...patch.commandShortcuts },
            }
          : {}),
      };
      // Validate/write once before applying OS state, then roll back on native failure.
      if (patch.autostart && !app.isPackaged)
        throw new AppError("developmentOnly", "开机启动请在安装后的版本中设置");
      if (
        config?.backgroundImagePath &&
        config.backgroundImagePath !== previous.backgroundImagePath
      )
        await notesClient.resolveImage(config.backgroundImagePath);
      hostConfig.save(config);
      const shortcutsChanged =
        patch.globalShortcut !== undefined ||
        patch.toggleVisibilityShortcut !== undefined ||
        patch.commandShortcuts !== undefined;
      try {
        if (shortcutsChanged) registerShortcuts(config);
        if (Object.keys(patch).some((key) => key.startsWith("superPanel")))
          await contextPanel?.configure(panelConfiguration(config));
        if (config.autostart !== previous.autostart)
          app.setLoginItemSettings({ openAtLogin: config.autostart, path: process.execPath });
        if (notesActive && config.locale !== previous.locale)
          await notesClient.initialize(config.locale);
      } catch (error) {
        hostConfig.save(previous);
        if (Object.keys(patch).some((key) => key.startsWith("superPanel")))
          await contextPanel?.configure(panelConfiguration(previous)).catch(() => {});
        if (shortcutsChanged) {
          try {
            registerShortcuts(previous);
          } catch (restoreError) {
            console.error("shortcut-rollback", restoreError);
          }
        }
        throw error;
      }
      syncMcp();
      emit("config-changed", hostConfig.value);
      publishPluginTheme();
      refreshTray();
      return hostConfig.value;
    }
    case "config_migrate_data_dir": {
      const dest = grants.assert(args.newDataDir);
      return migrateNotesDirectory(dest);
    }
    case "global_shortcut_check":
      return hostShortcuts.check(text(args.shortcut));
    case "start_shortcut_recording":
      hostShortcuts.beginRecording();
      return;
    case "stop_shortcut_recording":
      hostShortcuts.endRecording(hostConfig.value);
      return;
    case "note_window_states":
      publishNoteStates();
      return noteWindowSnapshot();
    case "note_set_pinned":
      if (typeof args.pinned !== "boolean") throw new AppError("invalidPayload", "置顶参数不合法");
      await setNotePinned(text(args.noteId), args.pinned);
      return;
    case "reminders_list":
      return data.listReminders();
    case "reminders_set": {
      const taskText = args.taskText === undefined ? undefined : text(args.taskText);
      return data.setReminder({
        noteId: text(args.noteId),
        fireAt: text(args.fireAt),
        taskText,
      });
    }
    case "reminders_cancel":
      await data.cancelReminder(text(args.id));
      return;
    case "hide_note_on_desktop":
      await hideNoteOnDesktop(text(args.noteId));
      return;
    case "show_note_on_desktop":
      return openNote(text(args.noteId));
    case "open_notepad_window":
      return openNote(args.noteId ?? undefined, "notepad", args.bounds ?? undefined);
    case "open_tile_window":
      return openNote(text(args.noteId), "tile", args.bounds ?? undefined);
    case "toggle_tile_window": {
      const id = text(args.noteId),
        entry = [...layouts.values()].find(
          (item) => item.noteId === id && item.view === "tile" && item.visible,
        );
      if (entry) {
        const other = windows.get(entry.label);
        if (other) await hideAndRelease(other);
        else {
          entry.visible = false;
          await persistLayout();
        }
        return false;
      }
      await openNote(id, "tile", args.bounds ?? undefined);
      return true;
    }
    case "note_context_menu":
      if (layout.view === "main") return;
      (await paperMenu(win)).popup({ window: win });
      return;
    case "fold_note_window":
      if (layout.view !== "main") await foldAndRelease(win);
      return;
    case "recycle_notepad_window":
      await hideAndRelease(win);
      return;
    case "open_note_in_editor": {
      const id = text(args.noteId);
      await openNoteWithAnchor(id);
      return;
    }
    case "take_startup_file": {
      const file = startupFile;
      startupFile = null;
      return file;
    }
    case "surface_state": {
      if (layout.view === "main") return;
      // A final save already validated/bound this identity. Its renderer must
      // finish acknowledging the existing surface while public reads are fenced.
      if (args.noteId && layout.noteId !== args.noteId) await data.get(text(args.noteId));
      layout.noteId = args.noteId || undefined;
      layout.view = args.mode === "tile" ? "tile" : "notepad";
      scheduleLayout();
      return;
    }
    case "desktop_prepare_report": {
      const request = pending.get(text(args.requestId));
      if (request?.windowId === win.id) {
        if (args.status === "ready") preparedWindows.add(win.id);
        else preparedWindows.delete(win.id);
        request.resolve(args.status === "ready");
      }
      return;
    }
    case "update_status":
      return {
        status: "idle",
        currentVersion: app.getVersion(),
        channel: "stable",
        installKind: "unknown",
      };
    case "update_install_prepare_report":
      return; // Historical frontend API; no updater is installed.
    case "window_control": {
      switch (args.action) {
        case "show":
          if (!(windowPresentations.get(win)?.() ?? true)) return;
          win.show();
          return;
        case "focus":
          if (!(windowPresentations.get(win)?.() ?? true)) return;
          win.focus();
          return;
        case "hide":
          await hideAndRelease(win);
          return;
        case "close":
          if (
            isAdminView(layout) &&
            layout.hostPage !== "settings" &&
            !layout.compact &&
            !hostConfig.value.closeToTray
          )
            await quit();
          else if (isHostView(layout)) await hideAndRelease(win);
          else await foldAndRelease(win);
          return;
        case "minimize":
          win.minimize();
          return;
        case "toggleMaximize":
          if (win.isMaximized()) win.unmaximize();
          else win.maximize();
          return;
        case "isMaximized":
          return win.isMaximized();
        case "isAlwaysOnTop":
          return layout.topmost;
        case "alwaysOnTop":
          if (typeof args.value !== "boolean")
            throw new AppError("invalidPayload", "置顶参数不合法");
          if (layout.noteId) setNotePinned(layout.noteId, args.value);
          else {
            layout.topmost = args.value;
            applyNoteTopmost(win, layout);
            remember(win);
            publishNoteStates();
          }
          return;
        case "bounds":
          return win.getBounds();
        case "position": {
          const [x, y] = win.getPosition();
          return { x, y };
        }
        case "size": {
          const [width, height] = win.getSize();
          return { width, height };
        }
        case "setPosition":
        case "setSize":
        case "setBounds": {
          const current = win.getBounds();
          const value = args.value;
          const keys =
            args.action === "setPosition"
              ? ["x", "y"]
              : args.action === "setSize"
                ? ["width", "height"]
                : ["x", "y", "width", "height"];
          if (
            !value ||
            keys.some((key) => !Number.isFinite(value[key]) || Math.abs(value[key]) > 100000)
          )
            throw new AppError("invalidPayload", "窗口尺寸不合法");
          win.setBounds({
            ...current,
            ...Object.fromEntries(keys.map((key) => [key, Math.round(value[key])])),
          });
          remember(win);
          return;
        }
      }
      throw new AppError("invalidCommand", "不支持的窗口操作");
    }
    case "dialog_open": {
      const selected = await dialog.showOpenDialog(win, {
        title: args.title,
        defaultPath: args.defaultPath,
        properties: [
          args.directory ? "openDirectory" : "openFile",
          ...(args.multiple ? ["multiSelections" as const] : []),
        ],
        filters: args.filters,
      });
      if (selected.canceled) return null;
      for (const file of selected.filePaths) grants.grant(file, !!args.directory);
      return args.multiple ? selected.filePaths : (selected.filePaths[0] ?? null);
    }
    case "dialog_save": {
      const selected = await dialog.showSaveDialog(win, {
        defaultPath: args.defaultPath,
        filters: args.filters,
      });
      if (selected.canceled || !selected.filePath) return null;
      grants.grant(selected.filePath);
      return selected.filePath;
    }
    case "dialog_message":
      await dialog.showMessageBox(win, {
        message: text(args.text),
        title: args.title || "spark233",
        type: args.kind === "error" ? "error" : "info",
      });
      return;
    case "shell_open":
      await shell.openExternal(externalUrl(args.url));
      return;
    case "clipboard_read":
      return clipboard.readText();
    case "clipboard_write":
      clipboard.writeText(text(args.text));
      return;
    default:
      throw new AppError("invalidCommand", `Electron 不支持此操作: ${command}`);
  }
}
function setupIpc(): void {
  ipcMain.handle("spark233:invoke", async (event, command: unknown, args: unknown) => {
    try {
      const win = sender(event);
      if (
        typeof command !== "string" ||
        command.length > 100 ||
        (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args)))
      )
        throw new AppError("invalidPayload", "IPC 参数不合法");
      const run = async () => {
        const modal =
          /^(dialog_|applications_entries_pick|search_scope_pick|launcher_pick_directory|plugins_import|backup_create|backup_inspect)/.test(
            command,
          );
        if (modal) nativeDialogDepth.set(win.id, (nativeDialogDepth.get(win.id) ?? 0) + 1);
        try {
          return await handle(win, command, (args ?? {}) as Record<string, any>);
        } finally {
          if (modal) {
            const count = (nativeDialogDepth.get(win.id) ?? 1) - 1;
            if (count) nativeDialogDepth.set(win.id, count);
            else nativeDialogDepth.delete(win.id);
          }
        }
      };
      // Disk writes and read/modify/write metadata transactions are globally serialized.
      const queued =
        command !== "config_migrate_data_dir" &&
        /^(notes_|categories_|images_|reminders_|config_|plugin_settings_save|copy_background|save_external)/.test(
          command,
        );
      const value = queued ? await (mutations = mutations.catch(() => {}).then(run)) : await run();
      return { ok: true, value };
    } catch (error) {
      return {
        ok: false,
        error: {
          code: error instanceof AppError ? error.code : "io",
          message: error instanceof Error ? error.message : String(error),
          details: error instanceof AppError ? error.details : {},
        },
      };
    }
  });
  ipcMain.handle("spark233:emit", (event, name, payload) => {
    sender(event);
    if (name === "config-changed") {
      emit("config-changed", hostConfig.value);
      return;
    }
    if (!["tile-window-unpinned"].includes(name) || typeof payload !== "string")
      throw new AppError("permissionDenied", "不允许发布此事件");
    emit(name, payload);
  });
  ipcMain.handle("spark233:drop", (event, paths: unknown) => {
    const win = sender(event),
      allowAnyFile = layouts.get(labelOf(win))?.view === "launcher";
    if (
      !Array.isArray(paths) ||
      paths.length > 100 ||
      paths.some(
        (p) =>
          typeof p !== "string" ||
          !path.isAbsolute(p) ||
          !(allowAnyFile || TEXT_FILE.test(p) || IMAGE_FILE.test(p)) ||
          !fs.statSync(p).isFile(),
      )
    )
      throw new AppError("permissionDenied", "拖入文件不合法");
    for (const file of paths) grants.grant(file);
    return paths;
  });
  ipcMain.handle("spark233:application-drop", (event, paths: unknown) => {
    const win = sender(event);
    if (!isAdminView(layouts.get(labelOf(win))!))
      throw new AppError("permissionDenied", "Entry drops require the host management view");
    if (
      !Array.isArray(paths) ||
      paths.length > 100 ||
      paths.some((value) => typeof value !== "string")
    )
      throw new AppError("permissionDenied", "Invalid dropped entry targets");
    const caller = launcherCaller(win);
    return paths.map((location) => applicationEntries.admit(caller, location));
  });
}
app.on("second-instance", (_event, argv) => {
  startupFile = externalArg(argv);
  const command = parseCliArgs(argv).command;
  if (!pluginHost || !tray) {
    if (command) pendingCliCommand = command;
    return;
  }
  if (command) executeCliCommand(command);
  if (startupFile) {
    const main = showMain();
    if (startupFile && ready.has(main.id)) {
      emit("open-external-file", startupFile, main);
      startupFile = null;
    }
  } else if (!command || command === "show") requestLauncher();
});
function externalArg(args: string[]): string | null {
  const file = args.find(
    (arg) =>
      !arg.startsWith("-") && path.isAbsolute(arg) && TEXT_FILE.test(arg) && fs.existsSync(arg),
  );
  if (file) grants.grant(file);
  return file ?? null;
}
app.on("window-all-closed", () => {}); // The tray owns application lifetime.
app.on("before-quit", (event) => {
  if (!exiting) {
    event.preventDefault();
    void quit();
  }
});
app.on("will-quit", () => {
  hostShortcuts.dispose();
  stopFullscreen();
  capsules?.dispose();
  mcpServer?.stop();
  tray?.dispose();
});
app
  .whenReady()
  .then(async () => {
    if (cliArgs.mcp) return; // --mcp 进程的正常启动路径已被启动器接管
    try {
      diagnostics = new DiagnosticsStore(path.join(configDir, "diagnostics"));
      diagnostics.record({ kind: "host", code: "started", level: "info" });
    } catch {
      console.error("diagnostics-unavailable");
    }
    const defaultNotesRoot =
      process.env.SPARK233_DATA_DIR || path.join(app.getPath("documents"), "spark233");
    hostConfig = new HostConfigStore(
      hostConfigDir,
      readPendingBackupDataRoots({
        hostRoot: hostConfigDir,
        pluginRoot: path.join(configDir, "plugins"),
        recoveryRoot: backupRecoveryDir,
        defaultDataRoots: { "spark233.notes": defaultNotesRoot },
        legacyMountAliases: { notes: "spark233.notes" },
        readHostDataRoots: (directory): Record<string, string> => {
          const file = path.join(directory, "config.json");
          if (!fs.existsSync(file)) return {};
          const info = fs.lstatSync(file);
          if (info.isSymbolicLink() || !info.isFile() || info.size > 1024 * 1024)
            throw new AppError("unsafeBackupPath", "恢复宿主配置文件不合法");
          const config = JSON.parse(fs.readFileSync(file, "utf8"));
          if (config?.dataDir === undefined) return {};
          if (typeof config.dataDir !== "string" || !path.isAbsolute(config.dataDir))
            throw new AppError("invalidBackup", "恢复宿主配置的数据位置不合法");
          return { "spark233.notes": config.dataDir };
        },
      })?.["spark233.notes"] || defaultNotesRoot,
    );
    privateDataRoots = new HostPrivateDataRootsStore(
      path.join(configDir, "private-data-roots.json"),
      [configDir, backupRecoveryDir, hostConfig.value.dataDir],
    );
    launcher = new LauncherController({
      commandMatcher,
      getWarnings: () => (shortcutWarning ? [shortcutWarning] : []),
      stateFile: path.join(hostConfigDir, "launcher.json"),
      manager: () => pluginHost?.manager,
      onQueryUpdate: deliverLauncherQueryUpdate,
      onPreferencesChanged: () => emit("launcher-status-changed"),
      onLearningChanged: (learning) => emit("launcher-learning-changed", learning),
      getContext: contextForCaller,
      adaptContext: contextForCommand,
      getContextRevision: contextRevisionForCaller,
      getAvailabilityRevision: () => launcherAvailabilityRevision,
      getLocale: () => hostConfig.value.locale,
    });
    capsules = new Capsules({
      here,
      url: devUrl || "spark233://notes/index.html",
      entries: layouts,
      notes: () => notesStartupClient ?? notesClient,
      getConfig: () => hostConfig.value,
      dataRoot: () => hostConfig.value.dataDir,
      save: persistLayout,
      open: async (id) => {
        await openNote(id);
      },
      hide: async (id) => {
        try {
          await hideNoteOnDesktop(id);
        } catch (error) {
          const entry = [...layouts.values()].find((e) => e.noteId === id);
          reportError(error, entry ? windows.get(entry.label) : undefined);
          throw error;
        }
      },
      changed: () => {
        refreshTray();
        publishNoteStates();
      },
      globalMenu,
      onRendererCrash: (error) => {
        if (notesScope)
          void pluginHost?.manager.reportCrash(notesScope.owner, error).catch(console.error);
      },
    });
    // No note resources or metadata refreshes belong to a running plugin yet.
    capsules.setEnabled(false);
    mcpServer = new McpServer({
      configDir: () => configDir,
      context: () => ({ permission: hostConfig.value.mcpPermission, ops: mcpOps }),
      onLog: (message, error) => (error ? console.error(message, error) : console.log(message)),
    });
    stopFullscreen = watchFullscreen(
      here,
      configDir,
      (rects) => {
        fullscreenRects = rects;
        capsules.setFullscreen(rects);
        for (const [label, win] of windows) {
          const layout = layouts.get(label);
          if (!layout || win.isDestroyed()) continue;
          applyNoteTopmost(win, layout);
        }
      },
      () => [...windows.values(), ...[...capsules.surfaces.values()].map((s) => s.win)],
    );
    startupFile = externalArg(process.argv.slice(1));
    protocol.handle("spark233", async (request) => {
      try {
        const url = new URL(request.url);
        let file: string;
        if (url.host === "app")
          file = confined(rendererRoot, decodeURIComponent(url.pathname.slice(1)) || "index.html");
        else if (url.host === "notes" && notesActive && notesRendererRoot)
          file = confined(
            notesRendererRoot,
            decodeURIComponent(url.pathname.slice(1)) || "index.html",
          );
        else if (url.host === "workspace") {
          const segments = url.pathname.slice(1).split("/"),
            pluginId = decodeURIComponent(segments.shift() ?? "");
          const renderer = officialRenderers.get(pluginId);
          if (!renderer || !renderer.scope.accepts(renderer.scope.owner))
            return new Response("Workspace is unavailable", { status: 404 });
          file = confined(
            renderer.directory,
            decodeURIComponent(segments.join("/")) || "index.html",
          );
        } else if (url.host === "shared") {
          const fonts: Record<string, { prefix: string; extension: string }> = {
            "/ui/v1/HarmonyOS_Sans_SC.ttf": { prefix: "HarmonyOS_Sans_SC-", extension: ".ttf" },
            "/ui/v1/SourceHanSerifSC-Regular.woff2": {
              prefix: "SourceHanSerifSC-Regular-",
              extension: ".woff2",
            },
          };
          const font = fonts[url.pathname];
          if (!font) return new Response("Not found", { status: 404 });
          const directory = confined(rendererRoot, "assets"),
            entry = fs
              .readdirSync(directory)
              .find((name) => name.startsWith(font.prefix) && name.endsWith(font.extension));
          if (!entry) return new Response("Font is unavailable", { status: 404 });
          file = confined(directory, entry);
        } else if (url.host === "resource") {
          const resource = pluginImages.get(decodeURIComponent(url.pathname.slice(1)));
          if (!resource) return new Response("Resource expired", { status: 404 });
          file = resource.path;
        } else if (url.host === "asset")
          file = await notesClient.resolveImage(decodeURIComponent(url.pathname.slice(1)));
        else return new Response("Not found", { status: 404 });
        const result = await net.fetch(pathToFileURL(file).href);
        const headers = new Headers(result.headers);
        headers.set(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' spark233://asset spark233://resource data: blob: https:; font-src 'self' spark233://shared data:; connect-src 'self' spark233://asset spark233://resource; object-src 'none'; frame-src 'none'; base-uri 'none'",
        );
        headers.set("X-Content-Type-Options", "nosniff");
        const origin = request.headers.get("Origin");
        headers.set(
          "Access-Control-Allow-Origin",
          origin &&
            ["spark233://app", "spark233://notes", "spark233://workspace", devUrl].includes(origin)
            ? origin
            : devUrl || url.origin,
        );
        headers.set("Vary", "Origin");
        return new Response(result.body, { status: result.status, headers });
      } catch {
        return new Response("Forbidden", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": devUrl || "spark233://app" },
        });
      }
    });
    session.defaultSession.setPermissionRequestHandler((_contents, permission, callback) =>
      callback(permission === "clipboard-sanitized-write"),
    );
    session.defaultSession.setPermissionCheckHandler(
      (_contents, permission) => permission === "clipboard-sanitized-write",
    );
    setupIpc();
    try {
      pluginHost = new DesktopPluginHost({
        root: path.join(configDir, "plugins"),
        bundledRoot: app.isPackaged
          ? path.join(process.resourcesPath, "plugins")
          : path.resolve(here, "../../../../dist-plugins"),
        createOfficialRuntime,
        resolveDataDirectory: (id) =>
          id === "spark233.notes" ? hostConfig.value.dataDir : undefined,
        onBackendHostCall: async (call, { owner, signal }) => {
          if (signal.aborted || owner.pluginId !== "spark233.notes" || !notesScope?.accepts(owner))
            throw new AppError("permissionDenied", "便签平台操作不属于当前运行实例");
          if (call.operation === "file.trash") await shell.trashItem(call.path);
          else if (call.operation === "storage.protectRoot") {
            const parent = pendingNotesMigration?.directory;
            const target = canonical(call.path);
            const source = canonical(hostConfig.value.dataDir);
            const host = canonical(configDir);
            const recovery = canonical(backupRecoveryDir);
            if (
              !parent ||
              !inside(canonical(parent), target) ||
              [source, host, recovery].some((root) => inside(root, target) || inside(target, root))
            )
              throw new AppError("permissionDenied", "迁移数据域不属于本次已授权的目标位置");
            await privateDataRoots.retain([source, target]);
            signal.throwIfAborted();
          }
        },
        onPluginEvent: (owner, name, payload) => {
          if (owner.pluginId === "spark233.translation" && name === "translation-chunk")
            emit(name, payload);
          if (owner.pluginId === "spark233.notes" && notesScope?.accepts(owner)) {
            if (name === "notes-data-changed") changed();
            else if (name === "reminders-changed") emit(name, payload);
            else if (name === "notes-reminder-due" && payload)
              fireReminderNotification(payload as unknown as ReminderNotification);
          }
        },
        resolveResource: (resource) =>
          pluginImages.get(resource.id)?.path ?? pluginFiles.get(resource.id),
        subscribeResourceRevocations: (listener) => {
          resourceRevocations.add(listener);
          return () => {
            resourceRevocations.delete(listener);
          };
        },
        hostVersion: app.getVersion(),
        getTheme: getPluginTheme,
        getLocale: () => hostConfig.value.locale,
        subscribeTheme: (listener) => {
          pluginThemeListeners.add(listener);
          return () => {
            pluginThemeListeners.delete(listener);
          };
        },
        onDiagnostic: (event) => {
          diagnostics?.record(event);
        },
        onDiagnosticOutput: (owner, stream, byteCount, kind) => {
          diagnostics?.output(owner, stream, byteCount, kind);
        },
        onPackageTaskChanged: (caller, task) => {
          for (const win of windows.values())
            if (
              !win.isDestroyed() &&
              !win.webContents.isDestroyed() &&
              launcherCallers.get(win.webContents.id) === caller
            )
              emit("plugin-package-task-changed", task, win);
        },
        onChange: () => {
          launcher?.pluginsChanged();
          emit("plugins-changed");
          refreshTray();
          if (pluginHost && !maintenance && !hostShortcuts.isRecording)
            try {
              registerShortcuts(hostConfig.value);
            } catch (error) {
              console.error("plugin-shortcut-registration", error);
            }
        },
      });
      backupService = new PluginBackupService({
        manager: pluginHost.manager,
        hostVersion: app.getVersion(),
        hostRoot: hostConfigDir,
        pluginRoot: path.join(configDir, "plugins"),
        externalDataRoots: () => ({ "spark233.notes": hostConfig.value.dataDir }),
        legacyMountAliases: { notes: "spark233.notes" },
        protectRoots: (roots) => privateDataRoots.retain(roots),
        rewriteHostConfig: (value, roots) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            throw new AppError("invalidBackup", "恢复宿主配置格式不合法");
          return { ...value, dataDir: roots["spark233.notes"] };
        },
        recoveryRoot: backupRecoveryDir,
        pauseHost: pauseForBackup,
        reloadHost: reloadHostAfterRestore,
      });
      try {
        await backupService.recoverInterrupted();
      } catch (error) {
        throw new AppError(
          "backupRecoveryRequired",
          `备份恢复尚未完成，已保留数据：${String(error)}`,
        );
      }
      await pluginHost.initialize();
    } catch (error) {
      if (error instanceof AppError && error.code === "backupRecoveryRequired") throw error;
      pluginHostStartupError = String(error);
      console.error("plugin-host-initialization", error);
    }
    initializeContextPanel();
    notesActive = !!pluginHost?.manager
      .list()
      .find(
        (record) => record.pluginId === "spark233.notes" && record.enabled && !record.lastError,
      );
    capsules.setEnabled(notesActive);
    tray = new TrayController({
      icon: path.join(here, "assets", process.platform === "win32" ? "icon.ico" : "32x32.png"),
      title: "spark233",
      getMenu: globalMenu,
      onClick: requestLauncher,
      onBalloonClick: () => {
        const item = lastBalloonReminder;
        lastBalloonReminder = undefined;
        if (item) void openNoteWithAnchor(item.noteId, item.taskText).catch(reportError);
      },
    });
    if (launcher.state().firstRun) await showLauncher();
    if (startupFile && notesActive) showMain();
    try {
      registerShortcuts(hostConfig.value);
    } catch (error) {
      console.error("shortcut-registration", error);
    }
    syncMcp();
    refreshTray();
    publishNoteStates();
    const initialCommand = pendingCliCommand ?? cliArgs.command;
    pendingCliCommand = undefined;
    if (initialCommand) executeCliCommand(initialCommand);
    if (smokeOutput) {
      const { runSmoke } = await import("./smoke.js");
      await runSmoke({
        output: smokeOutput,
        fullscreenRects: () => fullscreenRects,
        gpuDiagnostics: () => ({
          crashCount: gpuCrashCount,
          features: app.getGPUFeatureStatus(),
          startedFromUnc: startupWorkingDirectory.startsWith("\\\\"),
          workingDirectoryIsLocal: !process.cwd().startsWith("\\\\"),
          sandboxEnabled:
            !app.commandLine.hasSwitch("no-sandbox") &&
            !app.commandLine.hasSwitch("disable-gpu-sandbox"),
        }),
        notes: notesClient,
        config: () => hostConfig.value,
        configDir,
        dataDir: () => hostConfig.value.dataDir,
        windows,
        layouts,
        openNote,
        showMain,
        showLauncher,
        pauseForBackup,
        hideAndRelease,
        foldAndRelease,
        capsules,
        emit,
        quit: () => {
          void quit();
        },
      });
    }
  })
  .catch((error) => {
    reportError(error);
    app.exit(1);
  });

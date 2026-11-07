import { BackupScheduler } from "./backup-scheduler.js";
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  net,
  protocol,
  powerMonitor,
  screen,
  safeStorage,
  session,
  shell,
} from "electron";
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ApplicationEntryAdmissions } from "./application-entries.js";
import { BackupSelections } from "./backup-selections.js";
import { diagnosticErrorCode, DiagnosticsStore } from "./diagnostics.js";
import { createBackupRuntime } from "./host/backup-runtime.js";
import { createContextRuntime } from "./host/context-runtime.js";
import { createDesktopWindows } from "./host/desktop-windows.js";
import { createLauncherRuntime } from "./host/launcher-runtime.js";
import { createMcpOperations } from "./host/mcp-runtime.js";
import { createMenus } from "./host/menus.js";
import { createNoteSurfaces } from "./host/note-surfaces.js";
import { createOfficialRuntimeFactory } from "./host/official-runtimes.js";
import { createPluginSettings } from "./host/plugin-settings.js";
import { createSurfaceCommands } from "./host/surface-commands.js";
import { acquireDesktopInstance } from "./host/single-instance.js";
import { createWindowClose } from "./host/window-close.js";
import { createDispatch } from "./ipc/dispatch.js";
import { createTransport } from "./ipc/transport.js";
import { AppError, canonical, confined, inside } from "./persistence.js";
import { PluginBackupService, readPendingBackupDataRoots } from "./plugins/backup.js";
import type { PluginResourceScope } from "./plugins/resources.js";
import { readTranslationSettings } from "./plugins/translation-settings.js";
import { FileGrants } from "./security.js";

import type { PluginContext, PluginOwner, PluginTheme } from "@spark233/sdk";
import type { CapsuleEntry } from "../src/features/capsules/types.js";
import type { ReminderItem } from "../src/features/reminders/types.js";
import { Capsules } from "./capsules.js";
import { DesktopLayer } from "./desktop-layer.js";
import { DesktopOverlayLayout } from "./desktop-overlay-layout.js";
import { bindDevToolsShortcut } from "./host/windows.js";
import { LayerWindow } from "./layer-window.js";
import { LayerLayoutStore } from "./layer-layout-store.js";
import { ScreenshotLayerCoordinator } from "./screenshot-layer.js";
import { DEFAULT_DESKTOP_LAYER_PREFERENCES } from "../shared/config-schema.js";
import { NotesLayerCoordinator, parseNotesLayout } from "./notes-layer.js";
import { WidgetHost, widgetScheme } from "./plugins/widget-host.js";
import { UToolsDesktopHost } from "./plugins/utools-desktop.js";
import { PluginWindowDesktopHost, WindowModeController } from "./plugins/window-desktop.js";
import { parseCliArgs, type CliCommand } from "./cli-args.js";
import { HostConfigStore, persistedConfigSchema } from "./host-config.js";
import { ShortcutManager } from "./host/shortcuts.js";
import { HostLifecycle } from "./host/lifecycle.js";
import { ShutdownCoordinator } from "./host/shutdown.js";
import { createUpdateService, type UpdateService } from "./update/service.js";
import { TrayController } from "./host/tray.js";
import { createCommandPinyinMatcher } from "./launcher-command-matcher.js";
import { LauncherController } from "./launcher.js";
import { runMcpLauncher } from "./mcp-launcher.js";
import type { McpOps } from "./mcp-protocol.js";
import { McpServer } from "./mcp-server.js";
import { DesktopPluginHost, type DesktopPluginHostOptions } from "./plugins/desktop-host.js";
import { type CaptureImage } from "./plugins/official/capture.js";
import { type ClipboardRuntime } from "./plugins/official/clipboard.js";
import { NotesDataClient } from "./plugins/official/notes-data-client.js";
import { registerPluginProtocolScheme } from "./plugins/web-host.js";
import { HostPrivateDataRootsStore } from "./private-data-roots.js";
import type { ReminderNotification } from "./reminders.js";
import { initializeWindowsRuntime, watchFullscreen } from "./windows-runtime.js";

export interface RuntimeContext {
  readonly desktopLayer: typeof desktopLayer;
  readonly utoolsDesktop: typeof utoolsDesktop;
  readonly windowDesktop: typeof windowDesktop;
  readonly toggleDesktopOverlay: typeof toggleDesktopOverlay;
  readonly widgetHost: typeof widgetHost;
  readonly notesLayer: typeof notesLayer;
  readonly screenshotLayer: typeof screenshotLayer;
  readonly notesMigrationError: typeof notesMigrationError;
  readonly syncDesktopLayer: typeof syncDesktopLayer;
  readonly flushDesktopLayer: typeof flushDesktopLayer;
  readonly reloadDesktopLayer: typeof reloadDesktopLayer;
  readonly activateHostCommand: typeof activateHostCommand;
  readonly applicationEntries: typeof applicationEntries;
  readonly applyNoteTopmost: typeof applyNoteTopmost;
  readonly backupRecoveryDir: typeof backupRecoveryDir;
  backupRecoveryPending: typeof backupRecoveryPending;
  readonly backupSelections: typeof backupSelections;
  readonly backupScheduler: typeof backupScheduler;
  backupService: typeof backupService;
  capsules: typeof capsules;
  readonly changed: typeof changed;
  readonly clearLauncherContext: typeof clearLauncherContext;
  clipboardRuntime: typeof clipboardRuntime;
  readonly commandMatcher: typeof commandMatcher;
  readonly configDir: typeof configDir;
  readonly contextForCaller: typeof contextForCaller;
  readonly launcherDialogs: typeof launcherDialogs;
  readonly contextRevisionForCaller: typeof contextRevisionForCaller;
  readonly crashedWindows: typeof crashedWindows;
  readonly createWindow: typeof createWindow;
  readonly refreshWindowPresentations: typeof refreshWindowPresentations;
  readonly flushPluginWindowStates: typeof flushPluginWindowStates;
  readonly getPluginIcon: typeof getPluginIcon;
  readonly getPluginTheme: typeof getPluginTheme;
  readonly subscribePluginTheme: typeof subscribePluginTheme;
  readonly queuePluginWindowActivation: typeof queuePluginWindowActivation;
  readonly takePluginWindowActivation: typeof takePluginWindowActivation;
  readonly pluginWindowInfo: typeof pluginWindowInfo;
  readonly openPluginWindow: typeof openPluginWindow;
  readonly deliverLauncherQueryUpdate: typeof deliverLauncherQueryUpdate;
  readonly devUrl: typeof devUrl;
  diagnostics: typeof diagnostics;
  readonly diagnosticSubscriptions: typeof diagnosticSubscriptions;
  readonly emit: typeof emit;
  readonly endLauncherExecutionQuery: typeof endLauncherExecutionQuery;
  exiting: typeof exiting;
  readonly fileGrants: typeof fileGrants;
  readonly foldAndRelease: typeof foldAndRelease;
  fullscreenRects: typeof fullscreenRects;
  readonly grantsFor: typeof grantsFor;
  readonly handle: typeof handle;
  readonly here: typeof here;
  readonly hideAndRelease: typeof hideAndRelease;
  readonly hideHostWindow: typeof hideHostWindow;
  readonly hideNoteOnDesktop: typeof hideNoteOnDesktop;
  hostConfig: typeof hostConfig;
  readonly hostConfigDir: typeof hostConfigDir;
  readonly hostShortcuts: typeof hostShortcuts;
  readonly hostShutdown: typeof hostShutdown;
  readonly lifecycle: typeof lifecycle;
  readonly IMAGE_FILE: typeof IMAGE_FILE;
  readonly isAdminView: typeof isAdminView;
  readonly isHostView: typeof isHostView;
  readonly labelOf: typeof labelOf;
  lastBalloonReminder: typeof lastBalloonReminder;
  launcher: typeof launcher;
  launcherAvailabilityRevision: typeof launcherAvailabilityRevision;
  readonly launcherCaller: typeof launcherCaller;
  readonly launcherCallers: typeof launcherCallers;
  readonly launcherComposition: typeof launcherComposition;
  launcherContext: typeof launcherContext;
  launcherContextRevision: typeof launcherContextRevision;
  readonly launcherExecutions: typeof launcherExecutions;
  readonly launcherHides: typeof launcherHides;
  readonly launcherPresentationGuard: typeof launcherPresentationGuard;
  launcherShow: typeof launcherShow;
  readonly layouts: typeof layouts;
  layoutsRestored: typeof layoutsRestored;
  layoutTimer: typeof layoutTimer;
  maintenance: typeof maintenance;
  mcpServer: typeof mcpServer;
  readonly migrateNotesDirectory: typeof migrateNotesDirectory;
  mutations: typeof mutations;
  readonly nativeDialogDepth: typeof nativeDialogDepth;
  notesActive: typeof notesActive;
  readonly notesClient: typeof notesClient;
  notesMaintenanceClient: typeof notesMaintenanceClient;
  notesRecoveryPending: typeof notesRecoveryPending;
  notesScope: typeof notesScope;
  noteStateFingerprint: typeof noteStateFingerprint;
  noteStateVersion: typeof noteStateVersion;
  readonly noteWindowSnapshot: typeof noteWindowSnapshot;
  readonly officialRenderers: typeof officialRenderers;
  readonly officialWindows: typeof officialWindows;
  readonly openHostSettings: typeof openHostSettings;
  readonly openNote: typeof openNote;
  readonly openNoteWithAnchor: typeof openNoteWithAnchor;
  readonly paperMenu: typeof paperMenu;
  readonly pending: typeof pending;
  pendingManagerOpen: typeof pendingManagerOpen;
  pendingNotesMigration: typeof pendingNotesMigration;
  readonly persistLayout: typeof persistLayout;
  readonly pluginFiles: typeof pluginFiles;
  pluginHost: typeof pluginHost;
  pluginHostStartupError: typeof pluginHostStartupError;
  readonly pluginImages: typeof pluginImages;
  readonly pluginSettings: typeof pluginSettings;
  readonly prepare: typeof prepare;
  readonly preparedWindows: typeof preparedWindows;
  privateDataRoots: typeof privateDataRoots;
  readonly publishNoteStates: typeof publishNoteStates;
  readonly publishPluginTheme: typeof publishPluginTheme;
  readonly quit: typeof quit;
  readonly ready: typeof ready;
  readonly refreshTray: typeof refreshTray;
  readonly registerShortcuts: typeof registerShortcuts;
  readonly releasing: typeof releasing;
  readonly remember: typeof remember;
  readonly reportError: typeof reportError;
  readonly requestLauncher: typeof requestLauncher;
  readonly requireNotes: typeof requireNotes;
  readonly resourceRevocations: typeof resourceRevocations;
  readonly revokeLauncherCaller: typeof revokeLauncherCaller;
  readonly safeBounds: typeof safeBounds;
  readonly scheduleLayout: typeof scheduleLayout;
  readonly setMaintenance: typeof setMaintenance;
  readonly setNotePinned: typeof setNotePinned;
  settingsCaller: typeof settingsCaller;
  shortcutWarning: typeof shortcutWarning;
  readonly showLauncherWithSelection: typeof showLauncherWithSelection;
  readonly prepareSelectionReader: typeof prepareSelectionReader;
  readonly cancelSelection: typeof cancelSelection;
  readonly stopSelectionReader: typeof stopSelectionReader;
  readonly showLauncher: typeof showLauncher;
  readonly openLauncherWindow: typeof openLauncherWindow;
  readonly showMain: typeof showMain;
  startupFile: typeof startupFile;
  readonly syncMcp: typeof syncMcp;
  readonly TEXT_FILE: typeof TEXT_FILE;
  readonly translationSettings: typeof translationSettings;
  tray: typeof tray;
  readonly updateService: typeof updateService;
  readonly ui: typeof ui;
  readonly windowPresentations: typeof windowPresentations;
  readonly windowModes: typeof windowModes;
  readonly windows: typeof windows;
  readonly workspaceRequests: typeof workspaceRequests;
  readonly enqueueMutation: typeof enqueueMutation;
  notesRendererRoot: typeof notesRendererRoot;
  notesStartupClient: typeof notesStartupClient;
  readonly restoreNotesLayout: typeof restoreNotesLayout;
  readonly bindOfficialRenderer: typeof bindOfficialRenderer;
  readonly toMcpNote: typeof toMcpNote;
  readonly translationSettingsFile: typeof translationSettingsFile;
}
const runtimeContext: RuntimeContext = {
  get activateHostCommand(): typeof activateHostCommand {
    return activateHostCommand;
  },
  get applicationEntries(): typeof applicationEntries {
    return applicationEntries;
  },
  get applyNoteTopmost(): typeof applyNoteTopmost {
    return applyNoteTopmost;
  },
  get backupRecoveryDir(): typeof backupRecoveryDir {
    return backupRecoveryDir;
  },
  get backupRecoveryPending(): typeof backupRecoveryPending {
    return backupRecoveryPending;
  },
  set backupRecoveryPending(value: typeof backupRecoveryPending) {
    backupRecoveryPending = value;
  },
  get backupSelections(): typeof backupSelections {
    return backupSelections;
  },
  get backupScheduler(): typeof backupScheduler {
    return backupScheduler;
  },
  get backupService(): typeof backupService {
    return backupService;
  },
  set backupService(value: typeof backupService) {
    backupService = value;
  },
  get capsules(): typeof capsules {
    return capsules;
  },
  set capsules(value: typeof capsules) {
    capsules = value;
  },
  get changed(): typeof changed {
    return changed;
  },
  get desktopLayer(): typeof desktopLayer {
    return desktopLayer;
  },
  get utoolsDesktop(): typeof utoolsDesktop {
    return utoolsDesktop;
  },
  get windowDesktop(): typeof windowDesktop {
    return windowDesktop;
  },
  get toggleDesktopOverlay(): typeof toggleDesktopOverlay {
    return toggleDesktopOverlay;
  },
  get widgetHost(): typeof widgetHost {
    return widgetHost;
  },
  get notesLayer(): typeof notesLayer {
    return notesLayer;
  },
  get screenshotLayer(): typeof screenshotLayer {
    return screenshotLayer;
  },
  get notesMigrationError(): typeof notesMigrationError {
    return notesMigrationError;
  },
  get syncDesktopLayer(): typeof syncDesktopLayer {
    return syncDesktopLayer;
  },
  get flushDesktopLayer(): typeof flushDesktopLayer {
    return flushDesktopLayer;
  },
  get reloadDesktopLayer(): typeof reloadDesktopLayer {
    return reloadDesktopLayer;
  },
  get clearLauncherContext(): typeof clearLauncherContext {
    return clearLauncherContext;
  },
  get clipboardRuntime(): typeof clipboardRuntime {
    return clipboardRuntime;
  },
  set clipboardRuntime(value: typeof clipboardRuntime) {
    clipboardRuntime = value;
  },
  get commandMatcher(): typeof commandMatcher {
    return commandMatcher;
  },
  get configDir(): typeof configDir {
    return configDir;
  },
  get contextForCaller(): typeof contextForCaller {
    return contextForCaller;
  },
  get launcherDialogs(): typeof launcherDialogs {
    return launcherDialogs;
  },
  get contextRevisionForCaller(): typeof contextRevisionForCaller {
    return contextRevisionForCaller;
  },
  get crashedWindows(): typeof crashedWindows {
    return crashedWindows;
  },
  get createWindow(): typeof createWindow {
    return createWindow;
  },
  get refreshWindowPresentations(): typeof refreshWindowPresentations {
    return refreshWindowPresentations;
  },
  get flushPluginWindowStates(): typeof flushPluginWindowStates {
    return flushPluginWindowStates;
  },
  get getPluginIcon(): typeof getPluginIcon {
    return getPluginIcon;
  },
  get getPluginTheme(): typeof getPluginTheme {
    return getPluginTheme;
  },
  get subscribePluginTheme(): typeof subscribePluginTheme {
    return subscribePluginTheme;
  },
  get queuePluginWindowActivation(): typeof queuePluginWindowActivation {
    return queuePluginWindowActivation;
  },
  get takePluginWindowActivation(): typeof takePluginWindowActivation {
    return takePluginWindowActivation;
  },
  get pluginWindowInfo(): typeof pluginWindowInfo {
    return pluginWindowInfo;
  },
  get openPluginWindow(): typeof openPluginWindow {
    return openPluginWindow;
  },
  get deliverLauncherQueryUpdate(): typeof deliverLauncherQueryUpdate {
    return deliverLauncherQueryUpdate;
  },
  get devUrl(): typeof devUrl {
    return devUrl;
  },
  get diagnostics(): typeof diagnostics {
    return diagnostics;
  },
  set diagnostics(value: typeof diagnostics) {
    diagnostics = value;
  },
  get diagnosticSubscriptions(): typeof diagnosticSubscriptions {
    return diagnosticSubscriptions;
  },
  get emit(): typeof emit {
    return emit;
  },
  get endLauncherExecutionQuery(): typeof endLauncherExecutionQuery {
    return endLauncherExecutionQuery;
  },
  get exiting(): typeof exiting {
    return exiting;
  },
  set exiting(value: typeof exiting) {
    exiting = value;
  },
  get fileGrants(): typeof fileGrants {
    return fileGrants;
  },
  get foldAndRelease(): typeof foldAndRelease {
    return foldAndRelease;
  },
  get fullscreenRects(): typeof fullscreenRects {
    return fullscreenRects;
  },
  set fullscreenRects(value: typeof fullscreenRects) {
    fullscreenRects = value;
  },
  get grantsFor(): typeof grantsFor {
    return grantsFor;
  },
  get handle(): typeof handle {
    return handle;
  },
  get here(): typeof here {
    return here;
  },
  get hideAndRelease(): typeof hideAndRelease {
    return hideAndRelease;
  },
  get hideHostWindow(): typeof hideHostWindow {
    return hideHostWindow;
  },
  get hideNoteOnDesktop(): typeof hideNoteOnDesktop {
    return hideNoteOnDesktop;
  },
  get hostConfig(): typeof hostConfig {
    return hostConfig;
  },
  set hostConfig(value: typeof hostConfig) {
    hostConfig = value;
  },
  get hostConfigDir(): typeof hostConfigDir {
    return hostConfigDir;
  },
  get hostShortcuts(): typeof hostShortcuts {
    return hostShortcuts;
  },
  get lifecycle(): typeof lifecycle {
    return lifecycle;
  },
  get hostShutdown(): typeof hostShutdown {
    return hostShutdown;
  },
  get IMAGE_FILE(): typeof IMAGE_FILE {
    return IMAGE_FILE;
  },
  get isAdminView(): typeof isAdminView {
    return isAdminView;
  },
  get isHostView(): typeof isHostView {
    return isHostView;
  },
  get labelOf(): typeof labelOf {
    return labelOf;
  },
  get lastBalloonReminder(): typeof lastBalloonReminder {
    return lastBalloonReminder;
  },
  set lastBalloonReminder(value: typeof lastBalloonReminder) {
    lastBalloonReminder = value;
  },
  get launcher(): typeof launcher {
    return launcher;
  },
  set launcher(value: typeof launcher) {
    launcher = value;
  },
  get launcherAvailabilityRevision(): typeof launcherAvailabilityRevision {
    return launcherAvailabilityRevision;
  },
  set launcherAvailabilityRevision(value: typeof launcherAvailabilityRevision) {
    launcherAvailabilityRevision = value;
  },
  get launcherCaller(): typeof launcherCaller {
    return launcherCaller;
  },
  get launcherCallers(): typeof launcherCallers {
    return launcherCallers;
  },
  get launcherComposition(): typeof launcherComposition {
    return launcherComposition;
  },
  get launcherContext(): typeof launcherContext {
    return launcherContext;
  },
  set launcherContext(value: typeof launcherContext) {
    launcherContext = value;
  },
  get launcherContextRevision(): typeof launcherContextRevision {
    return launcherContextRevision;
  },
  set launcherContextRevision(value: typeof launcherContextRevision) {
    launcherContextRevision = value;
  },
  get launcherExecutions(): typeof launcherExecutions {
    return launcherExecutions;
  },
  get launcherHides(): typeof launcherHides {
    return launcherHides;
  },
  get launcherPresentationGuard(): typeof launcherPresentationGuard {
    return launcherPresentationGuard;
  },
  get launcherShow(): typeof launcherShow {
    return launcherShow;
  },
  set launcherShow(value: typeof launcherShow) {
    launcherShow = value;
  },
  get layouts(): typeof layouts {
    return layouts;
  },
  get layoutsRestored(): typeof layoutsRestored {
    return layoutsRestored;
  },
  set layoutsRestored(value: typeof layoutsRestored) {
    layoutsRestored = value;
  },
  get layoutTimer(): typeof layoutTimer {
    return layoutTimer;
  },
  set layoutTimer(value: typeof layoutTimer) {
    layoutTimer = value;
  },
  get maintenance(): typeof maintenance {
    return maintenance;
  },
  set maintenance(value: typeof maintenance) {
    maintenance = value;
  },
  get mcpServer(): typeof mcpServer {
    return mcpServer;
  },
  set mcpServer(value: typeof mcpServer) {
    mcpServer = value;
  },
  get migrateNotesDirectory(): typeof migrateNotesDirectory {
    return migrateNotesDirectory;
  },
  get mutations(): typeof mutations {
    return mutations;
  },
  set mutations(value: typeof mutations) {
    mutations = value;
  },
  get nativeDialogDepth(): typeof nativeDialogDepth {
    return nativeDialogDepth;
  },
  get notesActive(): typeof notesActive {
    return notesActive;
  },
  set notesActive(value: typeof notesActive) {
    notesActive = value;
  },
  get notesClient(): typeof notesClient {
    return notesClient;
  },
  get notesMaintenanceClient(): typeof notesMaintenanceClient {
    return notesMaintenanceClient;
  },
  set notesMaintenanceClient(value: typeof notesMaintenanceClient) {
    notesMaintenanceClient = value;
  },
  get notesRecoveryPending(): typeof notesRecoveryPending {
    return notesRecoveryPending;
  },
  set notesRecoveryPending(value: typeof notesRecoveryPending) {
    notesRecoveryPending = value;
  },
  get notesScope(): typeof notesScope {
    return notesScope;
  },
  set notesScope(value: typeof notesScope) {
    notesScope = value;
  },
  get noteStateFingerprint(): typeof noteStateFingerprint {
    return noteStateFingerprint;
  },
  set noteStateFingerprint(value: typeof noteStateFingerprint) {
    noteStateFingerprint = value;
  },
  get noteStateVersion(): typeof noteStateVersion {
    return noteStateVersion;
  },
  set noteStateVersion(value: typeof noteStateVersion) {
    noteStateVersion = value;
  },
  get noteWindowSnapshot(): typeof noteWindowSnapshot {
    return noteWindowSnapshot;
  },
  get officialRenderers(): typeof officialRenderers {
    return officialRenderers;
  },
  get officialWindows(): typeof officialWindows {
    return officialWindows;
  },
  get openHostSettings(): typeof openHostSettings {
    return openHostSettings;
  },
  get openNote(): typeof openNote {
    return openNote;
  },
  get openNoteWithAnchor(): typeof openNoteWithAnchor {
    return openNoteWithAnchor;
  },
  get paperMenu(): typeof paperMenu {
    return paperMenu;
  },
  get pending(): typeof pending {
    return pending;
  },
  get pendingManagerOpen(): typeof pendingManagerOpen {
    return pendingManagerOpen;
  },
  set pendingManagerOpen(value: typeof pendingManagerOpen) {
    pendingManagerOpen = value;
  },
  get pendingNotesMigration(): typeof pendingNotesMigration {
    return pendingNotesMigration;
  },
  set pendingNotesMigration(value: typeof pendingNotesMigration) {
    pendingNotesMigration = value;
  },
  get persistLayout(): typeof persistLayout {
    return persistLayout;
  },
  get pluginFiles(): typeof pluginFiles {
    return pluginFiles;
  },
  get pluginHost(): typeof pluginHost {
    return pluginHost;
  },
  set pluginHost(value: typeof pluginHost) {
    pluginHost = value;
  },
  get pluginHostStartupError(): typeof pluginHostStartupError {
    return pluginHostStartupError;
  },
  set pluginHostStartupError(value: typeof pluginHostStartupError) {
    pluginHostStartupError = value;
  },
  get pluginImages(): typeof pluginImages {
    return pluginImages;
  },
  get pluginSettings(): typeof pluginSettings {
    return pluginSettings;
  },
  get prepare(): typeof prepare {
    return prepare;
  },
  get preparedWindows(): typeof preparedWindows {
    return preparedWindows;
  },
  get privateDataRoots(): typeof privateDataRoots {
    return privateDataRoots;
  },
  set privateDataRoots(value: typeof privateDataRoots) {
    privateDataRoots = value;
  },
  get publishNoteStates(): typeof publishNoteStates {
    return publishNoteStates;
  },
  get publishPluginTheme(): typeof publishPluginTheme {
    return publishPluginTheme;
  },
  get quit(): typeof quit {
    return quit;
  },
  get ready(): typeof ready {
    return ready;
  },
  get refreshTray(): typeof refreshTray {
    return refreshTray;
  },
  get registerShortcuts(): typeof registerShortcuts {
    return registerShortcuts;
  },
  get releasing(): typeof releasing {
    return releasing;
  },
  get remember(): typeof remember {
    return remember;
  },
  get reportError(): typeof reportError {
    return reportError;
  },
  get requestLauncher(): typeof requestLauncher {
    return requestLauncher;
  },
  get requireNotes(): typeof requireNotes {
    return requireNotes;
  },
  get resourceRevocations(): typeof resourceRevocations {
    return resourceRevocations;
  },
  get revokeLauncherCaller(): typeof revokeLauncherCaller {
    return revokeLauncherCaller;
  },
  get safeBounds(): typeof safeBounds {
    return safeBounds;
  },
  get scheduleLayout(): typeof scheduleLayout {
    return scheduleLayout;
  },
  get setMaintenance(): typeof setMaintenance {
    return setMaintenance;
  },
  get setNotePinned(): typeof setNotePinned {
    return setNotePinned;
  },
  get settingsCaller(): typeof settingsCaller {
    return settingsCaller;
  },
  set settingsCaller(value: typeof settingsCaller) {
    settingsCaller = value;
  },
  get shortcutWarning(): typeof shortcutWarning {
    return shortcutWarning;
  },
  set shortcutWarning(value: typeof shortcutWarning) {
    shortcutWarning = value;
  },
  get showLauncherWithSelection(): typeof showLauncherWithSelection {
    return showLauncherWithSelection;
  },
  get prepareSelectionReader(): typeof prepareSelectionReader {
    return prepareSelectionReader;
  },
  get cancelSelection(): typeof cancelSelection {
    return cancelSelection;
  },
  get stopSelectionReader(): typeof stopSelectionReader {
    return stopSelectionReader;
  },
  get showLauncher(): typeof showLauncher {
    return showLauncher;
  },
  get openLauncherWindow(): typeof openLauncherWindow {
    return openLauncherWindow;
  },
  get showMain(): typeof showMain {
    return showMain;
  },
  get startupFile(): typeof startupFile {
    return startupFile;
  },
  set startupFile(value: typeof startupFile) {
    startupFile = value;
  },
  get syncMcp(): typeof syncMcp {
    return syncMcp;
  },
  get TEXT_FILE(): typeof TEXT_FILE {
    return TEXT_FILE;
  },
  get translationSettings(): typeof translationSettings {
    return translationSettings;
  },
  get tray(): typeof tray {
    return tray;
  },
  set tray(value: typeof tray) {
    tray = value;
  },
  get updateService(): typeof updateService {
    return updateService;
  },
  set updateService(value: typeof updateService) {
    updateService = value;
  },
  get ui(): typeof ui {
    return ui;
  },
  get windowModes(): typeof windowModes {
    return windowModes;
  },
  get windowPresentations(): typeof windowPresentations {
    return windowPresentations;
  },
  get windows(): typeof windows {
    return windows;
  },
  get workspaceRequests(): typeof workspaceRequests {
    return workspaceRequests;
  },
  get enqueueMutation(): typeof enqueueMutation {
    return enqueueMutation;
  },
  get notesRendererRoot(): typeof notesRendererRoot {
    return notesRendererRoot;
  },
  set notesRendererRoot(value: typeof notesRendererRoot) {
    notesRendererRoot = value;
  },
  get notesStartupClient(): typeof notesStartupClient {
    return notesStartupClient;
  },
  set notesStartupClient(value: typeof notesStartupClient) {
    notesStartupClient = value;
  },
  get restoreNotesLayout(): typeof restoreNotesLayout {
    return restoreNotesLayout;
  },
  get bindOfficialRenderer(): typeof bindOfficialRenderer {
    return bindOfficialRenderer;
  },
  get toMcpNote(): typeof toMcpNote {
    return toMcpNote;
  },
  get translationSettingsFile(): typeof translationSettingsFile {
    return translationSettingsFile;
  },
};
const { handle } = createDispatch(runtimeContext);
const { setupIpc, grantsFor } = createTransport(runtimeContext);
const { pauseForBackup, migrateNotesDirectory, reloadHostAfterRestore } =
  createBackupRuntime(runtimeContext);
const { toggleAllSurfaces, executeCliCommand, registerShortcuts } =
  createSurfaceCommands(runtimeContext);
const { globalMenu, paperMenu, fireReminderNotification, refreshTray } =
  createMenus(runtimeContext);
const { prepare, hideAndRelease, foldAndRelease, quit } = createWindowClose(runtimeContext);
const {
  launcherPresentationGuard,
  endLauncherExecutionQuery,
  launcherCaller,
  hideHostWindow,
  revokeLauncherCaller,
  deliverLauncherQueryUpdate,
  showLauncher,
  showLauncherWithSelection,
  prepareSelectionReader,
  cancelSelection,
  captureExternalFocus,
  restoreExternalFocus,
  stopSelectionReader,
  openLauncherWindow,
  requestLauncher,
  preloadLauncher,
  activateHostCommand,
} = createLauncherRuntime(runtimeContext);
const {
  flushPluginWindowStates,
  refreshWindowPresentations,
  getPluginIcon,
  getHostIcon,
  queuePluginWindowActivation,
  takePluginWindowActivation,
  pluginWindowInfo,
  openPluginWindow,
  labelOf,
  remember,
  safeBounds,
  isHostView,
  isAdminView,
  createWindow,
  requireNotes,
  bindOfficialRenderer,
  openHostSettings,
} = createDesktopWindows(runtimeContext);
const {
  noteWindowSnapshot,
  publishNoteStates,
  applyNoteTopmost,
  setNotePinned,
  hideNoteOnDesktop,
  restoreNotesLayout,
  persistLayout,
  scheduleLayout,
  showMain,
  openNote,
  openNoteWithAnchor,
} = createNoteSurfaces(runtimeContext);
const { contextForCaller, contextRevisionForCaller, clearLauncherContext } =
  createContextRuntime(runtimeContext);

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
const devPort = process.env.SPARK233_DEV_PLUGINS === "1" ? process.env.SPARK233_DEV_PORT : "1420";
if (
  devUrl &&
  (!/^\d+$/.test(devPort ?? "") || new URL(devUrl).origin !== `http://127.0.0.1:${devPort}`)
)
  throw new Error("Unexpected renderer dev server");
registerPluginProtocolScheme([
  widgetScheme,
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
let primaryDesktopInstance = false;
let startupComplete = false;
if (cliArgs.mcp) {
  // --mcp：stdio MCP 服务进程，不参与单实例锁与正常启动。
  void runMcpLauncher({ exe: process.execPath, here, configDir })
    .then((code) => app.exit(code))
    .catch((error) => {
      process.stderr.write(`spark233 MCP 启动失败: ${String(error)}\n`);
      app.exit(1);
    });
} else {
  primaryDesktopInstance = acquireDesktopInstance(
    app.getPath("userData"),
    process.env.SPARK233_SMOKE === "1" &&
      !!process.env.SPARK233_CONFIG_DIR &&
      !!process.env.SPARK233_DATA_DIR,
  );
  if (!primaryDesktopInstance) app.exit(0);
}
const fileGrants = new WeakMap<BrowserWindow, FileGrants>();
const applicationEntries = new ApplicationEntryAdmissions();
const windows = new Map<string, BrowserWindow>();
export interface Layout extends CapsuleEntry {
  windowProfile?: string;
  hostPage?: "settings" | "launcher";
  settingsTarget?: { page: string; pluginId?: string; tab?: string };
  everOpened?: boolean;
  label: string;
  view: "main" | "launcher" | "notepad" | "tile";
  noteId?: string;
  bounds: Electron.Rectangle;
  visible: boolean;
  topmost: boolean;
  workspace?: "clipboard" | "translation" | "ocr" | "screenshot-history" | "search";
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
let backupScheduler: BackupScheduler | undefined;
const backupSelections = new BackupSelections();
let maintenance = false;
let backupRecoveryPending = false;
let launcherAvailabilityRevision = 0;
function setMaintenance(value: boolean): void {
  if (maintenance === value) return;
  if (value && desktopLayer?.snapshot().editing)
    throw new AppError("saveFailed", "Finish or cancel desktop layout editing before maintenance");
  maintenance = value;
  desktopLayer?.setVisibility("user", value);
  screenshotLayer?.refresh();
  launcherAvailabilityRevision++;
  if (value) {
    launcher?.clear();
    cancelSelection();
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
let launcher: LauncherController;
const launcherExecutions = new AsyncLocalStorage<{
  callerId: string;
  active: boolean;
  query?: { sessionId: string; requestId: string };
}>();
const windowPresentations = new WeakMap<BrowserWindow, () => boolean>();
/** Window mode (normal / topmost / desktop) of host-rendered plugin windows. */
const windowModes = new Map<number, WindowModeController>();
const launcherCallers = new Map<number, string>();
const launcherHides = new Map<number, { caller: string; sessionId: string; requestId: string }>();
let notesActive = false;
let notesRendererRoot: string | undefined;
let layoutsRestored = false;
let clipboardRuntime: ClipboardRuntime | undefined;
let launcherContext: { context: PluginContext; label: string } | undefined;
let launcherContextRevision = 0;
const pluginImages = new Map<string, CaptureImage>();
const pluginFiles = new Map<string, string>();
const resourceRevocations = new Set<(ids: readonly string[]) => void>();
const launcherDialogs = new Set<number>();
const launcherComposition = new Map<number, number>();
const nativeDialogDepth = new Map<number, number>();
let pluginHost: DesktopPluginHost | undefined;
let pluginHostStartupError: string | undefined;
const pluginThemeListeners = new Set<() => void>();
// Native menus use the same two locale choices as renderer workspaces.
const ui = (chinese: string, english: string): string =>
  hostConfig?.value.locale.startsWith("en") ? english : chinese;
const getPluginTheme = (): PluginTheme => ({
  version: "1.0.0",
  accent: hostConfig.value.accentColor ?? "green",
  preference: hostConfig.value.theme,
  effective:
    hostConfig.value.theme === "system"
      ? nativeTheme.shouldUseDarkColors
        ? "dark"
        : "light"
      : hostConfig.value.theme,
});
function subscribePluginTheme(listener: () => void): () => void {
  pluginThemeListeners.add(listener);
  return () => {
    pluginThemeListeners.delete(listener);
  };
}
function publishPluginTheme(): void {
  for (const listener of pluginThemeListeners) listener();
  desktopLayer?.refresh();
}
nativeTheme.on("updated", publishPluginTheme);
nativeTheme.on("updated", () => {
  if (!hostConfig) return;
  refreshWindowPresentations();
  refreshTray();
});
const createOfficialRuntime: NonNullable<DesktopPluginHostOptions["createOfficialRuntime"]> =
  createOfficialRuntimeFactory(runtimeContext);
let tray: TrayController;
let capsules: Capsules;
let desktopLayer: DesktopLayer | undefined;
let overlayFocusTarget = 0;
let overlayToggle: Promise<void> = Promise.resolve();
function toggleDesktopOverlay(): Promise<void> {
  const task = overlayToggle
    .catch(() => {})
    .then(async () => {
      // Shortcuts can be registered by plugin onChange before installation and
      // desktop restoration finish. Preserve the request until that fence opens.
      const startupError = await layerStartup;
      if (lifecycle.blocked || !desktopLayer) return;
      if (startupError || !layerStartupReady)
        throw new AppError(
          "layer.startupFailed",
          ui(
            `桌面插件层初始化失败：${startupError ?? "插件宿主不可用"}`,
            `Desktop plugin layer failed to initialize: ${startupError ?? "Plugin host unavailable"}`,
          ),
        );
      if (desktopLayer.overlayActive) {
        await desktopLayer.closeOverlay(true);
        return;
      }
      const target = await captureExternalFocus();
      if (lifecycle.blocked) return;
      overlayFocusTarget = target;
      await desktopLayer.openOverlay();
    });
  overlayToggle = task;
  return task;
}
let widgetHost: WidgetHost | undefined;
let utoolsDesktop: UToolsDesktopHost | undefined;
let windowDesktop: PluginWindowDesktopHost | undefined;
let notesLayer: NotesLayerCoordinator | undefined;
let screenshotLayer: ScreenshotLayerCoordinator | undefined;
let notesMigrationError: string | undefined;
let layerStartupReady = false;
let completeLayerStartup: (error?: string) => void;
const layerStartup = new Promise<string | undefined>((resolve) => {
  completeLayerStartup = resolve;
});
let layerStore: LayerLayoutStore | undefined;
let stopLayerEnvironment = () => {};
function layerFlags() {
  const preferences = hostConfig?.value.desktopLayer ?? DEFAULT_DESKTOP_LAYER_PREFERENCES;
  // Plugin installation holds the manager's maintenance fence and can block
  // window readiness. Restore views once owners/data are fully initialized.
  return { ...preferences, enabled: preferences.enabled && layerStartupReady };
}
async function syncDesktopLayer(strict = false): Promise<void> {
  if (
    desktopLayer?.snapshot().editing &&
    notesLayer?.isEnabled !== !!(layerFlags().enabled && layerFlags().notesEnabled)
  )
    throw new AppError("saveFailed", "Apply or cancel desktop editing before changing notes mode");
  if (notesActive && layoutsRestored) {
    try {
      await notesLayer?.setEnabled(layerFlags().enabled && layerFlags().notesEnabled);
      notesMigrationError = undefined;
    } catch (error) {
      notesMigrationError = error instanceof Error ? error.message : String(error);
      console.error("desktop-notes-migration", error);
      emit("desktop-pins-changed");
      if (strict) throw error;
    }
  }
  await desktopLayer?.setEnabled(layerFlags().enabled);
  screenshotLayer?.refresh();
  await widgetHost?.sync();
  await utoolsDesktop?.sync();
  await windowDesktop?.sync();
  desktopLayer?.refresh();
}
async function flushDesktopLayer(): Promise<void> {
  if (desktopLayer?.snapshot().editing)
    throw new AppError("saveFailed", "Apply or cancel desktop layout editing before continuing");
  await layerStore?.flush();
  await notesLayer?.flush();
  await screenshotLayer?.flush();
}
async function reloadDesktopLayer(): Promise<void> {
  await notesLayer?.resetAfterRestore();
  await layerStore?.reloadAfterRestore();
  screenshotLayer?.reload();
  await widgetHost?.reloadAfterRestore();
  await syncDesktopLayer();
}
let mcpServer: McpServer;
let lastBalloonReminder: ReminderItem | undefined;
let stopFullscreen = () => {};
const releasing = new Map<number, Promise<void>>();
let exiting = false;
let updateService: UpdateService;
let updateInstallApply: (() => void) | undefined;
let updateInstallCommitted = false;
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
let startupFile: string | null = null;
let shortcutWarning: string | undefined;
let mutations: Promise<unknown> = Promise.resolve();
const hostShortcuts = new ShortcutManager({
  showLauncher: showLauncherWithSelection,
  toggleVisibility: toggleAllSurfaces,
  toggleDesktopOverlay,
  commands: () => pluginHost?.manager.commands() ?? [],
  activate: activateHostCommand,
  onError: reportError,
  isBlocked: () => lifecycle.blocked,
  getLocale: () => hostConfig?.value.locale ?? "zh-CN",
});
const lifecycle = new HostLifecycle({
  started: () => startupComplete,
  maintenance: () => maintenance,
  quitting: () => hostShutdown.isQuitting,
  exiting: () => exiting,
});
const hostShutdown = new ShutdownCoordinator<BrowserWindow>({
  isBlocked: () => maintenance && !backupRecoveryPending,
  awaitWrites: async () => {
    cancelSelection();
    await mutations.catch(() => {});
  },
  awaitReleases: async () => {
    const results = await Promise.allSettled(releasing.values());
    const errors = results.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (errors.length) throw new AggregateError(errors, "Window release failed");
  },
  windows: () => (backupRecoveryPending ? [] : windows.values()),
  prepare,
  describe: (win) => {
    const label = labelOf(win);
    const layout = layouts.get(label);
    const name = layout?.pluginId
      ? (pluginHost?.trayPlugins().find((p) => p.pluginId === layout.pluginId)?.displayName ??
        layout.pluginId)
      : (layout?.hostPage ?? label);
    return `${name || win.getTitle()}${ready.has(win.id) ? "" : ui("（未就绪）", " (not ready)")}`;
  },
  remember,
  persist: async () => {
    flushPluginWindowStates();
    await flushDesktopLayer();
    if (!backupRecoveryPending) await persistLayout();
  },
  shutdownPlugins: async () => {
    await pluginHost?.shutdown();
    // Once all plugins have stopped, cleanup failures cannot reopen the app.
    for (const cleanup of [
      stopSelectionReader,
      () => commandMatcher.stop(),
      () => {
        diagnostics?.record({ kind: "host", code: "stopped", level: "info" });
      },
      () => diagnostics?.shutdown(),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        console.error("shutdown-cleanup", error);
      }
    }
  },
  onCommit: async () => {
    stopLayerEnvironment();
    for (const cleanup of [
      () => notesLayer?.dispose(),
      () => screenshotLayer?.dispose(),
      () => widgetHost?.dispose(),
      () => desktopLayer?.dispose(),
    ])
      try {
        await cleanup();
      } catch (error) {
        console.error("desktop-layer-shutdown", error);
      }
    exiting = true;
    if (updateInstallApply) {
      const apply = updateInstallApply;
      updateInstallApply = undefined;
      updateInstallCommitted = true;
      // Everything is already torn down. If the installer cannot start (missing
      // or locked file), relaunch instead of leaving a running shell with no plugins.
      const relaunch = () => {
        app.relaunch();
        app.exit(0);
      };
      try {
        apply();
      } catch (error) {
        console.error("update-install-apply", error);
        relaunch();
        return;
      }
      setTimeout(relaunch, 8000).unref();
      return;
    }
    app.quit();
  },
  onError: async (error) => {
    preparedWindows.clear();
    if (!(error instanceof AppError) || !["pluginSaveRefused", "saveFailed"].includes(error.code)) {
      reportError(error);
      return;
    }
    const options: Electron.MessageBoxOptions = {
      type: "warning",
      title: "spark233",
      message: ui(
        "插件未能确认保存，退出已取消。",
        "A plugin could not confirm saving. Quitting was cancelled.",
      ),
      // Say which window or plugin refused; otherwise the user cannot act on it.
      detail:
        error.message +
        "\n\n" +
        ui(
          "可保留应用并重试。强制退出将结束应用拥有的插件进程，未保存的内容可能丢失。",
          "Keep the app open and retry, or force quit its owned plugin processes. Unsaved work may be lost.",
        ),
      buttons: [ui("保留应用", "Keep open"), ui("强制退出", "Force quit")],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    };
    const candidates = [...windows.values()].filter(
      (win) => !win.isDestroyed() && ready.has(win.id),
    );
    const parent =
      candidates.find((win) => win.isFocused()) ??
      candidates.find((win) => win.isVisible()) ??
      candidates[0];
    if (parent) {
      nativeDialogDepth.set(parent.id, (nativeDialogDepth.get(parent.id) ?? 0) + 1);
      if (parent.isMinimized()) parent.restore();
      if (!parent.isVisible()) parent.show();
      parent.focus();
    }
    let choice: Electron.MessageBoxReturnValue;
    try {
      choice = parent
        ? await dialog.showMessageBox(parent, options)
        : await dialog.showMessageBox(options);
    } finally {
      if (parent) {
        const depth = (nativeDialogDepth.get(parent.id) ?? 1) - 1;
        if (depth) nativeDialogDepth.set(parent.id, depth);
        else nativeDialogDepth.delete(parent.id);
      }
    }
    if (choice.response !== 1) return;
    try {
      await pluginHost?.manager.forceTerminateProcesses();
      stopFullscreen();
      mcpServer?.stop();
      backupScheduler?.stop();
      hostShortcuts.dispose();
      exiting = true;
      app.exit(0);
    } catch (failure) {
      reportError(failure);
    }
  },
  getLocale: () => hostConfig?.value.locale ?? "zh-CN",
});
/**
 * Installs a downloaded update only after the shutdown coordinator confirmed
 * that every window saved. Failure leaves the app running with the update
 * still pending.
 */
async function requestUpdateInstall(apply: () => void): Promise<void> {
  updateInstallApply = apply;
  updateInstallCommitted = false;
  await hostShutdown.request();
  const committed = updateInstallCommitted;
  updateInstallApply = undefined;
  updateInstallCommitted = false;
  if (!committed) throw new AppError("installSaveFailed", "有窗口未完成保存，已取消更新");
}
if (!app.isPackaged && devUrl && process.env.SPARK233_DEV_PLUGINS === "1") {
  process.on("message", (message) => {
    if (message !== "spark233-dev-reload") return;
    void quit().finally(() => {
      if (!exiting && process.connected) process.send?.("spark233-dev-reload-refused");
    });
  });
}
// MCP 写操作与 IPC 写操作共用同一条磁盘事务串行链。
function enqueueMutation<T>(run: () => T | Promise<T>): Promise<T> {
  if (lifecycle.blocked)
    return Promise.reject(new AppError("maintenance", "正在备份或恢复，请稍后重试"));
  return (mutations = mutations.catch(() => {}).then(run)) as Promise<T>;
}
let noteStateVersion = 0;
let noteStateFingerprint = "";
let fullscreenRects: Electron.Rectangle[] = [];
const emit = (name: string, payload?: unknown, target?: BrowserWindow) => {
  for (const win of target ? [target] : [...windows.values(), ...(capsules?.nativeWindows() ?? [])])
    if (!win.isDestroyed()) win.webContents.send(`spark233:event:${name}`, payload);
};
let launcherShow: Promise<BrowserWindow> | undefined;
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
const mcpOps: McpOps = createMcpOperations(runtimeContext);
function syncMcp(): void {
  if (!mcpServer) return;
  if (!maintenance && notesActive && hostConfig.value.mcpEnabled) mcpServer.start();
  else mcpServer.stop();
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
const pluginSettings = createPluginSettings(runtimeContext);
app.on("second-instance", (_event, argv) => {
  const file = externalArg(argv);
  if (file) startupFile = file;
  const command = parseCliArgs(argv).command;
  // Shutdown owns the save boundary and can cancel a partially restored UI.
  // Do not leave an explicit exit waiting behind desktop initialization.
  if (command === "exit" && hostConfig) {
    void quit();
    return;
  }
  if (!startupComplete) {
    if (command || !file) pendingCliCommand = command ?? "show";
    return;
  }
  if (command) executeCliCommand(command);
  if (file) {
    const main = showMain();
    if (startupFile && ready.has(main.id)) {
      grantsFor(main).grant(startupFile);
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
  updateService?.dispose();
  backupScheduler?.stop();
  hostShortcuts.dispose();
  stopFullscreen();
  stopLayerEnvironment();
  capsules?.dispose();
  mcpServer?.stop();
  tray?.dispose();
});
export function startDesktopHost(): void {
  app
    .whenReady()
    .then(async () => {
      if (cliArgs.mcp) return; // --mcp 进程的正常启动路径已被启动器接管
      if (!primaryDesktopInstance) return;
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
      updateService = createUpdateService({
        configDir: hostConfigDir,
        hostVersion: app.getVersion(),
        isPackaged: app.isPackaged,
        platform: process.platform,
        emit: (name, payload) => emit(name, payload),
        requestInstall: (apply) => requestUpdateInstall(apply),
      });
      updateService.start();
      launcher = new LauncherController({
        commandMatcher,
        getWarnings: () => (shortcutWarning ? [shortcutWarning] : []),
        stateFile: path.join(hostConfigDir, "launcher.json"),
        manager: () => pluginHost?.manager,
        onQueryUpdate: deliverLauncherQueryUpdate,
        onPreferencesChanged: () => emit("launcher-status-changed"),
        onLearningChanged: (learning) => emit("launcher-learning-changed", learning),
        getContext: contextForCaller,

        getContextRevision: contextRevisionForCaller,
        getAvailabilityRevision: () => launcherAvailabilityRevision,
        getLocale: () => hostConfig.value.locale,
        getPluginIcon,
      });
      capsules = new Capsules({
        canInteract: () =>
          notesActive && notesScope?.state === "active" && !maintenance && !hostShutdown.isQuitting,
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
          void widgetHost?.sync().catch((error) => console.error("desktop-notes-quota", error));
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
      layerStore = new LayerLayoutStore({
        file: path.join(hostConfigDir, "desktop-layout.json"),
        onError: (error) => console.error("desktop-layout", error),
      });
      // Card visibility can change from settings, a card's own menu or the
      // tray; keep the cached tray checkboxes in step with the stored layout.
      // Bounds commits are frequent; rebuild the menu only when the visible set changes.
      let trayCardVisibility = "";
      layerStore.subscribe((layout) => {
        const next = JSON.stringify(
          Object.entries(layout.cards).map(([id, card]) => [id, card.visible]),
        );
        if (next === trayCardVisibility) return;
        trayCardVisibility = next;
        refreshTray();
      });
      desktopLayer = new DesktopLayer({
        store: layerStore,
        overlayLayout: new DesktopOverlayLayout(
          path.join(configDir, "desktop-overlay-layout.json"),
        ),
        onOverlayClosed: async (restore) => {
          const target = overlayFocusTarget;
          overlayFocusTarget = 0;
          if (restore && target) await restoreExternalFocus(target);
        },
        onOverlaySettings: async () => {
          await openHostSettings({ page: "desktop" });
        },
        onOverlayOpenPanel: async (card) => {
          if (!card.widget || !pluginHost?.manager.isOwnerCurrent(card.widget.owner))
            throw new AppError("pluginDisabled", "插件实例已失效");
          await pluginHost.manager.activateOwned("spark233.traffic", { commandId: "open" }, () => {
            if (!pluginHost?.manager.isOwnerCurrent(card.widget!.owner))
              throw new AppError("pluginDisabled", "插件实例已失效");
          });
        },
        onOverlayPresentation: async (card, patch) => {
          if (card.widget) {
            await widgetHost?.update(card.widget.widgetInstanceId, patch);
            return true;
          }
          if (card.renderKind === "screenshot") {
            await screenshotLayer?.update(card.renderRef!, patch);
            return true;
          }
          return false;
        },
        displays: () =>
          screen.getAllDisplays().map((display) => ({
            id: String(display.id),
            workArea: display.workArea,
            scaleFactor: display.scaleFactor,
          })),
        primaryDisplay: () => String(screen.getPrimaryDisplay().id),
        cursor: () => screen.getCursorScreenPoint(),
        flags: layerFlags,
        theme: () => getPluginTheme().effective,
        locale: () => hostConfig.value.locale,
        diagnostic: (code, detail) => {
          console.error("desktop-layer", code, detail);
        },
        createWindow: (spec) => {
          const entryURL = `spark233://app/index.html?view=layer&surface=${encodeURIComponent(spec.id)}&generation=${spec.generation}`;
          const ownSession = widgetHost!.createSurfaceSession(spec, entryURL);
          const layer = new LayerWindow({
            id: spec.id,
            mode: spec.card ? "web-shell" : "shared",
            bounds: spec.bounds,
            group: spec.group,
            inputMode: spec.inputMode,
            title: "spark233 desktop cards",
            entryURL,
            preloadPath: path.join(here, "layer-preload.cjs"),
            session: ownSession,
            label: "layer:" + spec.id,
            additionalArguments: [
              "--spark233-surface=" + spec.id,
              "--spark233-surface-generation=" + spec.generation,
            ],
            screen,
            createBrowserWindow: (options) => new BrowserWindow(options),
            timers: { setTimeout, clearTimeout },
            diagnostic: spec.fault,
            onClosed: spec.closed,
          });
          widgetHost!.bindSession(ownSession, layer.win.webContents);
          if (!spec.card) {
            bindDevToolsShortcut(layer.win, { isolatedSession: true });
            layer.win.on("focus", () => desktopLayer?.restackOverlay());
            layer.win.on("blur", () => {
              setTimeout(() => {
                if (
                  !layer.win.isDestroyed() &&
                  !desktopLayer?.hasOverlayFocus() &&
                  !layer.win.webContents.isDevToolsOpened() &&
                  desktopLayer?.isOverlayWindow(layer.win)
                )
                  void desktopLayer.closeOverlay(false);
              }, 80);
            });
          }
          return { window: layer, entryURL };
        },
      });
      utoolsDesktop = new UToolsDesktopHost({
        layer: desktopLayer,
        store: layerStore,
        pluginHost: () => pluginHost,
      });
      windowDesktop = new PluginWindowDesktopHost({
        layer: desktopLayer,
        store: layerStore,
        available: (pluginId) => {
          const installed = pluginHost?.manager.list().find((p) => p.pluginId === pluginId);
          return !!installed?.enabled && !installed.lastError;
        },
        // Restores a kept window by running the command that opens that window.
        openWindow: async (pluginId, profile) => {
          const manager = pluginHost?.manager;
          if (!manager) return;
          const command = manager
            .describe(pluginId)
            .spark233.commands.find((entry) => entry.window === profile && !entry.internal);
          if (!command) throw new Error("No command opens this plugin window");
          await manager.activate(pluginId, { commandId: command.id });
        },
      });
      widgetHost = new WidgetHost({
        layer: desktopLayer,
        store: layerStore,
        notesActive: () => notesActive && notesLayer?.isEnabled === true,
        trustedCards: () => [
          ...capsules.quotaCards(),
          ...(screenshotLayer?.quotaCards() ?? []),
          ...(utoolsDesktop?.quotaCards() ?? []),
          ...(windowDesktop?.quotaCards() ?? []),
        ],
        resolveScreenshotImage: async (handle) => screenshotLayer?.resolveImage(handle),
        pluginHost: () => pluginHost,
        rendererRoot,
        flags: layerFlags,
        locale: () => hostConfig.value.locale,
        theme: () => getPluginTheme().effective,
        diagnostic: (code, detail) => console.error(code, detail),
      });
      notesLayer = new NotesLayerCoordinator({
        store: layerStore,
        journalFile: path.join(hostConfigDir, "desktop-layer-migration.json"),
        readLegacy: () => (notesStartupClient ?? notesClient).getState("layout"),
        writeLegacy: async (value) => {
          const data =
            notesScope?.state === "preparing" && notesMaintenanceClient
              ? notesMaintenanceClient
              : (notesStartupClient ?? notesClient);
          await data.putState("layout", JSON.parse(JSON.stringify(value)));
        },
        snapshotLegacy: () =>
          parseNotesLayout({
            version: 2,
            capsuleQueues: [...capsules.queues.values()],
            windows: [...layouts.values()].filter((entry) => entry.view === "main" || entry.noteId),
          }),
        applyLegacy: (value) => {
          for (const [label, entry] of layouts)
            if (entry.view === "main" || entry.noteId) layouts.delete(label);
          for (const entry of value.windows)
            layouts.set(entry.label, structuredClone(entry) as Layout);
          capsules.queues.clear();
          for (const queue of value.capsuleQueues)
            capsules.queues.set(queue.key, structuredClone(queue));
        },
        switchView: async (enabled) => {
          await capsules.setDesktopLayer(enabled ? desktopLayer : undefined);
        },
        displays: () =>
          screen.getAllDisplays().map((display) => ({
            id: String(display.id),
            workArea: display.workArea,
            scaleFactor: display.scaleFactor,
          })),
        primaryDisplay: () => String(screen.getPrimaryDisplay().id),
        diagnostic: (code, detail) => console.error(code, detail),
      });
      screenshotLayer = new ScreenshotLayerCoordinator({
        layer: desktopLayer,
        store: layerStore,
        flags: layerFlags,
        isOwnerCurrent: (owner, presentationOnly) =>
          pluginHost?.manager.isOwnerCurrent(owner, undefined, presentationOnly === true) === true,
        otherQuotaCards: () => [
          ...(widgetHost?.quotaCards() ?? []),
          ...capsules.quotaCards().map((card) => ({
            id: card.id,
            renderKind: "notes" as const,
            card: {
              kind: "notes" as const,
              noteId: card.renderRef!,
              displayId: card.displayId,
              workAreaAtSave: card.bounds,
              bounds: card.bounds,
              group: card.group,
              inputMode: card.inputMode,
              visible: card.visible,
              order: card.order,
              restore: true,
              createdAt: 0,
            },
          })),
        ],
        cursor: () => screen.getCursorScreenPoint(),
        toDip: (bounds) =>
          screen.screenToDipRect(null, {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          }),
        toPhysical: (bounds) =>
          screen.dipToScreenRect(null, {
            x: Math.round(bounds.x),
            y: Math.round(bounds.y),
            width: Math.round(bounds.width),
            height: Math.round(bounds.height),
          }),
        onImage: (image) => {
          pluginImages.set(image.resource.id, image);
        },
        onImageReleased: (id) => {
          pluginImages.delete(id);
        },
        changed: () => {
          emit("desktop-pins-changed");
        },
        diagnostic: (code, detail) => console.error(code, detail),
      });
      ipcMain.handle("spark233:layer", (event, value) => {
        if (lifecycle.blocked) throw new AppError("maintenance", "Desktop cards are stopping");
        return desktopLayer!.handle(event, value);
      });
      stopLayerEnvironment = LayerWindow.observeEnvironment({
        screen,
        powerMonitor,
        timers: { setTimeout, clearTimeout },
        onDisplayChange: () => {
          void desktopLayer
            ?.displayChanged()
            .then(() => widgetHost?.sync())
            .catch((error) => console.error("desktop-display", error));
        },
        onSuppressed: (reason, value) => {
          desktopLayer?.setVisibility(reason, value);
          screenshotLayer?.refresh();
        },
        onRestore: () => desktopLayer?.refresh(),
      });
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
          desktopLayer?.setFullscreen(rects);
          for (const [label, win] of windows) {
            const layout = layouts.get(label);
            if (!layout || win.isDestroyed()) continue;
            applyNoteTopmost(win, layout);
          }
        },
        () => [
          ...windows.values(),
          ...capsules.nativeWindows(),
          ...(desktopLayer?.windows().filter((win) => !desktopLayer?.isOverlayWindow(win)) ?? []),
        ],
      );
      startupFile ??= externalArg(process.argv.slice(1));
      protocol.handle("spark233", async (request) => {
        try {
          const url = new URL(request.url);
          let file: string;
          if (url.host === "app")
            file = confined(
              rendererRoot,
              decodeURIComponent(url.pathname.slice(1)) || "index.html",
            );
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
              ["spark233://app", "spark233://notes", "spark233://workspace", devUrl].includes(
                origin,
              )
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
          utoolsDesktop,
          windowDesktop,
          root: path.join(configDir, "plugins"),
          bundledRoot: app.isPackaged
            ? path.join(process.resourcesPath, "plugins")
            : process.env.SPARK233_DEV_PLUGIN_OUTPUT ||
              path.resolve(here, "../../../../dist-plugins"),
          developmentBundledUpdates:
            !app.isPackaged && !!devUrl && process.env.SPARK233_DEV_PLUGINS === "1",
          createOfficialRuntime,
          getPluginIcon,
          resolveDataDirectory: (id) =>
            id === "spark233.notes" ? hostConfig.value.dataDir : undefined,
          onBackendHostCall: async (call, { owner, signal }) => {
            if (
              signal.aborted ||
              owner.pluginId !== "spark233.notes" ||
              !notesScope?.accepts(owner)
            )
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
                [source, host, recovery].some(
                  (root) => inside(root, target) || inside(target, root),
                )
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
          onWidgetLifecycle: (owner, phase) => widgetHost?.lifecycle(owner, phase),
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
          subscribeTheme: subscribePluginTheme,
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
            if (layerStartupReady)
              void syncDesktopLayer().catch((error) => console.error("desktop-layer-sync", error));
            refreshWindowPresentations();
            launcher?.pluginsChanged();
            emit("plugins-changed");
            refreshTray();
            if (pluginHost && !maintenance && !hostShortcuts.isRecording)
              try {
                registerShortcuts(hostConfig.value, true);
              } catch (error) {
                console.error("plugin-shortcut-registration", error);
              }
          },
          onTrayChange: refreshTray,
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
            return persistedConfigSchema.parse({ ...value, dataDir: roots["spark233.notes"] });
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
        backupScheduler = new BackupScheduler(
          hostConfigDir,
          (directory) => backupService!.create(directory),
          () => !maintenance && !hostShutdown.isQuitting && !!pluginHost && !notesRecoveryPending,
          configDir,
        );
        backupScheduler.start();
      } catch (error) {
        if (error instanceof AppError && error.code === "backupRecoveryRequired") throw error;
        pluginHostStartupError = String(error);
        console.error("plugin-host-initialization", error);
      }
      prepareSelectionReader();
      notesActive = !!pluginHost?.manager
        .list()
        .find(
          (record) => record.pluginId === "spark233.notes" && record.enabled && !record.lastError,
        );
      capsules.setEnabled(notesActive);
      tray = new TrayController({
        icon: path.join(here, "assets", process.platform === "win32" ? "icon.ico" : "32x32.png"),
        getIcon: () => getHostIcon("tray") ?? path.join(here, "assets/tray-light.png"),
        ...(process.platform === "win32"
          ? {
              themeIcons: {
                dark: path.join(here, "assets/tray-light.png"),
                light: path.join(here, "assets/tray-dark.png"),
              },
            }
          : {}),
        title: "spark233",
        getMenu: globalMenu,
        onClick: requestLauncher,
        onBalloonClick: () => {
          const item = lastBalloonReminder;
          lastBalloonReminder = undefined;
          if (item) void openNoteWithAnchor(item.noteId, item.taskText).catch(reportError);
        },
      });
      preloadLauncher();
      if (launcher.state().firstRun) await showLauncher();
      try {
        registerShortcuts(hostConfig.value, true);
      } catch (error) {
        console.error("shortcut-registration", error);
      }
      syncMcp();
      refreshTray();
      publishNoteStates();
      // The first tray/menu/shortcut pass and launcher bootstrap validate the
      // installed packages. Finish that work before starting the layer's 5 s
      // window-ready budget, including restored pins on an existing profile.
      if (pluginHost && !pluginHostStartupError) {
        layerStartupReady = true;
        await syncDesktopLayer();
      }
      completeLayerStartup(pluginHostStartupError);
      startupComplete = true;
      if (startupFile && notesActive) showMain();
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
          prepare,
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
      completeLayerStartup(error instanceof Error ? error.message : String(error));
      diagnostics?.record({
        kind: "host",
        code: "failed",
        level: "error",
        errorCode: diagnosticErrorCode(error),
      });
      console.error(error);
      // showErrorBox blocks until dismissed, so the user learns why the app did
      // not start instead of it vanishing on every launch.
      dialog.showErrorBox("spark233", error instanceof Error ? error.message : String(error));
      app.exit(1);
    });
}

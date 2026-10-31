import type { OcrSession, OcrSessionSummary } from "./ocr-sessions.js";
import type { JsonValue } from "@spark233/sdk";
import type { PluginWindowActivation, PluginWindowInfo } from "./plugin-windows.js";
import type { z } from "zod";
import type {
  CustomApplicationTarget,
  CustomApplicationsSettings,
} from "../src/features/applications/types.js";
import type { BackupReport, BackupSelection } from "../src/features/backup/types.js";
import type { CapsuleSnapshot } from "../src/features/capsules/types.js";
import type {
  ClipboardDraft,
  ClipboardEmoji,
  ClipboardEntry,
  ClipboardGroup,
  ClipboardPage,
  ClipboardSettings,
} from "../src/features/clipboard/types.js";
import type { DiagnosticBatch, DiagnosticSnapshot } from "../src/features/diagnostics/types.js";
import type { LauncherQueryResult, LauncherState } from "../src/features/launcher/types.js";
import type { Note, NoteMetadata } from "../src/features/notes/types.js";
import type {
  InstallPreview,
  PackageTaskSnapshot,
  PluginManagementState,
  PluginReleaseNotes,
} from "../src/features/plugins/types.js";
import type { ReminderItem } from "../src/features/reminders/types.js";
import type { SearchScopeSettings, SearchServiceStatus } from "../src/features/search/types.js";
import type {
  AppConfig,
  AppConfigPatch,
  SettingsTarget,
  ShortcutCheckResult,
} from "../src/features/settings/types.js";
import type {
  DictionaryEntryResult,
  DictionaryItem,
  TranslationChunk,
  TranslationConfiguration,
  TranslationHistory,
  TranslationPreferences,
  TranslationResult,
} from "../src/features/translation/types.js";
import type {
  UpdateCheckResult,
  UpdateDownloadProgress,
  UpdateDownloadResult,
  UpdateErrorPayload,
  UpdateInstallResult,
  UpdateSettings,
  UpdateState,
} from "../src/features/update/types.js";
import type { NoteWindowSnapshot } from "../src/features/windows/noteWindowState.js";
import type { CommandName } from "./command-policies.js";
import type { commandSchemas } from "./command-schemas.js";
export interface DialogOptions {
  directory?: boolean;
  multiple?: boolean;
  filters?: { name: string; extensions: string[] }[];
  defaultPath?: string;
  title?: string;
}
export type WindowControlResult =
  | void
  | boolean
  | { x: number; y: number }
  | { width: number; height: number }
  | { x: number; y: number; width: number; height: number };
export type TranslationResponse =
  | TranslationConfiguration
  | TranslationResult
  | DictionaryEntryResult
  | { kind: "dictionary-search"; items: DictionaryItem[] }
  | { kind: "dictionary-history"; entries: { query: string; at: string }[] }
  | { cancelled: boolean }
  | TranslationHistory
  | TranslationPreferences;
export type ClipboardResponse =
  | void
  | string
  | boolean
  | ClipboardPage
  | ClipboardEntry
  | ClipboardEmoji[]
  | ClipboardGroup[]
  | ClipboardSettings
  | ClipboardDraft
  | { token: string; entries: ClipboardEntry[]; count: number; bytes: number; hasMore?: boolean };
/** One workspace row; `searchHit` carries the raw index fields the table shows. */
export interface SearchWorkspaceRow {
  id: string;
  title: string;
  description?: string;
  kind?: string;
  commandId?: string;
  parameters?: { selection?: string; callerId?: string; cursor?: string };
  searchHit?: {
    name: string;
    path: string;
    directory: boolean;
    size?: string;
    modified?: string;
    extension: string;
  };
}
export interface SearchWorkspacePage {
  total: number;
  /** Index totals are an upper bound until the admitted set has been walked. */
  approximate: boolean;
  hasMore: boolean;
  cursor?: string;
  revision?: string;
}
export interface SearchActionResponse {
  items?: SearchWorkspaceRow[];
  searchPage?: SearchWorkspacePage;
  searchStatus?: { state: string; message?: string };
}
/** Every command has an explicit result; business plugins return JSON values. */
interface CommandResults {
  app_exec_path: string;
  app_mcp_command: { command: string; args: string[] };
  app_name: string;
  app_version: string;
  applications_entries_get: CustomApplicationsSettings;
  applications_entries_pick: CustomApplicationTarget | undefined;
  applications_entries_save: CustomApplicationsSettings;
  backup_schedule: import("./backup-schedule.js").BackupSchedule;
  backup_create: BackupReport | undefined;
  backup_inspect: BackupSelection | undefined;
  backup_restore: BackupReport;
  backup_selection_release: void;
  capsule_state: CapsuleSnapshot;
  categories_create: void;
  categories_delete: void;
  categories_list: string[];
  categories_rename: void;
  clipboard_action: ClipboardResponse;
  clipboard_image_ocr: JsonValue | undefined;
  clipboard_read: string;
  clipboard_write: void;
  config_get: AppConfig;
  config_migrate_data_dir: AppConfig;
  config_patch: AppConfig;
  config_save: void;
  copy_background_image: string;
  desktop_prepare_report: void;
  desktop_ready: void;
  diagnostics_clear: DiagnosticSnapshot;
  diagnostics_export: { exported: boolean };
  diagnostics_list: DiagnosticSnapshot;
  diagnostics_subscribe: DiagnosticSnapshot;
  diagnostics_unsubscribe: void;
  dialog_message: void;
  dialog_open: string | string[] | null;
  dialog_save: string | null;
  fold_note_window: void;
  get_file_modified_time: number;
  global_shortcut_check: ShortcutCheckResult;
  hide_note_on_desktop: void;
  images_clean_unused: string[];
  images_get_base_dir: string;
  images_save: string;
  images_save_from_path: string;
  launcher_cancel_query: void;
  launcher_complete_onboarding: void;
  launcher_composition: void;
  launcher_context_clear: LauncherState;
  launcher_context_files: LauncherState;
  launcher_enter_mode: void;
  launcher_execute: JsonValue | undefined;
  launcher_hide: void;
  launcher_learning_update: LauncherState;
  launcher_pick_directory: string | undefined;
  launcher_preference_update: LauncherState;
  launcher_query: LauncherQueryResult;
  launcher_return: void;
  launcher_state: LauncherState;
  launcher_take_workspace: { kind: string; result?: unknown } | undefined;
  plugin_window_info: PluginWindowInfo;
  plugin_window_take_activation: PluginWindowActivation | undefined;
  note_context_menu: void;
  note_set_pinned: void;
  note_window_states: NoteWindowSnapshot;
  notes_create: Note;
  notes_delete: void;
  notes_export_markdown: void;
  notes_history: import("../src/features/notes/types.js").NoteHistory;
  notes_revision: import("../src/features/notes/types.js").SaveNoteRequest;
  notes_history_restore: Note;
  notes_get: Note;
  notes_import_markdown: Note;
  notes_list: NoteMetadata[];
  notes_move_category: NoteMetadata;
  notes_set_editor_mode: NoteMetadata;
  notes_update: Note;
  open_note_in_editor: void;
  open_notepad_window: string;
  open_tile_window: string;
  plugin_settings_get: import("../src/features/plugins/settingsTypes.js").PluginSettingsSnapshot;
  plugin_settings_save: import("../src/features/plugins/settingsTypes.js").PluginSettingsSnapshot;
  plugins_activate: PluginManagementState;
  plugins_cancel_install: PluginManagementState;
  plugins_cancel_package_task: PackageTaskSnapshot;
  plugins_check_updates: PluginManagementState;
  plugins_confirm_install: PluginManagementState;
  plugins_enable: PluginManagementState;
  plugins_import: InstallPreview | undefined;
  plugins_import_directory: InstallPreview | undefined;
  plugins_list: PluginManagementState;
  plugins_prepare_bundled: InstallPreview | undefined;
  plugins_prepare_registry: InstallPreview | undefined;
  plugins_prepare_update: InstallPreview | undefined;
  plugins_release_notes: PluginReleaseNotes;
  plugins_uninstall: PluginManagementState;
  read_external_file: string;
  recycle_notepad_window: void;
  reminders_cancel: void;
  reminders_list: ReminderItem[];
  reminders_set: ReminderItem;
  save_external_file: void;
  /** History rows, or the outcome of a per-row action. */
  ocr_action: OcrSession | OcrSessionSummary[] | { removed: boolean };
  screenshot_action: JsonValue;
  search_workspace: import("./search-history.js").SearchHistory;
  search_action: SearchActionResponse;
  search_scope_get: SearchScopeSettings;
  search_scope_pick: string | undefined;
  search_scope_save: SearchScopeSettings;
  search_service_configure: SearchServiceStatus;
  search_service_rebuild: SearchServiceStatus;
  search_service_status: SearchServiceStatus;
  settings_open: void;
  shell_open: void;
  show_note_on_desktop: string;
  start_shortcut_recording: void;
  stop_shortcut_recording: void;
  surface_state: void;
  take_startup_file: string | null;
  text_action: JsonValue | undefined;
  toggle_tile_window: boolean;
  translation_action: TranslationResponse;
  translation_configure: TranslationConfiguration;
  update_cancel: void;
  update_check: UpdateCheckResult;
  update_download: UpdateDownloadResult;
  update_install: UpdateInstallResult;
  update_install_prepare_report: void;
  update_mirror_chyan_cdk_clear: void;
  update_mirror_chyan_cdk_get: string | null;
  update_mirror_chyan_cdk_set: void;
  update_settings_get: UpdateSettings;
  update_settings_save: UpdateSettings;
  update_status: UpdateState;
  window_control: WindowControlResult;
  capsule_activate: void;
  capsule_drag_end: void;
  capsule_drag_start: void;
  capsule_hide: void;
  capsule_hover: void;
  capsule_menu: void;
  capsule_open: void;
  capsule_scroll: void;
}
interface ArgumentOverrides {
  config_patch: {
    patch: AppConfigPatch;
    expectedCommandShortcuts?: Record<string, string>;
    expectedShortcuts?: Pick<AppConfig, "globalShortcut" | "toggleVisibilityShortcut">;
  };
  search_scope_save: { excludedRoots: string[] } & Partial<
    Omit<SearchScopeSettings, "excludedRoots">
  >;
  plugin_settings_save: { pluginId: string; revision: string; patch: Record<string, unknown> };
}
export type Commands = {
  [K in CommandName]: {
    args: K extends keyof ArgumentOverrides
      ? ArgumentOverrides[K]
      : z.input<(typeof commandSchemas)[K]>;
    result: CommandResults[K];
  };
};
export type CommandResult<C extends CommandName, A> = C extends "window_control"
  ? A extends { action: "bounds" }
    ? { x: number; y: number; width: number; height: number }
    : A extends { action: "position" }
      ? { x: number; y: number }
      : A extends { action: "size" }
        ? { width: number; height: number }
        : A extends { action: "isMaximized" | "isAlwaysOnTop" }
          ? boolean
          : void
  : C extends "translation_action"
    ? A extends { action: "config_status" }
      ? TranslationConfiguration
      : TranslationResponse
    : Commands[C]["result"];
export interface Events {
  "config-changed": AppConfig;
  "launcher-query-updated": LauncherQueryResult;
  "notes-changed": undefined;
  "open-note": string | { noteId: string; taskText?: string };
  "open-external-file": string;
  "desktop:prepare-close": { requestId: string };
  "plugins-changed": undefined;
  "translation-chunk": TranslationChunk;
  "launcher-learning-changed": { enabled: boolean; recordCount: number };
  "launcher-status-changed": undefined;
  "search-scope-changed": undefined;
  "launcher-shown": undefined;
  "launcher-reset": undefined;
  "launcher-input-updated": { text: string; revision: number };
  "launcher-visibility-changed": { visible: boolean };
  "ocr-result": JsonValue;
  "screenshot-result": {
    resource: { id: string };
    width: number;
    height: number;
    action: "copy" | "save" | "ocr";
  };
  "open-workspace": { kind: string; result?: unknown };
  "plugin-window-activation": PluginWindowActivation;
  "clipboard-changed": undefined;
  "plugin-settings-changed": { pluginId: string };
  "plugin-package-task-changed": PackageTaskSnapshot;
  "diagnostics-batch": DiagnosticBatch;
  "note-window-states-changed": NoteWindowSnapshot;
  "reminders-changed": ReminderItem[];
  "capsule-state": CapsuleSnapshot;
  "notepad:activate": string;
  "notepad:show-menu": { x: number; y: number };
  "surface-mode-request": "tile" | "pad";
  "open-about-panel": undefined;
  "shortcut-register-failed": string;
  "window-resized": undefined;
  "tile-window-unpinned": string;
  "settings-navigate": SettingsTarget;
  "update://checking": UpdateState;
  "update://checked": UpdateState;
  "update://download-finished": UpdateState;
  "update://install-finished": UpdateState;
  "update://error": UpdateErrorPayload;
  "update://auto-check-error": UpdateErrorPayload;
  "update://download-progress": UpdateDownloadProgress;
  "shortcut-hook-key": import("../src/features/settings/types.js").HookKeyEvent;
}
export type UnlistenFn = () => void;
export type CommandInput<
  C extends CommandName,
  A = Commands[C]["args"],
> = undefined extends Commands[C]["args"] ? [args?: A] : [args: A];
export type IpcResult<T> = { ok: true; value: T } | { ok: false; error: unknown };
export interface DesktopBridge {
  label: string;
  invoke<C extends CommandName, const A extends Commands[C]["args"] = Commands[C]["args"]>(
    command: C,
    ...input: CommandInput<C, A>
  ): Promise<IpcResult<CommandResult<C, A>>>;
  emit<E extends keyof Events>(name: E, payload?: Events[E]): Promise<void>;
  on<E extends keyof Events>(name: E, callback: (payload: Events[E]) => void): UnlistenFn;
  droppedPaths(files: File[]): Promise<string[]>;
  droppedApplicationEntries(files: File[]): Promise<CustomApplicationTarget[]>;
}

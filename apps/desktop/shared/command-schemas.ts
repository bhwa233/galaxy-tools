import { z } from "zod";
import type { CommandName } from "./command-policies.js";
import { configPatchSchema } from "./config-schema.js";
import { settingsSchema as searchSettings } from "./search-schema.js";
import { settingsSchema as clipboardSettings } from "./clipboard-schema.js";
const empty = z.strictObject({}).optional();
const id = z.string().min(1).max(512);
const location = z
  .string()
  .min(1)
  .max(32768)
  .refine((value) => !value.includes(String.fromCharCode(0)));
const text = z.string().max(16 * 1024 * 1024);
const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const position = z.strictObject({ x: coordinate, y: coordinate });
const size = z.strictObject({
  width: z.number().int().min(1).max(32768),
  height: z.number().int().min(1).max(32768),
});
const bounds = position.extend(size.shape);
const note = z.strictObject({
  title: z.string().max(1000),
  content: text,
  category: z.string().max(512),
  editorMode: z.enum(["text", "markdown"]).optional(),
});
const plugin = z.string().min(1).max(80);
const pluginArgs = z.strictObject({ pluginId: plugin });
const noteArgs = z.strictObject({ noteId: id });
const fileArgs = z.strictObject({ path: location });
const windowArgs = z.strictObject({
  noteId: id.nullable().optional(),
  bounds: bounds.nullable().optional(),
});
const filter = z.strictObject({
  name: z.string().max(200),
  extensions: z.array(z.string().min(1).max(32)).max(100),
});
const dialog = z.strictObject({
  title: z.string().max(1000).optional(),
  defaultPath: location.optional(),
  filters: z.array(filter).max(100).optional(),
});
const diagnosticFilter = z.strictObject({
  source: z.enum(["host", "plugin"]).optional(),
  pluginId: plugin.optional(),
  levels: z
    .array(z.enum(["debug", "info", "warn", "error"]))
    .max(4)
    .optional(),
  from: z.number().finite().optional(),
  to: z.number().finite().optional(),
  afterSequence: z.number().int().nonnegative().optional(),
  limit: z.number().int().min(1).max(10000).optional(),
});
const application = z.strictObject({
  id,
  title: z.string().min(1).max(160),
  path: location,
  args: z.array(z.string().max(32768)).max(128),
  cwd: z.string().max(32768),
  kind: z.enum(["program", "shortcut", "document", "directory"]),
});
const resource = z.strictObject({
  id,
  kind: z.enum(["image", "file", "text"]),
  mimeType: z.string().max(256).optional(),
  size: z.number().int().nonnegative().optional(),
});
const sourceApplication = z.string().max(4096).optional();
const publicContext = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("text"), text, sourceApplication }),
  z.strictObject({ kind: z.literal("image"), resource, sourceApplication }),
  z.strictObject({
    kind: z.literal("files"),
    resources: z.array(resource).max(100),
    sourceApplication,
  }),
  z.strictObject({ kind: z.literal("window"), sourceApplication: z.string().min(1).max(4096) }),
]);
const clipboardRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("open-quick") }),
  z.strictObject({
    action: z.literal("list"),
    query: z.string().max(8192).optional(),
    kind: z.enum(["text", "html", "rtf", "image", "files"]).optional(),
    view: z.enum(["history", "favorites", "all"]).optional(),
    groupId: id.optional(),
    limit: z.number().int().min(1).max(200).optional(),
    offset: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({ action: z.literal("detail"), id }),
  z.strictObject({ action: z.literal("draft.save"), id, text, note: text, tags: text }),
  z.strictObject({ action: z.literal("draft.remove"), id }),
  z.strictObject({
    action: z.enum(["copy", "paste"]),
    id,
    mode: z.enum(["original", "text", "image-file"]).optional(),
  }),
  z.strictObject({
    action: z.literal("update"),
    id,
    note: text.optional(),
    tags: z.array(z.string().max(1000)).max(256).optional(),
    editedText: text.nullable().optional(),
    pinned: z.boolean().optional(),
    favoritePinned: z.boolean().optional(),
    order: z.number().finite().optional(),
    favoriteOrder: z.number().finite().optional(),
    groups: z.array(id).max(256).optional(),
  }),
  z.strictObject({ action: z.literal("favorite"), id, enabled: z.boolean() }),
  z.strictObject({ action: z.literal("history.remove"), ids: z.array(id).max(10000) }),
  z.strictObject({ action: z.literal("settings"), patch: clipboardSettings.partial().optional() }),
  z.strictObject({
    action: z.literal("groups"),
    name: z.string().max(1000).optional(),
    kind: z.enum(["gallery", "favorite"]).optional(),
    deleteId: id.optional(),
  }),
  z.strictObject({
    action: z.literal("merge"),
    ids: z.array(id).max(1000),
    kind: z.enum(["text", "rich", "files"]),
    separator: z.string().max(1000).optional(),
  }),
  z.strictObject({ action: z.literal("gallery.import"), groupId: id.optional() }),
  z.strictObject({
    action: z.literal("cleanup.preview"),
    ids: z.array(id).max(10000).optional(),
    outsideVisibleRange: z.boolean().optional(),
  }),
  z.strictObject({ action: z.literal("cleanup.confirm"), token: id }),
  z.strictObject({ action: z.literal("emoji.list") }),
  z.strictObject({
    action: z.literal("emoji.add"),
    symbol: z.string().min(1).max(128),
    name: z.string().max(1000).optional(),
    group: z.string().max(1000).optional(),
  }),
  z.strictObject({ action: z.enum(["emoji.remove", "emoji.copy"]), id }),
]);
const translationRequest = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("config_status") }),
  z.strictObject({
    action: z.literal("search"),
    query: z.string().max(8192),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  z.strictObject({ action: z.literal("detail"), id }),
  z.strictObject({
    action: z.literal("translate"),
    text,
    requestId: id,
    target: z.enum(["en", "zh-CN"]).optional(),
  }),
  z.strictObject({ action: z.literal("cancel"), requestId: id }),
  z.strictObject({ action: z.literal("history_list") }),
  z.strictObject({ action: z.literal("history_delete"), id }),
  z.strictObject({ action: z.literal("history_clear") }),
  z.strictObject({ action: z.literal("preferences_get") }),
  z.strictObject({
    action: z.literal("preferences_set"),
    autoLookup: z.boolean().optional(),
    historyEnabled: z.boolean().optional(),
  }),
]);

/** Exhaustive: new policies require a reviewed boundary schema. */
export const commandSchemas = {
  app_exec_path: empty,
  app_mcp_command: empty,
  app_name: empty,
  app_version: empty,
  applications_entries_get: empty,
  applications_entries_pick: z.strictObject({
    purpose: z.enum(["target", "cwd"]),
    directory: z.boolean().optional(),
  }),
  applications_entries_save: z.strictObject({
    entries: z.array(application).max(1000),
    revision: z.string().max(200),
  }),
  backup_create: empty,
  backup_inspect: empty,
  backup_restore: z.strictObject({ selectionId: z.uuid() }),
  backup_selection_release: z.strictObject({ selectionId: z.uuid() }),
  capsule_state: empty,
  categories_create: z.strictObject({ name: z.string().min(1).max(512) }),
  categories_delete: z.strictObject({ name: z.string().min(1).max(512) }),
  categories_list: empty,
  categories_rename: z.strictObject({
    oldName: z.string().min(1).max(512),
    newName: z.string().min(1).max(512),
  }),
  clipboard_action: clipboardRequest,
  clipboard_image_ocr: z.strictObject({ id }),
  clipboard_read: empty,
  clipboard_write: z.strictObject({ text }),
  config_get: empty,
  config_migrate_data_dir: z.strictObject({ newDataDir: location }),
  config_patch: z.strictObject({
    patch: configPatchSchema,
    expectedCommandShortcuts: z.record(z.string(), z.string().max(100)).optional(),
    expectedShortcuts: z
      .strictObject({
        globalShortcut: z.string().max(100),
        toggleVisibilityShortcut: z.string().max(100),
      })
      .optional(),
  }),
  config_save: z.strictObject({ config: z.record(z.string(), z.json()) }),
  copy_background_image: z.strictObject({ sourcePath: location }),
  desktop_prepare_report: z.strictObject({
    requestId: id,
    status: z.enum(["ready", "failed"]),
    message: z.string().max(4096).optional(),
  }),
  desktop_ready: empty,
  diagnostics_clear: empty,
  diagnostics_export: z.strictObject({ filter: diagnosticFilter.optional() }).optional(),
  diagnostics_list: z.strictObject({ filter: diagnosticFilter.optional() }).optional(),
  diagnostics_subscribe: empty,
  diagnostics_unsubscribe: empty,
  dialog_message: z.strictObject({
    text,
    title: z.string().max(1000).optional(),
    kind: z.enum(["info", "warning", "error", "question"]).optional(),
  }),
  dialog_open: dialog.extend({
    directory: z.boolean().optional(),
    multiple: z.boolean().optional(),
  }),
  dialog_save: dialog,
  fold_note_window: empty,
  get_file_modified_time: fileArgs,
  global_shortcut_check: z.strictObject({ shortcut: z.string().max(100) }),
  hide_note_on_desktop: noteArgs,
  images_clean_unused: noteArgs.extend({ content: text }),
  images_get_base_dir: empty,
  images_save: z.strictObject({
    data: z
      .custom<Uint8Array>((value) => value instanceof Uint8Array)
      .refine((value) => value.byteLength <= 32 * 1024 * 1024),
    headers: z.strictObject({ "x-note-id": id, "x-image-ext": z.string().min(1).max(16) }),
  }),
  images_save_from_path: noteArgs.extend({ filePath: location }),
  launcher_cancel_query: z.strictObject({
    sessionId: z.string().min(1).max(100),
    requestId: id.optional(),
  }),
  launcher_complete_onboarding: empty,
  launcher_composition: z.strictObject({ active: z.boolean() }),
  launcher_context_clear: empty,
  launcher_context_files: z.strictObject({ paths: z.array(location).min(1).max(100) }),
  launcher_enter_mode: z.strictObject({ mode: z.string().max(170) }),
  launcher_execute: pluginArgs.extend({
    id: id.optional(),
    commandId: z.string().max(80).optional(),
    context: publicContext.optional(),
  }),
  launcher_hide: empty,
  launcher_learning_update: z.union([
    z.strictObject({ enabled: z.boolean() }),
    z.strictObject({ clear: z.literal(true) }),
  ]),
  launcher_pick_directory: empty,
  launcher_preference_update: z.strictObject({
    key: id.optional(),
    selectionId: id.optional(),
    operation: z.enum([
      "pin",
      "unpin",
      "aliases",
      "hide",
      "show",
      "move-up",
      "move-down",
      "remove",
    ]),
    aliases: z.array(z.string().max(100)).max(32).optional(),
  }),
  launcher_query: z.strictObject({
    query: z.string().max(8192),
    sessionId: z.string().min(1).max(100),
    mode: z.string().max(170).optional(),
    directory: location.optional(),
  }),
  launcher_return: empty,
  launcher_state: empty,
  launcher_take_workspace: empty,
  note_context_menu: empty,
  note_set_pinned: noteArgs.extend({ pinned: z.boolean() }),
  note_window_states: empty,
  notes_create: z.strictObject({ request: note }),
  notes_delete: z.strictObject({ id }),
  notes_export_markdown: fileArgs.extend({ id }),
  notes_get: z.strictObject({ id }),
  notes_import_markdown: fileArgs.extend({ category: z.string().max(512).optional() }),
  notes_list: empty,
  notes_move_category: z.strictObject({ id, category: z.string().max(512) }),
  notes_set_editor_mode: z.strictObject({ id, mode: z.enum(["text", "markdown"]) }),
  notes_update: z.strictObject({ id, request: note }),
  open_note_in_editor: noteArgs,
  open_notepad_window: windowArgs,
  open_tile_window: windowArgs,
  plugin_settings_get: pluginArgs,
  plugin_settings_save: pluginArgs.extend({
    revision: z.string().length(64),
    patch: z.record(z.string(), z.json()),
  }),
  plugins_activate: pluginArgs.extend({ commandId: z.string().max(80).optional() }),
  plugins_cancel_install: z.strictObject({ previewId: z.uuid() }),
  plugins_cancel_package_task: z.strictObject({ taskId: z.uuid() }),
  plugins_check_updates: empty,
  plugins_confirm_install: z.strictObject({ previewId: z.uuid(), trustNative: z.boolean() }),
  plugins_enable: pluginArgs.extend({ enabled: z.boolean() }),
  plugins_import: empty,
  plugins_import_directory: empty,
  plugins_list: empty,
  plugins_prepare_bundled: pluginArgs,
  plugins_prepare_registry: z.strictObject({
    name: z.string().min(1).max(214),
    registry: z.url().max(8192).optional(),
    channel: z.string().max(100).optional(),
  }),
  plugins_prepare_update: pluginArgs,
  plugins_release_notes: pluginArgs,
  plugins_uninstall: pluginArgs.extend({ deleteData: z.boolean() }),
  read_external_file: fileArgs,
  recycle_notepad_window: empty,
  reminders_cancel: z.strictObject({ id }),
  reminders_list: empty,
  reminders_set: noteArgs.extend({
    fireAt: z.iso.datetime({ offset: true }),
    taskText: z.string().max(10000).optional(),
  }),
  save_external_file: fileArgs.extend({ content: text }),
  // History rows are addressed by their entry id; only list and clear are global.
  screenshot_action: z.strictObject({
    action: z.enum(["list", "copy", "save", "ocr", "remove", "clear"]),
    id: id.optional(),
  }),
  search_scope_get: empty,
  search_scope_pick: empty,
  search_scope_save: searchSettings,
  search_service_configure: z.strictObject({
    excludedRoots: z.array(location).max(128),
    volumeEnabled: z.array(z.strictObject({ id, enabled: z.boolean() })).max(128),
  }),
  search_service_rebuild: empty,
  search_service_status: empty,
  settings_open: z.strictObject({
    page: z
      .enum(["general", "shortcuts", "tray", "entries", "plugins", "backup", "diagnostics"])
      .optional(),
    pluginId: plugin.optional(),
    tab: z.enum(["config", "functions", "matching", "info"]).optional(),
  }),
  shell_open: z.strictObject({ url: z.url().max(32768) }),
  show_note_on_desktop: noteArgs,
  start_shortcut_recording: empty,
  stop_shortcut_recording: empty,
  surface_state: z.strictObject({
    noteId: id.nullable().optional(),
    mode: z.enum(["tile", "pad"]),
  }),
  take_startup_file: empty,
  text_action: z.strictObject({
    target: z.enum(["notes", "dictionary", "translate"]),
    text: z
      .string()
      .min(1)
      .max(1024 * 1024),
  }),
  toggle_tile_window: windowArgs,
  translation_action: translationRequest,
  translation_configure: z.strictObject({
    action: z.literal("configure"),
    endpoint: z.string().max(8192),
    model: z.string().max(200),
    key: z.string().max(8192).optional(),
  }),
  update_cancel: empty,
  update_check: z.strictObject({ manual: z.boolean() }),
  update_download: z.strictObject({ source: z.enum(["mirrorChyan", "github"]).optional() }),
  update_install: empty,
  update_install_prepare_report: z.strictObject({
    requestId: id,
    windowLabel: id,
    status: z.enum(["ready", "failed"]),
    message: z.string().max(4096).optional(),
  }),
  update_mirror_chyan_cdk_clear: empty,
  update_mirror_chyan_cdk_get: empty,
  update_mirror_chyan_cdk_set: z.strictObject({ cdk: z.string().max(8192) }),
  update_settings_get: empty,
  update_settings_save: z.strictObject({
    settings: z.strictObject({
      autoCheck: z.boolean(),
      autoDownload: z.boolean(),
      checkIntervalHours: z.number().finite().positive(),
      checkSourcePreference: z.enum(["mirrorChyanFirst", "githubFirst"]),
      downloadSourcePreference: z.enum(["mirrorChyanFirst", "githubFirst"]),
      channel: z.enum(["stable", "beta"]),
      allowPrerelease: z.boolean(),
      lastAutoCheckAt: z.string().nullable().optional(),
      hasMirrorChyanCdk: z.boolean(),
      mirrorChyanCdkLength: z.number().int().nullable().optional(),
    }),
  }),
  update_status: empty,
  window_control: z.union([
    z.strictObject({
      action: z.enum([
        "show",
        "focus",
        "hide",
        "close",
        "minimize",
        "toggleMaximize",
        "isMaximized",
        "isAlwaysOnTop",
        "bounds",
        "position",
        "size",
      ]),
    }),
    z.strictObject({ action: z.literal("alwaysOnTop"), value: z.boolean() }),
    z.strictObject({ action: z.literal("setPosition"), value: position }),
    z.strictObject({ action: z.literal("setSize"), value: size }),
    z.strictObject({ action: z.literal("setBounds"), value: bounds }),
  ]),
  capsule_activate: z.strictObject({ id }),
  capsule_drag_end: z.strictObject({ cancel: z.boolean().optional() }).optional(),
  capsule_drag_start: z.strictObject({ id }),
  capsule_hide: z.strictObject({ id }),
  capsule_hover: z.strictObject({ id }),
  capsule_menu: z.strictObject({ id }),
  capsule_open: z.strictObject({ id }),
  capsule_scroll: z.strictObject({ delta: z.number().finite() }),
} satisfies Record<CommandName, z.ZodType>;

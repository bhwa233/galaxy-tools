import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  net,
  protocol,
  screen,
  session,
  shell,
  Tray,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { AppError, atomicWrite, confined, NoteStore, readJson } from "./store.js";
import { externalUrl, FileGrants, imagePath } from "./security.js";
import type { AppConfig } from "../src/features/settings/types.js";
import type { SaveNoteRequest } from "../src/features/notes/types.js";

import { initializeWindowsRuntime } from "./windows.js";

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
  }
});

const here = path.dirname(fileURLToPath(import.meta.url));
const rendererRoot = path.resolve(here, "../../dist");
const devUrl = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined;
if (devUrl && new URL(devUrl).origin !== "http://127.0.0.1:1420")
  throw new Error("Unexpected renderer dev server");
protocol.registerSchemesAsPrivileged([
  {
    scheme: "floral",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);
app.setName("floral-notepaper-electron");
const configDir = path.resolve(
  process.env.FLORAL_NOTEPAPER_CONFIG_DIR || path.join(app.getPath("appData"), "floral-notepaper"),
);
app.setPath("userData", path.join(configDir, "electron-profile"));
app.setAppUserModelId("com.floral-notepaper.electron");
const smokeOutput = process.argv.find((arg) => arg.startsWith("--smoke-output="))?.slice(15);
if (
  smokeOutput &&
  (!process.env.FLORAL_NOTEPAPER_CONFIG_DIR ||
    !process.env.FLORAL_NOTEPAPER_DATA_DIR ||
    process.env.FLORAL_NOTEPAPER_SMOKE !== "1")
)
  throw new Error("Smoke probes require explicit opt-in and isolated profile paths");
if (!app.requestSingleInstanceLock()) app.exit(0);
const grants = new FileGrants();
const windows = new Map<string, BrowserWindow>();
interface Layout {
  label: string;
  view: "main" | "notepad" | "tile";
  noteId?: string;
  bounds: Electron.Rectangle;
  visible: boolean;
  topmost: boolean;
}
const layouts = new Map<string, Layout>();
const pending = new Map<string, { windowId: number; resolve: (result: boolean) => void }>();
const ready = new Set<number>();
let store: NoteStore;
let tray: Tray;
let exiting = false;
let quitting = false;
let layoutTimer: ReturnType<typeof setTimeout> | undefined;
let startupFile: string | null = null;
let mutations: Promise<unknown> = Promise.resolve();
const emit = (name: string, payload?: unknown, target?: BrowserWindow) => {
  for (const win of target ? [target] : windows.values())
    if (!win.isDestroyed()) win.webContents.send(`floral:event:${name}`, payload);
};
function layoutFile(): string {
  return path.join(store.dataDir, "electron-layout.json");
}
function persistLayout(): void {
  if (layoutTimer) clearTimeout(layoutTimer);
  atomicWrite(
    layoutFile(),
    JSON.stringify(
      {
        version: 1,
        windows: [...layouts.values()].filter((entry) => entry.view === "main" || entry.noteId),
      },
      null,
      2,
    ),
  );
}
function scheduleLayout(): void {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(() => {
    try {
      persistLayout();
    } catch (error) {
      console.error("layout-save", error);
    }
  }, 250);
}
function labelOf(win: BrowserWindow): string {
  return [...windows].find(([, value]) => value === win)?.[0] ?? "";
}
function remember(win: BrowserWindow): void {
  const layout = layouts.get(labelOf(win));
  if (!layout || win.isDestroyed()) return;
  layout.bounds = win.getBounds();
  layout.topmost = win.isAlwaysOnTop();
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
function createWindow(layout: Layout): BrowserWindow {
  const existing = windows.get(layout.label);
  if (existing && !existing.isDestroyed()) {
    layout.visible = true;
    existing.show();
    existing.focus();
    return existing;
  }
  layout.bounds = safeBounds(layout.bounds, layout.view === "main");
  layouts.set(layout.label, layout);
  const win = new BrowserWindow({
    ...layout.bounds,
    title: "花笺",
    frame: false,
    transparent: true,
    show: false,
    resizable: true,
    minWidth: layout.view === "main" ? 900 : 160,
    minHeight: layout.view === "main" ? 620 : 60,
    skipTaskbar: layout.view !== "main",
    alwaysOnTop: layout.topmost,
    hasShadow: layout.view === "main",
    icon: path.join(here, "assets/icon.ico"),
    webPreferences: {
      preload: path.join(here, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: true,
      additionalArguments: [`--floral-label=${layout.label}`],
    },
  });
  windows.set(layout.label, win);
  win.setMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.webContents.on("will-navigate", (event) => event.preventDefault());
  win.webContents.on("will-attach-webview", (event) => event.preventDefault());
  win.webContents.on("render-process-gone", (_event, details) =>
    console.error("renderer-gone", layout.label, details.reason),
  );
  win.webContents.on("before-input-event", (_event, input) => {
    if (
      !recording ||
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
  win.on("move", () => remember(win));
  win.on("resize", () => {
    remember(win);
    emit("window-resized", null, win);
  });
  win.on("show", () => {
    layout.visible = true;
    scheduleLayout();
  });
  win.on("close", (event) => {
    if (exiting) return;
    event.preventDefault();
    if (layout.view === "main" && !store.config.closeToTray) void quit();
    else void hideAndRelease(win).catch((error) => reportError(error, win));
  });
  win.on("closed", () => {
    ready.delete(win.id);
    windows.delete(layout.label);
  });
  const params = new URLSearchParams({
    view: layout.view,
    ...(layout.noteId ? { noteId: layout.noteId } : {}),
  });
  void win
    .loadURL(`${devUrl || "floral://app/index.html"}?${params}`)
    .catch((error) => reportError(error));
  return win;
}
function showMain(): BrowserWindow {
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
function openNote(noteId?: string, view?: "notepad" | "tile", bounds?: Electron.Rectangle): string {
  if (noteId) store.get(noteId);
  const found = noteId
    ? [...layouts.values()].find((entry) => entry.noteId === noteId && entry.view !== "main")
    : undefined;
  const label = found?.label ?? `${view ?? "notepad"}-${noteId || randomUUID()}`;
  const layout: Layout = found ?? {
    label,
    view: view ?? "notepad",
    noteId,
    bounds: safeBounds(
      bounds ?? { width: store.config.surfaceWidth, height: store.config.surfaceHeight },
    ),
    visible: true,
    topmost: false,
  };
  layout.visible = true;
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
  return label;
}
async function prepare(win: BrowserWindow): Promise<boolean> {
  if (win.isDestroyed()) return true;
  if (!ready.has(win.id)) return false;
  const requestId = randomUUID();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(requestId);
      resolve(false);
    }, 10000);
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
async function hideAndRelease(win: BrowserWindow): Promise<void> {
  if (!(await prepare(win)))
    throw new AppError("saveFailed", "保存未完成，已保留窗口，请先保存再关闭");
  const layout = layouts.get(labelOf(win));
  if (!layout) return;
  remember(win);
  layout.visible = false;
  persistLayout();
  win.hide();
  if (layout.noteId) emit("tile-window-closed", layout.noteId);
  win.destroy();
  refreshTray();
}
async function quit(): Promise<void> {
  if (quitting) return;
  quitting = true;
  try {
    const saved = await Promise.all([...windows.values()].map(prepare));
    if (!saved.every(Boolean)) throw new AppError("saveFailed", "有窗口未完成保存，已取消退出");
    for (const win of windows.values()) remember(win);
    persistLayout();
    exiting = true;
    app.quit();
  } catch (error) {
    reportError(error);
  } finally {
    quitting = false;
  }
}
function reportError(error: unknown, win?: BrowserWindow): void {
  console.error(error);
  const options: Electron.MessageBoxOptions = {
    type: "error",
    title: "花笺",
    message: error instanceof Error ? error.message : String(error),
  };
  if (win && !win.isDestroyed()) void dialog.showMessageBox(win, options);
  else void dialog.showMessageBox(options);
}
function refreshTray(): void {
  if (!tray) return;
  const notes = store.list();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "打开便签管理", click: () => showMain() },
      { label: "新建便签", click: () => openNote() },
      { type: "separator" },
      {
        label: "找回便签",
        submenu: notes.length
          ? notes.map((note) => ({
              label: (note.title || note.preview || "无标题便签").slice(0, 50).replace(/&/g, "&&"),
              click: () => openNote(note.id),
            }))
          : [{ label: "暂无便签", enabled: false }],
      },
      { type: "separator" },
      { label: "退出（保存后关闭）", click: () => void quit() },
    ]),
  );
}
let recording = false;
function registerShortcuts(config: AppConfig): void {
  globalShortcut.unregisterAll();
  try {
    for (const [shortcut, action] of [
      [config.globalShortcut, () => openNote()],
      [
        config.toggleVisibilityShortcut,
        () => {
          const visible = [...windows.values()].filter((win) => win.isVisible());
          if (visible.length) for (const win of visible) win.hide();
          else {
            const notes = [...layouts.values()].filter(
              (entry) => entry.visible && entry.view !== "main",
            );
            if (notes.length) for (const entry of notes) createWindow(entry).show();
            else showMain();
          }
        },
      ],
    ] as const) {
      if (shortcut && !globalShortcut.register(shortcut, action))
        throw new AppError("shortcutConflict", `快捷键 ${shortcut} 无法注册，请在设置中更改`);
    }
  } catch (error) {
    globalShortcut.unregisterAll();
    throw error;
  }
}
function sender(event: Electron.IpcMainInvokeEvent): BrowserWindow {
  const win = BrowserWindow.fromWebContents(event.sender);
  const frame = event.senderFrame;
  const expectedOrigin = devUrl ? new URL(devUrl).origin : "floral://app";
  if (
    !win ||
    !windows.has(labelOf(win)) ||
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
};
async function handle(
  win: BrowserWindow,
  command: string,
  args: Record<string, any>,
): Promise<unknown> {
  const label = labelOf(win),
    layout = layouts.get(label)!;
  switch (command) {
    case "desktop_ready":
      ready.add(win.id);
      if (layout.visible) {
        win.show();
        win.focus();
      }
      return;
    case "app_version":
      return app.getVersion();
    case "app_name":
      return "花笺";
    case "notes_list":
      return store.list();
    case "notes_get":
      return store.get(text(args.id));
    case "notes_create": {
      const note = store.save(args.request as SaveNoteRequest);
      changed();
      return note;
    }
    case "notes_update": {
      const note = store.save(args.request as SaveNoteRequest, text(args.id));
      changed();
      return note;
    }
    case "notes_delete": {
      const id = text(args.id);
      const editors = [...layouts.values()].filter(
        (entry) => entry.noteId === id && windows.has(entry.label),
      );
      if (editors.length) throw new AppError("noteInUse", "请先关闭该便签的独立窗口再删除");
      await store.delete(id);
      for (const entry of layouts.values()) if (entry.noteId === id) layouts.delete(entry.label);
      persistLayout();
      changed();
      return;
    }
    case "categories_list":
      return store.categories();
    case "categories_create":
      store.createCategory(text(args.name));
      changed();
      return;
    case "categories_rename":
      store.renameCategory(text(args.oldName), text(args.newName));
      changed();
      return;
    case "categories_delete":
      store.deleteCategory(text(args.name));
      changed();
      return;
    case "notes_move_category": {
      const meta = store.move(text(args.id), text(args.category));
      changed();
      return meta;
    }
    case "notes_import_markdown": {
      const file = grants.assert(args.path, /\.md$/i),
        content = fs.readFileSync(file, "utf8");
      const note = store.save({
        title:
          content.match(/^\s*# (.+)$/m)?.[1]?.trim() || path.basename(file, path.extname(file)),
        content,
        category: args.category || "",
      });
      changed();
      return note;
    }
    case "notes_export_markdown":
      atomicWrite(grants.assert(args.path, /\.md$/i), store.get(text(args.id)).content);
      return;
    case "read_external_file":
      return fs.readFileSync(grants.assert(args.path, TEXT_FILE), "utf8");
    case "get_file_modified_time":
      return fs.statSync(grants.assert(args.path, TEXT_FILE)).mtimeMs;
    case "save_external_file":
      atomicWrite(grants.assert(args.path, TEXT_FILE), text(args.content));
      return;
    case "images_get_base_dir":
      return store.dataDir;
    case "images_save":
      return store.saveImage(
        text(args.headers?.["x-note-id"]),
        args.data,
        text(args.headers?.["x-image-ext"]),
      );
    case "images_save_from_path": {
      const file = grants.assert(args.filePath, IMAGE_FILE);
      return store.saveImage(text(args.noteId), fs.readFileSync(file), path.extname(file).slice(1));
    }
    case "images_clean_unused":
      return store.cleanImages(text(args.noteId), text(args.content));
    case "copy_background_image": {
      const file = grants.assert(args.sourcePath, IMAGE_FILE),
        dest = confined(store.dataDir, "backgrounds", `${randomUUID()}${path.extname(file)}`);
      atomicWrite(dest, fs.readFileSync(file));
      return dest;
    }
    case "config_get":
      return store.config;
    case "config_save": {
      const previous = store.config;
      const config = args.config as AppConfig;
      // Validate/write once before applying OS state, then roll back on native failure.
      if (config?.autostart && !app.isPackaged)
        throw new AppError("developmentOnly", "开机启动请在安装后的版本中设置");
      if (
        config?.backgroundImagePath &&
        config.backgroundImagePath !== previous.backgroundImagePath
      )
        imagePath(store.dataDir, config.backgroundImagePath);
      store.saveConfig(config);
      try {
        registerShortcuts(config);
        if (config.autostart !== previous.autostart)
          app.setLoginItemSettings({ openAtLogin: config.autostart, path: process.execPath });
      } catch (error) {
        store.saveConfig(previous);
        registerShortcuts(previous);
        throw error;
      }
      emit("config-changed", store.config);
      return store.config;
    }
    case "config_migrate_data_dir": {
      const dest = grants.assert(args.newDataDir);
      persistLayout();
      const config = store.migrate(dest);
      emit("config-changed", config);
      return config;
    }
    case "global_shortcut_check": {
      const shortcut = text(args.shortcut);
      if (!shortcut) return { available: true, conflictType: "none", message: "" };
      if ([store.config.globalShortcut, store.config.toggleVisibilityShortcut].includes(shortcut))
        return { available: true, conflictType: "current", message: "" };
      try {
        const available = globalShortcut.register(shortcut, () => {});
        if (available) globalShortcut.unregister(shortcut);
        return {
          available,
          conflictType: available ? "none" : "registered",
          message: available ? "" : "快捷键已被占用",
        };
      } catch {
        return { available: false, conflictType: "invalid", message: "快捷键格式无效" };
      }
    }
    case "start_shortcut_recording":
      recording = true;
      globalShortcut.unregisterAll();
      return;
    case "stop_shortcut_recording":
      recording = false;
      registerShortcuts(store.config);
      return;
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
          persistLayout();
        }
        return false;
      }
      openNote(id, "tile", args.bounds ?? undefined);
      return true;
    }
    case "recycle_notepad_window":
      await hideAndRelease(win);
      return;
    case "open_note_in_editor": {
      const main = showMain();
      const id = text(args.noteId);
      store.get(id);
      if (ready.has(main.id)) emit("open-note", id, main);
      else main.webContents.once("did-finish-load", () => emit("open-note", id, main));
      return;
    }
    case "take_startup_file": {
      const file = startupFile;
      startupFile = null;
      return file;
    }
    case "surface_state": {
      if (layout.view === "main") return;
      if (args.noteId) store.get(text(args.noteId));
      layout.noteId = args.noteId || undefined;
      layout.view = args.mode === "tile" ? "tile" : "notepad";
      scheduleLayout();
      return;
    }
    case "desktop_prepare_report": {
      const request = pending.get(text(args.requestId));
      if (request?.windowId === win.id) request.resolve(args.status === "ready");
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
          win.show();
          return;
        case "focus":
          win.focus();
          return;
        case "hide":
          await hideAndRelease(win);
          return;
        case "close":
          if (layout.view === "main" && !store.config.closeToTray) await quit();
          else await hideAndRelease(win);
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
          return win.isAlwaysOnTop();
        case "alwaysOnTop":
          if (typeof args.value !== "boolean")
            throw new AppError("invalidPayload", "置顶参数不合法");
          win.setAlwaysOnTop(args.value);
          remember(win);
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
        title: args.title || "花笺",
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
  ipcMain.handle("floral:invoke", async (event, command: unknown, args: unknown) => {
    try {
      const win = sender(event);
      if (
        typeof command !== "string" ||
        command.length > 100 ||
        (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args)))
      )
        throw new AppError("invalidPayload", "IPC 参数不合法");
      const run = () => handle(win, command, (args ?? {}) as Record<string, any>);
      // Disk writes and read/modify/write metadata transactions are globally serialized.
      const queued = /^(notes_|categories_|images_|config_|copy_background|save_external)/.test(
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
  ipcMain.handle("floral:emit", (event, name, payload) => {
    sender(event);
    if (name === "config-changed") {
      emit("config-changed", store.config);
      return;
    }
    if (!["tile-window-unpinned"].includes(name) || typeof payload !== "string")
      throw new AppError("permissionDenied", "不允许发布此事件");
    emit(name, payload);
  });
  ipcMain.handle("floral:drop", (event, paths: unknown) => {
    sender(event);
    if (
      !Array.isArray(paths) ||
      paths.length > 100 ||
      paths.some(
        (p) =>
          typeof p !== "string" ||
          !path.isAbsolute(p) ||
          !(TEXT_FILE.test(p) || IMAGE_FILE.test(p)) ||
          !fs.statSync(p).isFile(),
      )
    )
      throw new AppError("permissionDenied", "拖入文件不合法");
    for (const file of paths) grants.grant(file);
    return paths;
  });
}
app.on("second-instance", (_event, argv) => {
  startupFile = externalArg(argv);
  const main = showMain();
  if (startupFile && ready.has(main.id)) {
    emit("open-external-file", startupFile, main);
    startupFile = null;
  }
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
  globalShortcut.unregisterAll();
  tray?.destroy();
});
app
  .whenReady()
  .then(async () => {
    store = new NoteStore(configDir, path.join(app.getPath("documents"), "花笺"), (file) =>
      shell.trashItem(file),
    );
    startupFile = externalArg(process.argv.slice(1));
    protocol.handle("floral", async (request) => {
      try {
        const url = new URL(request.url);
        let file: string;
        if (url.host === "app")
          file = confined(rendererRoot, decodeURIComponent(url.pathname.slice(1)) || "index.html");
        else if (url.host === "asset")
          file = imagePath(
            store.dataDir,
            decodeURIComponent(url.pathname.slice(1)),
            store.config.backgroundImagePath,
          );
        else return new Response("Not found", { status: 404 });
        const result = await net.fetch(pathToFileURL(file).href);
        const headers = new Headers(result.headers);
        headers.set(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' floral://asset data: blob: https:; font-src 'self' data:; connect-src 'self' floral://asset; object-src 'none'; frame-src 'none'; base-uri 'none'",
        );
        headers.set("X-Content-Type-Options", "nosniff");
        headers.set("Access-Control-Allow-Origin", devUrl || "floral://app");
        return new Response(result.body, { status: result.status, headers });
      } catch {
        return new Response("Forbidden", {
          status: 403,
          headers: { "Access-Control-Allow-Origin": devUrl || "floral://app" },
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
    tray = new Tray(
      path.join(here, "assets", process.platform === "win32" ? "icon.ico" : "32x32.png"),
    );
    tray.setToolTip("花笺 Electron");
    tray.on("click", () => showMain());
    if (fs.existsSync(layoutFile())) {
      const saved = readJson<{ windows: Layout[] }>(layoutFile());
      for (const entry of saved.windows) {
        if (
          !entry ||
          typeof entry.label !== "string" ||
          !["main", "tile", "notepad"].includes(entry.view) ||
          !entry.bounds
        )
          throw new AppError("invalidLayout", "布局文件格式无效，请检查 electron-layout.json");
        if (entry.noteId && !store.list().some((note) => note.id === entry.noteId)) continue;
        layouts.set(entry.label, entry);
      }
      for (const entry of layouts.values()) if (entry.visible) createWindow(entry);
    } else {
      if (!store.list().length) {
        const note = store.save({ title: "", content: "", category: "" });
        openNote(note.id);
      } else showMain();
    }
    try {
      registerShortcuts(store.config);
    } catch (error) {
      console.error("shortcut-registration", error);
    }
    refreshTray();
    if (smokeOutput) {
      const { runSmoke } = await import("./smoke.js");
      await runSmoke({
        output: smokeOutput,
        gpuDiagnostics: () => ({
          crashCount: gpuCrashCount,
          features: app.getGPUFeatureStatus(),
          startedFromUnc: startupWorkingDirectory.startsWith("\\\\"),
          workingDirectoryIsLocal: !process.cwd().startsWith("\\\\"),
          sandboxEnabled:
            !app.commandLine.hasSwitch("no-sandbox") &&
            !app.commandLine.hasSwitch("disable-gpu-sandbox"),
        }),
        store,
        windows,
        layouts,
        openNote,
        showMain,
        hideAndRelease,
        emit,
        quit: () => {
          exiting = true;
          app.quit();
        },
      });
    }
  })
  .catch((error) => {
    reportError(error);
    app.exit(1);
  });

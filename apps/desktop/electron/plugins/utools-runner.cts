import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { UToolsStore } from "./utools-store.js";
import { atomicWrite } from "../persistence.js";
import { utoolsFeatureSchema, type UToolsManifest } from "./utools-manifest.js";
import type {
  UToolsDesktopPresentation,
  UToolsDesktopRequest,
} from "../../shared/utools-desktop.js";
import type { Rect } from "../../src/features/capsules/types.js";
const {
  app,
  BrowserWindow,
  WebContentsView,
  ipcMain,
  screen,
  shell,
  dialog,
  Notification,
  nativeTheme,
  clipboard,
  ClipboardItem,
  nativeImage,
  Menu,
} = require("electron") as typeof import("electron");

export async function startUToolsRunner(): Promise<void> {
  if (!process.send || !process.connected) throw new Error("兼容运行器必须由宿主私有通道启动");
  const profile = process.env.SPARK233_UTOOLS_PROFILE;
  delete process.env.SPARK233_UTOOLS_PROFILE;
  if (!profile || !path.isAbsolute(profile)) throw new Error("兼容运行器缺少独立浏览器目录");
  // Must precede app ready, otherwise Chromium keeps the default shared profile.
  fs.mkdirSync(profile, { recursive: true });
  app.setPath("userData", profile);
  app.setPath("sessionData", profile);
  let configuration: any;
  let window: import("electron").BrowserWindow | undefined;
  let view: import("electron").WebContentsView | undefined;
  let store: UToolsStore | undefined;
  let manifest: UToolsManifest;
  let state: any;
  let desktop: UToolsDesktopPresentation | undefined;
  let originalBounds: Rect | undefined;
  let originalMaximized = false;
  let entered = false;
  let menuOpen = false;
  let geometryTimer: ReturnType<typeof setTimeout> | undefined;
  let nativeGesture: number | undefined;
  let drag:
    | { pointerId: number; cursor: { x: number; y: number }; bounds: Rect; revision: number }
    | undefined;
  let committed: { revision: number; finish(): void } | undefined;
  let desktopOperations: Promise<void> = Promise.resolve();
  // activate/select each run an out -> enter handshake; overlapping them would
  // deliver enter(A), enter(B) without onPluginOut in between.
  let activationOperations: Promise<void> = Promise.resolve();
  const parentCalls = new Map<
    string,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let stopping = false,
    exiting = false,
    shown = false,
    visible = false,
    wantsVisible = true;
  const calls = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let pendingOut: Promise<any> | undefined;
  let outUncertain = false;
  const send = (value: object) => process.send?.({ ...value, token: configuration?.token });
  const reply = (id: string, value?: unknown, error?: unknown) =>
    send({ id, ...(error ? { error: String(error).slice(0, 4096) } : { value }) });
  const hostRequest = (value: UToolsDesktopRequest): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (!configuration?.desktopAvailable) return reject(new Error("桌面插件层尚未就绪"));
      if (parentCalls.size >= 64) return reject(new Error("窗口控制请求过多"));
      const id = randomUUID();
      const timer = setTimeout(() => {
        parentCalls.delete(id);
        reject(new Error("桌面窗口控制超时"));
      }, 15000);
      parentCalls.set(id, { resolve, reject, timer });
      send({ event: "desktop-request", id, value });
    });
  const reportBounds = (revision: number) => {
    if (!desktop || desktop.revision !== revision || !window) return;
    const b = window.getBounds();
    void hostRequest({
      type: "bounds",
      revision,
      bounds: { x: b.x, y: b.y + 40, width: b.width, height: b.height - 40 },
    }).catch((error) => update({ error: String(error) }));
  };
  const publish = () => {
    if (window && !window.isDestroyed()) window.webContents.send("utools:shell-state", state);
  };
  const layout = () => {
    if (!window || !view) return;
    const [width, height] = window.getContentSize();
    const top = (desktop ? 40 : 48) + (state.subInput ? 56 : 0) + (state.error ? 52 : 0);
    view.setVisible(!state.list);
    view.setBorderRadius(desktop ? 10 : 0);
    view.setBounds({
      x: desktop ? 1 : 0,
      y: top,
      width: width - (desktop ? 2 : 0),
      height: Math.max(1, height - top - (desktop ? 1 : 0)),
    });
  };
  const request = (operation: string, value?: unknown, timeout = 15000): Promise<any> => {
    if (operation === "out" && value === false && pendingOut) return pendingOut;
    const result = new Promise((resolve, reject) => {
      if (!view || view.webContents.isDestroyed()) return reject(new Error("插件页面已关闭"));
      const id = randomUUID();
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error("插件回调超时: " + operation));
      }, timeout);
      calls.set(id, {
        resolve: (value) => {
          if (operation === "out") entered = false;
          resolve(value);
        },
        reject,
        timer,
      });
      view.webContents.send("utools:request", { id, operation, value });
    });
    if (operation === "out" && value === false) {
      pendingOut = result;
      void result.then(
        () => {
          outUncertain = false;
          if (pendingOut === result) pendingOut = undefined;
        },
        () => {
          // A late callback can still clear the page after its acknowledgement
          // times out. The next activation must retry the lifecycle handshake.
          outUncertain = true;
          if (pendingOut === result) pendingOut = undefined;
        },
      );
    }
    return result;
  };
  const update = (value: Record<string, unknown>) => {
    for (const key of ["subInputValue", "inputFocus", "inputSelect"]) delete state[key];
    Object.assign(state, value);
    layout();
    publish();
  };
  const featuresFile = () => path.join(configuration.dataDir, "utools-features.json");
  const features = (): any[] => {
    try {
      return JSON.parse(fs.readFileSync(featuresFile(), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const nativeCall = (operation: string, args: any[]): unknown => {
    switch (operation) {
      case "bootstrap":
        return {
          ...configuration,
          preload: manifest.preload
            ? path.join(configuration.pluginRoot, manifest.preload)
            : undefined,
          localDataDir: configuration.dataDir,
          tempDir: configuration.cacheDir,
        };
      case "storage":
        return store!.storage(args[0], args[1], args[2]);
      case "db": {
        const [op, ...values] = args;
        if (
          ["postAttachment", "getAttachment", "getAttachmentType", "removeAttachment"].includes(op)
        )
          return store!.attachment(op, values[0], values[1], values[2]);
        if (!["get", "put", "remove", "allDocs", "bulkDocs"].includes(op))
          throw new Error("无效的数据库操作");
        return (store![op as "get"] as (...values: any[]) => unknown).apply(store, values);
      }
      case "ui": {
        if (Buffer.byteLength(JSON.stringify(args[0])) > 256 * 1024)
          throw new Error("插件界面更新超过限制");
        update(args[0]);
        return true;
      }
      case "height": {
        if (desktop) return true;
        const height = Number(args[0]);
        if (!Number.isFinite(height)) throw new Error("无效的高度");
        const [width] = window!.getSize();
        const area = screen.getDisplayMatching(window!.getBounds()).workArea;
        window!.setSize(
          width,
          Math.max(160, Math.min(area.height, height + 48 + (state.subInput ? 56 : 0))),
        );
        return true;
      }
      case "hide":
      case "out": {
        if (desktop) {
          void hostRequest({ type: "panel", revision: desktop.revision, action: "hide" }).catch(
            (error) => update({ error: String(error) }),
          );
          return true;
        }
        wantsVisible = false;
        window!.hide();
        if (visible) {
          visible = false;
          void request("out", false).catch((error) => update({ error: String(error) }));
        }
        return true;
      }
      case "show":
        if (desktop) {
          void hostRequest({ type: "panel", revision: desktop.revision, action: "show" }).catch(
            (error) => update({ error: String(error) }),
          );
          return true;
        }
        wantsVisible = true;
        if (configuration.show !== false) {
          window!.show();
          window!.focus();
          shown = true;
          visible = true;
        }
        return true;
      case "path": {
        const allowed = [
          "home",
          "temp",
          "desktop",
          "documents",
          "downloads",
          "music",
          "pictures",
          "videos",
          "userData",
        ];
        if (!allowed.includes(args[0])) throw new Error("未支持的系统目录");
        return app.getPath(args[0]);
      }
      case "features.get":
        return features().filter((f) => !args[0] || args[0].includes(f.code));
      case "features.set":
      case "features.remove": {
        // Validate with the host's schema: an entry the host cannot parse
        // would otherwise disable every feature of this plugin persistently.
        const parsed =
          operation === "features.set" ? utoolsFeatureSchema.safeParse(args[0]) : undefined;
        if (parsed && (!parsed.success || Buffer.byteLength(JSON.stringify(parsed.data)) > 32768))
          throw new Error("动态功能格式不合法");
        const feature = parsed?.data;
        const code = feature ? feature.code : args[0];
        const current = features(),
          next = current.filter((f) => f.code !== code);
        if (feature) next.push(feature);
        if (next.length > 100) throw new Error("动态功能超过 100 个");
        const serialized = JSON.stringify(next);
        if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("动态功能文件超过限制");
        atomicWrite(featuresFile(), serialized);
        return operation === "features.set" ? undefined : current.length !== next.length;
      }
      case "openDialog":
        return dialog.showOpenDialogSync(window!, args[0] || {});
      case "saveDialog":
        return dialog.showSaveDialogSync(window!, args[0] || {});
      case "notification": {
        if (!Notification.isSupported()) return;
        const notification = new Notification({
          title: configuration.title,
          body: String(args[0]).slice(0, 4096),
        });
        notification.show();
        return;
      }
      case "showItem":
        shell.showItemInFolder(String(args[0]));
        return;
      case "beep":
        shell.beep();
        return;
      case "screen": {
        const methods = [
          "getAllDisplays",
          "getPrimaryDisplay",
          "getCursorScreenPoint",
          "getDisplayNearestPoint",
          "getDisplayMatching",
          "screenToDipPoint",
          "dipToScreenPoint",
        ];
        if (!methods.includes(args[0])) throw new Error("未支持的屏幕操作");
        return (screen[args[0] as "getAllDisplays"] as (...values: any[]) => unknown)(
          ...args.slice(1),
        );
      }
      case "devtools":
        view!.webContents.openDevTools({ mode: "detach" });
        return;
      case "unsupported":
        update({ error: String(args[0]).slice(0, 2000) });
        send({ event: "diagnostic", message: String(args[0]).slice(0, 4096) });
        return;
      default:
        throw new Error("当前兼容版本不支持: " + operation);
    }
  };
  ipcMain.on("utools:call", async (event, { operation, args }) => {
    if (event.sender !== view?.webContents || event.senderFrame !== view.webContents.mainFrame) {
      event.returnValue = { ok: false, error: "来源不属于当前插件" };
      return;
    }
    try {
      if (stopping && !["bootstrap", "db", "storage", "unsupported"].includes(operation))
        throw new Error("插件正在停止");
      if (operation === "copyText") {
        await clipboard.writeText(String(args[0]));
        event.returnValue = { ok: true, value: true };
        return;
      }
      if (operation === "copyImage") {
        const image = args[0];
        const value =
          typeof image === "string"
            ? image.startsWith("data:")
              ? nativeImage.createFromDataURL(image)
              : nativeImage.createFromPath(image)
            : nativeImage.createFromBuffer(Buffer.from(image));
        if (value.isEmpty()) {
          event.returnValue = { ok: true, value: false };
          return;
        }
        await clipboard.write([
          new ClipboardItem({
            "image/png": new Blob([new Uint8Array(value.toPNG())], { type: "image/png" }),
          }),
        ]);
        event.returnValue = { ok: true, value: true };
        return;
      }
      if (operation === "fileIcon") {
        void app.getFileIcon(String(args[0])).then(
          (icon) => {
            event.returnValue = { ok: true, value: icon.toDataURL() };
          },
          (error) => {
            event.returnValue = { ok: false, error: String(error) };
          },
        );
        return;
      }
      event.returnValue = { ok: true, value: nativeCall(operation, args) };
    } catch (error) {
      event.returnValue = { ok: false, error: String(error) };
    }
  });
  ipcMain.handle("utools:async", async (event, operation, value) => {
    if (
      event.sender !== view?.webContents ||
      event.senderFrame !== view.webContents.mainFrame ||
      stopping
    )
      throw new Error("插件来源失效");
    if (operation === "openExternal") return shell.openExternal(String(value));
    if (operation === "openPath") return shell.openPath(String(value));
    if (operation === "trash") return shell.trashItem(String(value));
    if (operation === "fileIcon") return (await app.getFileIcon(String(value))).toDataURL();
    throw new Error("未支持的系统操作");
  });
  ipcMain.handle("utools:db", (event, operation, args) => {
    if (event.sender !== view?.webContents || event.senderFrame !== view.webContents.mainFrame)
      throw new Error("插件来源失效");
    return nativeCall("db", [operation, ...args]);
  });
  ipcMain.on("utools:result", (event, { id, value, error }) => {
    if (event.sender !== view?.webContents || event.senderFrame !== view.webContents.mainFrame)
      return;
    const call = calls.get(id);
    if (!call) return;
    calls.delete(id);
    clearTimeout(call.timer);
    if (error) call.reject(new Error(String(error)));
    else call.resolve(value);
  });
  ipcMain.handle("utools:shell", async (event, operation, value) => {
    if (event.sender !== window?.webContents || event.senderFrame !== window.webContents.mainFrame)
      throw new Error("窗口来源失效");
    if (operation === "state") return state;
    if (operation === "desktop-ready") {
      if (committed && value === committed.revision) committed.finish();
      return;
    }
    if (operation === "mode-menu" || operation === "more-menu") {
      // The plugin view sits above DOM popups of the shell page; use native menus.
      const anchor =
        value && Number.isSafeInteger(value.x) && Number.isSafeInteger(value.y)
          ? { x: value.x, y: value.y }
          : {};
      const report = (error: unknown) => update({ error: String(error) });
      const template: import("electron").MenuItemConstructorOptions[] =
        operation === "mode-menu"
          ? [
              {
                label: "普通窗口",
                type: "radio",
                checked: !window.isAlwaysOnTop(),
                click: () => {
                  window!.setAlwaysOnTop(false);
                  update({ mode: "normal" });
                },
              },
              {
                label: "置顶",
                type: "radio",
                checked: window.isAlwaysOnTop(),
                click: () => {
                  window!.setAlwaysOnTop(true);
                  update({ mode: "topmost" });
                },
              },
              ...(state.desktopAvailable
                ? [
                    {
                      label: "常驻桌面",
                      type: "radio" as const,
                      checked: false,
                      enabled: !!entered && !!state.featureCode,
                      click: () => {
                        const b = window!.getBounds();
                        void hostRequest({
                          type: "pin",
                          featureCode: state.featureCode,
                          bounds: {
                            x: b.x,
                            y: b.y + 48,
                            width: b.width,
                            height: Math.max(160, b.height - 48),
                          },
                        }).catch(report);
                      },
                    },
                  ]
                : []),
            ]
          : [{ label: "重新加载", click: () => view?.webContents.reload() }];
      Menu.buildFromTemplate(template).popup({ window, ...anchor });
      return;
    }
    if (operation === "pin") {
      if (!entered || !state.featureCode) throw new Error("请先打开一个插件功能");
      const b = window.getBounds();
      return hostRequest({
        type: "pin",
        featureCode: state.featureCode,
        bounds: { x: b.x, y: b.y + 48, width: b.width, height: Math.max(160, b.height - 48) },
      });
    }
    if (operation === "desktop-action") {
      if (!desktop) throw new Error("插件尚未固定到桌面");
      return hostRequest(
        value === "unpin"
          ? { type: "unpin" }
          : { type: "panel", revision: desktop.revision, action: value.action, value: value.value },
      );
    }
    if (operation === "desktop-close-overlay") {
      if (desktop?.mode === "overlay")
        return hostRequest({ type: "close-overlay", revision: desktop.revision });
      return;
    }
    if (operation === "desktop-settings") {
      if (!desktop) return;
      const p = desktop;
      // The original WebContentsView sits above DOM popups. Keep its page
      // mounted and use Electron's existing menu for this shared toolbar button.
      const act = (action: "pin" | "passthrough", enabled: boolean) =>
        void hostRequest({ type: "panel", revision: p.revision, action, value: enabled }).catch(
          (error) => update({ error: String(error) }),
        );
      menuOpen = true;
      Menu.buildFromTemplate([
        {
          label: "置顶",
          type: "checkbox",
          checked: p.card.group === "top",
          click: (item) => act("pin", item.checked),
        },
        {
          label: "常驻时鼠标穿透",
          type: "checkbox",
          checked: p.card.inputMode === "passive",
          click: (item) => act("passthrough", item.checked),
        },
        { type: "separator" },
        {
          label: "取消固定到桌面",
          click: () =>
            void hostRequest({ type: "unpin" }).catch((error) => update({ error: String(error) })),
        },
      ]).popup({
        window,
        callback: () => {
          menuOpen = false;
          if (desktop)
            void hostRequest({ type: "focus", focused: window!.isFocused() }).catch(() => {});
        },
      });
      return;
    }
    if (operation === "desktop-pointer") {
      if (!desktop || !Number.isSafeInteger(value?.pointerId)) throw new Error("窗口拖动已失效");
      if (value.phase === "start") {
        drag = {
          pointerId: value.pointerId,
          cursor: screen.getCursorScreenPoint(),
          bounds: window.getBounds(),
          revision: desktop.revision,
        };
        return;
      }
      if (!drag || drag.pointerId !== value.pointerId || drag.revision !== desktop.revision) return;
      const cursor = screen.getCursorScreenPoint();
      const area =
        desktop.mode === "overlay" ? desktop.area : screen.getDisplayNearestPoint(cursor).workArea;
      const b = drag.bounds;
      window.setBounds({
        ...b,
        x: Math.round(
          Math.max(area.x, Math.min(area.x + area.width - b.width, b.x + cursor.x - drag.cursor.x)),
        ),
        y: Math.round(
          Math.max(
            area.y,
            Math.min(area.y + area.height - b.height, b.y + cursor.y - drag.cursor.y),
          ),
        ),
      });
      if (value.phase === "cancel") {
        window.setBounds(drag.bounds);
        drag = undefined;
      }
      if (value.phase === "end") {
        drag = undefined;
        reportBounds(desktop.revision);
      }
      return;
    }
    if (operation === "hide") {
      if (desktop)
        return hostRequest({ type: "panel", revision: desktop.revision, action: "hide" });
      wantsVisible = false;
      window.hide();
      if (visible) {
        visible = false;
        await request("out", false);
      }
      return;
    }
    if (operation === "minimize") {
      window.minimize();
      return;
    }
    if (operation === "maximize") {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
      return;
    }
    if (operation === "input") {
      if (typeof value !== "string" || value.length > 100000) throw new Error("输入超过限制");
      if (state.subInput) state.subInput.value = value;
      await request("input", value);
      return;
    }
    if (operation === "select") {
      await request("list-select", value);
      return;
    }
    throw new Error("未支持的窗口操作");
  });
  const open = async () => {
    if (window) return;
    await app.whenReady();
    const area = screen.getPrimaryDisplay().workArea;
    window = new BrowserWindow({
      width: Math.min(1000, area.width),
      height: Math.min((manifest.pluginSetting?.height || 636) + 104, area.height),
      minWidth: 320,
      minHeight: 160,
      frame: false,
      transparent: true,
      type: "toolbar",
      show: false,
      title: configuration.title,
      icon: manifest.logo ? path.join(configuration.pluginRoot, manifest.logo) : undefined,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(__dirname, "utools-shell-preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    });
    view = new WebContentsView({
      webPreferences: {
        preload: path.join(__dirname, "utools-preload.cjs"),
        sandbox: false,
        contextIsolation: false,
        nodeIntegration: false,
        webviewTag: false,
        webSecurity: true,
      },
    });
    window.contentView.addChildView(view);
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    for (const contents of [window.webContents, view.webContents]) {
      contents.on("before-input-event", (event, input) => {
        if (input.type === "keyDown" && input.key === "F12") {
          event.preventDefault();
          view!.webContents.toggleDevTools();
        }
      });
      contents.on("render-process-gone", (_event, details) => {
        if (!exiting) {
          send({ event: "crash", message: details.reason });
          app.exit(1);
        }
      });
    }
    view.webContents.on("will-navigate", (event, url) => {
      const target = manifest.main
        ? pathToFileURL(path.join(configuration.pluginRoot, manifest.main)).href
        : configuration.entryUrl;
      if (url !== target) event.preventDefault();
    });
    window.on("resize", layout);
    const markNativeGesture = () => {
      nativeGesture = desktop?.revision;
    };
    window.on("will-move", markNativeGesture);
    window.on("will-resize", markNativeGesture);
    const finishNativeGesture = () => {
      if (nativeGesture === undefined) return;
      const revision = nativeGesture;
      clearTimeout(geometryTimer);
      geometryTimer = setTimeout(() => {
        nativeGesture = undefined;
        reportBounds(revision);
      }, 150);
    };
    window.on("moved", finishNativeGesture);
    window.on("resized", finishNativeGesture);
    window.on("focus", () => {
      if (desktop) void hostRequest({ type: "focus", focused: true }).catch(() => {});
    });
    window.on("blur", () => {
      if (desktop && !menuOpen) void hostRequest({ type: "focus", focused: false }).catch(() => {});
    });
    window.on("maximize", () => update({ maximized: true }));
    window.on("unmaximize", () => update({ maximized: false }));
    window.on("close", (event) => {
      if (!exiting) {
        event.preventDefault();
        if (desktop) {
          void hostRequest({ type: "panel", revision: desktop.revision, action: "hide" }).catch(
            (error) => update({ error: String(error) }),
          );
          return;
        }
        wantsVisible = false;
        window!.hide();
        if (visible) {
          visible = false;
          void request("out", false).catch((error) => update({ error: String(error) }));
        }
      }
    });
    await Promise.all([
      window.loadFile(path.resolve(__dirname, "../../../dist/utools.html")),
      view.webContents.loadURL(configuration.entryUrl),
    ]);
    layout();
    await request("ready");
  };
  const shutdown = async () => {
    exiting = true;
    stopping = true;
    clearTimeout(geometryTimer);
    for (const call of parentCalls.values()) {
      clearTimeout(call.timer);
      call.reject(new Error("兼容运行器已停止"));
    }
    parentCalls.clear();
    committed?.finish();
    for (const item of calls.values()) {
      clearTimeout(item.timer);
      item.reject(new Error("兼容运行器已停止"));
    }
    calls.clear();
    if (view && !view.webContents.isDestroyed()) view.webContents.close();
    window?.destroy();
    store?.close();
    store = undefined;
  };
  process.on("message", async (message: any) => {
    if (!message || typeof message !== "object") return;
    const { id, operation, value } = message;
    let finishDesktop: (() => void) | undefined;
    if (operation === "desktop") {
      const previous = desktopOperations;
      desktopOperations = new Promise<void>((resolve) => {
        finishDesktop = resolve;
      });
      await previous;
    } else if (operation === "activate" || operation === "select") {
      const previous = activationOperations;
      activationOperations = new Promise<void>((resolve) => {
        finishDesktop = resolve;
      });
      await previous;
    }
    try {
      if (operation === "init") {
        if (configuration) throw new Error("不能重复初始化");
        configuration = value;
        manifest = value.manifest;
        fs.mkdirSync(value.cacheDir, { recursive: true });
        store = new UToolsStore(value.dataDir);
        state = {
          title: value.title,
          desktopAvailable: value.desktopAvailable,
          theme: value.theme,
          maximized: false,
          subInput: null,
          list: null,
        };
        nativeTheme.themeSource = value.theme.effective;
        return reply(id, { ready: true, pid: process.pid });
      }
      if (!configuration || message.token !== configuration.token)
        throw new Error("运行器身份不匹配");
      if (message.event === "desktop-result") {
        const call = parentCalls.get(id);
        if (call) {
          parentCalls.delete(id);
          clearTimeout(call.timer);
          if (message.error) call.reject(new Error(message.error));
          else call.resolve(value);
        }
        return;
      }
      if (operation === "stop") {
        if (view)
          try {
            await request("out", true, 5000);
          } catch (error) {
            send({ event: "diagnostic", message: "停止时的插件回调失败: " + String(error) });
          }
        await shutdown();
        reply(id, { ok: true });
        app.quit();
        return;
      }
      if (operation === "resume") {
        stopping = false;
        return reply(id, { ok: true });
      }
      if (operation === "prepare") {
        stopping = true;
        if (shown && window && value !== "crash") {
          const result = await dialog.showMessageBox(window, {
            type: "question",
            message: "停止此 uTools 插件？",
            detail: "请先保存插件中的修改。旧插件没有统一的保存确认接口。",
            buttons: ["取消", "已保存并停止"],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response !== 1) {
            stopping = false;
            return reply(id, { ok: false, reason: "用户取消停止插件" });
          }
        }
        store!.checkpoint();
        return reply(id, { ok: true });
      }
      if (stopping) throw new Error("插件正在停止");
      await open();
      if (operation === "desktop") {
        clearTimeout(geometryTimer);
        nativeGesture = undefined;
        drag = undefined;
        if (value === null) {
          desktop = undefined;
          window!.setAlwaysOnTop(false);
          window!.setMinimumSize(320, 160);
          window!.setFocusable(true);
          window!.setIgnoreMouseEvents(false);
          window!.setSkipTaskbar(false);
          if (originalBounds) {
            const area = screen.getDisplayMatching(originalBounds).workArea;
            const width = Math.min(originalBounds.width, area.width);
            const height = Math.min(originalBounds.height, area.height);
            window!.setBounds({
              x: Math.max(area.x, Math.min(originalBounds.x, area.x + area.width - width)),
              y: Math.max(area.y, Math.min(originalBounds.y, area.y + area.height - height)),
              width,
              height,
            });
          }
          if (originalMaximized) window!.maximize();
          update({ desktop: null });
          if (configuration.show !== false) window!.show();
          return reply(id, { ok: true });
        }
        const next = value as UToolsDesktopPresentation;
        if (!desktop) {
          originalBounds = window!.getBounds();
          originalMaximized = window!.isMaximized();
        }
        if (window!.isMaximized()) window!.unmaximize();
        if (desktop && next.revision < desktop.revision) throw new Error("过期的桌面窗口投影");
        const transition = !desktop || desktop.mode !== next.mode;
        if (transition) window!.hide();
        desktop = next;
        if (!entered) {
          const feature = [...features(), ...manifest.features].find(
            (f) => f.code === next.featureCode,
          );
          if (!feature) throw new Error("固定的插件功能已不存在");
          state.featureCode = feature.code;
          await request("enter", {
            code: feature.code,
            type: "text",
            payload: feature.cmds.find((c: unknown) => typeof c === "string") || feature.code,
            from: "main",
          });
          entered = true;
        }
        window!.setSkipTaskbar(true);
        window!.setFocusable(next.mode === "overlay" || next.card.inputMode === "interactive");
        window!.setIgnoreMouseEvents(next.mode === "desktop" && next.card.inputMode === "passive", {
          forward: true,
        });
        window!.setAlwaysOnTop(
          next.mode === "overlay" || next.card.group === "top",
          process.platform === "win32" ? "pop-up-menu" : "floating",
        );
        const b = next.card.bounds;
        window!.setMinimumSize(320, 200);
        window!.setBounds({
          x: Math.round(b.x),
          y: Math.round(b.y - 40),
          width: Math.round(b.width),
          height: Math.round(b.height + 40),
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => {
            committed = undefined;
            reject(new Error("桌面窗口布局确认超时"));
          }, 4000);
          committed = {
            revision: next.revision,
            finish: () => {
              clearTimeout(timer);
              committed = undefined;
              resolve();
            },
          };
          update({ desktop: next });
        });
        if (next.visible && configuration.show !== false) {
          if (!window!.isVisible()) window!.showInactive();
          if (next.mode === "overlay") window!.moveTop();
          shown = true;
          visible = true;
        } else {
          window!.hide();
          visible = false;
        }
        return reply(id, { ok: true });
      }
      if (operation === "activate") {
        const { revealOnly, ...action } = value;
        // A timed-out hide sets outUncertain; retry the handshake below
        // instead of failing this activation with the stale timeout.
        await pendingOut?.catch(() => undefined);
        if (revealOnly === true && entered && !outUncertain && state.featureCode === action.code) {
          if (desktop)
            await hostRequest({ type: "panel", revision: desktop.revision, action: "show" });
          if (configuration.show !== false) {
            window!.show();
            window!.focus();
            shown = true;
            visible = true;
          }
          return reply(id, { ok: true });
        }
        if (entered || outUncertain) await request("out", false);
        wantsVisible = true;
        update({ list: null, listTruncated: false, error: "", subInput: null });
        await request("enter", action);
        entered = true;
        state.featureCode = action.code;
        if (configuration.show !== false && wantsVisible) {
          window!.show();
          window!.focus();
          shown = true;
          visible = true;
        }
        return reply(id, { ok: true });
      }
      if (operation === "select") {
        await pendingOut?.catch(() => undefined);
        wantsVisible = true;
        if ((await request("select", value)) === true) {
          const selectedVisibility = wantsVisible;
          if (entered || outUncertain) await request("out", false);
          wantsVisible = selectedVisibility;
          // Same reset as activate: a stale legacy list would keep the page hidden.
          update({ list: null, listTruncated: false, error: "", subInput: null });
          await request("enter", value);
          entered = true;
          state.featureCode = value.code;
          if (configuration.show !== false && wantsVisible) {
            window!.show();
            window!.focus();
            shown = true;
            visible = true;
          }
        }
        return reply(id, { ok: true });
      }
      if (operation === "query") return reply(id, await request("query", value));
      if (operation === "theme") {
        configuration.theme = value;
        nativeTheme.themeSource = value.effective;
        update({ theme: value });
        await request("theme", value);
        return reply(id);
      }
      throw new Error("未支持的兼容请求");
    } catch (error) {
      reply(id, undefined, error);
    } finally {
      finishDesktop?.();
    }
  });
  process.on("disconnect", () => {
    void shutdown().finally(() => app.exit());
  });
  send({ event: "ready" });
}

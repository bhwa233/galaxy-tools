import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { UToolsStore } from "./utools-store.js";
import { atomicWrite } from "../persistence.js";
import type { UToolsManifest } from "./utools-manifest.js";
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
} = require("electron") as typeof import("electron");

export async function startUToolsRunner(): Promise<void> {
  if (!process.send || !process.connected) throw new Error("兼容运行器必须由宿主私有通道启动");
  let configuration: any;
  let window: import("electron").BrowserWindow | undefined;
  let view: import("electron").WebContentsView | undefined;
  let store: UToolsStore | undefined;
  let manifest: UToolsManifest;
  let state: any;
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
  const send = (value: object) => process.send?.({ ...value, token: configuration?.token });
  const reply = (id: string, value?: unknown, error?: unknown) =>
    send({ id, ...(error ? { error: String(error).slice(0, 4096) } : { value }) });
  const publish = () => {
    if (window && !window.isDestroyed()) window.webContents.send("utools:shell-state", state);
  };
  const layout = () => {
    if (!window || !view) return;
    const [width, height] = window.getContentSize();
    const top = 48 + (state.subInput ? 56 : 0) + (state.error ? 52 : 0);
    view.setVisible(!state.list);
    view.setBounds({ x: 0, y: top, width, height: Math.max(1, height - top) });
  };
  const request = (operation: string, value?: unknown, timeout = 15000): Promise<any> =>
    new Promise((resolve, reject) => {
      if (!view || view.webContents.isDestroyed()) return reject(new Error("插件页面已关闭"));
      const id = randomUUID();
      const timer = setTimeout(() => {
        calls.delete(id);
        reject(new Error("插件回调超时: " + operation));
      }, timeout);
      calls.set(id, { resolve, reject, timer });
      view.webContents.send("utools:request", { id, operation, value });
    });
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
        wantsVisible = false;
        window!.hide();
        if (visible) {
          visible = false;
          void request("out", false).catch((error) => update({ error: String(error) }));
        }
        return true;
      }
      case "show":
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
        const feature = args[0];
        if (
          operation === "features.set" &&
          (!feature ||
            typeof feature.code !== "string" ||
            !Array.isArray(feature.cmds) ||
            Buffer.byteLength(JSON.stringify(feature)) > 32768)
        )
          throw new Error("动态功能格式不合法");
        const code = operation === "features.set" ? feature.code : feature;
        const current = features(),
          next = current.filter((f) => f.code !== code);
        if (operation === "features.set") next.push(feature);
        if (next.length > 100) throw new Error("动态功能超过 100 个");
        atomicWrite(featuresFile(), JSON.stringify(next));
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
    if (operation === "hide") {
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
      show: false,
      title: configuration.title,
      icon: manifest.logo ? path.join(configuration.pluginRoot, manifest.logo) : undefined,
      backgroundColor: configuration.theme.effective === "dark" ? "#18181b" : "#ffffff",
      webPreferences: {
        preload: path.join(__dirname, "utools-shell-preload.cjs"),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
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
    window.on("maximize", () => update({ maximized: true }));
    window.on("unmaximize", () => update({ maximized: false }));
    window.on("close", (event) => {
      if (!exiting) {
        event.preventDefault();
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
    try {
      if (operation === "init") {
        if (configuration) throw new Error("不能重复初始化");
        configuration = value;
        manifest = value.manifest;
        app.setPath("userData", path.join(value.dataDir, "browser-profile"));
        fs.mkdirSync(value.cacheDir, { recursive: true });
        store = new UToolsStore(value.dataDir);
        state = {
          title: value.title,
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
      if (operation === "activate") {
        wantsVisible = true;
        update({ list: null, error: "", subInput: null });
        await request("enter", value);
        if (configuration.show !== false && wantsVisible) {
          window!.show();
          window!.focus();
          shown = true;
          visible = true;
        }
        return reply(id, { ok: true });
      }
      if (operation === "select") {
        wantsVisible = true;
        if ((await request("select", value)) === true) {
          await request("enter", value);
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
    }
  });
  process.on("disconnect", () => {
    void shutdown().finally(() => app.exit());
  });
  send({ event: "ready" });
}

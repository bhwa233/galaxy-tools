import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import type { UToolsFeature } from "./utools-manifest.js";
const { ipcRenderer } = require("electron") as typeof import("electron");
type Callback = (...args: unknown[]) => unknown;
const call = (operation: string, ...args: unknown[]): any => {
  const result = ipcRenderer.sendSync("utools:call", { operation, args });
  if (!result?.ok) throw new Error(result?.error || "兼容运行器未响应");
  return result.value;
};
const config = call("bootstrap");
const handlers = new Map<string, Callback[]>();
const on = (name: string, callback: Callback) => {
  if (typeof callback !== "function") throw new Error("回调必须是函数");
  handlers.set(name, [...(handlers.get(name) || []), callback]);
};
const emit = async (name: string, ...args: unknown[]) => {
  for (const callback of handlers.get(name) || []) await callback(...args);
};
let subInput: Callback | undefined;
let pushQuery: Callback | undefined;
let pushSelect: Callback | undefined;
let legacy: Record<string, any> | undefined;
let action: Record<string, unknown> | undefined;
let legacyRows: unknown[] = [];
let listRevision = 0;
let ready = false;
let preloadFailure: string | undefined;
const updateUI = (state: unknown) => call("ui", state);
const setList = (rows: unknown) => {
  if (!Array.isArray(rows) || rows.length > 1000) throw new Error("列表超过 1000 项或格式不正确");
  legacyRows = rows;
  updateUI({
    list: rows.map((item, index) => ({
      id: String(index),
      title: String(item.title || item.text || "").slice(0, 1000),
      description: String(item.description || "").slice(0, 2000),
    })),
  });
};
const storage = Object.fromEntries(
  ["getItem", "setItem", "removeItem", "clear"].map((op) => [
    op,
    (...args: unknown[]) => call("storage", op, ...args),
  ]),
);
const db = Object.fromEntries(
  [
    "get",
    "put",
    "remove",
    "allDocs",
    "bulkDocs",
    "postAttachment",
    "getAttachment",
    "getAttachmentType",
    "removeAttachment",
  ].map((op) => [
    op,
    (...args: unknown[]) => {
      const value = call("db", op, ...args);
      return op === "getAttachment" && value ? Buffer.from(value) : value;
    },
  ]),
);
db.promises = Object.fromEntries(
  Object.keys(db).map((op) => [
    op,
    async (...args: unknown[]) => {
      const value = await ipcRenderer.invoke("utools:db", op, args);
      return op === "getAttachment" && value ? Buffer.from(value) : value;
    },
  ]),
) as any;
const api: Record<string, unknown> = {
  onPluginReady: (cb: Callback) => {
    on("ready", cb);
    if (ready) void cb();
  },
  onPluginEnter: (cb: Callback) => on("enter", cb),
  onPluginOut: (cb: Callback) => on("out", cb),
  onPluginDetach: (cb: Callback) => on("detach", cb),
  onDbPull: (_cb: Callback) => undefined,
  onMainPush: (query: Callback, select: Callback) => {
    pushQuery = query;
    pushSelect = select;
  },
  dbStorage: storage,
  db,
  setSubInput: (callback: Callback, placeholder = "", isFocus = true) => {
    subInput = callback;
    updateUI({ subInput: { placeholder, value: "", focus: isFocus } });
    return true;
  },
  removeSubInput: () => {
    subInput = undefined;
    updateUI({ subInput: null });
    return true;
  },
  setSubInputValue: (value: string) => {
    updateUI({ subInputValue: value });
    return true;
  },
  subInputFocus: () => {
    updateUI({ inputFocus: true });
    return true;
  },
  subInputBlur: () => {
    updateUI({ inputFocus: false });
    return true;
  },
  subInputSelect: () => {
    updateUI({ inputSelect: true });
    return true;
  },
  setExpandHeight: (height: number) => call("height", height),
  hideMainWindow: (_focusPrevious = true) => call("hide"),
  showMainWindow: () => call("show"),
  outPlugin: () => call("out"),
  getWindowType: () => "detach",
  isDarkColors: () => config.theme.effective === "dark",
  isDev: () => false,
  isWindows: () => process.platform === "win32",
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isMacOs: () => process.platform === "darwin",
  allAiModels: async () => [],
  getAppVersion: () => config.hostVersion,
  getPluginLocalDataPath: () => config.localDataDir,
  getPluginTempPath: () => config.tempDir,
  getUser: () => null,
  getPath: (name: string) => call("path", name),
  copyText: (text: string) => call("copyText", String(text)),
  copyImage: (image: string | Uint8Array) => call("copyImage", image),
  getFeatures: (codes?: string[]) => call("features.get", codes),
  setFeature: (feature: UToolsFeature) => call("features.set", feature),
  removeFeature: (code: string) => call("features.remove", code),
  showNotification: (body: string, featureCode?: string) => call("notification", body, featureCode),
  showOpenDialog: (options: unknown) => call("openDialog", options),
  showSaveDialog: (options: unknown) => call("saveDialog", options),
  shellOpenExternal: (url: string) => ipcRenderer.invoke("utools:async", "openExternal", url),
  shellOpenPath: (file: string) => ipcRenderer.invoke("utools:async", "openPath", file),
  shellTrashItem: (file: string) => ipcRenderer.invoke("utools:async", "trash", file),
  shellShowItemInFolder: (file: string) => call("showItem", file),
  shellBeep: () => call("beep"),
  getFileIcon: (file: string) => call("fileIcon", file),
  getFileIconAsync: (file: string) => ipcRenderer.invoke("utools:async", "fileIcon", file),
  getAllDisplays: () => call("screen", "getAllDisplays"),
  getPrimaryDisplay: () => call("screen", "getPrimaryDisplay"),
  getCursorScreenPoint: () => call("screen", "getCursorScreenPoint"),
  getDisplayNearestPoint: (point: unknown) => call("screen", "getDisplayNearestPoint", point),
  getDisplayMatching: (rect: unknown) => call("screen", "getDisplayMatching", rect),
  screenToDipPoint: (point: unknown) => call("screen", "screenToDipPoint", point),
  dipToScreenPoint: (point: unknown) => call("screen", "dipToScreenPoint", point),
  openDeveloperTools: () => call("devtools"),
};
const utools = new Proxy(api, {
  get: (target, key) => {
    if (typeof key !== "string" || key === "then") return undefined;
    if (Object.hasOwn(target, key)) return target[key];
    return (..._args: unknown[]) => {
      const message = `当前兼容版本不支持 utools.${key}`;
      call("unsupported", message);
      throw new Error(message);
    };
  },
});
(window as unknown as Record<string, unknown>).utools = utools;
(globalThis as unknown as Record<string, unknown>).utools = utools;
ipcRenderer.on("utools:request", async (_event, { id, operation, value }) => {
  try {
    if (preloadFailure) throw new Error(preloadFailure);
    let result: unknown;
    if (operation === "ready") {
      if (!ready) {
        ready = true;
        await emit("ready");
      }
    } else if (operation === "enter") {
      const revision = ++listRevision;
      subInput = undefined;
      action = value;
      legacy = (window as unknown as { exports?: Record<string, any> }).exports?.[value.code];
      if (legacy?.mode === "list") {
        updateUI({
          list: [],
          subInput: { placeholder: legacy.args?.placeholder || "搜索", value: "", focus: true },
        });
        await legacy.args?.enter?.(value, (rows: unknown) => {
          if (revision === listRevision) setList(rows);
        });
      } else if (legacy?.mode === "none") await legacy.args?.enter?.(value);
      await emit("enter", value);
    } else if (operation === "out") {
      listRevision++;
      await emit("out", !!value);
    } else if (operation === "query") result = pushQuery ? await pushQuery(value) : [];
    else if (operation === "select") result = pushSelect ? await pushSelect(value) : true;
    else if (operation === "input") {
      const revision = ++listRevision;
      if (subInput) await subInput({ text: value });
      if (legacy?.mode === "list" && revision === listRevision)
        await legacy.args?.search?.(action, value, (rows: unknown) => {
          if (revision === listRevision) setList(rows);
        });
    } else if (operation === "list-select")
      await legacy?.args?.select?.(action, legacyRows[Number(value)]);
    else if (operation === "theme") {
      config.theme = value;
      await emit("theme", value);
    }
    ipcRenderer.send("utools:result", { id, value: result });
  } catch (error) {
    ipcRenderer.send("utools:result", { id, error: String(error) });
  }
});
window.addEventListener("error", (event) => {
  call("unsupported", String(event.error || event.message));
});
window.addEventListener("unhandledrejection", (event) => {
  call("unsupported", String(event.reason));
});
if (config.preload) {
  // uTools defines the entry as CommonJS even when the frontend package is ESM.
  // Node's VM and createRequire preserve module-relative requires and filenames.
  try {
    const source = fs.readFileSync(config.preload, "utf8").replace(/^#![^\n]*\n/, "");
    const mod = { exports: {} };
    const wrapper = vm.runInThisContext(
      "(function(require,module,exports,__filename,__dirname){\n" + source + "\n})",
      { filename: config.preload },
    );
    wrapper(
      createRequire(config.preload),
      mod,
      mod.exports,
      config.preload,
      path.dirname(config.preload),
    );
  } catch (error) {
    preloadFailure = "preload 加载失败: " + String(error);
    call("unsupported", preloadFailure);
  }
}

import {
  app,
  BrowserWindow,
  Menu,
  screen,
  protocol,
  session,
  type CustomScheme,
  type IpcMainInvokeEvent,
  type Session,
  type WebContents,
  WebContentsView,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import {
  localizePluginManifest,
  pluginCapabilitySchema,
  type JsonValue,
  type PluginActivation,
  type PluginCapability,
  type PluginManifest,
  type PluginOwner,
  type PluginSaveDecision,
  type PluginTheme,
  type PluginWebContext,
  type PluginWebEvent,
  type PluginWindowStopReason,
} from "@spark233/sdk";
import { atomicWrite, canonical, confined, inside } from "../persistence.js";
import { bindDevToolsShortcut } from "../host/windows.js";
import { PluginResourceScope, type StopDecision } from "./resources.js";
import { PendingRequests } from "./pending-requests.js";
import { PACKAGE_MIME, resolvePackageFile } from "./package-files.js";
import { WindowModeController, type PluginWindowDesktopHost } from "./window-desktop.js";
import type { WindowMode } from "../../shared/window-mode.js";

const SCHEME = "spark233-plugin";
const CHANNEL = "spark233:plugin-web:invoke";
let registered = false;
export function registerPluginProtocolScheme(additionalSchemes: CustomScheme[] = []): void {
  if (registered) {
    if (additionalSchemes.length)
      throw new Error("Host schemes must join the first protocol registration");
    return;
  }
  if (app.isReady()) throw new Error("Register the plugin protocol before Electron app ready");
  if (additionalSchemes.some((entry) => entry.scheme === SCHEME))
    throw new Error("Plugin scheme must not be registered twice");
  protocol.registerSchemesAsPrivileged([
    ...additionalSchemes,
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        bypassCSP: false,
        allowServiceWorkers: false,
      },
    },
  ]);
  registered = true;
}

export interface PluginWebCapabilityRequest {
  owner: PluginOwner;
  capability: PluginCapability;
  operation: string;
  payload?: JsonValue;
  signal: AbortSignal;
}
export interface WebPluginOptions {
  windowProfile?: string;
  getLocale?: () => string;
  scope: PluginResourceScope;
  pluginRoot: string;
  entryPath: string;
  manifest: PluginManifest;
  dataDir: string;
  grant: { capabilities: readonly PluginCapability[] };
  getTheme: () => PluginTheme;
  subscribeTheme?: (listener: () => void) => () => void;
  capabilityBroker?: (request: PluginWebCapabilityRequest) => Promise<JsonValue | undefined>;
  onCrash?: (error: Error) => void;
  /** Host presentation policy; never read from plugin IPC. */
  show?: boolean;
  /** Keeps this window on the desktop when the user chooses that mode. */
  desktop?: PluginWindowDesktopHost;
  timeoutMs?: number;
  /** Host-owned allowance for a bounded long action such as visible Windows UAC. */
  capabilityTimeoutMs?: (
    request: Pick<PluginWebCapabilityRequest, "capability" | "operation" | "payload">,
  ) => number | undefined;
}
export interface WebPluginController {
  readonly owner: PluginOwner;
  readonly window: BrowserWindow | undefined;
  checkStartup(): Promise<void>;
  query(activation: PluginActivation, signal?: AbortSignal): Promise<JsonValue | undefined>;
  activate(activation: PluginActivation): Promise<JsonValue | undefined>;
  prepareStop(reason: PluginWindowStopReason): Promise<StopDecision>;
  dispose(): Promise<void>;
}

const payloadObject = z.record(z.string(), z.json());
const storageKey = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,159}$/i);
const launcherPage = z.object({
  items: z
    .array(
      z.object({
        id: z.string().min(1).max(512),
        title: z.string().min(1).max(1000),
        description: z.string().max(4000).optional(),
        commandId: z.string().min(1).max(80),
        parameters: z.json().optional(),
        kind: z.string().max(40).optional(),
        icon: z
          .string()
          .max(32768)
          .regex(/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/)
          .optional(),
        actions: z
          .array(
            z.object({
              title: z.string().min(1).max(160),
              commandId: z.string().min(1).max(80),
              parameters: z.json().optional(),
            }),
          )
          .max(8)
          .optional(),
      }),
    )
    .max(100),
  hint: z.string().max(4000).optional(),
});
const CSP =
  "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; frame-src 'none'; child-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const SHELL_CHANNEL = "spark233:plugin-shell";
/** Height of the host status bar (WindowTitleBar h-12). */
export const SHELL_BAR_HEIGHT = 48;
/** Folded status bar of an unfocused desktop card. */
export const SHELL_STRIP_HEIGHT = 6;

// Reuse Electron sandbox/session/protocol, Zod, and the existing confined/atomic
// storage primitives. Existing note windows cannot safely own third-party pages.
class WebRuntime implements WebPluginController {
  readonly owner: PluginOwner;
  /** Host-owned shell window: status bar and window state. */
  private currentWindow?: BrowserWindow;
  /** The plugin page, in its own isolated session, inside the shell. */
  private currentView?: WebContentsView;
  private currentSession?: Session;
  /** Window mode chosen in the status bar (normal / always on top / desktop). */
  private modes?: WindowModeController;
  private get mode(): WindowMode {
    return this.modes?.mode ?? "normal";
  }
  private opening?: Promise<BrowserWindow>;
  private disposed = false;
  private crashed = false;
  private connected = false;
  /** Host API 1.7 window.status; cleared when the page reloads. */
  private status: { subtitle?: string; runState?: "unsaved" | "busy" | "error" } = {};
  private menuOpen = false;
  private peek?: ReturnType<typeof setInterval>;
  private saveApproved = false;
  private activation?: PluginActivation;
  private activationId?: string;
  private readonly root: string;
  private readonly entry: string;
  private readonly storageFile: string;
  private readonly hostname: string;
  private readonly entryUrl: string;
  private readyListeners = new Set<() => void>();
  private brokers = new Map<AbortController, () => Promise<void>>();
  private queries = new PendingRequests(32);
  private preparing?: {
    requestId: string;
    promise: Promise<StopDecision>;
    resolve: (decision: StopDecision) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private cleanup: Promise<void> = Promise.resolve();

  constructor(private options: WebPluginOptions) {
    if (!registered || !app.isReady())
      throw new Error("Plugin scheme registration and app ready are required");
    this.owner = options.scope.owner;
    if (this.owner.pluginId !== options.manifest.id)
      throw new Error("Plugin owner does not match manifest");
    if (
      !path.isAbsolute(options.pluginRoot) ||
      !path.isAbsolute(options.entryPath) ||
      !path.isAbsolute(options.dataDir)
    )
      throw new Error("Plugin paths must be host-resolved absolute paths");
    this.root = canonical(options.pluginRoot);
    this.entry = fs.realpathSync(options.entryPath);
    if (
      !inside(this.root, this.entry) ||
      !fs.statSync(this.entry).isFile() ||
      !/\.html$/i.test(this.entry)
    )
      throw new Error("Web entry is outside its verified package");
    this.storageFile = confined(options.dataDir, "web-storage.json");
    this.hostname = `p${createHash("sha256").update(JSON.stringify(this.owner)).digest("hex").slice(0, 40)}`;
    this.entryUrl = `${SCHEME}://${this.hostname}/${path.relative(this.root, this.entry).split(path.sep).map(encodeURIComponent).join("/")}`;
    options.scope.own("window", {
      prepareStop: (reason) => this.prepareStop(reason),
      dispose: () => this.dispose(),
    });
    if (options.subscribeTheme) {
      const unsubscribe = options.subscribeTheme(() => {
        this.applyWindowIdentity();
        this.publishShell();
        this.send({ type: "theme", owner: this.owner, theme: options.getTheme() });
      });
      options.scope.own("event", { dispose: unsubscribe });
    }
  }
  private async shellRequest(
    window: BrowserWindow,
    event: IpcMainInvokeEvent,
    operation: unknown,
    anchorInput?: unknown,
  ): Promise<unknown> {
    // Only the host shell page of this exact window may drive it.
    if (
      this.currentWindow !== window ||
      window.isDestroyed() ||
      event.sender !== window.webContents ||
      event.senderFrame !== window.webContents.mainFrame
    )
      throw new Error("Shell request is not from its own window");
    const anchor = z
      .strictObject({
        x: z.number().int().min(0).max(10000),
        y: z.number().int().min(0).max(10000),
      })
      .optional()
      .parse(anchorInput);
    const english = (this.options.getLocale?.() ?? "zh-CN").startsWith("en");
    const report = (error: unknown) => console.error("plugin-shell-menu", error);
    if (typeof operation === "string" && operation.startsWith("mode:")) {
      const next = operation.slice(5);
      if (next !== "normal" && next !== "topmost" && next !== "desktop")
        throw new Error("Unknown window mode");
      return this.setMode(next);
    }
    switch (operation) {
      case "state":
        return this.shellState();
      case "menu:mode": {
        // Native menus: DOM popups of the shell page would sit under the plugin view.
        const choose = (next: WindowMode) => void this.setMode(next).catch(report);
        const item = (mode: WindowMode, zh: string, en: string) => ({
          label: english ? en : zh,
          type: "radio" as const,
          checked: this.mode === mode,
          click: () => choose(mode),
        });
        Menu.buildFromTemplate([
          item("normal", "普通窗口", "Normal window"),
          item("topmost", "置顶", "Always on top"),
          ...(this.modes?.desktopAvailable ? [item("desktop", "常驻桌面", "Keep on desktop")] : []),
        ]).popup({ window, ...anchor, callback: this.holdBar() });
        return undefined;
      }
      case "menu:more": {
        const modes = this.modes;
        Menu.buildFromTemplate([
          ...(modes?.onDesktop
            ? [
                {
                  label: english ? "Lock position" : "锁定位置",
                  type: "checkbox" as const,
                  checked: modes.locked,
                  click: () => void modes.setLocked(!modes.locked).catch(report),
                },
                { type: "separator" as const },
              ]
            : []),
          {
            label: english ? "Reload" : "重新加载",
            click: () => void this.reloadPage().catch(report),
          },
        ]).popup({ window, ...anchor, callback: this.holdBar() });
        return undefined;
      }
      case "bar:peek":
        this.startPeek(window);
        return undefined;
      case "lock:on":
      case "lock:off":
        await this.modes?.setLocked(operation === "lock:on");
        return undefined;
      case "minimize":
        window.minimize();
        return undefined;
      case "toggleMaximize":
        if (!window.isResizable() || !window.isMaximizable()) return undefined;
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        return undefined;
      case "close":
        // On the desktop, close means "remove from desktop"; the page stays alive.
        if (this.mode === "desktop") {
          await this.modes?.removeFromDesktop();
          return undefined;
        }
        window.close();
        return undefined;
      default:
        throw new Error("Unsupported shell operation");
    }
  }
  get window(): BrowserWindow | undefined {
    return this.currentWindow;
  }
  private presentation() {
    const manifest = localizePluginManifest(
      this.options.manifest,
      this.options.getLocale?.() ?? "zh-CN",
    );
    const profile = this.options.windowProfile;
    const window =
      profile && Object.hasOwn(manifest.ui?.windows ?? {}, profile)
        ? manifest.ui!.windows![profile]
        : undefined;
    return { manifest, window, icon: window?.icon ?? manifest.ui?.icon };
  }
  private applyWindowIdentity() {
    const window = this.currentWindow;
    if (!window || window.isDestroyed()) return;
    const presentation = this.presentation();
    window.setTitle(presentation.window?.title ?? presentation.manifest.displayName);
    if (presentation.icon) {
      window.setIcon(confined(this.root, presentation.icon.png));
      if (process.platform === "win32")
        window.setAppDetails({
          appId: `com.spark233.desktop.${this.owner.pluginId}`,
          appIconPath: confined(this.root, presentation.icon.ico ?? presentation.icon.png),
          appIconIndex: 0,
        });
    }
  }
  private allowed(capability: PluginCapability): void {
    if (
      !this.options.manifest.capabilities.includes(capability) ||
      !this.options.grant.capabilities.includes(capability)
    )
      throw new Error(`Plugin capability was not declared and granted: ${capability}`);
  }
  private accepts(window: BrowserWindow): boolean {
    return (
      !this.disposed &&
      !this.crashed &&
      this.currentWindow === window &&
      !window.isDestroyed() &&
      this.options.scope.accepts(this.owner)
    );
  }
  private page(): WebContents | undefined {
    const contents = this.currentView?.webContents;
    return contents && !contents.isDestroyed() ? contents : undefined;
  }
  private send(event: PluginWebEvent): void {
    const window = this.currentWindow;
    const page = this.page();
    if (!window || !page || !this.accepts(window) || !this.connected) return;
    page.send("spark233:plugin-web:event", event);
  }
  /** Status bar state, pushed only to the trusted shell page. */
  private shellState() {
    const window = this.currentWindow;
    const presentation = this.presentation();
    return {
      title: presentation.window?.title ?? presentation.manifest.displayName,
      maximized: !!window && !window.isDestroyed() && window.isMaximized(),
      maximizable: presentation.window?.maximizable ?? true,
      locale: this.options.getLocale?.() ?? "zh-CN",
      theme: this.options.getTheme(),
      ...(this.modes?.state() ?? { mode: "normal" as const, desktopAvailable: false }),
      desktopAvailable: !!this.options.desktop,
      ...this.status,
      barCollapsed: this.barCollapsed(),
    };
  }
  /**
   * An unfocused desktop card folds its bar to a strip so the page fills the
   * card. Hovering the strip (unless locked), focus or an open menu unfolds it.
   */
  private barCollapsed(): boolean {
    const window = this.currentWindow;
    if (!window || window.isDestroyed() || this.mode !== "desktop") return false;
    if (window.isFocused() || this.menuOpen) return false;
    return !this.peek || !!this.modes?.locked;
  }
  private refreshBar(): void {
    this.layout();
    this.publishShell();
  }
  /** Keeps the bar unfolded while a native menu is open. */
  private holdBar(): () => void {
    this.menuOpen = true;
    this.refreshBar();
    return () => {
      this.menuOpen = false;
      this.refreshBar();
    };
  }
  /** Unfolds the bar while the cursor stays over it (checked on the host side). */
  private startPeek(window: BrowserWindow): void {
    if (this.mode !== "desktop" || this.modes?.locked || this.peek) return;
    this.peek = setInterval(() => {
      const point = screen.getCursorScreenPoint();
      const area = window.isDestroyed() ? undefined : window.getContentBounds();
      const over =
        !!area &&
        point.x >= area.x &&
        point.x < area.x + area.width &&
        point.y >= area.y &&
        point.y < area.y + SHELL_BAR_HEIGHT;
      if (over && this.currentWindow === window) return;
      clearInterval(this.peek);
      this.peek = undefined;
      if (!window.isDestroyed()) this.refreshBar();
    }, 150);
    this.refreshBar();
  }
  private profile(): string {
    return this.options.windowProfile ?? "main";
  }
  private async setMode(next: WindowMode): Promise<void> {
    await this.modes?.setMode(next);
  }
  /** Reloading drops unsaved page state, so it goes through save first. */
  private async reloadPage(): Promise<void> {
    const decision = await this.prepareStop("window-close");
    if (!decision.ok) throw new Error(decision.reason);
    this.saveApproved = false;
    this.connected = false;
    this.status = {};
    this.publishShell();
    this.page()?.reload();
  }
  private publishShell(): void {
    const window = this.currentWindow;
    if (window && !window.isDestroyed())
      window.webContents.send("spark233:plugin-shell:state", this.shellState());
  }
  /** Places the page below the host status bar. */
  private layout(): void {
    const window = this.currentWindow;
    const view = this.currentView;
    if (!window || window.isDestroyed() || !view) return;
    const [width, height] = window.getContentSize();
    const top = this.barCollapsed() ? SHELL_STRIP_HEIGHT : SHELL_BAR_HEIGHT;
    view.setBounds({ x: 0, y: top, width, height: Math.max(1, height - top) });
  }
  private context(): PluginWebContext {
    return {
      owner: { ...this.owner },
      theme: this.options.getTheme(),
      ...(this.activation ? { activation: this.activation, activationId: this.activationId } : {}),
    };
  }
  private storage(): Record<string, JsonValue> {
    if (!fs.existsSync(this.storageFile)) return {};
    if (fs.statSync(this.storageFile).size > 1024 * 1024)
      throw new Error("Plugin storage exceeds 1 MiB");
    return payloadObject.parse(JSON.parse(fs.readFileSync(this.storageFile, "utf8")));
  }
  private writeStorage(value: Record<string, JsonValue>): void {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json) > 1024 * 1024) throw new Error("Plugin storage exceeds 1 MiB");
    atomicWrite(this.storageFile, json);
  }
  private async request(
    window: BrowserWindow,
    event: IpcMainInvokeEvent,
    input: unknown,
  ): Promise<JsonValue | undefined> {
    const page = this.page();
    if (
      !this.accepts(window) ||
      !page ||
      event.sender !== page ||
      event.senderFrame !== page.mainFrame
    )
      throw new Error("Plugin request is not from its active main frame");
    if (new URL(event.senderFrame.url).href.split("#")[0] !== this.entryUrl)
      throw new Error("Plugin frame origin changed");
    const serialized = JSON.stringify(input);
    if (!serialized || Buffer.byteLength(serialized) > 256 * 1024)
      throw new Error("Plugin request exceeds 256 KiB");
    const request = z
      .strictObject({
        instanceId: z.literal(this.owner.instanceId),
        operation: z.string(),
        payload: z.json().optional(),
      })
      .parse(JSON.parse(serialized));
    if (
      this.options.scope.state !== "active" &&
      ![
        "context.get",
        "storage.get",
        "storage.set",
        "storage.remove",
        "lifecycle.result",
        "query.result",
      ].includes(request.operation)
    )
      throw new Error("Plugin is stopping");
    if (
      this.saveApproved &&
      this.options.scope.state !== "active" &&
      ["storage.set", "storage.remove", "query.result"].includes(request.operation)
    )
      throw new Error("Save was already acknowledged");
    const payload = () => payloadObject.parse(request.payload);
    switch (request.operation) {
      case "context.get": {
        this.connected = true;
        for (const listener of this.readyListeners) listener();
        return this.context() as unknown as JsonValue;
      }
      case "storage.get": {
        this.allowed("storage");
        const key = storageKey.parse(payload().key);
        const data = this.storage();
        return Object.hasOwn(data, key) ? data[key] : undefined;
      }
      case "storage.set": {
        this.allowed("storage");
        const data = payload();
        const key = storageKey.parse(data.key);
        const value = z.json().parse(data.value);
        this.writeStorage({ ...this.storage(), [key]: value });
        return undefined;
      }
      case "storage.remove": {
        this.allowed("storage");
        const key = storageKey.parse(payload().key);
        const data = this.storage();
        delete data[key];
        this.writeStorage(data);
        return undefined;
      }
      case "command.register": {
        const id = z.string().parse(payload().id);
        if (!this.options.manifest.commands.some((command) => command.id === id))
          throw new Error("Command is absent from plugin manifest");
        // The manifest owns routing; this operation acknowledges validation only.
        return undefined;
      }
      case "lifecycle.result": {
        const data = z
          .strictObject({
            requestId: z.string(),
            decision: z.union([
              z.strictObject({ ok: z.literal(true) }),
              z.strictObject({ ok: z.literal(false), reason: z.string().max(1000) }),
            ]),
          })
          .parse(request.payload);
        if (!this.preparing || this.preparing.requestId !== data.requestId)
          throw new Error("Stale plugin save acknowledgement");
        this.finishPreparation(data.decision);
        return undefined;
      }
      case "query.result": {
        const data = z
          .strictObject({
            requestId: z.string(),
            value: z.json().optional(),
            error: z.string().max(1000).optional(),
          })
          .parse(request.payload);
        if (!this.queries.has(data.requestId)) throw new Error("Stale plugin query result");
        try {
          if (data.error !== undefined) throw new Error(data.error);
          const value = launcherPage.parse(data.value);
          const declared = new Set(this.options.manifest.commands.map((command) => command.id));
          for (const item of value.items) {
            if (
              !declared.has(item.commandId) ||
              item.actions?.some((action) => !declared.has(action.commandId))
            )
              throw new Error("Query result names an undeclared plugin command");
          }
          this.queries.resolve(data.requestId, value as JsonValue);
        } catch (error) {
          this.queries.reject(
            data.requestId,
            error instanceof Error ? error : new Error(String(error)),
          );
        }
        return undefined;
      }
      case "window.minimize":
      case "window.toggleMaximize":
      case "window.isMaximized": {
        // This handler already authenticates the active owner and main frame.
        // No target window, coordinates or renderer-controlled flags are accepted.
        // Host API 1.7: available to every page; they act on the host shell window.
        z.undefined().parse(request.payload);
        if (request.operation === "window.isMaximized") return window.isMaximized();
        if (request.operation === "window.minimize") {
          window.minimize();
          return undefined;
        }
        if (!window.isResizable() || !window.isMaximizable())
          throw new Error("This plugin window cannot be maximized");
        if (window.isMaximized()) window.unmaximize();
        else window.maximize();
        return undefined;
      }
      case "window.status": {
        // Plain text only: the shell renders it as text, never as markup.
        const data = z
          .strictObject({
            subtitle: z
              .string()
              .max(80)
              .regex(/^[^\p{Cc}\p{Cf}]*$/u)
              .optional(),
            runState: z.enum(["unsaved", "busy", "error"]).optional(),
          })
          .parse(request.payload);
        this.status = {
          ...(data.subtitle ? { subtitle: data.subtitle } : {}),
          ...(data.runState ? { runState: data.runState } : {}),
        };
        this.publishShell();
        return undefined;
      }
      case "window.close": {
        const decision = await this.prepareStop("window-close");
        if (!decision.ok) throw new Error(decision.reason);
        setImmediate(() => {
          if (this.currentWindow === window) this.destroyWindow();
        });
        return undefined;
      }
      case "capability.invoke": {
        const data = z
          .strictObject({
            capability: pluginCapabilitySchema,
            operation: z.string().min(1).max(120),
            payload: z.json().optional(),
          })
          .parse(request.payload);
        this.allowed(data.capability);
        if (!this.options.capabilityBroker) throw new Error("Host capability is not implemented");
        const controller = new AbortController();
        const release = this.options.scope.own("task", { dispose: () => controller.abort() });
        this.brokers.set(controller, release);
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          const result = await Promise.race([
            this.options.capabilityBroker({
              owner: { ...this.owner },
              capability: data.capability,
              operation: data.operation,
              payload: data.payload,
              signal: controller.signal,
            }),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => {
                  controller.abort();
                  reject(new Error("Plugin capability timed out"));
                },
                this.options.capabilityTimeoutMs?.(
                  data as Pick<PluginWebCapabilityRequest, "capability" | "operation" | "payload">,
                ) ??
                  this.options.timeoutMs ??
                  10_000,
              );
            }),
            new Promise<never>((_, reject) =>
              controller.signal.addEventListener(
                "abort",
                () => reject(new Error("Plugin capability cancelled")),
                { once: true },
              ),
            ),
          ]);
          if (
            !this.accepts(window) ||
            this.options.scope.state !== "active" ||
            controller.signal.aborted
          )
            throw new Error("Stale plugin capability result");
          return result === undefined ? undefined : z.json().parse(result);
        } finally {
          if (timer) clearTimeout(timer);
          this.brokers.delete(controller);
          await release();
        }
      }
      default:
        throw new Error("Unsupported plugin operation");
    }
  }
  private async open(): Promise<BrowserWindow> {
    if (this.disposed || this.options.scope.state !== "active")
      throw new Error("Plugin window scope is not active");
    if (this.currentWindow && !this.currentWindow.isDestroyed()) return this.currentWindow;
    if (this.opening) return this.opening;
    const operation = (async () => {
      const ownSession = session.fromPartition(`spark233-plugin-${randomUUID()}`, { cache: false });
      this.currentSession = ownSession;
      ownSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      ownSession.setPermissionCheckHandler(() => false);
      ownSession.on("will-download", (event) => event.preventDefault());
      ownSession.webRequest.onBeforeRequest((details, callback) => {
        let allowed = false;
        try {
          const url = new URL(details.url);
          allowed =
            url.protocol === `${SCHEME}:` &&
            url.hostname === this.hostname &&
            !url.port &&
            !url.username &&
            !url.password &&
            details.resourceType !== "subFrame";
        } catch {
          /* Deny malformed URLs. */
        }
        callback({ cancel: !allowed });
      });
      ownSession.protocol.handle(SCHEME, (request) => {
        try {
          const url = new URL(request.url);
          if (
            request.method !== "GET" ||
            url.hostname !== this.hostname ||
            url.port ||
            url.username ||
            url.password
          )
            return new Response("Forbidden", { status: 403 });
          const resolved = resolvePackageFile(this.root, url.pathname, {
            extensions: Object.keys(PACKAGE_MIME).filter((extension) => extension !== ".ico"),
            maxBytes: () => 32 * 1024 * 1024,
          });
          if (!resolved) return new Response("Not found", { status: 404 });
          const { file, mime } = resolved;
          return new Response(new Uint8Array(fs.readFileSync(file)), {
            headers: {
              "Content-Type": mime,
              "Content-Security-Policy": CSP,
              "X-Content-Type-Options": "nosniff",
              "Cache-Control": "no-store",
            },
          });
        } catch {
          return new Response("Not found", { status: 404 });
        }
      });
      const declaration = this.presentation().window;
      const area = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
      // Every page gets the host status bar; titleBar "custom" is deprecated and ignored.
      const bar = SHELL_BAR_HEIGHT;
      // The shell is a host page in the default session; the plugin never runs in it.
      const window = new BrowserWindow({
        width: Math.min(declaration?.size?.width ?? 900, area.width),
        height: Math.min((declaration?.size?.height ?? 620) + bar, area.height),
        minWidth: Math.min(declaration?.minSize?.width ?? 160, area.width),
        minHeight: Math.min((declaration?.minSize?.height ?? 60) + bar, area.height),
        resizable: declaration?.resizable ?? true,
        maximizable: declaration?.maximizable ?? true,
        skipTaskbar: declaration?.taskbar === false,
        frame: false,
        show: false,
        title: this.options.manifest.displayName,
        webPreferences: {
          preload: fileURLToPath(new URL("./plugin-shell-preload.cjs", import.meta.url)),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          webSecurity: true,
          webviewTag: false,
          navigateOnDragDrop: false,
        },
      });
      const view = new WebContentsView({
        webPreferences: {
          session: ownSession,
          preload: fileURLToPath(new URL("./plugin-preload.cjs", import.meta.url)),
          sandbox: true,
          contextIsolation: true,
          nodeIntegration: false,
          nodeIntegrationInSubFrames: false,
          webSecurity: true,
          allowRunningInsecureContent: false,
          webviewTag: false,
          navigateOnDragDrop: false,
          additionalArguments: [`--spark233-instance=${this.owner.instanceId}`],
        },
      });
      window.contentView.addChildView(view);
      this.currentWindow = window;
      this.currentView = view;
      const page = view.webContents;
      bindDevToolsShortcut(window, { isolatedSession: true, contents: page });
      this.applyWindowIdentity();
      window.on("page-title-updated", (event) => event.preventDefault());
      this.connected = false;
      window.setMenuBarVisibility(false);
      // The shell page only ever shows the bundled status bar.
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (event) => event.preventDefault());
      window.webContents.on("will-attach-webview", (event) => event.preventDefault());
      window.webContents.ipc.handle(SHELL_CHANNEL, (event, name: unknown, anchor: unknown) =>
        this.shellRequest(window, event, name, anchor),
      );
      for (const change of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"])
        window.on(change as "maximize", () => this.publishShell());
      window.on("resize", () => this.layout());
      this.modes = new WindowModeController({
        window,
        desktop: this.options.desktop,
        pluginId: this.owner.pluginId,
        profile: this.profile(),
        title: () => this.shellState().title,
        taskbar: () => this.presentation().window?.taskbar !== false,
        desktopMinSize: (() => {
          const size = this.presentation().window?.desktopMinSize;
          return size && { width: size.width, height: size.height + SHELL_BAR_HEIGHT };
        })(),
        onChange: () => this.refreshBar(),
      });
      // Keyboard input belongs to the plugin page, not the status bar.
      window.on("focus", () => {
        if (this.currentView === view && !page.isDestroyed()) page.focus();
        this.refreshBar();
      });
      window.on("blur", () => this.refreshBar());
      this.layout();
      page.setWindowOpenHandler(() => ({ action: "deny" }));
      page.on("will-navigate", (event, url) => {
        if (url !== this.entryUrl) event.preventDefault();
      });
      page.on("will-frame-navigate", (event) => {
        if (!event.isMainFrame || event.url !== this.entryUrl) event.preventDefault();
      });
      page.on("will-redirect", (event) => event.preventDefault());
      page.on("will-attach-webview", (event) => event.preventDefault());
      page.on("render-process-gone", (_event, details) => {
        if (this.currentWindow !== window || this.disposed) return;
        this.crashed = true;
        this.connected = false;
        const error = new Error(`Plugin renderer exited: ${details.reason} (${details.exitCode})`);
        this.cancelQueries(error);
        this.finishPreparation({ ok: false, reason: error.message });
        this.options.onCrash?.(error);
      });
      page.ipc.handle(CHANNEL, (event, value: unknown) => this.request(window, event, value));
      window.on("close", (event) => {
        event.preventDefault();
        // Closing a desktop card (e.g. Alt+F4) removes it from the desktop only.
        if (this.mode === "desktop") {
          void this.modes
            ?.removeFromDesktop()
            .catch((error) => console.error("plugin-window-unpin", error));
          return;
        }
        void this.prepareStop("window-close").then((decision) => {
          if (decision.ok && this.currentWindow === window) this.destroyWindow();
        });
      });
      window.once("closed", () => {
        if (this.currentWindow === window) this.destroyWindow();
      });
      try {
        await Promise.all([
          window.loadFile(
            fileURLToPath(new URL("../../../dist/plugin-shell.html", import.meta.url)),
          ),
          page.loadURL(this.entryUrl),
        ]);
        if (!this.accepts(window)) throw new Error("Plugin window was released while loading");
      } catch (error) {
        this.destroyWindow();
        throw error;
      }
      return window;
    })();
    this.opening = operation.finally(() => {
      this.opening = undefined;
    });
    return this.opening;
  }
  async checkStartup(): Promise<void> {
    const window = await this.open();
    if (this.connected) return;
    await new Promise<void>((resolve, reject) => {
      const finish = () => {
        clearTimeout(timer);
        this.readyListeners.delete(finish);
        if (this.accepts(window) && this.connected) return resolve();
        // A page that never connected must not linger: it would keep its session
        // alive and the next activation should start from a fresh load.
        if (this.currentWindow === window && !this.connected) this.destroyWindow();
        reject(new Error("Plugin SDK did not complete its startup handshake"));
      };
      const timer = setTimeout(finish, this.options.timeoutMs ?? 10_000);
      this.readyListeners.add(finish);
    });
  }
  async activate(activation: PluginActivation): Promise<JsonValue | undefined> {
    if (this.disposed || this.options.scope.state !== "active")
      throw new Error("Plugin is not accepting activation");
    if (
      activation.commandId &&
      !this.options.manifest.commands.some((command) => command.id === activation.commandId)
    )
      throw new Error("Unknown plugin command");
    const existing = !!this.currentWindow;
    this.activation = structuredClone(activation);
    this.activationId = randomUUID();
    this.saveApproved = false;
    const window = await this.open();
    if (existing)
      this.send({
        type: "activation",
        owner: this.owner,
        activationId: this.activationId,
        activation: this.activation,
      });
    // A desktop card is shown by the layer's presentation; focusing raises it.
    // An existing desktop card is located: raised and briefly highlighted.
    if (this.options.show !== false) {
      if (this.modes?.onDesktop) this.modes.locate();
      else {
        window.show();
        window.focus();
      }
    }
    return undefined;
  }
  async query(activation: PluginActivation, signal?: AbortSignal): Promise<JsonValue | undefined> {
    signal?.throwIfAborted();
    if (
      !activation.commandId ||
      !this.options.manifest.commands.some((command) => command.id === activation.commandId)
    )
      throw new Error("Unknown plugin query command");
    await this.checkStartup();
    signal?.throwIfAborted();
    if (this.options.scope.state !== "active" || this.disposed || this.crashed)
      throw new Error("Plugin is not accepting queries");
    if (this.queries.size >= 32) throw new Error("Too many pending plugin queries");
    const requestId = randomUUID();
    const notifyCancel = () => {
      try {
        this.send({ type: "query-cancel", owner: this.owner, requestId });
      } catch {
        // Cancellation still settles locally if the renderer has already gone.
      }
    };
    const cancel = (error: Error) => {
      if (!this.queries.has(requestId)) return;
      notifyCancel();
      this.queries.reject(requestId, error);
    };
    const result = this.queries.open<JsonValue>(requestId, {
      timeoutMs: this.options.timeoutMs ?? 10_000,
      meta: undefined,
      onTimeout: () => {
        notifyCancel();
        return new Error("Plugin query timed out");
      },
    });
    const release = this.options.scope.own("task", {
      dispose: () => cancel(new Error("Plugin query cancelled")),
    });
    const abort = () => void release().catch(() => {});
    signal?.addEventListener("abort", abort, { once: true });
    try {
      if (signal?.aborted) abort();
      else {
        try {
          this.send({
            type: "query",
            owner: this.owner,
            requestId,
            activation: structuredClone(activation),
          });
        } catch (error) {
          cancel(error instanceof Error ? error : new Error(String(error)));
        }
      }
      return await result;
    } finally {
      signal?.removeEventListener("abort", abort);
      await release();
    }
  }
  private cancelQueries(error: Error): void {
    for (const requestId of this.queries.ids()) {
      this.send({ type: "query-cancel", owner: this.owner, requestId });
      this.queries.reject(requestId, error);
    }
  }
  private finishPreparation(decision: PluginSaveDecision): void {
    if (!this.preparing) return;
    const pending = this.preparing;
    this.preparing = undefined;
    clearTimeout(pending.timer);
    this.saveApproved = decision.ok;
    pending.resolve(decision);
  }
  prepareStop(reason: PluginWindowStopReason): Promise<StopDecision> {
    if (this.preparing) return this.preparing.promise;
    if (!this.currentWindow || this.currentWindow.isDestroyed()) {
      this.saveApproved = true;
      return Promise.resolve({ ok: true });
    }
    if (this.crashed || !this.page() || this.page()!.isCrashed())
      return Promise.resolve(
        reason === "crash"
          ? ((this.saveApproved = true), { ok: true })
          : { ok: false, reason: "Plugin renderer exited before save confirmation" },
      );
    if (!this.connected) {
      // The page never completed context.get, so it never received an activation
      // and cannot hold SDK state to save. Refusing here made the plugin unstoppable.
      this.saveApproved = true;
      return Promise.resolve({ ok: true });
    }
    const requestId = randomUUID();
    let resolve!: (decision: StopDecision) => void;
    const promise = new Promise<StopDecision>((finish) => {
      resolve = finish;
    });
    const timer = setTimeout(
      () => this.finishPreparation({ ok: false, reason: "Plugin save confirmation timed out" }),
      this.options.timeoutMs ?? 10_000,
    );
    this.preparing = { requestId, promise, resolve, timer };
    this.send({ type: "prepareStop", owner: this.owner, requestId, reason });
    return promise;
  }
  private destroyWindow(): void {
    this.cancelQueries(new Error("Plugin page closed before query completion"));
    const window = this.currentWindow;
    const view = this.currentView;
    const ownSession = this.currentSession;
    this.modes?.dispose();
    this.modes = undefined;
    this.currentWindow = undefined;
    this.currentView = undefined;
    this.currentSession = undefined;
    this.connected = false;
    for (const listener of this.readyListeners) listener();
    this.finishPreparation({ ok: false, reason: "Plugin page closed before save acknowledgement" });
    const releasing = [...this.brokers.values()].map((release) => release());
    this.brokers.clear();
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.ipc.removeHandler(CHANNEL);
      // A view's page is not destroyed with its window; close it explicitly.
      view.webContents.close();
    }
    if (window && !window.isDestroyed()) {
      window.webContents.ipc.removeHandler(SHELL_CHANNEL);
      window.destroy();
    }
    if (ownSession) {
      ownSession.protocol.unhandle(SCHEME);
      releasing.push(ownSession.clearStorageData());
    }
    this.cleanup = Promise.allSettled([this.cleanup, ...releasing]).then(() => {});
  }
  async dispose(): Promise<void> {
    if (this.disposed) return;
    if (this.currentWindow && !this.saveApproved)
      throw new Error("Plugin page requires successful save confirmation before release");
    this.disposed = true;
    this.destroyWindow();
    await this.cleanup;
  }
}

export async function createWebPluginRuntime(
  options: WebPluginOptions,
): Promise<WebPluginController> {
  const unsupported = options.manifest.capabilities.filter((capability) =>
    ["windows", "search.index", "clipboard.watch"].includes(capability),
  );
  if (unsupported.length)
    throw new Error("Unsupported Web capabilities: " + unsupported.join(", "));
  return new WebRuntime(options);
}

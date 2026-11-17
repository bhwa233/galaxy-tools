import type { BrowserWindow } from "electron";
import { randomUUID } from "node:crypto";
import {
  pluginWindowPageEntry,
  pluginWidgetDefinitions,
  windowCreateResultSchema,
} from "@spark233/sdk";
import type {
  JsonValue,
  PluginActivation,
  PluginOwner,
  PluginPackageMetadata,
  StopReason,
  WindowBinding,
} from "@spark233/sdk";
import type { DiagnosticKind } from "../../src/features/diagnostics/types.js";
import type { PluginTrayStateStore } from "../host/plugin-tray.js";
import { confined } from "../persistence.js";
import { routePluginWindow, windowOpenContext } from "../host/plugin-window-routing.js";
import { createTrustedBackend } from "./backend.js";
import { createCapabilityBroker } from "./capabilities.js";
import type { DesktopPluginHostOptions, WidgetSourceEvent } from "./desktop-host.js";
import type { ManagedPluginRuntime, PluginInstallation, PluginManager } from "./manager.js";
import { resolvePluginEntries } from "./manifest.js";
import { createNativePluginRuntime } from "./native-runtime.js";
import type { PluginPackagePaths } from "./package-installer.js";
import type { PluginResourceScope } from "./resources.js";
import { createUToolsRuntime } from "./utools-runtime.js";
import { loadUToolsNativeId } from "./utools-store.js";
import { createWebPluginRuntime, type WebPluginController } from "./web-host.js";

/** What runtime composition needs from the desktop plugin host. */
export interface RuntimeComposerContext {
  options: DesktopPluginHostOptions;
  manager: () => PluginManager;
  root: string;
  paths: PluginPackagePaths;
  trayStates: PluginTrayStateStore;
  widgetSubscribers: Map<string, Set<(event: WidgetSourceEvent) => void>>;
  diagnosticOutput: (
    owner: PluginOwner,
    stream: "stdout" | "stderr",
    bytes: number,
    kind: DiagnosticKind,
  ) => void;
}

/**
 * Builds the managed runtime of one installed plugin: the uTools runner, or the
 * combination of Node backend, native entries, capability broker and Web pages
 * it declares. Package management and IPC stay in the desktop plugin host.
 */
export async function composePluginRuntime(
  ctx: RuntimeComposerContext,
  installation: PluginInstallation,
  metadata: PluginPackageMetadata,
  scope: PluginResourceScope,
  startupCheckOnly: boolean,
  purpose?: "widget",
): Promise<ManagedPluginRuntime> {
  // Long-running commands declare their own budget (host API 1.7).
  const commandTimeout = (commandId?: string) =>
    commandId
      ? metadata.spark233.commands.find((command) => command.id === commandId)?.timeoutMs
      : undefined;
  if (metadata.spark233.compatibility)
    return createUToolsRuntime({
      scope,
      metadata,
      directory: installation.directory,
      dataDir: ctx.manager().dataDirectory(installation.pluginId),
      cacheDir: confined(ctx.paths.cacheRoot, "utools", scope.owner.instanceId),
      hostVersion: ctx.options.hostVersion,
      getNativeId: () => loadUToolsNativeId(confined(ctx.root, "utools-native-id")),
      trusted: installation.grant.native,
      startupCheckOnly,
      desktop: ctx.options.utoolsDesktop,
      resolveResource: ctx.options.resolveResource,
      getTheme: ctx.options.getTheme,
      subscribeTheme: ctx.options.subscribeTheme,
      onCrash: (error) => {
        void ctx
          .manager()
          .reportCrash(scope.owner, error)
          .catch((failure) => console.error("utools-crash", failure));
      },
      onDiagnostic: (message) =>
        console.error("utools-compatibility", scope.owner.pluginId, message),
    });
  const updateTray = ctx.trayStates.attach(scope, metadata.spark233);
  const widgetDefinitions = Object.keys(pluginWidgetDefinitions(metadata.spark233));
  if (widgetDefinitions.length && !startupCheckOnly) {
    let reason: StopReason = "disable";
    let resumeTimer: ReturnType<typeof setImmediate> | undefined;
    scope.own("event", {
      prepareStop: async (nextReason) => {
        reason = nextReason;
        if (resumeTimer) clearImmediate(resumeTimer);
        await ctx.options.onWidgetLifecycle?.(scope.owner, "quiesce", reason);
        return { ok: true };
      },
      cancelStop: () => {
        // ResourceScope changes to active only after all cancelStop hooks
        // finish. Reattach views on the next turn, with a fresh owner check.
        resumeTimer = setImmediate(() => {
          resumeTimer = undefined;
          if (scope.state === "active" && ctx.manager().isOwnerCurrent(scope.owner))
            void Promise.resolve()
              .then(() => ctx.options.onWidgetLifecycle?.(scope.owner, "resume", reason))
              .catch((error) => console.error("widget-resume", error));
        });
      },
      dispose: async () => {
        if (resumeTimer) clearImmediate(resumeTimer);
        ctx.widgetSubscribers.delete(scope.owner.instanceId);
        await ctx.options.onWidgetLifecycle?.(scope.owner, "revoke", reason);
      },
    });
  }
  const onEvent = (
    event: { name: string; payload?: JsonValue },
    source: "backend" | "native",
    entryId?: string,
  ) => {
    if (event.name === "tray-state") {
      try {
        updateTray(event.payload);
      } catch (error) {
        console.error("plugin-tray-state", error);
      }
    } else {
      try {
        ctx.options.onPluginEvent?.(scope.owner, event.name, event.payload);
      } catch (error) {
        console.error("plugin-event-listener", error);
      }
    }
    if (scope.state === "active") {
      const widgetEvent: WidgetSourceEvent = {
        owner: { ...scope.owner },
        source,
        ...(entryId ? { entryId } : {}),
        name: event.name,
        payload: event.payload,
      };
      for (const listener of ctx.widgetSubscribers.get(scope.owner.instanceId) ?? []) {
        try {
          listener(widgetEvent);
        } catch (error) {
          console.error("widget-source-listener", error);
        }
      }
    }
  };
  const entries = resolvePluginEntries(installation.directory, metadata);
  let openTransientWindow:
    | ((
        binding: WindowBinding,
        action: "open" | "create",
        parent?: BrowserWindow,
      ) => Promise<boolean>)
    | undefined;
  const backend = entries.backend
    ? await createTrustedBackend({
        scope,
        pluginRoot: installation.directory,
        entryPath: entries.backend.entry,
        dataDir: ctx.manager().dataDirectory(installation.pluginId),
        cacheDir: confined(ctx.paths.cacheRoot, "runtime", installation.pluginId),
        approveTrust: () => installation.grant.native,
        startupCheckOnly,
        hostCapabilities: installation.grant.capabilities,
        onHostCall: ctx.options.onBackendHostCall,
        openTransientWindow: (binding, action) =>
          openTransientWindow?.(binding, action) ?? Promise.resolve(false),
        onLogBytes: (stream, bytes) => ctx.diagnosticOutput(scope.owner, stream, bytes, "backend"),
        onEvent: (event) => onEvent(event, "backend"),
        onCrash: (error) => {
          void ctx
            .manager()
            .reportCrash(scope.owner, error)
            .catch((failure) => console.error("plugin-crash-recovery", failure));
        },
        activationTimeoutMs: (activation) => commandTimeout(activation.commandId),
      })
    : undefined;
  const official = await ctx.options.createOfficialRuntime?.(
    installation,
    metadata,
    scope,
    backend,
    startupCheckOnly,
  );
  if (official)
    return Object.assign(official, {
      // Extend the original runtime so class lifecycle methods keep their receiver.
      openWindow: async (instanceId, binding) => {
        if (!ctx.options.openOfficialWindow)
          throw new Error("Official window adapter is unavailable");
        const restore = metadata.spark233.ui?.windows?.[binding.windowId]?.restore;
        if (restore && binding.parameterVersion !== restore.parameterVersion)
          throw new Error("窗口恢复参数版本不受支持");
        if (restore?.commandId) {
          if (!backend) throw new Error("Window restore requires a backend");
          await backend.activate({ commandId: restore.commandId, parameters: { binding } });
        }
        windowOpenContext.getStore()?.assertActive?.();
        await ctx.options.openOfficialWindow(scope.owner.pluginId, instanceId, binding);
      },
      prepareWindowClose: (instanceId) =>
        ctx.options.prepareOfficialWindowClose?.(instanceId) ?? Promise.resolve({ ok: true }),
      closeWindow: (instanceId) =>
        ctx.options.closeOfficialWindow?.(instanceId) ?? Promise.resolve(),
      createWindowContent: async (windowId, creationId) => {
        const commandId = metadata.spark233.ui?.windows?.[windowId]?.create?.commandId;
        if (!commandId || !backend)
          throw new Error("Window creation needs a backend create command");
        return windowCreateResultSchema.parse(
          await backend.activate({
            commandId,
            parameters: { creationId, windowId },
          }),
        ).binding;
      },
      ...official,
    } satisfies Partial<ManagedPluginRuntime>);
  if (
    !entries.web &&
    Object.keys(entries.native).length &&
    metadata.spark233.commands.some((command) =>
      command.inputs.some((kind) => kind === "files" || kind === "image"),
    )
  )
    throw new Error("Generic native-only entries cannot yet resolve file/image resource handles");
  const native = Object.keys(entries.native).length
    ? await createNativePluginRuntime({
        scope,
        pluginRoot: installation.directory,
        entries: entries.native,
        capabilities: installation.grant.capabilities,
        dataDir: ctx.manager().dataDirectory(installation.pluginId),
        cacheDir: confined(ctx.paths.cacheRoot, "runtime", installation.pluginId),
        approveTrust: () => installation.grant.native,
        onOutputBytes: (stream, bytes) =>
          ctx.diagnosticOutput(scope.owner, stream, bytes, "native"),
        onEvent: (event) => onEvent(event, "native", event.entryId),
        onCrash: (error) => {
          void ctx
            .manager()
            .reportCrash(scope.owner, error)
            .catch((failure) => console.error("plugin-crash-recovery", failure));
        },
      })
    : undefined;
  const broker = entries.web
    ? createCapabilityBroker({
        scope,
        manifest: metadata.spark233,
        manager: () => ctx.manager(),
        updateTray,
        resolveResource: ctx.options.resolveResource,
        ...(backend
          ? {
              invokeBackend: (activation: PluginActivation, signal: AbortSignal) =>
                backend.activate(activation, signal),
            }
          : {}),
        ...(native
          ? {
              invokeNative: (entryId, activation, signal) =>
                native.request(entryId, activation, signal),
            }
          : {}),
      })
    : undefined;
  if (broker && ctx.options.subscribeResourceRevocations) {
    const stop = ctx.options.subscribeResourceRevocations((ids) => broker.revokeContext(ids));
    scope.own("event", { dispose: stop });
  }
  const webControllers = new Map<string, Promise<WebPluginController>>();
  const getWeb = (
    profile = Object.entries(metadata.spark233.ui?.windows ?? {}).find(([, window]) =>
      pluginWindowPageEntry(window),
    )?.[0],
    documentKey?: string,
    unified = false,
  ): Promise<WebPluginController | undefined> => {
    if (!entries.web && !profile) return Promise.resolve(undefined);
    const key = JSON.stringify([profile, documentKey]);
    const known = webControllers.get(key);
    if (known) return known;
    const declaration = profile ? metadata.spark233.ui?.windows?.[profile] : undefined;
    const pageEntry = declaration ? pluginWindowPageEntry(declaration) : undefined;
    if (declaration && !pageEntry) return Promise.resolve(undefined);
    const opening = createWebPluginRuntime({
      scope,
      pluginRoot: installation.directory,
      entryPath: pageEntry ? confined(installation.directory, pageEntry) : entries.web!,
      windowProfile: profile,
      windowInstanceId: unified ? documentKey : undefined,
      onWindowAttach: ctx.options.onWindowAttach,
      openTransientWindow: (binding, action, parent) =>
        openTransientWindow!(binding, action, parent),
      show: unified ? false : undefined,
      desktop: declaration?.purpose === "dialog" ? undefined : ctx.options.windowDesktop,
      getLocale: ctx.options.getLocale,
      manifest: metadata.spark233,
      dataDir: ctx.manager().dataDirectory(installation.pluginId),
      grant: installation.grant,
      getTheme: ctx.options.getTheme,
      subscribeTheme: ctx.options.subscribeTheme,
      capabilityBroker: broker,
      capabilityTimeoutMs: (request) => {
        const payload = request.payload;
        return request.capability === "node.backend" &&
          request.operation === "invoke" &&
          payload &&
          typeof payload === "object" &&
          !Array.isArray(payload) &&
          typeof payload.commandId === "string"
          ? commandTimeout(payload.commandId)
          : undefined;
      },
      onCrash: (error) => {
        void ctx
          .manager()
          .reportCrash(scope.owner, error)
          .catch((failure) => console.error("plugin-crash-recovery", failure));
      },
    });
    webControllers.set(key, opening);
    // A page that failed to open must not stay cached; the next request retries.
    opening.catch(() => {
      if (webControllers.get(key) === opening) webControllers.delete(key);
    });
    return opening;
  };
  // Dialogs reuse the existing isolated page/controller lifecycle, but never
  // acquire a durable instance or card placement. Only host-owned windows may
  // be supplied as parents; plugin IPC carries no native window identity.
  openTransientWindow = async (binding, action, source) => {
    const declaration = metadata.spark233.ui?.windows?.[binding.windowId];
    if (declaration?.purpose !== "dialog") return false;
    if (!pluginWindowPageEntry(declaration))
      throw new Error("Temporary windows require a declared page entry");
    if (declaration.restore && binding.parameterVersion !== declaration.restore.parameterVersion)
      throw new Error("窗口恢复参数版本不受支持");
    const invocation = windowOpenContext.getStore();
    const assertActive = () => {
      invocation?.assertActive?.();
      if (scope.state !== "active" || !ctx.manager().isOwnerCurrent(scope.owner))
        throw new Error("Temporary window owner is no longer active");
    };
    assertActive();
    let parent = source;
    if (!parent) {
      const candidates = await Promise.all(
        [...webControllers].map(async ([key, pending]) => ({
          key: JSON.parse(key) as [string | undefined, string | undefined],
          window: (await pending).window,
        })),
      );
      parent =
        candidates.find(
          (candidate) => invocation?.instanceId && candidate.key[1] === invocation.instanceId,
        )?.window ??
        candidates.find((candidate) => candidate.window?.isFocused())?.window ??
        candidates.find(
          (candidate) =>
            candidate.window?.isVisible() &&
            metadata.spark233.ui?.windows?.[candidate.key[0] ?? ""]?.purpose !== "dialog",
        )?.window;
    }
    const assertParent = () => {
      if (parent?.isDestroyed()) throw new Error("Temporary window parent was closed");
      if (parent && !parent.isFocusable())
        throw new Error("Temporary window parent is blocked by host interaction");
    };
    assertParent();
    const documentKey =
      declaration.reuse === "document"
        ? binding.contentId
        : declaration.reuse === "multiple" && action === "create"
          ? randomUUID()
          : undefined;
    if (declaration.reuse === "document" && !documentKey)
      throw new Error("Document windows require a stable content ID");
    const controller = await getWeb(binding.windowId, documentKey);
    if (!controller) throw new Error("Temporary window page is unavailable");
    await controller.checkStartup();
    assertActive();
    assertParent();
    if (parent && controller.window && parent !== controller.window) {
      let ancestor: BrowserWindow | null = parent;
      while (ancestor) {
        if (ancestor === controller.window)
          throw new Error("Temporary window ownership would be cyclic");
        ancestor = ancestor.getParentWindow();
      }
      controller.window.setParentWindow(parent);
    }
    const parameters = binding.contentId
      ? {
          ...(binding.parameters &&
          typeof binding.parameters === "object" &&
          !Array.isArray(binding.parameters)
            ? binding.parameters
            : {}),
          documentId: binding.contentId,
        }
      : binding.parameters;
    await controller.activate(parameters === undefined ? {} : { parameters });
    assertActive();
    return true;
  };
  // Startup widgets need the backend and lightweight owner; installing or
  // updating still checks the packaged main page, while ordinary startup
  // keeps its renderer cold until an explicit window command.
  const deferWeb =
    purpose === "widget" ||
    (!startupCheckOnly && Object.keys(metadata.spark233.ui?.windows ?? {}).length > 0) ||
    (!startupCheckOnly &&
      metadata.spark233.activation === "on-startup" &&
      !!backend &&
      widgetDefinitions.length > 0);
  const web = deferWeb ? undefined : await getWeb();
  if (
    !backend &&
    !web &&
    !entries.web &&
    !Object.keys(metadata.spark233.ui?.windows ?? {}).length
  ) {
    if (!native && !widgetDefinitions.length)
      throw new Error("Plugin has no supported runtime entry");
    if (native && purpose !== "widget") await native.checkStartup();
    return {
      activate: (activation, signal) =>
        native?.activate(activation, signal) ?? Promise.resolve(undefined),
      query: (activation, signal) =>
        native?.query(activation, signal) ?? Promise.resolve(undefined),
      executeWidget: async ({ activation, entryId, signal }) => {
        if (!native) throw new Error("Widget has no headless runtime");
        return entryId
          ? native.request(entryId, activation, signal)
          : native.query(activation, signal);
      },
    };
  }
  await web?.checkStartup();
  return {
    openWindow: async (instanceId, binding) => {
      const restore = metadata.spark233.ui?.windows?.[binding.windowId]?.restore;
      if (restore && binding.parameterVersion !== restore.parameterVersion)
        throw new Error("窗口恢复参数版本不受支持");
      if (restore?.commandId) {
        if (!backend) throw new Error("Window restore requires a backend");
        await backend.activate({ commandId: restore.commandId, parameters: { binding } });
      }
      const controller = await getWeb(binding.windowId, instanceId, true);
      if (!controller) throw new Error("Window is not a page");
      windowOpenContext.getStore()?.assertActive?.();
      await controller.checkStartup();
      windowOpenContext.getStore()?.assertActive?.();
      await controller.activate({
        parameters: {
          ...(binding.parameters &&
          typeof binding.parameters === "object" &&
          !Array.isArray(binding.parameters)
            ? binding.parameters
            : {}),
          ...(binding.contentId ? { documentId: binding.contentId } : {}),
        },
      });
    },
    prepareWindowClose: async (instanceId) => {
      const controller = [...webControllers.entries()].find(
        ([key]) => JSON.parse(key)[1] === instanceId,
      )?.[1];
      return controller ? (await controller).prepareStop("window-close") : { ok: true };
    },
    activateWindow: async (instanceId, activation) => {
      const entry = [...webControllers.entries()].find(
        ([key]) => JSON.parse(key)[1] === instanceId,
      );
      if (!entry) throw new Error("Window controller is unavailable");
      await (await entry[1]).activate(activation);
    },
    closeWindow: async (instanceId) => {
      const entry = [...webControllers.entries()].find(
        ([key]) => JSON.parse(key)[1] === instanceId,
      );
      if (!entry) return;
      await (await entry[1]).dispose();
      webControllers.delete(entry[0]);
    },
    createWindowContent: async (windowId, creationId) => {
      const commandId = metadata.spark233.ui?.windows?.[windowId]?.create?.commandId;
      if (!commandId || !backend) throw new Error("Window creation needs a backend create command");
      return windowCreateResultSchema.parse(
        await backend.activate({
          commandId,
          parameters: { creationId, windowId },
        }),
      ).binding;
    },
    executeWidget: async ({ activation, entryId, signal }) => {
      signal.throwIfAborted();
      if (entryId) {
        if (!native) throw new Error("Widget native entry is unavailable");
        return native.request(entryId, activation, signal);
      }
      if (backend) return backend.activate(activation, signal);
      if (native) return native.query(activation, signal);
      throw new Error("Widget has no headless runtime");
    },
    query: async (activation, signal) => {
      signal?.throwIfAborted();
      broker?.grantContext(activation.context);
      return backend
        ? backend.activate(activation, signal)
        : (await getWeb())?.query(activation, signal);
    },
    activate: async (activation, signal) => {
      signal?.throwIfAborted();
      broker?.grantContext(activation.context);
      const result = await backend?.activate(activation, signal);
      signal?.throwIfAborted();
      windowOpenContext.getStore()?.assertActive?.();
      // An on-startup activation must not display a window.
      if (activation.commandId || activation.context) {
        const command = metadata.spark233.commands.find(
          (candidate) => candidate.id === activation.commandId,
        );
        // A backend action with no window is complete once its handler returns.
        // Do not accidentally construct and activate the default page.
        if (backend && command && !command.window) return result;
        const profile = command?.window;
        const declaration = profile ? metadata.spark233.ui?.windows?.[profile] : undefined;
        const parameters = activation.parameters;
        if (
          profile &&
          declaration &&
          declaration.purpose !== "dialog" &&
          (await routePluginWindow(
            scope.owner.pluginId,
            {
              windowId: profile,
              parameterVersion: declaration.restore?.parameterVersion ?? 1,
              ...(parameters === undefined ? {} : { parameters }),
              ...(parameters &&
              typeof parameters === "object" &&
              !Array.isArray(parameters) &&
              typeof parameters.documentId === "string"
                ? { contentId: parameters.documentId }
                : {}),
            },
            "open",
            activation,
          ))
        )
          return result;
        const documentKey =
          declaration?.reuse === "document"
            ? parameters &&
              typeof parameters === "object" &&
              !Array.isArray(parameters) &&
              typeof parameters.documentId === "string" &&
              parameters.documentId.length <= 200
              ? parameters.documentId
              : randomUUID()
            : undefined;
        const controller = await getWeb(profile, documentKey);
        await controller?.checkStartup();
        signal?.throwIfAborted();
        windowOpenContext.getStore()?.assertActive?.();
        await controller?.activate(activation);
      }
      return result;
    },
  };
}

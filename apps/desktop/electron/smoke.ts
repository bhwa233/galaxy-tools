import fs from "node:fs";
import {
  verifyUnifiedNoteList,
  expectNotePresence,
  ensureSourceEditor,
} from "./smoke-note-list.js";
import path from "node:path";
import { verifyNoteModes } from "./smoke-note-modes.js";
import { verifyNoteReminders } from "./smoke-note-reminders.js";
import { verifyTopCapsules } from "./smoke-top-capsules.js";
import { app, screen, type BrowserWindow } from "electron";
import type { NoteLayoutState } from "./note-window-state.js";
import type { NoteWindowSnapshot } from "../src/features/windows/noteWindowState.js";
import type { Capsules } from "./capsules.js";
import { contains } from "./capsule-layout.js";
import type { NotesDataClient } from "./plugins/official/notes-data-client.js";
import type { AppConfig } from "../src/features/settings/types.js";
import type { DesktopLayer } from "./desktop-layer.js";
import type { PluginWindowCoordinator } from "./host/plugin-window-coordinator.js";
import type { PluginWindowLayoutStore } from "./host/plugin-window-state.js";
import type { PluginManager } from "./plugins/manager.js";
import type { LayerManagementState } from "../shared/layer-contract.js";

/** Uses the real Electron presentation acknowledgements and note backend. */
export async function runPluginWindowSmoke(context: {
  output: string;
  layer: DesktopLayer;
  coordinator: PluginWindowCoordinator;
  store: PluginWindowLayoutStore;
  notes: NotesDataClient;
  manager: PluginManager;
  configDir: string;
  management(): LayerManagementState;
  quit(): void;
}): Promise<void> {
  const checks: Record<string, unknown> = {};
  const assert = (condition: unknown, message: string) => {
    if (!condition) throw new Error(message);
  };
  try {
    await context.layer.openOverlay();
    const placement = await context.coordinator.open({
      pluginId: "spark233.notes",
      windowId: "tile",
      environment: "card-desktop",
      action: "create",
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = context.layer.externalPresentation("placement:" + placement.id);
      if (value?.visible) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(context.layer.overlayActive, "Adding a note collapsed the card desktop");
    assert(
      context.layer.externalPresentation("placement:" + placement.id)?.visible,
      "Note was not presented in the card desktop",
    );
    const instance = context.store
      .load()
      .instances.find((value) => value.id === placement.instanceId)!;
    assert(instance.binding.contentId, "New note has no stable content ID");
    const note = await context.notes.get(instance.binding.contentId!);
    checks.createdNote = note.id;
    await context.layer.closeOverlay(false);
    assert(
      context.store.load().placements.some((value) => value.id === placement.id),
      "Collapsing removed the panel",
    );
    await context.layer.openOverlay();
    assert(
      (await context.notes.list()).filter((value) => value.id === note.id).length === 1,
      "Reopening duplicated the note",
    );
    checks.reopenedWithoutCreatingContent = true;
    const fixture = path.join(path.dirname(context.output), "utools-fixture");
    fs.mkdirSync(fixture, { recursive: true });
    fs.writeFileSync(
      path.join(fixture, "plugin.json"),
      JSON.stringify({
        name: "spark-window-smoke",
        version: "1.0.0",
        main: "index.html",
        preload: "preload.js",
        features: [
          { code: "first", cmds: ["Smoke first"] },
          { code: "second", cmds: ["Smoke second"] },
        ],
      }),
    );
    fs.writeFileSync(
      path.join(fixture, "index.html"),
      '<!doctype html><html><body><textarea id="draft">kept draft</textarea></body></html>',
    );
    fs.writeFileSync(
      path.join(fixture, "preload.js"),
      `const pageToken = require('node:crypto').randomUUID();
      const record = (type, feature) => {
        const trace = utools.dbStorage.getItem('window-smoke-trace') || [];
        trace.push({type, feature, pageToken, pid:process.pid, draft:document.querySelector('#draft')?.value});
        utools.dbStorage.setItem('window-smoke-trace', trace);
      };
      utools.onPluginEnter(action => {
        record('enter', action.code);
        if (action.code === 'first') document.querySelector('#draft').value = 'unsaved uTools draft';
      });
      utools.onPluginOut(() => record('out'));`,
    );
    const { stageDevelopmentPluginPackage } = await import("./plugins/package-installer.js");
    const { defaultHostEnvironment } = await import("./plugins/manifest.js");
    const staged = await stageDevelopmentPluginPackage(
      fixture,
      defaultHostEnvironment(app.getVersion()),
      {
        stagingRoot: path.join(context.configDir, "plugins/staging"),
        versionsRoot: path.join(context.configDir, "plugins/versions"),
        cacheRoot: path.join(context.configDir, "plugins/cache"),
      },
    );
    await context.manager.install(staged, {
      capabilities: staged.metadata.spark233.capabilities,
      native: true,
    });
    const compat = await context.coordinator.open({
      pluginId: staged.metadata.spark233.id,
      windowId: "utools-main",
      environment: "card-desktop",
      action: "create",
    });
    for (
      let attempt = 0;
      attempt < 100 && !context.layer.externalPresentation("utools:" + compat.instanceId)?.visible;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert(
      context.layer.externalPresentation("utools:" + compat.instanceId)?.visible,
      "uTools window did not appear",
    );
    const { windowOpenContext } = await import("./host/plugin-window-routing.js");
    const { utoolsCommandId } = await import("./plugins/utools-manifest.js");
    const compatRuntimeId = context.manager
      .list()
      .find((value) => value.pluginId === staged.metadata.spark233.id)?.instanceId;
    assert(compatRuntimeId, "uTools runner has no runtime identity");
    await windowOpenContext.run({ environment: "card-desktop" }, () =>
      context.manager.activate(staged.metadata.spark233.id, {
        commandId: utoolsCommandId("second"),
      }),
    );
    await windowOpenContext.run({ environment: "card-desktop" }, () =>
      context.manager.activate(staged.metadata.spark233.id, {
        commandId: utoolsCommandId("first"),
      }),
    );
    await context.layer.closeOverlay(false);
    await context.layer.openOverlay();
    assert(
      context.store
        .load()
        .instances.filter((value) => value.pluginId === staged.metadata.spark233.id).length === 1,
      "uTools created separate runner windows for one plugin",
    );
    assert(
      context.manager.list().find((value) => value.pluginId === staged.metadata.spark233.id)
        ?.instanceId === compatRuntimeId,
      "uTools feature changes or collapse replaced the runner",
    );
    const { UToolsStore } = await import("./plugins/utools-store.js");
    const compatData = new UToolsStore(context.manager.dataDirectory(staged.metadata.spark233.id));
    try {
      const trace = compatData.get("window-smoke-trace")?.value as Array<{
        type: string;
        feature?: string;
        pageToken: string;
        pid: number;
        draft: string;
      }>;
      assert(
        Array.isArray(trace) && trace.length,
        "uTools fixture recorded no lifecycle callbacks",
      );
      const second = trace.findIndex(
        (value) => value.type === "enter" && value.feature === "second",
      );
      assert(
        second > 0 &&
          trace[second - 1].type === "out" &&
          trace[second].draft === "unsaved uTools draft" &&
          trace
            .slice(second + 1)
            .some((value) => value.type === "enter" && value.feature === "first"),
        "uTools feature switch skipped lifecycle callbacks or discarded the draft",
      );
      assert(
        new Set(trace.map((value) => value.pageToken)).size === 1 &&
          new Set(trace.map((value) => value.pid)).size === 1,
        "uTools feature switch or collapse recreated the page or runner process",
      );
      checks.utoolsFeatureSwitch = {
        runtimeId: compatRuntimeId,
        pageToken: trace[0].pageToken,
        pid: trace[0].pid,
        enters: trace.filter((value) => value.type === "enter").map((value) => value.feature),
      };
    } finally {
      compatData.close();
    }
    checks.utoolsSingletonRetained = true;
    const webFixture = path.join(path.dirname(context.output), "web-fixture");
    fs.mkdirSync(webFixture, { recursive: true });
    fs.writeFileSync(
      path.join(webFixture, "package.json"),
      JSON.stringify({
        name: "@fixture/window-smoke",
        version: "1.0.0",
        spark233: {
          schemaVersion: 1,
          id: "fixture.window-smoke",
          displayName: "Window smoke",
          api: "^1.8.0",
          host: ">=0.1.7",
          platforms: ["win32"],
          architectures: ["x64"],
          entry: "index.html",
          backend: { entry: "backend.mjs" },
          capabilities: ["node.backend"],
          commands: [
            { id: "open", title: "Open", window: "main" },
            { id: "background-open", title: "Background open" },
            { id: "background-dialog", title: "Background dialog" },
            { id: "open-secondary", title: "Open secondary", window: "secondary" },
            { id: "backend-state", title: "Backend state" },
          ],
          ui: {
            theme: "^1.0.0",
            windows: {
              main: { entry: "index.html", cardDesktop: true },
              dialog: { entry: "index.html", title: "Window smoke dialog", purpose: "dialog" },
              secondary: {
                entry: "index.html",
                title: "Window smoke secondary",
                cardDesktop: false,
              },
              multiple: {
                entry: "index.html",
                title: "Window smoke multiple",
                cardDesktop: true,
                reuse: "multiple",
              },
            },
          },
        },
      }),
    );
    fs.writeFileSync(
      path.join(webFixture, "index.html"),
      '<!doctype html><html><body><textarea>kept</textarea><script src="main.js"></script></body></html>',
    );
    fs.writeFileSync(
      path.join(webFixture, "backend.mjs"),
      `import fs from 'node:fs';
      import path from 'node:path';
      export default lifetime => {
        if (!lifetime.startupCheckOnly) fs.appendFileSync(path.join(lifetime.dataDir, 'window-smoke-starts.log'), process.pid + '\\n');
        return {
          prepareStop: () => ({ok:true}), activate: async (activation, context) => {
            if (activation.commandId === 'backend-state') return {pid:process.pid, owner:context.owner.instanceId};
            if(activation.commandId === 'background-open') await context.callHost({operation:'window.open',
              binding:{windowId:'main',parameterVersion:1}, action:'open'});
            if(activation.commandId === 'background-dialog') await context.callHost({operation:'window.open',
              binding:{windowId:'dialog',parameterVersion:1}, action:'open'});
          }
        };
      };`,
    );
    fs.writeFileSync(
      path.join(webFixture, "main.js"),
      `
      window.spark233.subscribe(event => { if(event.type === 'prepareStop') window.spark233.request('lifecycle.result', {requestId:event.requestId,decision:{ok:true}}); });
      window.spark233.request('context.get');
    `,
    );
    const webStaged = await stageDevelopmentPluginPackage(
      webFixture,
      defaultHostEnvironment(app.getVersion()),
      {
        stagingRoot: path.join(context.configDir, "plugins/staging"),
        versionsRoot: path.join(context.configDir, "plugins/versions"),
        cacheRoot: path.join(context.configDir, "plugins/cache"),
      },
    );
    await context.manager.install(webStaged, {
      capabilities: webStaged.metadata.spark233.capabilities,
      native: true,
    });
    const webPlacement = await context.coordinator.open({
      pluginId: "fixture.window-smoke",
      windowId: "main",
      environment: "card-desktop",
      action: "create",
    });
    for (
      let attempt = 0;
      attempt < 100 && !context.layer.externalPresentation("placement:" + webPlacement.id)?.visible;
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert(
      context.layer.externalPresentation("placement:" + webPlacement.id)?.visible,
      "Isolated Web window did not appear",
    );
    const { unifiedWindowControl } = await import("./host/plugin-window-adapters.js");
    const { BrowserWindow: NativeWindow } = await import("electron");
    const webWindow = NativeWindow.getAllWindows().find(
      (value) => value.getTitle() === "Window smoke" && unifiedWindowControl(value),
    );
    assert(webWindow, "Web window native carrier is missing");
    const page = webWindow!.contentView.children.find(
      (child) => "webContents" in child,
    ) as Electron.WebContentsView;
    const pageId = page.webContents.id;
    await context.layer.locateWindow(webPlacement.instanceId);
    assert(webWindow!.isFocused(), "Locating a Web panel did not focus its native carrier");
    assert(page.webContents.id === pageId, "Locating replaced the existing Web page");
    checks.locatedExistingWebWindow = true;
    await page.webContents.executeJavaScript(
      "document.querySelector('textarea').value = 'unsaved retained draft'",
    );
    // The regression spans separate HWNDs: a DOM z-index alone cannot block a
    // native plugin carrier or keep the workspace's add dialog above it.
    const placementBeforeTransient = JSON.stringify(
      context.store.load().placements.find((value) => value.id === webPlacement.id),
    );
    const focusableBeforeTransient = webWindow!.isFocusable();
    let overlayHost: BrowserWindow | undefined;
    for (const candidate of context.layer.windows()) {
      if (!candidate.isVisible() || !context.layer.isOverlayWindow(candidate)) continue;
      if (
        await candidate.webContents.executeJavaScript(`(() => {
        const button = document.querySelector('[data-desktop-overlay] button[aria-label="添加插件"], [data-desktop-overlay] button[aria-label="Add plugin"]');
        if (!button) return false;
        button.click();
        return true;
      })()`)
      ) {
        overlayHost = candidate;
        break;
      }
    }
    assert(overlayHost, "Workspace add button is missing from its real host renderer");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        context.layer.overlayInputBlocked &&
        !webWindow!.isFocusable() &&
        overlayHost!.isFocused() &&
        (await overlayHost!.webContents.executeJavaScript(
          "!!document.querySelector('[role=dialog]')",
        ))
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    context.layer.restackOverlay();
    assert(
      context.layer.overlayInputBlocked &&
        !webWindow!.isFocusable() &&
        overlayHost!.isFocused() &&
        context.layer.externalPresentation("placement:" + webPlacement.id)?.inputBlocked &&
        context.layer.externalPresentation("utools:" + compat.instanceId)?.inputBlocked &&
        (await overlayHost!.webContents.executeJavaScript(
          "!!document.querySelector('[role=dialog]')",
        )),
      "Add dialog did not block native Web/uTools cards and retain host focus",
    );
    const noteCard = NativeWindow.getAllWindows().find(
      (value) =>
        value.webContents.getURL().includes("noteId=" + note.id) && unifiedWindowControl(value),
    );
    assert(noteCard, "Official note carrier is missing during the add dialog probe");
    await noteCard!.webContents.executeJavaScript(
      "(async () => {for (const action of ['show', 'focus']) await window.spark233Desktop.invoke('window_control', {action});})()",
    );
    assert(
      overlayHost!.isFocused() && !noteCard!.isFocused(),
      "Official card show/focus IPC raised the card over the add dialog",
    );
    overlayHost!.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    overlayHost!.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        !context.layer.overlayInputBlocked &&
        webWindow!.isFocusable() === focusableBeforeTransient &&
        webWindow!.isFocused() &&
        (await overlayHost!.webContents.executeJavaScript(
          "!document.querySelector('[role=dialog]')",
        ))
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const closedDialogVisible = await overlayHost!.webContents.executeJavaScript(
      "!!document.querySelector('[role=dialog]')",
    );
    checks.nativeCloseDialogState = {
      overlayActive: context.layer.overlayActive,
      inputBlocked: context.layer.overlayInputBlocked,
      focusableBefore: focusableBeforeTransient,
      focusableAfter: webWindow!.isFocusable(),
      webFocused: webWindow!.isFocused(),
      hostFocused: overlayHost!.isFocused(),
      focusedTitle: NativeWindow.getFocusedWindow()?.getTitle(),
      presentationBlocked: context.layer.externalPresentation("placement:" + webPlacement.id)
        ?.inputBlocked,
      dialogVisible: closedDialogVisible,
    };
    assert(
      context.layer.overlayActive &&
        !context.layer.overlayInputBlocked &&
        webWindow!.isFocusable() === focusableBeforeTransient &&
        webWindow!.isFocused() &&
        !closedDialogVisible &&
        !context.layer.externalPresentation("placement:" + webPlacement.id)?.inputBlocked,
      "Closing add dialog did not restore the native card's input and focus",
    );
    assert(
      JSON.stringify(
        context.store.load().placements.find((value) => value.id === webPlacement.id),
      ) === placementBeforeTransient,
      "Transient add dialog changed the durable placement or stacking order",
    );
    checks.nativeAddDialogPriority = true;
    // Both sources must open a real owned transient HWND without creating a
    // durable business binding, placement, or pending creation intent.
    for (const source of ["renderer", "backend"] as const) {
      const layoutBeforeDialog = JSON.stringify(context.store.load());
      if (source === "renderer") {
        await page.webContents.executeJavaScript(
          "window.spark233.request('windows.open', {binding:{windowId:'dialog',parameterVersion:1},action:'open'})",
        );
      } else {
        await windowOpenContext.run(
          { environment: "card-desktop", instanceId: webPlacement.instanceId },
          () =>
            context.manager.activate("fixture.window-smoke", { commandId: "background-dialog" }),
        );
      }
      const dialogWindow = NativeWindow.getAllWindows().find(
        (value) => value.getTitle() === "Window smoke dialog",
      );
      assert(
        dialogWindow?.isVisible() &&
          dialogWindow.getParentWindow() === webWindow &&
          !unifiedWindowControl(dialogWindow) &&
          context.layer.overlayActive,
        source + " dialog did not open as an independent transient owned by its source window",
      );
      assert(
        JSON.stringify(context.store.load()) === layoutBeforeDialog,
        source + " dialog incorrectly acquired a durable window binding or placement",
      );
      const dialogPage = dialogWindow!.contentView.children.find(
        (child) => "webContents" in child,
      ) as Electron.WebContentsView;
      await dialogPage.webContents
        .executeJavaScript("window.spark233.request('window.close')")
        .catch((error: unknown) => {
          // The real close can destroy its own frame before its JavaScript
          // result is returned. The native lifetime assertions below remain
          // the completion proof; other errors still fail this probe.
          if (!dialogWindow!.isDestroyed() || !String(error).includes("Render frame was disposed"))
            throw error;
        });
      for (let attempt = 0; attempt < 100 && !dialogWindow!.isDestroyed(); attempt++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      assert(
        dialogWindow!.isDestroyed() && !webWindow!.isDestroyed() && context.layer.overlayActive,
        source + " dialog close damaged its business parent or collapsed the workspace",
      );
    }
    checks.transientDialogsAvoidPersistentState = ["renderer", "backend"];
    const cardBounds = context.store
      .load()
      .placements.find((value) => value.id === webPlacement.id)!.bounds;
    await context.layer.closeOverlay(false);
    const desktopPlacement = await context.coordinator.open({
      pluginId: "fixture.window-smoke",
      windowId: "main",
      environment: "desktop",
      action: "open",
      instanceId: webPlacement.instanceId,
    });
    const ordinaryBounds = { x: 120, y: 140, width: 640, height: 480 };
    webWindow!.setBounds(ordinaryBounds);
    unifiedWindowControl(webWindow!)!.setAlwaysOnTop(true);
    assert(webWindow!.isAlwaysOnTop(), "Ordinary topmost did not reach the native window");
    const acceptedOrdinaryBounds = webWindow!.getBounds();
    const geometryRoundTrips: Electron.Rectangle[] = [];
    const topmostRoundTrips: Array<{ before: boolean; overlay: boolean; restored: boolean }> = [];
    checks.borrowedWindowGeometry = {
      requested: ordinaryBounds,
      accepted: acceptedOrdinaryBounds,
      roundTrips: geometryRoundTrips,
      topmostRoundTrips,
    };
    for (let round = 0; round < 3; round++) {
      const before = webWindow!.isAlwaysOnTop();
      await context.layer.openOverlay();
      const overlay = webWindow!.isAlwaysOnTop();
      await context.layer.closeOverlay(false);
      topmostRoundTrips.push({ before, overlay, restored: webWindow!.isAlwaysOnTop() });
      const restored = webWindow!.getBounds();
      geometryRoundTrips.push(restored);
      assert(
        JSON.stringify(restored) === JSON.stringify(acceptedOrdinaryBounds),
        "Borrowed window did not return its accepted native geometry",
      );
    }
    checks.borrowedWindowState = {
      topmost: webWindow!.isAlwaysOnTop(),
      visible: webWindow!.isVisible(),
      placements: context.store
        .load()
        .placements.filter((value) => value.instanceId === webPlacement.instanceId),
    };
    assert(
      webWindow!.isAlwaysOnTop() && webWindow!.isVisible(),
      "Borrowed window did not return visibility/topmost",
    );
    assert(
      await page.webContents.executeJavaScript(
        "document.querySelector('textarea').value === 'unsaved retained draft'",
      ),
      "Collapsing reloaded the live Web editor",
    );
    assert(
      JSON.stringify(
        context.store.load().placements.find((value) => value.id === webPlacement.id)!.bounds,
      ) === JSON.stringify(cardBounds),
      "Ordinary geometry changed the shared card layout",
    );
    await context.layer.openOverlay();
    await page.webContents.executeJavaScript(`window.spark233.request('windows.open', {
      binding:{windowId:'secondary',parameterVersion:1},action:'open'
    })`);
    const secondaryInstance = context.store
      .load()
      .instances.find(
        (value) =>
          value.pluginId === "fixture.window-smoke" && value.binding.windowId === "secondary",
      );
    const secondaryPlacements = context.store
      .load()
      .placements.filter((value) => value.instanceId === secondaryInstance?.id);
    const secondaryWindow = NativeWindow.getAllWindows().find(
      (value) => value.getTitle() === "Window smoke secondary" && unifiedWindowControl(value),
    );
    for (let attempt = 0; attempt < 100 && !secondaryWindow?.isFocused(); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert(
      secondaryInstance &&
        secondaryPlacements.length === 1 &&
        secondaryPlacements[0].environment === "desktop" &&
        secondaryWindow?.isVisible() &&
        secondaryWindow.isFocused() &&
        unifiedWindowControl(secondaryWindow)?.state().environment === "desktop" &&
        !context.layer.overlayActive,
      "Card-internal unsupported business window did not open on the ordinary desktop and receive focus",
    );
    await context.coordinator.close(secondaryPlacements[0].id);
    checks.unsupportedBusinessWindowUsesDesktop = true;
    await context.layer.openOverlay();
    await context.coordinator.close(webPlacement.id);
    assert(webWindow!.isVisible(), "Closing card membership hid the remaining ordinary display");
    await context.coordinator.close(desktopPlacement.id);
    checks.webSaveAndClose = true;
    checks.webDraftAndBorrowedState = true;
    await windowOpenContext.run({ environment: "card-desktop" }, () =>
      context.manager.activate("fixture.window-smoke", { commandId: "background-open" }),
    );
    const background = context.store
      .load()
      .placements.find(
        (value) =>
          value.environment === "card-desktop" &&
          context.store
            .load()
            .instances.some(
              (candidate) =>
                candidate.id === value.instanceId && candidate.pluginId === "fixture.window-smoke",
            ),
      );
    assert(background, "Backend window call lost its originating environment");
    await context.coordinator.close(background!.id);
    checks.backendWindowRouting = true;
    const multipleFirst = await context.coordinator.open({
      pluginId: "fixture.window-smoke",
      windowId: "multiple",
      environment: "card-desktop",
      action: "create",
    });
    const multipleSecond = await context.coordinator.open({
      pluginId: "fixture.window-smoke",
      windowId: "multiple",
      environment: "card-desktop",
      action: "create",
    });
    await context.layer.closeOverlay(false);
    const multipleDesktop = await context.coordinator.open({
      pluginId: "fixture.window-smoke",
      windowId: "multiple",
      environment: "desktop",
      action: "open",
    });
    const multipleReused = await context.coordinator.open({
      pluginId: "fixture.window-smoke",
      windowId: "multiple",
      environment: "card-desktop",
      action: "open",
    });
    assert(
      multipleFirst.instanceId !== multipleSecond.instanceId &&
        ![multipleFirst.instanceId, multipleSecond.instanceId].includes(
          multipleDesktop.instanceId,
        ) &&
        [multipleFirst.id, multipleSecond.id].includes(multipleReused.id),
      "Multiple-instance open did not prefer an existing window in the requested environment",
    );
    const multipleWindows = NativeWindow.getAllWindows().filter(
      (value) => value.getTitle() === "Window smoke multiple" && unifiedWindowControl(value),
    );
    assert(
      multipleWindows.length === 3 &&
        new Set(
          multipleWindows
            .map(
              (value) =>
                value.contentView.children.find(
                  (child) => "webContents" in child,
                ) as Electron.WebContentsView,
            )
            .map((view) => view.webContents.id),
        ).size === 3,
      "Distinct window instances unexpectedly shared a native carrier or page",
    );
    for (const value of [multipleFirst, multipleSecond, multipleDesktop])
      await context.coordinator.close(value.id);
    checks.multipleInstancesPreferTargetEnvironment = true;
    const backendState = (await context.manager.activate("fixture.window-smoke", {
      commandId: "backend-state",
    })) as { pid: number; owner: string };
    const backendStarts = fs
      .readFileSync(
        path.join(context.manager.dataDirectory("fixture.window-smoke"), "window-smoke-starts.log"),
        "utf8",
      )
      .trim()
      .split(/\r?\n/);
    assert(
      backendStarts.length === 1 &&
        Number(backendStarts[0]) === backendState.pid &&
        context.manager.list().find((value) => value.pluginId === "fixture.window-smoke")
          ?.instanceId === backendState.owner,
      "Opening, borrowing or collapsing windows duplicated the background runtime",
    );
    checks.backgroundRuntimeStartedOnce = backendState;
    await context.layer.openOverlay();
    const hud = await context.coordinator.open({
      pluginId: "spark233.traffic",
      windowId: "hud",
      environment: "card-desktop",
      action: "create",
    });
    assert(context.layer.overlayActive, "Adding HUD collapsed the card desktop");
    for (
      let attempt = 0;
      attempt < 100 && !context.layer.isCardVisible("widget:" + hud.instanceId);
      attempt++
    )
      await new Promise((resolve) => setTimeout(resolve, 100));
    assert(context.layer.isCardVisible("widget:" + hud.instanceId), "HUD did not become visible");
    checks.hud = hud.id;
    await context.layer.closeOverlay(false);
    assert(
      !context.layer.isCardVisible("widget:" + hud.instanceId),
      "Card-only HUD leaked onto the ordinary desktop",
    );
    await context.layer.openOverlay();
    await context.coordinator.close(placement.id);
    assert(context.layer.overlayActive, "Closing one panel collapsed the workspace");
    assert(
      !context.store.load().placements.some((value) => value.id === placement.id),
      "Closed panel retained its membership",
    );
    assert(
      (await context.notes.get(note.id)).id === note.id,
      "Closing a note display deleted its content",
    );
    const notePlacement = await context.coordinator.open({
      pluginId: "spark233.notes",
      windowId: "notepad",
      environment: "card-desktop",
      action: "open",
      binding: { windowId: "notepad", contentId: note.id, parameterVersion: 1 },
    });
    const invalidContentId = "00000000-0000-4000-8000-000000000001";
    const noteCount = (await context.notes.list()).length;
    try {
      await context.coordinator.open({
        pluginId: "spark233.notes",
        windowId: "notepad",
        environment: "card-desktop",
        action: "open",
        binding: { windowId: "notepad", contentId: invalidContentId, parameterVersion: 1 },
      });
      throw new Error("Missing content was unexpectedly restored");
    } catch (error) {
      if (!(error instanceof Error) || !("code" in error) || error.code !== "noteNotFound")
        throw error;
      const failedInstance = context.store
        .load()
        .instances.find((value) => value.binding.contentId === invalidContentId);
      assert(failedInstance, "Failed restore lost its stable binding");
      const failedPlacement = context.store
        .load()
        .placements.find((value) => value.instanceId === failedInstance!.id)!;
      const summary = context
        .management()
        .instances.find((value) => value.widgetInstanceId === failedPlacement.id);
      assert(
        summary?.status === "fault" && summary.canRetry && summary.reason,
        "Management did not expose the failed restore and retry action",
      );
      assert(
        (await context.notes.list()).length === noteCount,
        "Failed restore created replacement content",
      );
      await context.coordinator.close(failedPlacement.id);
      checks.restoreFailureVisibleInManagement = true;
    }
    let noteWindow: BrowserWindow | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      noteWindow = NativeWindow.getAllWindows().find(
        (value) =>
          value.webContents.getURL().includes("noteId=" + note.id) && unifiedWindowControl(value),
      );
      if (noteWindow) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(noteWindow, "Reopened note editor carrier is missing");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await noteWindow!.webContents.executeJavaScript(
          "!!document.querySelector('[data-note-ready=true] textarea:not(:disabled)')",
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const dirtyText = "保存拒绝后仍保留的草稿";
    assert(
      await noteWindow!.webContents.executeJavaScript(
        "!!document.querySelector('[data-note-ready=true] textarea:not(:disabled)')",
      ),
      "Note editor was not ready for input",
    );
    await noteWindow!.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(dirtyText)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await new Promise((resolve) => setTimeout(resolve, 80));
    const metadataFile = path.join(
      context.manager.dataDirectory("spark233.notes"),
      "metadata.json",
    );
    const savedMetadata = metadataFile + ".window-smoke-backup";
    fs.renameSync(metadataFile, savedMetadata);
    fs.mkdirSync(metadataFile);
    let refused = false;
    try {
      // Save preparation still protects backup operations, but no longer runs
      // as a veto when the user closes a placement.
      refused = !(
        await context.manager.prepareWindowClose("spark233.notes", notePlacement.instanceId)
      ).ok;
    } catch {
      refused = true;
    } finally {
      fs.rmdirSync(metadataFile);
      fs.renameSync(savedMetadata, metadataFile);
    }
    assert(
      refused &&
        !noteWindow!.isDestroyed() &&
        context.store.load().placements.some((value) => value.id === notePlacement.id),
      "Save refusal removed the live note or its card placement",
    );
    assert(
      await noteWindow!.webContents.executeJavaScript(
        `document.querySelector('textarea').value === ${JSON.stringify(dirtyText)}`,
      ),
      "Save refusal lost the note draft",
    );
    checks.noteSavePreparationRetainedDraft = true;
    await context.coordinator.open({
      pluginId: "spark233.notes",
      windowId: "main",
      environment: "card-desktop",
      action: "open",
    });
    let noteManager: BrowserWindow | undefined;
    for (let attempt = 0; attempt < 100; attempt++) {
      noteManager = NativeWindow.getAllWindows().find(
        (value) => value.webContents.getURL().includes("view=main") && unifiedWindowControl(value),
      );
      if (noteManager) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(noteManager, "Note manager did not open");
    for (let attempt = 0; attempt < 100; attempt++) {
      if (
        await noteManager!.webContents.executeJavaScript(
          "!!document.querySelector('textarea')?.readOnly",
        )
      )
        break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert(
      await noteManager!.webContents.executeJavaScript(
        "!!document.querySelector('textarea')?.readOnly",
      ),
      "Manager did not relinquish the active note editor",
    );
    checks.noteManagerSingleEditor = true;
    await noteManager!.webContents.executeJavaScript(
      `window.spark233Desktop.invoke('notes_delete', {id:${JSON.stringify(note.id)}})`,
    );
    assert(
      !context.store.load().instances.some((value) => value.binding.contentId === note.id),
      "Deleting a note retained its window binding",
    );
    assert(
      !(await context.notes.list()).some((value) => value.id === note.id),
      "Note deletion did not commit",
    );
    checks.noteDeletionCoordinatedSave = true;
    await context.layer.closeOverlay(false);
    checks.retainedPlacements = context.store.load().placements.length;
    fs.mkdirSync(path.dirname(context.output), { recursive: true });
    fs.writeFileSync(context.output, JSON.stringify({ ok: true, checks }, null, 2));
  } catch (error) {
    fs.mkdirSync(path.dirname(context.output), { recursive: true });
    fs.writeFileSync(
      context.output,
      JSON.stringify(
        { ok: false, checks, error: error instanceof Error ? error.stack : String(error) },
        null,
        2,
      ),
    );
  } finally {
    context.quit();
  }
}

export interface SmokeContext {
  output: string;
  fullscreenRects: () => Electron.Rectangle[];
  gpuDiagnostics: () => {
    crashCount: number;
    features: Electron.GPUFeatureStatus;
    startedFromUnc: boolean;
    workingDirectoryIsLocal: boolean;
    sandboxEnabled: boolean;
  };
  notes: NotesDataClient;
  config: () => AppConfig;
  configDir: string;
  dataDir: () => string;
  windows: Map<string, BrowserWindow>;
  layouts: Map<string, NoteLayoutState>;
  openNote: (id?: string, view?: "notepad" | "tile") => Promise<string>;
  showMain: () => BrowserWindow;
  showLauncher: () => Promise<BrowserWindow>;
  pauseForBackup: () => Promise<() => void>;
  prepare: (win: BrowserWindow) => Promise<boolean>;
  hideAndRelease: (win: BrowserWindow) => Promise<void>;
  foldAndRelease: (win: BrowserWindow) => Promise<void>;
  capsules: Capsules;
  emit: (name: string, payload?: unknown, target?: BrowserWindow) => void;
  quit: () => void;
}
export async function runSmoke(context: SmokeContext): Promise<void> {
  const { notes, windows, openNote, showMain } = context;
  const checks: Record<string, unknown> = {};
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function clickCapsule(win: BrowserWindow, selector: string, movement = 0) {
    let point: { x: number; y: number } | undefined;
    // desktop_ready precedes the asynchronous CapsuleHost snapshot commit.
    // Native input must wait for its actual target, not only window readiness.
    for (let attempt = 0; attempt < 100; attempt++) {
      if (win.isDestroyed()) throw new Error(`Capsule window closed before input: ${selector}`);
      point = await win.webContents.executeJavaScript(`(() => {
        const rect = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
        return rect?.width && rect.height
          ? { x: Math.round(rect.x + 20), y: Math.round(rect.y + rect.height / 2) }
          : undefined;
      })()`);
      if (point) break;
      await wait(50);
    }
    if (!point) throw new Error(`Capsule input target did not render: ${selector}`);
    win.webContents.sendInputEvent({ type: "mouseDown", button: "left", clickCount: 1, ...point });
    await wait(50);
    if (movement) {
      point.x += movement;
      win.webContents.sendInputEvent({ type: "mouseMove", ...point });
    }
    win.webContents.sendInputEvent({ type: "mouseUp", button: "left", clickCount: 1, ...point });
    await wait(120);
  }
  async function hydrated(source: BrowserWindow | string): Promise<BrowserWindow> {
    let win = typeof source === "string" ? windows.get(source) : source;
    for (let i = 0; i < 100; i++) {
      if (!win && typeof source === "string") win = windows.get(source);
      if (!win) {
        await wait(100);
        continue;
      }
      if (win.isDestroyed()) throw new Error("Window destroyed during load");
      if (
        await win.webContents
          .executeJavaScript(
            "!!window.spark233Desktop && (!!document.querySelector('textarea') || !!document.querySelector('[data-editor-mode]'))",
          )
          .catch(() => false)
      ) {
        await wait(500);
        await ensureSourceEditor(win);
        return win;
      }
      await wait(100);
    }
    throw new Error("Renderer did not hydrate");
  }
  // A completed backup restored commands but left its rejected query banner.
  // Exercise the real renderer and maintenance gate, including disabled actions.
  async function verifyLauncherMaintenance() {
    const launcher = await context.showLauncher();
    const settledCommands = `document.querySelector('[data-slot="command-list"]')?.getAttribute('aria-busy') === 'false' && !!document.querySelector('[role="option"][data-result-key]')`;
    const untilRenderer = async (predicate: string, failure: string, attempts = 100) => {
      for (let attempt = 0; attempt < attempts; attempt++) {
        if (await launcher.webContents.executeJavaScript(predicate).catch(() => false)) return;
        await wait(50);
      }
      checks.launcherFailure = await launcher.webContents.executeJavaScript(`(async () => ({
        text: document.body.innerText, url: location.href,
        busy: document.querySelector('[data-slot="command-list"]')?.getAttribute('aria-busy'),
        items: document.querySelectorAll('[role="option"][data-result-key]').length,
        state: await window.spark233Desktop.invoke('launcher_state')
      }))()`);
      throw new Error(failure);
    };
    await untilRenderer(
      "!!window.spark233Desktop",
      "Launcher bridge did not initialize before maintenance",
    );
    // Every run uses a new isolated profile. Exercise the real onboarding
    // command before testing the normal command catalog and maintenance flow.
    const onboarding = await launcher.webContents.executeJavaScript(`(async () => {
      const state = await window.spark233Desktop.invoke('launcher_state');
      if (!state.ok || !state.value.firstRun) return state;
      return window.spark233Desktop.invoke('launcher_complete_onboarding');
    })()`);
    if (!onboarding.ok || onboarding.value.firstRun)
      throw new Error("Isolated launcher onboarding did not complete");
    checks.launcherOnboardingCompleted = true;
    context.emit("launcher-status-changed", undefined, launcher);
    await untilRenderer(settledCommands, "Launcher commands did not settle before maintenance");
    const maintenance: Record<string, unknown> = {};
    checks.launcherMaintenance = maintenance;
    let resume: (() => void) | undefined;
    try {
      resume = await context.pauseForBackup();
      maintenance.launcherShown = (await context.showLauncher()).isVisible();
      const settingsOpened = await launcher.webContents.executeJavaScript(
        `window.spark233Desktop.invoke('settings_open', {page:'general'})`,
      );
      if (!settingsOpened.ok) throw new Error("Maintenance prevented opening settings");
      const settings = context.windows.get("settings");
      if (!settings) throw new Error("Maintenance did not create the settings window");
      for (let attempt = 0; attempt < 100; attempt++) {
        if (
          await settings.webContents
            .executeJavaScript("!!document.querySelector('fieldset:disabled')")
            .catch(() => false)
        )
          break;
        await wait(100);
      }
      maintenance.settingsDisabled = await settings.webContents.executeJavaScript(
        "!!document.querySelector('fieldset:disabled')",
      );
      maintenance.settingsShown = settings.isVisible();
      settings.close();
      for (let attempt = 0; attempt < 100 && !settings.isDestroyed(); attempt++) await wait(20);
      maintenance.settingsClosed = settings.isDestroyed();
      if (
        !maintenance.launcherShown ||
        !maintenance.settingsShown ||
        !maintenance.settingsDisabled ||
        !maintenance.settingsClosed
      )
        throw new Error(
          "Maintenance must preserve shell display/close while disabling configuration writes",
        );
      await context.showLauncher();
      const reads = await launcher.webContents.executeJavaScript(`(async () => ({
          state: await window.spark233Desktop.invoke('launcher_state'),
          query: await window.spark233Desktop.invoke('launcher_query', {query:'',sessionId:crypto.randomUUID()})
        }))()`);
      maintenance.stateReadAllowed = reads.state.ok;
      maintenance.queryRejected = !reads.query.ok && reads.query.error.code === "maintenance";
      if (!maintenance.stateReadAllowed || !maintenance.queryRejected)
        throw new Error("Maintenance must allow state reads and reject launcher queries");
      const errorVisible = `Array.from(document.querySelectorAll('[role="alert"] [data-slot="alert-description"]')).some(node => node.textContent === ${JSON.stringify(reads.query.error.message)})`;
      context.emit("plugins-changed", undefined, launcher);
      await untilRenderer(
        errorVisible,
        "Maintenance query rejection was not shown by the renderer",
      );
      maintenance.errorShown = true;
      resume();
      resume = undefined;
      context.emit("plugins-changed", undefined, launcher);
      await untilRenderer(settledCommands, "Launcher commands did not recover after maintenance");
      maintenance.commandsRecovered = true;
      maintenance.afterRecovery = await launcher.webContents.executeJavaScript(
        `Array.from(document.querySelectorAll('[role="alert"] [data-slot="alert-description"]')).map(node => node.textContent)`,
      );
      await untilRenderer(
        `!(${errorVisible})`,
        "Recovered launcher retained its maintenance read error",
      );
      maintenance.transientErrorCleared = true;
      const modeCommand = reads.state.value.commands.find(
        (command: { pluginId: string; id: string; mode?: string }) =>
          command.pluginId === "spark233.notes" && command.id === "search" && command.mode,
      );
      if (!modeCommand)
        throw new Error("Official notes search mode is required for the action regression");
      // The default launcher now shows primary plugin entries. Search for this
      // secondary mode through the real input before testing its action error.
      await launcher.webContents.executeJavaScript(`(() => {
        const input = document.querySelector('[role="combobox"]');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, ${JSON.stringify(modeCommand.title)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      // Ready command rows remain actionable while independent native search
      // providers are pending; a populated machine index can take much longer.
      const modeAvailable = `Array.from(document.querySelectorAll('[role="option"][data-result-key]')).some(node => node.getAttribute('aria-disabled') !== 'true' && node.textContent.includes(${JSON.stringify(modeCommand.title)}))`;
      await untilRenderer(modeAvailable, "Notes search mode did not appear for its explicit query");
      resume = await context.pauseForBackup();
      const modeDisabled = `Array.from(document.querySelectorAll('[role="option"][data-result-key]')).some(node => node.getAttribute('aria-disabled') === 'true' && node.textContent.includes(${JSON.stringify(modeCommand.title)}))`;
      await untilRenderer(modeDisabled, "Maintenance left a dependent action enabled");
      maintenance.actionDisabled = true;
      const clicked = await launcher.webContents.executeJavaScript(`(() => {
          const item = Array.from(document.querySelectorAll('[role="option"][data-result-key]')).find(node => node.textContent.includes(${JSON.stringify(modeCommand.title)}));
          if (!item) return false;
          item.click();
          return true;
        })()`);
      if (!clicked) {
        checks.launcherMissingAction = await launcher.webContents.executeJavaScript(`({
          text: document.body.innerText,
          query: document.querySelector('[role="combobox"]')?.value,
          items: Array.from(document.querySelectorAll('[role="option"][data-result-key]')).map(node => node.textContent)
        })`);
        throw new Error("Notes mode action was not available in the real launcher");
      }
      await untilRenderer(
        errorVisible,
        "Maintenance action rejection was not shown by the renderer",
      );
      maintenance.disabledActionIgnored = await launcher.webContents.executeJavaScript(
        `document.querySelector('[role="combobox"]')?.value === ${JSON.stringify(modeCommand.title)}`,
      );
      if (!maintenance.disabledActionIgnored)
        throw new Error("A disabled command entered its mode");
      resume();
      resume = undefined;
      context.emit("plugins-changed", undefined, launcher);
      await untilRenderer(
        settledCommands,
        "Notes query did not recover after the disabled mode action",
      );
      await untilRenderer(`!(${errorVisible})`, "Maintenance error remained after recovery");
    } finally {
      resume?.();
    }
  }
  async function verifyFinalPluginSave() {
    // Regression: the final note write succeeded, but surface_state re-read the
    // same identity through the fenced public manager and refused the save ack.
    const lifecycleLauncher = await context.showLauncher();
    const pluginCommand = async (command: string, args: unknown) => {
      const result = await lifecycleLauncher.webContents.executeJavaScript(
        `window.spark233Desktop.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`,
      );
      if (!result.ok) throw new Error(JSON.stringify(result.error));
    };
    const autoSave = context.config().noteSurfaceAutoSave;
    const originalFont = context.config().fontSize;
    const originalSurfaceFont = context.config().surfaceFontSize;
    await pluginCommand("config_patch", {
      patch: { noteSurfaceAutoSave: false },
    });
    let notesStopped = false;
    try {
      const fixture = await notes.save({ title: "Final plugin save", content: "", category: "" });
      const editor = windows.get(await openNote(fixture.id))!;
      await hydrated(editor);
      // Two settings panels can hold the same old snapshot. Each must submit
      // only its edited field, so the second window cannot revert the first.
      const denied = await editor.webContents.executeJavaScript(
        "window.spark233Desktop.invoke('config_patch', {patch:{fontSize:18}})",
      );
      if (denied.ok || denied.error.code !== "permissionDenied")
        throw new Error("A note renderer could modify host configuration");
      checks.noteAdministrationDenied = true;
      await pluginCommand("settings_open", { page: "general" });
      const settings = windows.get("settings")!;
      const settingsBefore = await settings.webContents.executeJavaScript(
        "window.spark233Desktop.invoke('config_get')",
      );
      const launcherBefore = context.config();
      const fontSize = launcherBefore.fontSize === 18 ? 19 : 18;
      const surfaceFontSize = settingsBefore.value.surfaceFontSize === 20 ? 21 : 20;
      await pluginCommand("config_patch", { patch: { fontSize } });
      const patched = await settings.webContents.executeJavaScript(
        `window.spark233Desktop.invoke('config_patch', {patch:{surfaceFontSize:${surfaceFontSize}}})`,
      );
      if (
        !patched.ok ||
        patched.value.fontSize !== fontSize ||
        patched.value.surfaceFontSize !== surfaceFontSize
      )
        throw new Error("A stale settings window reverted another window's config patch");
      const forbidden = await settings.webContents.executeJavaScript(
        `window.spark233Desktop.invoke('config_patch', {patch:{dataDir:${JSON.stringify(context.dataDir())}}})`,
      );
      const obsolete = await settings.webContents.executeJavaScript(
        `window.spark233Desktop.invoke('config_save', {config:${JSON.stringify(settingsBefore.value)}})`,
      );
      if (
        forbidden.ok ||
        forbidden.error.code !== "invalidPayload" ||
        obsolete.ok ||
        obsolete.error.code !== "obsoleteClient"
      )
        throw new Error("Config writes accepted a root change or an obsolete full snapshot");
      checks.independentSettingsPatches = true;
      const finalContent = "停用插件前的未保存正文\n";
      await editor.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(finalContent)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
      await wait(80);
      await pluginCommand("plugins_enable", { pluginId: "spark233.notes", enabled: false });
      notesStopped = true;
      if (!editor.isDestroyed()) throw new Error("Saved plugin stop left the editor alive");
      await pluginCommand("plugins_enable", { pluginId: "spark233.notes", enabled: true });
      notesStopped = false;
      if ((await notes.get(fixture.id)).content !== finalContent)
        throw new Error("Plugin stop/restart lost the final renderer save");
      checks.finalPluginSave = true;
    } finally {
      if (notesStopped)
        await pluginCommand("plugins_enable", { pluginId: "spark233.notes", enabled: true });
      await pluginCommand("config_patch", {
        patch: {
          noteSurfaceAutoSave: autoSave,
          fontSize: originalFont,
          surfaceFontSize: originalSurfaceFont,
        },
      });
    }
    // Restored windows must finish their ready handshake before the final quit.
    for (const [label, restored] of windows)
      if (context.layouts.get(label)?.view !== "launcher") await hydrated(restored);
  }
  try {
    if (
      process.argv.includes("--smoke-launcher-maintenance") ||
      process.argv.includes("--smoke-notes-final-save") ||
      process.argv.includes("--smoke-note-modes") ||
      process.argv.includes("--smoke-note-list")
    ) {
      if (process.argv.includes("--smoke-launcher-maintenance")) {
        if (!(await notes.list()).length)
          await notes.save({
            title: "Smoke maintenance fixture",
            content: "Controlled search result",
            category: "",
          });
        await verifyLauncherMaintenance();
      }
      if (process.argv.includes("--smoke-notes-final-save")) await verifyFinalPluginSave();
      if (process.argv.includes("--smoke-note-modes")) {
        if (!(await notes.list()).length)
          await notes.save({
            title: "Smoke note modes fixture",
            content: "Controlled source",
            category: "",
          });
        const main = showMain();
        await hydrated(main);
        checks.noteModes = await verifyNoteModes(context, main);
      }
      if (process.argv.includes("--smoke-note-list")) {
        const note = await notes.save({
          title: "Unified list lifecycle fixture",
          content: "Controlled shared source",
          category: "",
        });
        const main = showMain();
        await hydrated(main);
        checks.unifiedList = (await verifyUnifiedNoteList(context, main, note)).checks;
      }
      fs.mkdirSync(path.dirname(context.output), { recursive: true });
      fs.writeFileSync(
        context.output,
        JSON.stringify(
          {
            ok: true,
            runtime: { packaged: app.isPackaged, electron: process.versions.electron },
            checks,
          },
          null,
          2,
        ),
      );
      return;
    }
    checks.initialNoteCount = (await notes.list()).length;
    // The launcher no longer manufactures a blank note on first startup.
    // Existing editor regressions still need an explicit controlled document.
    if (!(await notes.list()).length)
      await notes.save({
        title: "Smoke editor fixture",
        content: "# Controlled smoke document\n",
        category: "",
      });
    const main = showMain();
    await hydrated(main);
    checks.topCapsules = await verifyTopCapsules(context, main);
    checks.noteModes = await verifyNoteModes(context, main);
    checks.noteReminders = await verifyNoteReminders(context, main);
    const restoredPins = [...context.layouts.values()].filter(
      (entry) => entry.noteId && entry.topmost,
    );
    const initial = (await main.webContents.executeJavaScript(
      "window.spark233Desktop.invoke('note_window_states')",
    )) as { ok: boolean; value: NoteWindowSnapshot };
    if (!initial.ok) throw new Error("Failed to read restored pin state");
    for (const entry of restoredPins) {
      const state = initial.value.notes.find((n) => n.noteId === entry.noteId);
      if (!state?.pinned) throw new Error("Restored layout lost a pin preference");
      if (
        entry.everOpened === false &&
        (state.presence !== "unopened" || context.windows.has(entry.label))
      )
        throw new Error("Restoring pin-only preference opened a desktop window");
    }
    checks.restoredPinPreferences = restoredPins.length;
    const pinOnlyId =
      (await notes.list()).find((n) => n.title === "未展示置顶恢复验证")?.id ??
      (
        await notes.save({
          title: "未展示置顶恢复验证",
          content: "只保留置顶偏好，不打开窗口",
          category: "",
        })
      ).id;
    await main.webContents.executeJavaScript(
      "window.spark233Desktop.invoke('note_set_pinned',{noteId:" +
        JSON.stringify(pinOnlyId) +
        ",pinned:true})",
    );
    context.emit("notes-changed");
    await expectNotePresence(main, pinOnlyId, "unopened");
    const errors: string[] = [];
    for (const win of windows.values())
      win.webContents.on("console-message", (details) => {
        if (details.level === "error") errors.push(details.message);
      });
    const note = await notes.save({
      title: "Electron 中文验证",
      content: "# 测试\n- [ ] 保留中文\n**Markdown**\n",
      category: "",
    });
    const unified = await verifyUnifiedNoteList(context, main, note);
    checks.unifiedList = unified.checks;
    const { label, win } = unified;
    await hydrated(win);
    const ipc = await win.webContents.executeJavaScript(`(async () => {
      const result = await window.spark233Desktop.invoke('notes_get', { id: ${JSON.stringify(note.id)} });
      const denial = await window.spark233Desktop.invoke('read_external_file', { path: ${JSON.stringify(path.join(context.configDir, "config.json"))} });
      return { node: typeof require, bridge: !!window.spark233Desktop, note: result, denial };
    })()`);
    if (
      !ipc.note.ok ||
      ipc.note.value.content !== note.content ||
      ipc.node !== "undefined" ||
      ipc.denial.ok
    )
      throw new Error(`IPC/sandbox failed: ${JSON.stringify(ipc)}`);
    checks.ipc = ipc;
    const oldBounds = win.getBounds();
    win.setBounds({ ...oldBounds, x: oldBounds.x + 30, y: oldBounds.y + 20 });
    checks.moved = win.getBounds().x === oldBounds.x + 30;
    const dirtyText = "关闭前立即输入：中文不丢失 **bold**\n";
    await win.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(dirtyText)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(80);
    // Explicit save and close are separate operations; closing no longer
    // promises to flush a draft that has not reached autosave yet.
    if (!(await context.prepare(win))) throw new Error("Explicit note save failed");
    await context.hideAndRelease(win);
    if (!win.isDestroyed() || (await notes.get(note.id)).content !== dirtyText)
      throw new Error("Close/release lost unsaved content");
    await expectNotePresence(main, note.id, "hidden");
    checks.savedContentSurvivesClose = true;
    checks.rendererReleased = true;
    const reopened = windows.get(await openNote(note.id))!;
    await hydrated(reopened);
    checks.restored = await reopened.webContents.executeJavaScript(
      `document.querySelector('textarea').value === ${JSON.stringify(dirtyText)}`,
    );
    if (!checks.restored) throw new Error("Reopen lost content");
    await reopened.webContents.executeJavaScript(
      `window.spark233Desktop.invoke("toggle_tile_window", { noteId: ${JSON.stringify(note.id)} })`,
    );
    await wait(350);
    checks.sameWindowTile = await reopened.webContents.executeJavaScript(
      "!!document.querySelector('[data-surface-mode=tile]')",
    );
    // Regression: the native paper-menu interceptor swallowed the tile's edit action.
    // Exercise the user's actual right-click path instead of reopening through backend IPC.
    reopened.webContents.sendInputEvent({ type: "mouseDown", button: "right", x: 100, y: 100 });
    reopened.webContents.sendInputEvent({ type: "mouseUp", button: "right", x: 100, y: 100 });
    await wait(200);
    const tileMenuOpened = await reopened.webContents.executeJavaScript(`(() => {
      const action = document.querySelector('button[data-surface-action="switchToPad"]:not([aria-label])');
      if (!action) return false;
      action.click();
      return true;
    })()`);
    if (!tileMenuOpened) throw new Error("Tile right-click has no return-to-note action");
    await wait(350);
    checks.sameWindowEditor = await reopened.webContents.executeJavaScript(
      `document.querySelector('textarea')?.value === ${JSON.stringify(dirtyText)}`,
    );
    if (!checks.sameWindowTile || !checks.sameWindowEditor)
      throw new Error("Existing note window did not switch display/edit mode");
    await reopened.webContents.executeJavaScript(
      `window.spark233Desktop.invoke("toggle_tile_window", { noteId: ${JSON.stringify(note.id)} })`,
    );
    await wait(200);
    await reopened.webContents.executeJavaScript(
      "document.querySelector('button[data-surface-action=\"switchToPad\"][aria-label]').click()",
    );
    await wait(350);
    if (!(await reopened.webContents.executeJavaScript("!!document.querySelector('textarea')")))
      throw new Error("Tile edit button did not return to the note editor");
    checks.tileReturnViaContextMenuAndButton = true;
    // Explicit backup/save preparation still reports real filesystem failures.
    const failureText = "保存失败时保留这段中文\n";
    await reopened.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(failureText)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(80);
    const metadataFile = path.join(context.dataDir(), "metadata.json");
    const backup = `${metadataFile}.smoke-backup`;
    fs.renameSync(metadataFile, backup);
    fs.mkdirSync(metadataFile);
    let refused = false;
    try {
      refused = !(await context.prepare(reopened));
    } catch {
      refused = true;
    } finally {
      fs.rmdirSync(metadataFile);
      fs.renameSync(backup, metadataFile);
    }
    checks.saveFailurePreservesWindow =
      refused &&
      !reopened.isDestroyed() &&
      (await reopened.webContents.executeJavaScript(
        `document.querySelector('textarea').value === ${JSON.stringify(failureText)}`,
      ));
    if (!checks.saveFailurePreservesWindow)
      throw new Error("Save failure destroyed the dirty editor");
    const relativeImage = await notes.saveImage(
      note.id,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=",
        "base64",
      ),
      "png",
    );
    const imagePath = await notes.resolveImage(relativeImage);
    checks.imageFetch = await reopened.webContents.executeJavaScript(
      `fetch('spark233://asset/' + encodeURIComponent(${JSON.stringify(imagePath)})).then(async r => ({ status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength }))`,
    );
    checks.image = await reopened.webContents.executeJavaScript(
      `(async () => { const img = new Image(); img.src = 'spark233://asset/' + encodeURIComponent(${JSON.stringify(imagePath)}); await img.decode(); return img.naturalWidth; })()`,
    );
    checks.protocolDenied = await reopened.webContents.executeJavaScript(
      `fetch('spark233://asset/' + encodeURIComponent(${JSON.stringify(path.join(context.configDir, "config.json"))})).then(r => r.status)`,
    );
    if (checks.image !== 1 || checks.protocolDenied !== 403)
      throw new Error("Asset protocol boundary failed");
    const expandedBounds = reopened.getBounds();
    if (!(await context.prepare(reopened))) throw new Error("Explicit note save failed");
    await context.foldAndRelease(reopened);
    await expectNotePresence(main, note.id, "capsule");
    const layout = context.layouts.get(label)!;
    if (
      !reopened.isDestroyed() ||
      !layout.folded ||
      !layout.visible ||
      (await notes.get(note.id)).content !== failureText
    )
      throw new Error("Fold did not save and release its editor");
    const owner = () =>
      [...context.capsules.surfaces.values()].find(
        (s) => s.snapshot.kind === "queue" && s.snapshot.items.some((i) => i.id === note.id),
      );
    let queue = owner();
    if (!queue) throw new Error("Folded note has no edge queue");
    for (let i = 0; i < 100 && !queue.ready; i++) await wait(100);
    await wait(150);
    if (!queue.ready || !queue.win.isVisible()) throw new Error("Edge host did not render");
    const queueWin = queue.win;
    const capsuleInputErrors: string[] = [];
    queueWin.webContents.on("console-message", (details) => {
      if (details.level === "error") capsuleInputErrors.push(details.message);
    });
    await queueWin.webContents.executeJavaScript(`(() => {
      window.capsuleInputEvents = [];
      for (const type of ['pointerdown','pointerup','pointercancel','gotpointercapture','lostpointercapture','click']) {
        document.addEventListener(type,event=>window.capsuleInputEvents.push({type,button:event.button,detail:event.detail,id:event.target.closest('[data-capsule-id]')?.dataset.capsuleId}),true);
      }
    })()`);
    for (let i = 0; i < 2; i++) {
      const n = await notes.save({
        title: `队列验证 ${i + 1}`,
        content: "# 胶囊预览\n- [ ] 任务\n",
        category: "",
      });
      const w = windows.get(await openNote(n.id))!;
      await hydrated(w);
      w.setBounds(expandedBounds);
      await context.foldAndRelease(w);
    }
    queue = owner()!;
    if (queue.win !== queueWin || queue.snapshot.items.filter((i) => !i.master).length < 3)
      throw new Error("Collapsed notes did not share one edge host");
    const denial = await queueWin.webContents.executeJavaScript(
      "window.spark233Desktop.invoke('notes_delete',{id:" + JSON.stringify(note.id) + "})",
    );
    if (denial.ok) throw new Error("Capsule host crossed its write capability boundary");
    const clickMaster = () => clickCapsule(queueWin, ".capsule-master", 2);
    await clickMaster();
    await wait(120);
    checks.capsulePointerInput = {
      events: await queueWin.webContents.executeJavaScript("window.capsuleInputEvents"),
      errors: capsuleInputErrors,
    };
    if (queue.snapshot.items.length !== 1) throw new Error("Master did not collapse its queue");
    await clickMaster();
    await wait(120);
    if (queue.snapshot.items.length < 4) throw new Error("Master did not restore its queue");
    // A drag that loses capture must not become a click, and must not leave a stuck gesture.
    const dragTarget = `[data-capsule-id="${note.id}"]`;
    const dragPoint = await queueWin.webContents.executeJavaScript(`(() => {
      const r=document.querySelector(${JSON.stringify(dragTarget)}).getBoundingClientRect();
      return {x:Math.round(r.x+20),y:Math.round(r.y+r.height/2)};
    })()`);
    queueWin.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      clickCount: 1,
      ...dragPoint,
    });
    queueWin.webContents.sendInputEvent({ type: "mouseMove", x: dragPoint.x + 12, y: dragPoint.y });
    await wait(150);
    if (!context.capsules.surfaces.has("drag"))
      throw new Error("Pointer movement did not start a capsule drag");
    await queueWin.webContents.executeJavaScript(
      `document.querySelector(${JSON.stringify(dragTarget)}).dispatchEvent(new Event('lostpointercapture',{bubbles:true}))`,
    );
    queueWin.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      clickCount: 1,
      x: dragPoint.x + 12,
      y: dragPoint.y,
    });
    await wait(150);
    if (
      windows.has(label) ||
      !context.layouts.get(label)!.folded ||
      context.capsules.surfaces.has("drag")
    )
      throw new Error("Cancelled capsule drag opened a note or left a drag window");
    // Move only the test window under the existing cursor, then exercise renderer hover IPC.
    // This proves the real preview/no-focus path, not physical mouse gestures or mixed-DPI dragging.
    let cursor = screen.getCursorScreenPoint();
    const item = queue.snapshot.items.find((i) => i.id === note.id)!;
    const originalQueueBounds = queueWin.getBounds();
    let preview = context.capsules.surfaces.get("preview");
    // Native hover admission uses the real cursor. The user may keep using the desktop during
    // a probe, so retry positioning the test host rather than assuming the cursor stayed still.
    for (let attempt = 0; attempt < 12; attempt++) {
      cursor = screen.getCursorScreenPoint();
      const actualBounds = queueWin.getBounds();
      if (
        attempt === 0 ||
        !contains(
          { ...item.rect, x: actualBounds.x + item.rect.x, y: actualBounds.y + item.rect.y },
          cursor,
          2,
        )
      ) {
        queueWin.setPosition(cursor.x - item.rect.x - 20, cursor.y - item.rect.y - 16);
        await queueWin.webContents.executeJavaScript(
          "window.spark233Desktop.invoke('capsule_hover',{id:" + JSON.stringify(note.id) + "})",
        );
      }
      // Keep the one hover request alive while its real backend read completes.
      // Re-entering on every poll would invalidate each in-flight preview.
      await wait(350);
      preview = context.capsules.surfaces.get("preview");
      if (preview?.ready && preview.win.isVisible()) break;
    }
    checks.previewDiagnostics = {
      cursor,
      currentCursor: screen.getCursorScreenPoint(),
      item,
      queueBounds: queueWin.isDestroyed() ? null : queueWin.getBounds(),
      present: !!preview,
      ready: preview?.ready,
      visible: preview?.win.isVisible(),
      focusable: preview?.win.isFocusable(),
      focused: preview?.win.isFocused(),
    };
    if (!preview?.win.isVisible() || preview.win.isFocusable() || preview.win.isFocused())
      throw new Error("Hover preview was missing or activated");
    const previewText = await preview.win.webContents.executeJavaScript("document.body.innerText");
    if (!previewText.includes(failureText))
      throw new Error("Preview content differs from durable note");
    fs.writeFileSync(
      path.join(path.dirname(context.output), "capsule-preview.png"),
      (await preview.win.capturePage()).toPNG(),
    );
    queueWin.setBounds(originalQueueBounds);
    await clickCapsule(queueWin, `[data-capsule-id="${note.id}"]`);
    const restored = await hydrated(label);
    if (
      context.layouts.get(label)!.folded ||
      JSON.stringify(restored.getBounds()) !== JSON.stringify(expandedBounds)
    )
      throw new Error("Capsule open lost expanded geometry");
    await expectNotePresence(main, note.id, "desktop");
    checks.notePresenceTransitions = true;
    fs.writeFileSync(
      path.join(path.dirname(context.output), "note-states.png"),
      (await main.capturePage()).toPNG(),
    );
    await context.foldAndRelease(restored);
    await wait(200);
    const pinBeforeClose = context.layouts.get(label)!.topmost;
    const capsuleControl = await queueWin.webContents.executeJavaScript(`(() => {
      const button = document.querySelector('[data-capsule-id=${JSON.stringify(note.id)}]');
      const close = document.querySelector('[data-capsule-close=${JSON.stringify(note.id)}]');
      const text = button.querySelector('.capsule-label').getBoundingClientRect();
      const pill = button.getBoundingClientRect();
      const x = close.getBoundingClientRect();
      return { x: Math.round(x.x + x.width/2), y: Math.round(x.y + x.height/2),
        titleReadable: text.width >= 75 && text.right <= x.left,
        closeOnRight: x.right <= pill.right && x.left > pill.x + pill.width/2,
        fullTitle: button.title === button.querySelector('.capsule-label').textContent };
    })()`);
    if (!capsuleControl.titleReadable || !capsuleControl.closeOnRight || !capsuleControl.fullTitle)
      throw new Error(`Capsule title/close layout failed: ${JSON.stringify(capsuleControl)}`);
    fs.writeFileSync(
      path.join(path.dirname(context.output), "capsule-controls.png"),
      (await queueWin.capturePage()).toPNG(),
    );
    queueWin.webContents.sendInputEvent({
      type: "mouseDown",
      button: "left",
      x: capsuleControl.x,
      y: capsuleControl.y,
      clickCount: 1,
    });
    queueWin.webContents.sendInputEvent({
      type: "mouseUp",
      button: "left",
      x: capsuleControl.x,
      y: capsuleControl.y,
      clickCount: 1,
    });
    await expectNotePresence(main, note.id, "hidden");
    if (
      (await notes.get(note.id)).content !== failureText ||
      context.layouts.get(label)!.topmost !== pinBeforeClose ||
      windows.has(label)
    )
      throw new Error("Capsule close lost content, pin preference, or reopened the editor");
    if (owner()) throw new Error("Closed capsule remained in the edge queue");
    const afterClose = windows.get(await openNote(note.id))!;
    await hydrated(afterClose);
    if (
      !(await afterClose.webContents.executeJavaScript(
        `document.querySelector('textarea').value === ${JSON.stringify(failureText)}`,
      ))
    )
      throw new Error("Hidden capsule did not reopen with saved content");
    checks.capsuleClose = {
      hidden: true,
      contentPreserved: true,
      pinPreserved: true,
      noAccidentalOpen: true,
      canReopen: true,
      titleReadable: true,
      closeOnRight: true,
    };
    const floatingNote = await notes.save({
      title: "悬浮胶囊点击",
      content: "悬浮展开后正文保持原样",
      category: "",
    });
    const floatingLabel = await openNote(floatingNote.id);
    const floatingEditor = windows.get(floatingLabel)!;
    await hydrated(floatingEditor);
    const floatingBounds = floatingEditor.getBounds();
    await context.foldAndRelease(floatingEditor);
    const floatingLayout = context.layouts.get(floatingLabel)!;
    floatingLayout.capsule = {
      ...floatingLayout.capsule!,
      kind: "floating",
      x: floatingBounds.x,
      y: floatingBounds.y,
    };
    await context.capsules.refresh();
    const floating = context.capsules.surfaces.get(`floating:${floatingNote.id}`)!;
    for (let i = 0; !floating.ready && i < 60; i++) await wait(50);
    if (!floating.ready) throw new Error("Floating capsule did not render");
    await clickCapsule(floating.win, `[data-capsule-id="${floatingNote.id}"]`);
    const floatingRestored = await hydrated(floatingLabel);
    if (floatingLayout.folded) throw new Error("Native click did not open floating capsule");
    if (
      JSON.stringify(floatingRestored.getBounds()) !== JSON.stringify(floatingBounds) ||
      (await notes.get(floatingNote.id)).content !== floatingNote.content
    )
      throw new Error("Floating capsule lost its expanded bounds or note content");
    await context.hideAndRelease(floatingRestored);
    checks.capsules = {
      durableFold: true,
      editorReleased: true,
      sharedQueue: true,
      masterToggle: true,
      nativeClickOpensNote: true,
      floatingClickOpensNote: true,
      smallMovementStillClicks: true,
      cancelledDragDoesNotOpen: true,
      capabilityDenied: true,
      previewNoFocus: true,
      previewContent: true,
      expandedGeometry: true,
    };
    checks.gpu = context.gpuDiagnostics();
    const gpu = context.gpuDiagnostics();
    if (
      process.platform === "win32" &&
      (gpu.crashCount !== 0 || gpu.features.gpu_compositing !== "enabled" || !gpu.sandboxEnabled)
    )
      throw new Error(`Hardware GPU/sandbox check failed: ${JSON.stringify(gpu)}`);
    await verifyLauncherMaintenance();
    await verifyFinalPluginSave();
    checks.errors = errors;
    fs.mkdirSync(path.dirname(context.output), { recursive: true });
    fs.writeFileSync(
      context.output,
      JSON.stringify(
        {
          ok: true,
          runtime: {
            packaged: app.isPackaged,
            electron: process.versions.electron,
            platform: process.platform,
          },
          checks,
        },
        null,
        2,
      ),
    );
  } catch (error) {
    fs.mkdirSync(path.dirname(context.output), { recursive: true });
    fs.writeFileSync(
      context.output,
      JSON.stringify(
        {
          ok: false,
          checks,
          error:
            error instanceof Error
              ? error.stack
              : JSON.stringify(error, Object.getOwnPropertyNames(Object(error))),
        },
        null,
        2,
      ),
    );
  } finally {
    context.quit();
  }
}

import fs from "node:fs";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import type { NoteStore } from "./store.js";

interface SmokeContext {
  output: string;
  gpuDiagnostics: () => {
    crashCount: number;
    features: Electron.GPUFeatureStatus;
    startedFromUnc: boolean;
    workingDirectoryIsLocal: boolean;
    sandboxEnabled: boolean;
  };
  store: NoteStore;
  windows: Map<string, BrowserWindow>;
  layouts: Map<string, { noteId?: string; visible: boolean }>;
  openNote: (id?: string, view?: "notepad" | "tile") => string;
  showMain: () => BrowserWindow;
  hideAndRelease: (win: BrowserWindow) => Promise<void>;
  emit: (name: string, payload?: unknown, target?: BrowserWindow) => void;
  quit: () => void;
}
export async function runSmoke(context: SmokeContext): Promise<void> {
  const { store, windows, openNote, showMain } = context;
  const checks: Record<string, unknown> = {};
  const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  async function hydrated(win: BrowserWindow) {
    for (let i = 0; i < 100; i++) {
      if (win.isDestroyed()) throw new Error("Window destroyed during load");
      if (
        await win.webContents
          .executeJavaScript("!!window.floralDesktop && !!document.querySelector('textarea')")
          .catch(() => false)
      ) {
        await wait(500);
        return;
      }
      await wait(100);
    }
    throw new Error("Renderer did not hydrate");
  }
  try {
    const main = showMain();
    await hydrated(main);
    const errors: string[] = [];
    for (const win of windows.values())
      win.webContents.on("console-message", (details) => {
        if (details.level === "error") errors.push(details.message);
      });
    const note = store.save({
      title: "Electron 中文验证",
      content: "# 测试\n- [ ] 保留中文\n**Markdown**\n",
      category: "",
    });
    const label = openNote(note.id),
      win = windows.get(label)!;
    await hydrated(win);
    const ipc = await win.webContents.executeJavaScript(`(async () => {
      const result = await window.floralDesktop.invoke('notes_get', { id: ${JSON.stringify(note.id)} });
      const denial = await window.floralDesktop.invoke('read_external_file', { path: ${JSON.stringify(path.join(store.configDir, "config.json"))} });
      return { node: typeof require, bridge: !!window.floralDesktop, note: result, denial };
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
    await context.hideAndRelease(win);
    if (!win.isDestroyed() || store.get(note.id).content !== dirtyText)
      throw new Error("Close/release lost unsaved content");
    checks.durableClose = true;
    checks.rendererReleased = true;
    const reopened = windows.get(openNote(note.id))!;
    await hydrated(reopened);
    checks.restored = await reopened.webContents.executeJavaScript(
      `document.querySelector('textarea').value === ${JSON.stringify(dirtyText)}`,
    );
    if (!checks.restored) throw new Error("Reopen lost content");
    await reopened.webContents.executeJavaScript(
      `window.floralDesktop.invoke("toggle_tile_window", { noteId: ${JSON.stringify(note.id)} })`,
    );
    await wait(350);
    checks.sameWindowTile = await reopened.webContents.executeJavaScript(
      "!!document.querySelector('[data-surface-mode=tile]')",
    );
    openNote(note.id, "notepad");
    await wait(350);
    checks.sameWindowEditor = await reopened.webContents.executeJavaScript(
      "!!document.querySelector('textarea')",
    );
    if (!checks.sameWindowTile || !checks.sameWindowEditor)
      throw new Error("Existing note window did not switch display/edit mode");
    // A real filesystem failure must keep the renderer and its dirty text alive.
    const failureText = "保存失败时保留这段中文";
    await reopened.webContents.executeJavaScript(`(() => {
      const area = document.querySelector('textarea');
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(area, ${JSON.stringify(failureText)});
      area.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await wait(80);
    const metadataFile = path.join(store.dataDir, "metadata.json");
    const backup = `${metadataFile}.smoke-backup`;
    fs.renameSync(metadataFile, backup);
    fs.mkdirSync(metadataFile);
    let refused = false;
    try {
      await context.hideAndRelease(reopened);
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
    const relativeImage = store.saveImage(
      note.id,
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZl8AAAAASUVORK5CYII=",
        "base64",
      ),
      "png",
    );
    checks.imageFetch = await reopened.webContents.executeJavaScript(
      `fetch('floral://asset/' + encodeURIComponent(${JSON.stringify(path.join(store.dataDir, relativeImage))})).then(async r => ({ status: r.status, type: r.headers.get('content-type'), size: (await r.arrayBuffer()).byteLength }))`,
    );
    checks.image = await reopened.webContents.executeJavaScript(
      `(async () => { const img = new Image(); img.src = 'floral://asset/' + encodeURIComponent(${JSON.stringify(path.join(store.dataDir, relativeImage))}); await img.decode(); return img.naturalWidth; })()`,
    );
    checks.protocolDenied = await reopened.webContents.executeJavaScript(
      `fetch('floral://asset/' + encodeURIComponent(${JSON.stringify(path.join(store.configDir, "config.json"))})).then(r => r.status)`,
    );
    if (checks.image !== 1 || checks.protocolDenied !== 403)
      throw new Error("Asset protocol boundary failed");
    checks.gpu = context.gpuDiagnostics();
    const gpu = context.gpuDiagnostics();
    if (
      process.platform === "win32" &&
      (gpu.crashCount !== 0 || gpu.features.gpu_compositing !== "enabled" || !gpu.sandboxEnabled)
    )
      throw new Error(`Hardware GPU/sandbox check failed: ${JSON.stringify(gpu)}`);
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

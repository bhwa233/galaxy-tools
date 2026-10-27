import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import clipboardBackend from "./backend.js";
import {
  decodeClipboardSnapshot,
  encodeClipboardSnapshot,
  textClipboardSnapshot,
} from "../../../electron/plugins/official/clipboard-history.js";
import type { BackendContext, BackendPlugin } from "../../../electron/plugins/backend-worker.js";
import type { JsonValue } from "../../../packages/sdk/src/index.js";
import type {
  ClipboardEntry,
  ClipboardPage,
  ClipboardSettings,
} from "../../../src/features/clipboard/types.js";

describe("clipboard backend persistence and resource ownership", () => {
  let directory: string;
  let lifetime: BackendContext;
  let backend: BackendPlugin;
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6n8AAAAASUVORK5CYII=",
    "base64",
  );
  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), "spark233-clipboard-backend-"));
    lifetime = {
      owner: { pluginId: "spark233.clipboard", version: "1.0.0", instanceId: randomUUID() },
      dataDir: path.join(directory, "data"),
      cacheDir: path.join(directory, "cache"),
      signal: new AbortController().signal,
      startupCheckOnly: false,
      emit: () => {},
      callHost: async () => {
        throw new Error("Clipboard data tests must not invoke a host effect");
      },
    };
    fs.mkdirSync(lifetime.cacheDir);
    backend = clipboardBackend(lifetime);
  });
  afterEach(async () => {
    try {
      await backend?.stop?.(lifetime);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
  async function request<T>(parameters: Record<string, unknown>): Promise<T> {
    return (await backend.activate!(
      { commandId: "data", parameters: parameters as JsonValue },
      lifetime,
    )) as T;
  }
  async function capture(raw: Buffer, executable = "owned-editor.exe") {
    const file = path.join(lifetime.cacheDir, `capture-${randomUUID()}.scb`);
    fs.writeFileSync(file, raw);
    return request<{ captured: boolean }>({
      action: "native.capture",
      file,
      source: { executable, title: "Owned source fixture" },
    });
  }
  async function snapshot(id: string) {
    const file = path.join(lifetime.cacheDir, `replay-${randomUUID()}.scb`);
    await request({ action: "snapshot", id, mode: "original", file });
    return fs.readFileSync(file);
  }

  it("deduplicates full original formats and durably replays their unchanged bytes", async () => {
    const formats = [
      { id: 13, name: "", bytes: Buffer.from("同一预览正文\0", "utf16le") },
      { id: 0xc000, name: "HTML Format", bytes: Buffer.from("<b>同一预览正文</b>\0") },
      { id: 0xc001, name: "Rich Text Format", bytes: Buffer.from("{\\rtf1 owned rich text}\0") },
    ];
    const original = encodeClipboardSnapshot(formats);
    await capture(original);
    const first = (await request<ClipboardPage>({ action: "list" })).entries[0];
    await capture(original, "another-editor.exe");
    const repeated = await request<ClipboardPage>({ action: "list" });
    expect(repeated.entries.map((entry) => entry.id)).toEqual([first.id]);
    expect(repeated.entries[0]).toMatchObject({ copies: 2, source: "another-editor.exe" });

    // Equal plaintext must not collapse differing rich content into that entry.
    await capture(
      encodeClipboardSnapshot([
        formats[0],
        { ...formats[1], bytes: Buffer.from("<i>同一预览正文</i>\0") },
        formats[2],
      ]),
    );
    const distinct = await request<ClipboardPage>({ action: "list" });
    expect(distinct.entries).toHaveLength(2);
    expect(new Set(distinct.entries.map((entry) => entry.text))).toEqual(new Set([first.text]));
    expect(await snapshot(first.id)).toEqual(original);
    expect(decodeClipboardSnapshot(await snapshot(first.id))).toEqual(formats);

    await backend.prepareStop("quit", lifetime);
    await backend.stop!(lifetime);
    backend = clipboardBackend(lifetime);
    expect(await snapshot(first.id)).toEqual(original);
    expect(
      (await request<ClipboardPage>({ action: "list" })).entries.find(
        (entry) => entry.id === first.id,
      ),
    ).toMatchObject({ copies: 2, source: "another-editor.exe" });
  });

  it("protects favorites and gallery resources while retention only hides entries until confirmed cleanup", async () => {
    const favoriteRaw = textClipboardSnapshot("收藏仍保留");
    const obsoleteRaw = textClipboardSnapshot("待清理独有正文");
    await capture(favoriteRaw);
    const favorite = (await request<ClipboardPage>({ action: "list" })).entries[0];
    await request({ action: "favorite", id: favorite.id, enabled: true });
    await request({ action: "history.remove", ids: [favorite.id] });
    await capture(obsoleteRaw);
    const obsolete = (await request<ClipboardPage>({ action: "list" })).entries[0];
    await request({ action: "update", id: obsolete.id, order: 1 });
    await capture(textClipboardSnapshot("当前可见正文"));
    const imageFile = path.join(lifetime.cacheDir, "owned-gallery.png");
    fs.writeFileSync(imageFile, png);
    const gallery = await request<ClipboardEntry>({
      action: "gallery.import",
      file: imageFile,
      name: "Owned gallery fixture",
    });
    fs.rmSync(imageFile);
    const galleryRaw = await snapshot(gallery.id);
    expect(decodeClipboardSnapshot(galleryRaw)).toEqual([{ id: 0xc000, name: "PNG", bytes: png }]);

    const resources = path.join(lifetime.dataDir, "resources");
    const before = fs.readdirSync(resources).sort();
    const obsoleteResource = before
      .map((name) => path.join(resources, name))
      .find((file) => fs.readFileSync(file).equals(obsoleteRaw))!;
    expect(obsoleteResource).toBeDefined();
    await request({ action: "settings", patch: { visibleCount: 1 } });
    expect((await request<ClipboardPage>({ action: "list", query: "待清理独有正文" })).total).toBe(
      0,
    );
    await request({ action: "settings", patch: { visibleCount: null } });
    expect((await request<ClipboardPage>({ action: "list", query: "待清理独有正文" })).total).toBe(
      1,
    );
    await request({ action: "settings", patch: { visibleCount: 1 } });
    const preview = await request<{ token: string; entries: ClipboardEntry[] }>({
      action: "cleanup.preview",
      outsideVisibleRange: true,
    });
    expect(preview.entries.map((entry) => entry.id)).toEqual([obsolete.id]);
    expect(fs.readdirSync(resources).sort()).toEqual(before);
    const removed = await request<{ removed: number; resourcesReclaimed: number }>({
      action: "cleanup.confirm",
      token: preview.token,
    });
    expect(removed).toMatchObject({ removed: 1, resourcesReclaimed: 1 });
    expect(fs.existsSync(obsoleteResource)).toBe(false);
    expect(
      (await request<ClipboardPage>({ action: "list", view: "all", query: "待清理独有正文" }))
        .total,
    ).toBe(0);
    expect(
      (await request<ClipboardPage>({ action: "list", view: "favorites" })).entries.map(
        (entry) => entry.id,
      ),
    ).toEqual([favorite.id]);
    expect(
      (
        await request<ClipboardPage>({ action: "list", view: "all", groupId: gallery.groups[0] })
      ).entries.map((entry) => entry.id),
    ).toEqual([gallery.id]);
    expect(await snapshot(favorite.id)).toEqual(favoriteRaw);
    expect(await snapshot(gallery.id)).toEqual(galleryRaw);
  });

  it("suppresses passive capture while paused or excluded without blocking an allowed source", async () => {
    expect((await request<ClipboardSettings>({ action: "settings" })).excludedApps).toEqual([]);
    const raw = textClipboardSnapshot("合成输入，不读取系统剪贴板");
    await request({ action: "settings", patch: { paused: true } });
    await expect(capture(raw)).resolves.toEqual({ captured: false });
    await request({ action: "settings", patch: { paused: false, excludedApps: ["secret.exe"] } });
    await expect(capture(raw, path.join(directory, "SeCrEt.ExE"))).resolves.toEqual({
      captured: false,
    });
    expect((await request<ClipboardPage>({ action: "list" })).total).toBe(0);
    expect(fs.readdirSync(path.join(lifetime.dataDir, "resources"))).toEqual([]);
    await expect(capture(raw, "allowed-editor.exe")).resolves.toEqual({ captured: true });
    expect((await request<ClipboardPage>({ action: "list" })).entries[0].source).toBe(
      "allowed-editor.exe",
    );
  });
});

import fs from "node:fs";
import { z } from "zod";
import type { Rect } from "../src/features/capsules/types.js";
import type { DesktopOverlayPanel, LayerCard } from "../shared/layer-contract.js";
import { atomicWrite } from "./persistence.js";

/** Reserve a stable viewport for controls and the bounded hover template. Only
 * visible interaction regions become a native shape, so empty space stays clear. */
export function overlayInteractionBounds(card: LayerCard, area: Rect) {
  const b = card.bounds;
  const controlsWidth = Math.min(280, area.width);
  const controls = {
    x: Math.max(
      area.x,
      b.x + controlsWidth > area.x + area.width ? b.x + b.width - controlsWidth : b.x,
    ),
    y: Math.max(area.y, b.y - 36),
    width: controlsWidth,
    height: 32,
  };
  const size = card.hover?.size;
  const preview = size
    ? {
        x: Math.max(
          area.x + 12,
          Math.min(b.x, area.x + area.width - Math.min(size.width, area.width - 24) - 12),
        ),
        y: 0,
        width: Math.max(1, Math.min(size.width, area.width - 24)),
        height: Math.max(1, Math.min(size.height, area.height - 24)),
      }
    : undefined;
  if (preview) {
    const below = b.y + b.height + 8;
    preview.y = Math.max(
      area.y + 12,
      Math.min(
        below + preview.height <= area.y + area.height - 12 ? below : b.y - preview.height - 44,
        area.y + area.height - preview.height - 12,
      ),
    );
  }
  return { controls, preview };
}

export function overlayViewport(cards: readonly LayerCard[], area: Rect): Rect {
  const regions = cards
    .filter((card) => card.visible)
    .flatMap((card) =>
      [
        card.bounds,
        card.overlayControls,
        card.overlayPreview,
        {
          x: Math.max(area.x, Math.min(card.bounds.x, area.x + area.width - 300)),
          y: Math.max(area.y, Math.min(card.bounds.y - 36, area.y + area.height - 280)),
          width: Math.min(300, area.width),
          height: Math.min(280, area.height),
        },
      ].filter((r): r is Rect => !!r),
    );
  if (!regions.length) return { x: area.x, y: area.y, width: 1, height: 1 };
  const x = Math.min(...regions.map((r) => r.x)),
    y = Math.min(...regions.map((r) => r.y));
  return {
    x,
    y,
    width: Math.max(...regions.map((r) => r.x + r.width)) - x,
    height: Math.max(...regions.map((r) => r.y + r.height)) - y,
  };
}

const boundsSchema = z.strictObject({
  x: z.number().finite().min(-1000000).max(1000000),
  y: z.number().finite().min(-1000000).max(1000000),
  width: z.number().finite().positive().max(32768),
  height: z.number().finite().positive().max(32768),
});
const panelSchema = z.strictObject({
  selected: z.boolean().default(true),
  pinned: z.boolean().optional(),
  passthrough: z.boolean().optional(),
  sourceGroup: z.enum(["top", "normal"]).optional(),
  sourceInputMode: z.enum(["passive", "interactive"]).optional(),
  positions: z.record(z.string().min(1).max(160), boundsSchema).default({}),
});
const layoutSchema = z.strictObject({
  version: z.literal(1),
  panels: z
    .record(z.string().min(1).max(160), panelSchema)
    .refine((v) => Object.keys(v).length <= 512),
});

export function overlayPanelKind(card: LayerCard): DesktopOverlayPanel["kind"] | undefined {
  if (card.presentationOnly || card.presentationHidden) return;
  if (card.renderKind === "notes") {
    const payload = card.payload as { items?: Array<{ master?: boolean }> } | undefined;
    return payload?.items?.[0]?.master ? undefined : "notes";
  }
  if (card.renderKind === "screenshot") return "screenshot";
  if (card.renderKind === "utools") return "utools";
  if (card.renderKind === "window") return "window";
  if (card.renderKind === "declarative" && card.widget?.pluginId === "spark233.traffic")
    return "traffic";
}
/** A note's queue/display view can change while its business identity stays. */
export function overlayPanelKey(card: LayerCard): string {
  return card.renderKind === "notes" && card.renderRef ? `notes:${card.renderRef}` : card.id;
}

// Reuse the host's atomic writer and existing bounded Zod schema. Desktop layout
// transactions describe physical card locations; this separate projection only
// stores game-bar placement and explicit presentation choices, never note data.
export class DesktopOverlayLayout {
  readError?: string;
  /** Keys of cards that currently exist; set by the desktop layer for pruning. */
  liveKeys?: () => ReadonlySet<string>;
  private value: z.infer<typeof layoutSchema> = { version: 1, panels: {} };
  constructor(private readonly filename?: string) {
    if (!filename || !fs.existsSync(filename)) return;
    try {
      if (fs.statSync(filename).size > 256 * 1024) throw new Error("布局超过大小限制");
      this.value = layoutSchema.parse(JSON.parse(fs.readFileSync(filename, "utf8")));
    } catch (error) {
      this.readError = `桌面插件栏布局无法读取，原文件已保留：${String(error)}`;
    }
  }
  get(id: string) {
    return this.value.panels[id];
  }
  update(id: string, patch: Partial<z.infer<typeof panelSchema>>) {
    if (this.readError) throw new Error(this.readError);
    const previous = this.value.panels[id] ?? { selected: true, positions: {} };
    let panels = { ...this.value.panels, [id]: { ...previous, ...patch } };
    let serialized = JSON.stringify({ ...this.value, panels }, null, 2);
    // Panels are keyed per card and were never removed, so the file eventually
    // hit its limits and every drag failed. Near a limit, drop cards that no
    // longer exist. Cards absent only briefly (startup) keep their place until then.
    if (Object.keys(panels).length > 384 || Buffer.byteLength(serialized) > 192 * 1024) {
      const live = this.liveKeys?.();
      if (live)
        panels = Object.fromEntries(
          Object.entries(panels).filter(([key]) => key === id || live.has(key)),
        );
      serialized = JSON.stringify({ ...this.value, panels }, null, 2);
    }
    const next = layoutSchema.parse({ ...this.value, panels });
    if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("桌面插件栏布局超过大小限制");
    if (this.filename) atomicWrite(this.filename, serialized);
    this.value = next;
  }
  position(id: string, displayId: string, bounds: Rect) {
    this.update(id, { positions: { ...this.get(id)?.positions, [displayId]: bounds } });
  }
  place(card: LayerCard, displayId: string, area: Rect, index: number): Rect {
    const saved = this.get(overlayPanelKey(card))?.positions[displayId];
    // Retain the bar's independent position, including older saved layouts,
    // but always take the current content size from its desktop owner.
    const scale = Math.min(
      1,
      Math.max(1, area.width - 24) / card.bounds.width,
      Math.max(1, area.height - 122) / card.bounds.height,
    );
    const width =
      card.renderKind === "utools" || card.renderKind === "window"
        ? Math.min(Math.max(1, area.width - 24), Math.max(320, card.bounds.width * scale))
        : card.bounds.width * scale;
    const height =
      card.renderKind === "utools" || card.renderKind === "window"
        ? Math.min(Math.max(1, area.height - 122), Math.max(160, card.bounds.height * scale))
        : card.bounds.height * scale;
    const columns = Math.max(1, Math.floor((area.width - 32) / (Math.min(340, width) + 20)));
    const x =
      saved?.x ??
      area.x + 24 + (index % columns) * Math.min(width + 20, (area.width - 48) / columns);
    const y = saved?.y ?? area.y + 132 + Math.floor(index / columns) * 304;
    return {
      x: Math.max(area.x + 12, Math.min(area.x + area.width - width - 12, x)),
      y: Math.max(area.y + 110, Math.min(area.y + area.height - height - 12, y)),
      width,
      height,
    };
  }
}

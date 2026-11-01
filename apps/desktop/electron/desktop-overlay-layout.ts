import fs from "node:fs";
import { z } from "zod";
import type { Rect } from "../src/features/capsules/types.js";
import type { DesktopOverlayPanel, LayerCard } from "../shared/layer-contract.js";
import { atomicWrite } from "./persistence.js";

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
    const next = layoutSchema.parse({
      ...this.value,
      panels: { ...this.value.panels, [id]: { ...previous, ...patch } },
    });
    const serialized = JSON.stringify(next, null, 2);
    if (Buffer.byteLength(serialized) > 256 * 1024) throw new Error("桌面插件栏布局超过大小限制");
    if (this.filename) atomicWrite(this.filename, serialized);
    this.value = next;
  }
  position(id: string, displayId: string, bounds: Rect) {
    this.update(id, { positions: { ...this.get(id)?.positions, [displayId]: bounds } });
  }
  place(card: LayerCard, displayId: string, area: Rect, index: number): Rect {
    const saved = this.get(overlayPanelKey(card))?.positions[displayId];
    const width = Math.min(Math.max(240, saved?.width ?? 320), Math.max(1, area.width - 32));
    const height = Math.min(
      Math.max(
        64,
        saved?.height ??
          (card.renderKind === "screenshot" ? 240 : card.renderKind === "notes" ? 160 : 112),
      ),
      Math.max(1, area.height - 136),
    );
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

import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite, readJson } from "../persistence.js";
import { desktopLayoutSchema, type LayerLayoutStore } from "../layer-layout-store.js";
import { PluginWindowLayoutStore, type WindowPlacementRecord } from "./plugin-window-state.js";
import type { ResolvedWindowDefinition } from "./plugin-window-catalog.js";

/** One migration snapshot and one new writer. Source records are removed only
 * after the full target commits; a replay finishes retirement with stable IDs. */
export async function migratePluginWindowLayout(options: {
  store: PluginWindowLayoutStore;
  layer: LayerLayoutStore;
  hostRoot: string;
  configRoot: string;
  definition(pluginId: string, windowId: string): ResolvedWindowDefinition | undefined;
  displayId: string;
  area: WindowPlacementRecord["bounds"];
}): Promise<void> {
  if (options.store.readError || options.layer.readError)
    throw new Error("Window migration source is unreadable");
  const retire = async () => {
    const migration = options.store.load().migration;
    const removed = migration?.removedCards ?? [];
    const source = options.layer.load();
    if (!removed.some((id) => source.cards[id])) return;
    const hash = migration?.sources[0];
    if (!hash || !/^[a-f0-9]{64}$/.test(hash))
      throw new Error("Window migration snapshot identity is unavailable");
    const backup = readJson(
      path.join(options.hostRoot, "window-migration-" + hash.slice(0, 16) + ".json"),
    );
    if (createHash("sha256").update(JSON.stringify(backup)).digest("hex") !== hash)
      throw new Error("Window migration snapshot identity does not match");
    const saved = z.object({ layer: desktopLayoutSchema }).parse(backup).layer;
    const warnings: string[] = [];
    let changed = false;
    for (const id of removed) {
      if (!source.cards[id]) continue;
      // An interrupted retirement must never erase a newer legacy record that
      // happens to reuse the same key after a restore or an older host run.
      if (JSON.stringify(source.cards[id]) !== JSON.stringify(saved.cards[id])) {
        warnings.push(`${id}: changed legacy source retained after interrupted migration`);
        continue;
      }
      delete source.cards[id];
      changed = true;
    }
    if (changed)
      await options.layer.commit({ ...source, revision: source.revision + 1 }, source.revision);
    const nextWarnings = [...new Set([...(migration?.warnings ?? []), ...warnings])].slice(0, 512);
    if (JSON.stringify(nextWarnings) !== JSON.stringify(migration?.warnings ?? []))
      options.store.commit((target) => {
        target.migration!.warnings = nextWarnings;
      });
  };
  if (options.store.load().migration) {
    await retire();
    return;
  }
  const source = options.layer.load();
  const geometryFile = path.join(options.hostRoot, "plugin-windows.json");
  const geometry = fs.existsSync(geometryFile)
    ? z
        .array(
          z.object({
            pluginId: z.string(),
            profile: z.string(),
            topmost: z.boolean(),
            bounds: z.object({
              x: z.number().finite(),
              y: z.number().finite(),
              width: z.number().positive(),
              height: z.number().positive(),
            }),
          }),
        )
        .max(512)
        .parse(readJson(geometryFile))
    : [];
  const overlayFile = path.join(options.configRoot, "desktop-overlay-layout.json");
  const positions = fs.existsSync(overlayFile)
    ? z
        .object({
          panels: z.record(
            z.string(),
            z.object({
              selected: z.boolean().optional(),
              positions: z
                .record(
                  z.string(),
                  z.object({
                    x: z.number().finite(),
                    y: z.number().finite(),
                    width: z.number().positive(),
                    height: z.number().positive(),
                  }),
                )
                .optional(),
            }),
          ),
        })
        .parse(readJson(overlayFile)).panels
    : {};
  const snapshot = { layer: source, overlay: positions, geometry };
  const hash = createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
  const backup = path.join(options.hostRoot, "window-migration-" + hash.slice(0, 16) + ".json");
  if (!fs.existsSync(backup)) atomicWrite(backup, JSON.stringify(snapshot));
  options.store.commit((target) => {
    const removedCards: string[] = [];
    const warnings: string[] = [];
    const cardBounds = (
      id: string,
      card: (typeof source.cards)[string],
      fallback: WindowPlacementRecord["bounds"],
    ) => {
      const previous = positions[id];
      const current = previous?.positions?.[options.displayId];
      if (current)
        return { ...current, x: current.x - options.area.x, y: current.y - options.area.y };
      const original = previous?.positions?.[card.displayId];
      if (original)
        return {
          ...original,
          x: original.x - card.workAreaAtSave.x,
          y: original.y - card.workAreaAtSave.y,
        };
      return { ...fallback, x: 24, y: 110 };
    };
    // Notes retain their capsule consumer, but card membership uses the stable
    // business ID and the expanded editor geometry from notesCompat.
    for (const [id, card] of Object.entries(source.cards)) {
      if (card.kind !== "notes") continue;
      const note = source.notesCompat?.windows.find((value) => value.noteId === card.noteId);
      const windowId = note?.view === "tile" ? "tile" : "notepad";
      const definition = options.definition("spark233.notes", windowId);
      if (
        !definition ||
        definition.purpose !== "business" ||
        target.instances.some(
          (value) => value.pluginId === "spark233.notes" && value.binding.contentId === card.noteId,
        )
      )
        continue;
      const instance = {
        id: randomUUID(),
        pluginId: "spark233.notes",
        autoRestore: card.restore,
        binding: { windowId, contentId: card.noteId, parameterVersion: 1 },
      };
      target.instances.push(instance);
      const bounds = note?.bounds ?? { ...card.bounds, ...definition.size };
      target.placements.push({
        id: randomUUID(),
        instanceId: instance.id,
        environment: "desktop",
        bounds,
        visible: card.visible,
        topmost: card.group === "top",
        order: card.order,
      });
      const previous = positions[id];
      if (definition.cardDesktop && card.visible && previous) {
        target.placements.push({
          id: randomUUID(),
          instanceId: instance.id,
          environment: "card-desktop",
          bounds: cardBounds(id, card, bounds),
          visible: previous.selected !== false,
          order: card.order,
        });
      }
    }
    for (const saved of geometry) {
      const definition = options.definition(saved.pluginId, saved.profile);
      if (
        !definition ||
        definition.purpose !== "business" ||
        definition.reuse !== "singleton" ||
        target.instances.some(
          (value) => value.pluginId === saved.pluginId && value.binding.windowId === saved.profile,
        )
      )
        continue;
      const instance = {
        id: randomUUID(),
        pluginId: saved.pluginId,
        binding: {
          windowId: saved.profile,
          parameterVersion: definition.restore?.parameterVersion ?? 1,
        },
        autoRestore: false,
      };
      target.instances.push(instance);
      target.placements.push({
        id: randomUUID(),
        instanceId: instance.id,
        environment: "desktop",
        bounds: saved.bounds,
        visible: false,
        topmost: saved.topmost,
        order: 0,
      });
    }
    for (const [id, card] of Object.entries(source.cards)) {
      if (card.kind === "screenshot" || card.kind === "notes") {
        if (card.kind === "notes") continue;
        warnings.push(
          `${id}: retained by its existing consumer until a window binding is available`,
        );
        continue;
      }
      const windowId =
        card.kind === "window"
          ? card.windowProfile
          : card.kind === "widget"
            ? card.widgetDefinitionId
            : "utools-main";
      const definition = options.definition(card.pluginId, windowId);
      if (!definition) {
        warnings.push(`${id}: window declaration unavailable`);
        continue;
      }
      if (definition.purpose !== "business") {
        warnings.push(`${id}: transient dialog retained by its existing consumer`);
        continue;
      }
      if (definition.reuse === "document") {
        warnings.push(`${id}: content identity unavailable`);
        continue;
      }
      let instance = target.instances.find(
        (value) =>
          value.pluginId === card.pluginId &&
          value.binding.windowId === windowId &&
          definition.reuse === "singleton",
      );
      if (!instance) {
        instance = {
          id:
            card.kind === "window"
              ? card.windowInstanceId
              : card.kind === "widget"
                ? card.widgetInstanceId
                : card.utoolsInstanceId,
          pluginId: card.pluginId,
          autoRestore: card.restore,
          binding: {
            windowId,
            parameterVersion: 1,
            ...(card.kind === "utools" ? { parameters: { featureCode: card.featureCode } } : {}),
          },
        };
        target.instances.push(instance);
      }
      // A legacy live membership supersedes its older geometry-only snapshot.
      // Otherwise that snapshot leaves the migrated window hidden on restart.
      instance.autoRestore = card.restore;
      const desktop = target.placements.find(
        (value) => value.instanceId === instance.id && value.environment === "desktop",
      );
      if (desktop)
        Object.assign(desktop, {
          bounds: card.bounds,
          visible: card.visible,
          topmost: card.group === "top",
          displayId: card.displayId,
          order: card.order,
        });
      else
        target.placements.push({
          id: randomUUID(),
          instanceId: instance.id,
          environment: "desktop",
          bounds: card.bounds,
          visible: card.visible,
          topmost: card.group === "top",
          displayId: card.displayId,
          order: card.order,
        });
      const previous = positions[id];
      if (
        definition.cardDesktop &&
        card.visible &&
        previous &&
        !target.placements.some(
          (value) => value.instanceId === instance.id && value.environment === "card-desktop",
        )
      ) {
        target.placements.push({
          id: randomUUID(),
          instanceId: instance.id,
          environment: "card-desktop",
          bounds: cardBounds(id, card, card.bounds),
          visible: previous.selected !== false,
          order: card.order,
        });
      }
      removedCards.push(id);
    }
    target.migration = { version: 1, sources: [hash], removedCards, warnings };
  });
  await retire();
}

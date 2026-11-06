import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { PluginPackageMetadata } from "@spark233/sdk";
import type { LayerCard, LayerInstanceSummary } from "../../shared/layer-contract.js";
import type { UToolsDesktopPresentation } from "../../shared/utools-desktop.js";
import type { DesktopLayer } from "../desktop-layer.js";
import {
  constrainLayerCard,
  DEFAULT_LAYER_QUOTAS,
  type LayerLayoutStore,
  type UToolsLayoutCard,
} from "../layer-layout-store.js";
import { AppError } from "../persistence.js";
import { contains } from "../capsule-layout.js";
import type { DesktopPluginHost } from "./desktop-host.js";
import type { PluginResourceScope } from "./resources.js";

const coordinate = z.number().finite().min(-1_000_000).max(1_000_000);
const bounds = z.strictObject({
  x: coordinate,
  y: coordinate,
  width: z.number().min(320).max(32768),
  height: z.number().min(160).max(32768),
});
const revision = z.number().int().nonnegative().safe();
const requestSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("pin"), bounds, featureCode: z.string().min(1).max(160) }),
  z.strictObject({ type: z.literal("unpin") }),
  z.strictObject({ type: z.literal("focus"), focused: z.boolean() }),
  z.strictObject({ type: z.literal("close-overlay"), revision }),
  z.strictObject({ type: z.literal("bounds"), bounds, revision }),
  z.strictObject({
    type: z.literal("panel"),
    revision,
    action: z.enum(["show", "hide", "pin", "passthrough", "open"]),
    value: z.boolean().optional(),
  }),
]);
interface Session {
  scope: PluginResourceScope;
  metadata: PluginPackageMetadata;
  present(value: UToolsDesktopPresentation | null): Promise<void>;
  release?: () => void;
  revision: number;
  focused: boolean;
  queue: Promise<void>;
  failure?: string;
  detaching?: boolean;
}

/** Reuses the layer's durable layout, projection and management commands. The
 * compatibility process keeps ownership of its existing HWND and WebContents. */
export class UToolsDesktopHost {
  private sessions = new Map<string, Session>();
  private syncing?: Promise<void>;
  constructor(
    private readonly options: {
      layer: DesktopLayer;
      store: LayerLayoutStore;
      pluginHost(): DesktopPluginHost | undefined;
    },
  ) {
    options.layer.register({
      id: "utools",
      snapshot: () => this.cards(),
      onInvoke: async (id) => {
        const card = this.options.store.load().cards[id];
        if (card?.kind === "utools") await this.remove(card.utoolsInstanceId);
      },
    });
  }
  private stored(): Array<[string, UToolsLayoutCard]> {
    return Object.entries(this.options.store.load().cards).filter(
      (entry): entry is [string, UToolsLayoutCard] => entry[1].kind === "utools",
    );
  }
  private cards(): LayerCard[] {
    return this.stored().flatMap(([id, card]) => {
      const session = this.sessions.get(card.pluginId);
      if (!session) return [];
      return [
        {
          id,
          title: session.metadata.spark233.displayName,
          ...card,
          renderKind: "utools" as const,
          renderRef: card.utoolsInstanceId,
          fullscreenAutoHide: false,
        },
      ];
    });
  }
  attach(scope: PluginResourceScope, metadata: PluginPackageMetadata, present: Session["present"]) {
    const session: Session = {
      scope,
      metadata,
      present,
      revision: 0,
      focused: false,
      queue: Promise.resolve(),
    };
    const pluginId = scope.owner.pluginId;
    this.sessions.get(pluginId)?.release?.();
    this.sessions.set(pluginId, session);
    this.register(session);
    scope.own("event", {
      dispose: () => {
        if (this.sessions.get(pluginId) !== session) return;
        session.release?.();
        this.sessions.delete(pluginId);
        this.options.layer.refresh();
      },
    });
    return async (value: unknown) => {
      if (this.sessions.get(pluginId) !== session || scope.state !== "active")
        throw new AppError("pluginStopping", "兼容插件实例已失效");
      const input = requestSchema.parse(value);
      if (session.detaching && input.type !== "focus")
        throw new AppError("pluginBusy", "正在取消固定，请稍后重试");
      if (input.type === "focus") {
        session.focused = input.focused;
        if (input.focused) this.options.layer.restackOverlay();
        else
          setTimeout(() => {
            if (this.options.layer.overlayActive && !this.options.layer.hasOverlayFocus())
              void this.options.layer.closeOverlay(false);
          }, 100).unref();
        return;
      }
      if (input.type === "pin") {
        if (!this.options.layer.options.flags().enabled)
          throw new AppError("layer.disabled", "请先在设置中开启桌面插件层");
        const previous = this.stored().find(([, c]) => c.pluginId === pluginId);
        if (previous) return this.update(previous[1].utoolsInstanceId, { visible: true });
        const display =
          this.options.layer.options.displays().find((d) =>
            contains(d.workArea, {
              x: input.bounds.x + input.bounds.width / 2,
              y: input.bounds.y + input.bounds.height / 2,
            }),
          ) ??
          this.options.layer.options
            .displays()
            .find((d) => d.id === this.options.layer.options.primaryDisplay()) ??
          this.options.layer.options.displays()[0];
        if (!display) throw new AppError("layer.displayUnavailable", "当前没有可用显示器");
        const id = randomUUID();
        const card: UToolsLayoutCard = {
          kind: "utools",
          pluginId,
          utoolsInstanceId: id,
          featureCode: input.featureCode,
          displayId: display.id,
          workAreaAtSave: display.workArea,
          bounds: input.bounds,
          group: "normal",
          inputMode: "interactive",
          order: Date.now(),
          visible: true,
          restore: true,
          createdAt: Date.now(),
        };
        const layout = this.options.store.load();
        const active = Object.values(layout.cards).filter((candidate) => candidate.visible);
        if (
          active.length >= DEFAULT_LAYER_QUOTAS.total ||
          active.filter((candidate) => candidate.displayId === display.id).length >=
            DEFAULT_LAYER_QUOTAS.perDisplay
        )
          throw new AppError("layer.quotaExceeded", "桌面插件数量已达上限");
        layout.cards["utools:" + id] = constrainLayerCard(
          card,
          this.options.layer.options.displays(),
          this.options.layer.options.primaryDisplay(),
        ).card;
        await this.options.store.commit(
          { ...layout, revision: layout.revision + 1 },
          layout.revision,
        );
        this.register(session);
        this.options.layer.refresh();
        return;
      }
      const stored = this.stored().find(([, c]) => c.pluginId === pluginId);
      if (!stored) throw new AppError("layer.card.invalid", "插件尚未固定到桌面");
      if (input.type === "unpin") return this.remove(stored[1].utoolsInstanceId);
      if (input.revision !== session.revision)
        throw new AppError("layer.layoutConflict", "窗口布局已变化，请重试");
      if (input.type === "close-overlay") return this.options.layer.closeOverlay(true);
      if (input.type === "bounds")
        return this.options.layer.externalBounds(stored[0], input.bounds);
      if (input.action === "show" && !stored[1].visible)
        await this.update(stored[1].utoolsInstanceId, { visible: true });
      return this.options.layer.externalPanel(stored[0], input.action, input.value);
    };
  }
  private register(session: Session): void {
    if (session.release) return;
    const entry = this.stored().find(([, c]) => c.pluginId === session.scope.owner.pluginId);
    if (!entry) return;
    const [id, card] = entry;
    session.release = this.options.layer.registerExternal(id, {
      present: (value) => {
        const current = ++session.revision;
        session.queue = session.queue
          .catch(() => {})
          .then(async () => {
            if (
              current !== session.revision ||
              this.sessions.get(card.pluginId) !== session ||
              !session.release ||
              session.detaching
            )
              return;
            try {
              await session.present({ ...value, revision: current, featureCode: card.featureCode });
              session.failure = undefined;
            } catch (error) {
              session.failure = error instanceof Error ? error.message : String(error);
              throw error;
            }
          });
        return session.queue;
      },
      focus: () => session.focused,
      restack: () => {
        if (!this.options.layer.overlayActive) return;
        // A fresh presentation raises the same HWND after the shade gains focus.
        session.queue = session.queue
          .catch(() => {})
          .then(async () => {
            const current = this.options.layer.externalPresentation(id);
            if (
              !current ||
              !session.release ||
              session.detaching ||
              this.sessions.get(card.pluginId) !== session
            )
              return;
            await session.present({
              ...current,
              revision: session.revision,
              featureCode: card.featureCode,
            });
          });
        void session.queue.catch(() => {});
      },
      update: (patch) => this.update(card.utoolsInstanceId, patch),
    });
  }
  sync(): Promise<void> {
    return (this.syncing ??= this.restore().finally(() => {
      this.syncing = undefined;
    }));
  }
  private async restore(): Promise<void> {
    const host = this.options.pluginHost();
    if (!host || !this.options.layer.options.flags().enabled) return;
    for (const [, card] of this.stored()) {
      const installed = host.manager.list().find((p) => p.pluginId === card.pluginId);
      if (
        !card.restore ||
        !card.visible ||
        !installed?.enabled ||
        installed.lastError ||
        !host.manager.describe(card.pluginId).spark233.compatibility
      )
        continue;
      // One failing plugin must not block restoring the remaining cards.
      try {
        await host.manager.ensureWidgetOwner(card.pluginId);
      } catch (error) {
        const session = this.sessions.get(card.pluginId);
        if (session) session.failure = error instanceof Error ? error.message : String(error);
        console.error("utools-desktop-restore", card.pluginId, error);
      }
    }
    this.options.layer.refresh();
  }
  has(id: string): boolean {
    return this.stored().some(([, card]) => card.utoolsInstanceId === id);
  }
  quotaCards(): LayerCard[] {
    return this.cards();
  }
  list(): LayerInstanceSummary[] {
    return this.stored().map(([, card]) => {
      const session = this.sessions.get(card.pluginId);
      return {
        title: session?.metadata.spark233.displayName ?? card.pluginId,
        widgetInstanceId: card.utoolsInstanceId,
        pluginId: card.pluginId,
        widgetDefinitionId: "utools-main",
        displayId: card.displayId,
        visible: card.visible,
        group: card.group,
        inputMode: card.inputMode,
        bounds: card.bounds,
        status: !session
          ? "orphan"
          : session.failure
            ? "fault"
            : !this.options.layer.options.flags().enabled
              ? "suspended"
              : card.visible
                ? "active"
                : "hidden",
        reason: session?.failure,
      };
    });
  }
  async update(
    id: string,
    patch: { visible?: boolean; group?: "normal" | "top"; inputMode?: "passive" | "interactive" },
  ): Promise<void> {
    const layout = this.options.store.load();
    const entry = layout.cards["utools:" + id];
    if (entry?.kind !== "utools") throw new AppError("layer.card.invalid", "兼容桌面插件已移除");
    if (this.sessions.get(entry.pluginId)?.detaching)
      throw new AppError("pluginBusy", "正在取消固定，请稍后重试");
    layout.cards["utools:" + id] = { ...entry, ...patch };
    await this.options.store.commit({ ...layout, revision: layout.revision + 1 }, layout.revision);
    if (patch.visible) await this.sync();
  }
  async remove(id: string): Promise<void> {
    const card = this.options.store.load().cards["utools:" + id];
    if (card?.kind !== "utools") return;
    const session = this.sessions.get(card.pluginId);
    if (session?.detaching || (session && session.scope.state !== "active"))
      throw new AppError("pluginBusy", "插件正在停止或取消固定，请稍后重试");
    if (session) {
      session.detaching = true;
      ++session.revision;
    }
    try {
      if (this.options.layer.overlayActive) await this.options.layer.closeOverlay(false);
      if (session) {
        await session.queue.catch(() => {});
        await session.present(null);
      }
      // The durable identity and its management entry survive until the runner
      // acknowledges the ordinary window. A failed disk commit replays desktop.
      await this.options.store.removeUTools(id);
      session?.release?.();
      if (session) session.release = undefined;
    } catch (error) {
      if (session) {
        session.failure = error instanceof Error ? error.message : String(error);
        const current = this.options.layer.externalPresentation("utools:" + id);
        if (current) {
          try {
            await session.present({
              ...current,
              revision: ++session.revision,
              featureCode: card.featureCode,
            });
          } catch {
            /* Retain the record and retry entry even if the runner is unavailable. */
          }
        }
      }
      throw error;
    } finally {
      if (session) session.detaching = false;
    }
  }
  async retry(id: string): Promise<void> {
    const card = this.options.store.load().cards["utools:" + id];
    if (card?.kind !== "utools") throw new AppError("layer.card.invalid", "兼容桌面插件已移除");
    const session = this.sessions.get(card.pluginId);
    if (session) {
      session.release?.();
      session.release = undefined;
      session.failure = undefined;
      this.register(session);
    }
    await this.sync();
  }
}

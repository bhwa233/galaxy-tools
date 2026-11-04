import { useCallback } from "react";
import type {
  LayerClient,
  LayerRenderCard,
  LayerScreenshotAction,
} from "../../../shared/layer-contract";
import { CapsuleHost } from "../capsules/CapsuleHost";
import type { CapsuleSnapshot } from "../capsules/types";
import type { invoke } from "../../platform/desktop";
import { DeclarativeCard } from "./DeclarativeCard";
import { ScreenshotCard } from "./ScreenshotCard";

/** Both desktop surfaces render the same content. Only the operation bar's
 * command routing differs, so moving or hiding its panels keeps desktop layout. */
export function LayerCardContent({
  card,
  request,
  locale,
  scaleFactor,
  width = card.bounds.width,
  disabled,
  overlay = false,
  pinned = card.group === "top",
}: {
  card: LayerRenderCard;
  request: LayerClient["request"];
  locale: string;
  scaleFactor: number;
  width?: number;
  disabled: boolean;
  overlay?: boolean;
  pinned?: boolean;
}) {
  const cardId = card.id;
  const onAction = useCallback(
    async (actionId: string) => {
      await request(
        overlay && actionId === "open"
          ? { type: "overlay-panel", cardId, action: "open" }
          : { type: "widget-invoke", cardId, actionId },
      );
    },
    [request, cardId, overlay],
  );
  const onContentHeight = useCallback(
    (height: number) => {
      void request({ type: "content-height", cardId, height }).catch(() => {});
    },
    [request, cardId],
  );
  const onScreenshotAction = useCallback(
    (action: LayerScreenshotAction, value?: number) => {
      if (overlay) {
        if (action === "edit") return request({ type: "overlay-panel", cardId, action: "open" });
        if (action === "pin")
          return request({ type: "overlay-panel", cardId, action: "pin", value: !pinned });
        if (action === "hide" || action === "close")
          return request({ type: "overlay-panel", cardId, action: "hide" });
      }
      return request({
        type: "screenshot-invoke",
        cardId,
        action,
        ...(value === undefined ? {} : { value }),
      });
    },
    [request, cardId, overlay, pinned],
  );
  const onNotesRequest = useCallback(
    (command: string, args: Record<string, unknown> = {}) => {
      if (overlay) {
        if (command === "capsule_activate" || command === "capsule_open")
          return request({ type: "overlay-panel", cardId, action: "open" });
        if (command === "capsule_hide")
          return request({ type: "overlay-panel", cardId, action: "hide" });
      }
      return request({ type: "notes-invoke", cardId, command, args });
    },
    [request, cardId, overlay],
  ) as typeof invoke;
  if (card.status && card.status !== "active")
    return (
      <div className="layer-card-fault" role="status">
        {card.reason ?? card.title}
      </div>
    );
  if (card.renderKind === "declarative" && card.template)
    return (
      <DeclarativeCard
        template={card.template}
        data={card.data}
        images={card.images}
        disabled={disabled}
        locale={locale}
        onAction={onAction}
        onContentHeight={card.intrinsicHeight ? onContentHeight : undefined}
      />
    );
  if (card.renderKind === "notes" && card.payload)
    return (
      <CapsuleHost
        snapshot={card.payload as unknown as CapsuleSnapshot}
        request={onNotesRequest}
        layoutInteractive={!overlay}
      />
    );
  if (card.renderKind === "screenshot" && card.screenshot)
    return (
      <ScreenshotCard
        image={card.screenshot}
        title={card.title ?? (locale.startsWith("zh") ? "截图贴图" : "Pinned image")}
        width={width}
        scaleFactor={scaleFactor}
        pinned={pinned}
        disabled={disabled}
        locale={locale}
        onAction={onScreenshotAction}
      />
    );
  return (
    <div className="layer-note-label">
      <span>{card.title}</span>
    </div>
  );
}

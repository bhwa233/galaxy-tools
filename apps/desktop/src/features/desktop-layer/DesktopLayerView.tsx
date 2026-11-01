import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type PointerEvent,
  type WheelEvent,
} from "react";
import type {
  LayerClient,
  LayerEvent,
  LayerPointerEvent,
  LayerRenderCard,
  LayerSnapshot,
} from "../../../shared/layer-contract";
import type { Rect } from "../capsules/types";
import { DeclarativeCard } from "./DeclarativeCard";
import { LayerErrorBoundary } from "./LayerErrorBoundary";
import { LayerEditor } from "./LayerEditor";
import { WidgetFrame } from "./WidgetFrame";
import { ScreenshotCard } from "./ScreenshotCard";
import { DesktopOverlayView } from "./DesktopOverlayView";
import { CapsuleHost } from "../capsules/CapsuleHost";
import type { CapsuleSnapshot } from "../capsules/types";
import type { invoke } from "../../platform/desktop";
import "./desktop-layer.css";

type WebBootstrap = Extract<LayerEvent, { type: "widget-init" }>;
function isSnapshot(value: unknown): value is LayerSnapshot {
  return (
    !!value &&
    typeof value === "object" &&
    (value as LayerSnapshot).protocol === 1 &&
    Array.isArray((value as LayerSnapshot).cards)
  );
}

// Keep the existing memoized card's action stable when only its outer position
// changes; binding the owner here avoids rebuilding the declarative subtree.
function LayerDeclarativeCard({
  client,
  cardId,
  intrinsicHeight,
  ...props
}: Omit<ComponentProps<typeof DeclarativeCard>, "onAction" | "onContentHeight"> & {
  client: LayerClient;
  cardId: string;
  intrinsicHeight?: boolean;
}) {
  const onAction = useCallback(
    async (actionId: string) => {
      await client.request({ type: "widget-invoke", cardId, actionId });
    },
    [client, cardId],
  );
  const onContentHeight = useCallback(
    (height: number) => {
      void client.request({ type: "content-height", cardId, height }).catch(() => {});
    },
    [client, cardId],
  );
  return (
    <DeclarativeCard
      {...props}
      onAction={onAction}
      onContentHeight={intrinsicHeight ? onContentHeight : undefined}
    />
  );
}

export function DesktopLayerView({ client }: { client: LayerClient }) {
  const [snapshot, setSnapshot] = useState<LayerSnapshot>();
  const latest = useRef<LayerSnapshot | undefined>(undefined);
  const [web, setWeb] = useState<WebBootstrap>();
  const [edit, setEdit] = useState<{ editing: boolean; editSession?: string }>();
  const [drafts, setDrafts] = useState<Record<string, Rect>>({});
  const [cancelGeneration, setCancelGeneration] = useState(0);
  const [failure, setFailure] = useState<string>();
  const queuedMove = useRef<{ event: LayerPointerEvent; surfaceGeneration: number } | undefined>(
    undefined,
  );
  const moveFrame = useRef<number | undefined>(undefined);
  const moveInFlight = useRef(false);
  const pointerClient = useRef<LayerClient | undefined>(undefined);
  const drainMoves = useRef<(() => void) | undefined>(undefined);
  const clearQueuedMove = useCallback(() => {
    if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = undefined;
    queuedMove.current = undefined;
  }, []);
  // Reuse the shell's rAF and sequenced LayerClient. A busy host receives one
  // move at a time; only the newest unsent position survives between replies.
  const scheduleMove = useCallback(() => {
    if (
      pointerClient.current !== client ||
      moveInFlight.current ||
      moveFrame.current !== undefined ||
      !queuedMove.current
    )
      return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = undefined;
      const move = queuedMove.current;
      queuedMove.current = undefined;
      const current = latest.current;
      if (
        pointerClient.current !== client ||
        !move ||
        !current ||
        current.editing ||
        current.surfaceGeneration !== move.surfaceGeneration ||
        current.revision !== move.event.revision ||
        !current.cards.some((card) => card.id === move.event.cardId && card.visible)
      )
        return;
      moveInFlight.current = true;
      void client
        .request({ type: "pointer", event: move.event })
        .catch(() => {})
        .finally(() => {
          moveInFlight.current = false;
          drainMoves.current?.();
        });
    });
  }, [client]);
  useEffect(() => {
    drainMoves.current = scheduleMove;
    return () => {
      if (drainMoves.current === scheduleMove) drainMoves.current = undefined;
    };
  }, [scheduleMove]);
  const fault = useCallback(
    (cardId: string | undefined, error: unknown) => {
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 512);
      void client
        .request({ type: "fault", cardId, code: "renderer-error", message })
        .catch(() => {});
    },
    [client],
  );
  useEffect(() => {
    let active = true;
    pointerClient.current = client;
    const accept = (next: LayerSnapshot) => {
      const previous = latest.current;
      if (
        previous &&
        next.surfaceId === previous.surfaceId &&
        next.surfaceGeneration < previous.surfaceGeneration
      )
        return;
      if (
        previous &&
        next.surfaceGeneration === previous.surfaceGeneration &&
        next.revision < previous.revision
      )
        return;
      if (
        !previous ||
        next.surfaceId !== previous.surfaceId ||
        next.surfaceGeneration !== previous.surfaceGeneration ||
        next.revision !== previous.revision ||
        next.editing !== previous.editing
      )
        clearQueuedMove();
      if (
        !previous ||
        next.surfaceGeneration !== previous.surfaceGeneration ||
        next.editing !== previous.editing
      ) {
        setDrafts({});
        setEdit(undefined);
      }
      latest.current = next;
      setSnapshot(next);
      document.documentElement.classList.toggle("dark", next.theme === "dark");
      document.documentElement.dataset.theme = next.theme;
      document.documentElement.lang = next.locale;
      document.body.style.background = "transparent";
      document.documentElement.style.background = "transparent";
    };
    const off = client.subscribe((event) => {
      if (!active) return;
      switch (event.type) {
        case "snapshot":
          accept(event.snapshot);
          break;
        case "geometry": {
          const previous = latest.current;
          if (
            !previous ||
            previous.surfaceGeneration !== event.surfaceGeneration ||
            previous.revision !== event.revision
          )
            return;
          const changes = new Map(event.cards.map((card) => [card.cardId, card.bounds]));
          let changed =
            !!event.bounds &&
            (!previous.bounds ||
              event.bounds.x !== previous.bounds.x ||
              event.bounds.y !== previous.bounds.y ||
              event.bounds.width !== previous.bounds.width ||
              event.bounds.height !== previous.bounds.height);
          const cards = previous.cards.map((card) => {
            const bounds = changes.get(card.id);
            if (
              !bounds ||
              (bounds.x === card.bounds.x &&
                bounds.y === card.bounds.y &&
                bounds.width === card.bounds.width &&
                bounds.height === card.bounds.height)
            )
              return card;
            changed = true;
            return { ...card, bounds };
          });
          if (!changed) return;
          const next = { ...previous, ...(event.bounds ? { bounds: event.bounds } : {}), cards };
          latest.current = next;
          setSnapshot(next);
          break;
        }
        case "data": {
          const previous = latest.current;
          if (!previous) return;
          const next = {
            ...previous,
            cards: previous.cards.map((card) =>
              card.id === event.cardId && (!card.data || event.data.revision > card.data.revision)
                ? { ...card, data: event.data }
                : card,
            ),
          };
          latest.current = next;
          setSnapshot(next);
          break;
        }
        case "widget-init":
          setWeb(event);
          break;
        case "edit-state":
          clearQueuedMove();
          setEdit({ editing: event.editing, editSession: event.editSession });
          if (!event.editing) setDrafts({});
          break;
        case "cancel-pointer":
          clearQueuedMove();
          setDrafts({});
          setCancelGeneration((value) => value + 1);
          break;
      }
    });
    void client
      .request({ type: "ready" })
      .then((value) => {
        if (active && isSnapshot(value)) accept(value);
      })
      .catch((error) => {
        if (active) setFailure(String(error));
      });
    const heartbeat = window.setInterval(() => {
      const current = latest.current;
      if (current)
        void client.request({ type: "heartbeat", lastRevision: current.revision }).catch(() => {});
    }, 1000);
    return () => {
      active = false;
      if (pointerClient.current === client) pointerClient.current = undefined;
      off();
      window.clearInterval(heartbeat);
      clearQueuedMove();
    };
  }, [client, clearQueuedMove]);
  const pointer = (
    card: LayerRenderCard,
    type: LayerPointerEvent["type"],
    event: PointerEvent<HTMLElement> | WheelEvent<HTMLElement>,
  ) => {
    if (!snapshot || snapshot.editing || edit?.editing) return;
    if (card.desktopInteractive && "pointerId" in event) {
      if (type === "down" && event.button === 0)
        event.currentTarget.setPointerCapture(event.pointerId);
    }
    const box = event.currentTarget.getBoundingClientRect();
    const p: LayerPointerEvent = {
      cardId: card.id,
      revision: snapshot.revision,
      pointerId: "pointerId" in event ? event.pointerId : 0,
      type,
      x: event.clientX - box.left,
      y: event.clientY - box.top,
      screenX: event.screenX,
      screenY: event.screenY,
      buttons: event.buttons,
      button:
        event.button === 0
          ? "left"
          : event.button === 1
            ? "middle"
            : event.button === 2
              ? "right"
              : "none",
      modifiers: {
        alt: event.altKey,
        ctrl: event.ctrlKey,
        shift: event.shiftKey,
        meta: event.metaKey,
      },
      ...("deltaX" in event
        ? {
            deltaX: Math.max(-120, Math.min(120, event.deltaX)),
            deltaY: Math.max(-120, Math.min(120, event.deltaY)),
          }
        : {}),
    };
    if (type === "move") {
      queuedMove.current = { event: p, surfaceGeneration: snapshot.surfaceGeneration };
      scheduleMove();
    } else {
      // An already sent move precedes this boundary on the same IPC channel.
      // Cancel pending rAF work so no old move can arrive after up/cancel/down.
      if (["down", "up", "cancel", "contextmenu"].includes(type)) clearQueuedMove();
      void client.request({ type: "pointer", event: p }).catch(() => {});
    }
    // Send up before releasing capture: release can synchronously emit a lost-
    // capture cancellation, which must not cancel the drag before it commits.
    if (
      card.desktopInteractive &&
      "pointerId" in event &&
      (type === "up" || type === "cancel") &&
      event.currentTarget.hasPointerCapture(event.pointerId)
    )
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  if (!snapshot)
    return failure ? (
      <div className="layer-card-fault" role="status">
        {failure}
      </div>
    ) : null;
  if (snapshot.overlay) return <DesktopOverlayView snapshot={snapshot} client={client} />;
  const editing = edit?.editing ?? snapshot.editing;
  const origin = snapshot.bounds ?? {
    x: window.screenX,
    y: window.screenY,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const label = (card: LayerRenderCard) =>
    card.title ??
    card.widget?.widgetDefinitionId ??
    (snapshot.locale.startsWith("zh") ? "卡片暂不可用" : "Card unavailable");
  return (
    <main className="desktop-layer-root" data-layer-surface={snapshot.surfaceId}>
      {snapshot.cards
        .filter((card) => card.visible)
        .map((card) => {
          const bounds = drafts[card.id] ?? card.bounds;
          const unavailable = card.status && card.status !== "active";
          return (
            <section
              key={`${card.id}:${card.widget?.loadGeneration ?? 0}`}
              className={
                card.desktopInteractive && !card.presentationOnly
                  ? "layer-render-card layer-desktop-interactive"
                  : "layer-render-card"
              }
              style={{
                left: bounds.x - origin.x,
                top: bounds.y - origin.y,
                width: bounds.width,
                height: bounds.height,
                zIndex: card.order,
                opacity: card.presentationHidden ? 0 : undefined,
                ...(card.clip
                  ? {
                      clipPath: `inset(${card.clip.y}px ${Math.max(0, bounds.width - card.clip.x - card.clip.width)}px ${Math.max(0, bounds.height - card.clip.y - card.clip.height)}px ${card.clip.x}px)`,
                    }
                  : {}),
              }}
              aria-label={label(card)}
              onPointerEnter={(event) => pointer(card, "enter", event)}
              onPointerLeave={(event) => pointer(card, "leave", event)}
              onPointerDown={(event) => pointer(card, "down", event)}
              onPointerMove={(event) => pointer(card, "move", event)}
              onPointerUp={(event) => pointer(card, "up", event)}
              onPointerCancel={(event) => pointer(card, "cancel", event)}
              onLostPointerCapture={(event) => pointer(card, "cancel", event)}
              onDoubleClick={(event) =>
                pointer(card, "doubleclick", event as unknown as PointerEvent<HTMLElement>)
              }
              onContextMenu={(event) => {
                event.preventDefault();
                pointer(card, "contextmenu", event as unknown as PointerEvent<HTMLElement>);
              }}
              onWheel={(event) => pointer(card, "wheel", event)}
            >
              <LayerErrorBoundary label={label(card)} onError={(error) => fault(card.id, error)}>
                {unavailable ? (
                  <div className="layer-card-fault" role="status">
                    {card.reason ?? label(card)}
                  </div>
                ) : card.renderKind === "declarative" && card.template ? (
                  <LayerDeclarativeCard
                    client={client}
                    cardId={card.id}
                    intrinsicHeight={card.intrinsicHeight}
                    template={card.template}
                    data={card.data}
                    images={card.images}
                    disabled={editing || card.inputMode !== "interactive"}
                    locale={snapshot.locale}
                  />
                ) : card.renderKind === "notes" && card.payload ? (
                  <CapsuleHost
                    snapshot={card.payload as unknown as CapsuleSnapshot}
                    request={
                      ((command: string, args: Record<string, unknown> = {}) =>
                        client.request({
                          type: "notes-invoke",
                          cardId: card.id,
                          command,
                          args,
                        })) as typeof invoke
                    }
                  />
                ) : card.renderKind === "screenshot" && card.screenshot ? (
                  <ScreenshotCard
                    image={card.screenshot}
                    title={
                      card.title ?? (snapshot.locale.startsWith("zh") ? "截图贴图" : "Pinned image")
                    }
                    width={bounds.width}
                    scaleFactor={snapshot.scaleFactor}
                    pinned={card.group === "top"}
                    disabled={editing || card.inputMode !== "interactive"}
                    locale={snapshot.locale}
                    onAction={(action, value) =>
                      client.request({
                        type: "screenshot-invoke",
                        cardId: card.id,
                        action,
                        ...(value === undefined ? {} : { value }),
                      })
                    }
                  />
                ) : card.renderKind === "web" && web ? (
                  <WidgetFrame
                    key={`${web.binding.widgetInstanceId}:${web.binding.loadGeneration}:${web.nonce}`}
                    binding={web.binding}
                    url={web.url}
                    nonce={web.nonce}
                    initialWire={web.initialWire}
                    client={client}
                    blocked={editing || card.inputMode !== "interactive"}
                  />
                ) : (
                  <div className="layer-note-label">
                    <span>{label(card)}</span>
                  </div>
                )}
              </LayerErrorBoundary>
            </section>
          );
        })}
      {editing && (
        <LayerEditor
          snapshot={snapshot}
          client={client}
          editSession={edit?.editSession ?? snapshot.editSession}
          drafts={drafts}
          onPreview={setDrafts}
          cancelGeneration={cancelGeneration}
        />
      )}
    </main>
  );
}

export function LayerPage() {
  const client = window.spark233Layer;
  return client ? <DesktopLayerView client={client} /> : null;
}

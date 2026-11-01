import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
} from "react";
import { Check, GripHorizontal, MoveDownRight, X } from "lucide-react";
import type { LayerClient, LayerRenderCard, LayerSnapshot } from "../../../shared/layer-contract";
import type { Rect } from "../capsules/types";
import { Button } from "../../components/ui/button";
import { cn } from "../../lib/utils";
import { getErrorMessage } from "../notes/api";

export interface LayerEditorProps {
  snapshot: LayerSnapshot;
  client: LayerClient;
  editSession?: string;
  drafts: Readonly<Record<string, Rect>>;
  onPreview: (next: Record<string, Rect>) => void;
  cancelGeneration: number;
}
interface Gesture {
  cardId: string;
  pointerId: number;
  mode: "move" | "resize";
  clientPoint: { x: number; y: number };
  previousDraft?: Rect;
  cancelled: boolean;
  generation: number;
  moveQueued?: boolean;
}

/** The host owns handles and capture. No iframe content event is relied upon. */
export function LayerEditor({
  snapshot,
  client,
  editSession,
  drafts,
  onPreview,
  cancelGeneration,
}: LayerEditorProps) {
  const gesture = useRef<Gesture | undefined>(undefined);
  const requests = useRef<Promise<unknown>>(Promise.resolve());
  const generation = useRef(0);
  const moveFrame = useRef<number | undefined>(undefined);
  useLayoutEffect(() => {
    generation.current++;
    gesture.current = undefined;
    if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = undefined;
  }, [cancelGeneration]);
  const draftsRef = useRef(drafts);
  useLayoutEffect(() => {
    draftsRef.current = drafts;
  }, [drafts]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [ghosts, setGhosts] = useState<Record<string, { bounds: Rect; title?: string }>>({});
  useEffect(
    () =>
      client.subscribe((event) => {
        if (event.type !== "edit-preview") return;
        setGhosts((previous) => {
          const next = { ...previous };
          if (event.bounds) next[event.cardId] = { bounds: event.bounds, title: event.title };
          else delete next[event.cardId];
          return next;
        });
      }),
    [client],
  );
  const zh = snapshot.locale.startsWith("zh");
  const text = (cnText: string, en: string) => (zh ? cnText : en);
  const origin = snapshot.bounds ?? {
    x: window.screenX,
    y: window.screenY,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const preview = useCallback(
    (next: Record<string, Rect>) => {
      draftsRef.current = next;
      onPreview(next);
    },
    [onPreview],
  );
  const sendPointer = useCallback(
    (active: Gesture, phase: "start" | "move" | "end" | "cancel") => {
      const operation = requests.current
        .catch(() => {})
        .then(async () => {
          if (!editSession || (phase !== "cancel" && active.cancelled)) return;
          const result = (await client.request({
            type: "edit-pointer",
            editSession,
            cardId: active.cardId,
            pointerId: active.pointerId,
            phase,
            ...(phase === "start" ? { mode: active.mode, clientPoint: active.clientPoint } : {}),
          })) as { bounds?: Rect };
          if (
            (phase === "move" || phase === "end") &&
            result?.bounds &&
            !active.cancelled &&
            active.generation === generation.current
          )
            preview({ ...draftsRef.current, [active.cardId]: result.bounds });
        });
      requests.current = operation;
      return operation;
    },
    [client, editSession, preview],
  );
  const cancelGesture = useCallback(() => {
    const active = gesture.current;
    if (!active) return;
    gesture.current = undefined;
    active.cancelled = true;
    if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = undefined;
    void sendPointer(active, "cancel").catch(() => {});
    const next = { ...draftsRef.current };
    if (active.previousDraft) next[active.cardId] = active.previousDraft;
    else delete next[active.cardId];
    preview(next);
  }, [preview, sendPointer]);
  const finish = async (apply: boolean) => {
    if (!editSession || saving) return;
    setSaving(true);
    setError(undefined);
    cancelGesture();
    try {
      await requests.current.catch(() => {});
      const mutations = Object.entries(draftsRef.current).map(([cardId, bounds]) => ({
        cardId,
        patch: { bounds },
      }));
      if (apply && mutations.length)
        await client.request({
          type: "layout-commit",
          mutations,
          expectedRevision: snapshot.revision,
          editSession,
        });
      await client.request({ type: "edit-end", editSession, apply });
      generation.current++;
      preview({});
    } catch (failure) {
      setError(getErrorMessage(failure));
    } finally {
      setSaving(false);
    }
  };
  const finishRef = useRef(finish);
  useLayoutEffect(() => {
    finishRef.current = finish;
  });
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (gesture.current) cancelGesture();
      else void finishRef.current(false);
    };
    window.addEventListener("keydown", escape);
    return () => window.removeEventListener("keydown", escape);
  }, [cancelGesture]);
  const press = (
    event: PointerEvent<HTMLButtonElement>,
    card: LayerRenderCard,
    mode: "move" | "resize",
  ) => {
    if (event.button !== 0 || saving) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const active: Gesture = {
      cardId: card.id,
      pointerId: event.pointerId,
      mode,
      clientPoint: { x: event.clientX, y: event.clientY },
      previousDraft: draftsRef.current[card.id],
      cancelled: false,
      generation: generation.current,
    };
    gesture.current = active;
    void sendPointer(active, "start").catch((failure) => {
      if (active.generation !== generation.current) return;
      setError(getErrorMessage(failure));
      if (gesture.current === active) cancelGesture();
    });
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (!active || active.pointerId !== event.pointerId) return;
    event.preventDefault();
    event.stopPropagation();
    if (moveFrame.current !== undefined || active.moveQueued) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = undefined;
      active.moveQueued = true;
      void sendPointer(active, "move")
        .catch((failure) => {
          if (active.generation !== generation.current) return;
          setError(getErrorMessage(failure));
          if (gesture.current === active) cancelGesture();
        })
        .finally(() => {
          active.moveQueued = false;
        });
    });
  };
  const release = (event: PointerEvent<HTMLButtonElement>) => {
    const active = gesture.current;
    if (active?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    gesture.current = undefined;
    if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = undefined;
    void sendPointer(active, "end").catch((failure) => setError(getErrorMessage(failure)));
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  const cancel = (event: PointerEvent<HTMLButtonElement>) => {
    if (gesture.current?.pointerId !== event.pointerId) return;
    event.stopPropagation();
    cancelGesture();
  };
  return (
    <>
      {Object.entries(ghosts).map(([cardId, ghost]) => (
        <div
          key={"ghost:" + cardId}
          className="layer-editor-card"
          aria-hidden
          style={{
            left: ghost.bounds.x - origin.x,
            top: ghost.bounds.y - origin.y,
            width: ghost.bounds.width,
            height: ghost.bounds.height,
            pointerEvents: "none",
            opacity: 0.6,
          }}
        >
          <span className="layer-editor-handle">
            {ghost.title ?? text("桌面卡片", "Desktop card")}
          </span>
        </div>
      ))}
      {snapshot.cards
        .filter((card) => card.visible && card.renderKind !== "notes")
        .map((card) => {
          const bounds = drafts[card.id] ?? card.bounds;
          return (
            <div
              key={card.id}
              className="layer-editor-card"
              style={{
                left: bounds.x - origin.x,
                top: bounds.y - origin.y,
                width: bounds.width,
                height: bounds.height,
              }}
            >
              <button
                type="button"
                className="layer-editor-handle"
                disabled={saving}
                aria-label={text("移动卡片", "Move card")}
                onPointerDown={(event) => press(event, card, "move")}
                onPointerMove={move}
                onPointerUp={release}
                onPointerCancel={cancel}
                onLostPointerCapture={cancel}
              >
                <GripHorizontal width={14} height={14} aria-hidden />
                <span>
                  {card.title ??
                    card.widget?.widgetDefinitionId ??
                    text("桌面卡片", "Desktop card")}
                </span>
              </button>
              <button
                type="button"
                className="layer-editor-resize"
                disabled={saving}
                aria-label={text("调整大小", "Resize card")}
                onPointerDown={(event) => press(event, card, "resize")}
                onPointerMove={move}
                onPointerUp={release}
                onPointerCancel={cancel}
                onLostPointerCapture={cancel}
              >
                <MoveDownRight width={14} height={14} aria-hidden />
              </button>
            </div>
          );
        })}
      <div
        className="layer-editor-toolbar"
        role="toolbar"
        aria-label={text("桌面编辑", "Desktop arrangement")}
      >
        <span
          className={cn("layer-editor-message", error && "layer-editor-error")}
          role={error ? "alert" : undefined}
        >
          {error ?? text("编辑桌面", "Arrange desktop")}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={saving || !editSession}
          onClick={() => void finish(false)}
        >
          <X data-icon="inline-start" />
          {text("取消", "Cancel")}
        </Button>
        <Button
          type="button"
          size="sm"
          disabled={saving || !editSession}
          onClick={() => void finish(true)}
        >
          <Check data-icon="inline-start" />
          {text("应用", "Apply")}
        </Button>
      </div>
    </>
  );
}

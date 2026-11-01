import { useCallback, useEffect, useRef, useState, type PointerEvent } from "react";
import {
  ExternalLink,
  GripHorizontal,
  Image,
  LayoutGrid,
  MousePointer2,
  Network,
  Pin,
  PinOff,
  Settings,
  SlidersHorizontal,
  StickyNote,
  X,
} from "lucide-react";
import type {
  DesktopOverlayPanel,
  LayerClient,
  LayerClientRequest,
  LayerRenderCard,
  LayerSnapshot,
} from "../../../shared/layer-contract";
import type { Rect } from "../capsules/types";
import type { CapsuleSnapshot } from "../capsules/types";
import { Button } from "../../components/ui/button";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import { getErrorMessage } from "../notes/api";
import { DeclarativeCard } from "./DeclarativeCard";
import { ScreenshotCard } from "./ScreenshotCard";
import { LayerErrorBoundary } from "./LayerErrorBoundary";
import { isWidgetRankRows } from "@spark233/sdk";
import "./desktop-overlay.css";

type Send = (request: LayerClientRequest) => Promise<unknown>;
const kindIcons = { notes: StickyNote, traffic: Network, screenshot: Image };

/** The overlay reuses the existing card renderers and Base UI menus. This page
 * only owns the toolbar and a bounded free-position drag, adapted from LayerEditor;
 * plugin data and all durable state remain with their current host owners. */
export function DesktopOverlayView({
  snapshot,
  client,
}: {
  snapshot: LayerSnapshot;
  client: LayerClient;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState(false);
  const dragging = useRef(false);
  const dragChanged = useCallback((value: boolean) => {
    dragging.current = value;
  }, []);
  const panels = snapshot.overlay?.panels ?? [];
  const zh = snapshot.locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const send: Send = useCallback(
    async (request) => {
      setError(undefined);
      try {
        return await client.request(request);
      } catch (value) {
        setError(getErrorMessage(value));
        throw value;
      }
    },
    [client],
  );
  const act = (request: LayerClientRequest) => void send(request).catch(() => {});
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        menuOpen ||
        dragging.current
      )
        return;
      event.preventDefault();
      void send({ type: "overlay-close" }).catch(() => {});
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [menuOpen, send]);
  const toggleKind = async (kind: DesktopOverlayPanel["kind"]) => {
    const matching = panels.filter((panel) => panel.kind === kind);
    const show = !matching.some((panel) => panel.selected);
    for (const panel of matching)
      await send({ type: "overlay-panel", cardId: panel.cardId, action: show ? "show" : "hide" });
  };
  const origin = snapshot.bounds ?? {
    x: window.screenX,
    y: window.screenY,
    width: window.innerWidth,
    height: window.innerHeight,
  };
  const categories = [
    { kind: "notes" as const, title: text("便签", "Notes") },
    { kind: "traffic" as const, title: text("流量", "Traffic") },
    { kind: "screenshot" as const, title: text("截图图钉", "Pinned images") },
  ];
  return (
    <main
      className="desktop-overlay"
      data-desktop-overlay="true"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget && event.button === 0)
          act({ type: "overlay-close" });
      }}
    >
      <nav
        className="desktop-overlay-toolbar"
        aria-label={text("桌面插件栏", "Desktop plugin bar")}
      >
        <div className="desktop-overlay-brand">
          <LayoutGrid aria-hidden />
          <span>spark233</span>
        </div>
        <div className="desktop-overlay-divider" />
        {categories.map(({ kind, title }) => {
          const Icon = kindIcons[kind];
          const group = panels.filter((panel) => panel.kind === kind);
          return (
            <Button
              key={kind}
              type="button"
              variant="ghost"
              size="icon"
              className="desktop-overlay-tool"
              title={title}
              aria-label={title}
              aria-pressed={group.some((panel) => panel.selected)}
              disabled={!group.length}
              onClick={() => void toggleKind(kind).catch(() => {})}
            >
              <Icon />
            </Button>
          );
        })}
        <div className="desktop-overlay-divider" />
        <DropdownMenu onOpenChange={setMenuOpen}>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="desktop-overlay-tool"
                title={text("面板列表", "Panels")}
                aria-label={text("面板列表", "Panels")}
              />
            }
          >
            <LayoutGrid />
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="center"
            className="desktop-overlay-menu desktop-overlay-panel-list"
          >
            <DropdownMenuGroup>
              <DropdownMenuLabel>
                {text("已有桌面面板", "Existing desktop panels")}
              </DropdownMenuLabel>
              {!panels.length && (
                <DropdownMenuItem disabled>
                  {text("还没有桌面插件面板", "No desktop panels yet")}
                </DropdownMenuItem>
              )}
              {panels.map((panel) => {
                const Icon = kindIcons[panel.kind];
                return (
                  <DropdownMenuCheckboxItem
                    key={panel.cardId}
                    checked={panel.selected}
                    closeOnClick={false}
                    onCheckedChange={(value) =>
                      act({
                        type: "overlay-panel",
                        cardId: panel.cardId,
                        action: value ? "show" : "hide",
                      })
                    }
                  >
                    <Icon />
                    <span className="desktop-overlay-menu-title">{panel.title}</span>
                  </DropdownMenuCheckboxItem>
                );
              })}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <time className="desktop-overlay-clock" dateTime={new Date(now).toISOString()}>
          {new Date(now).toLocaleTimeString(snapshot.locale, {
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          })}
        </time>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="desktop-overlay-tool"
          title={text("设置", "Settings")}
          aria-label={text("设置", "Settings")}
          onClick={() => act({ type: "overlay-settings" })}
        >
          <Settings />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="desktop-overlay-tool"
          title={text("关闭插件栏", "Close plugin bar")}
          aria-label={text("关闭插件栏", "Close plugin bar")}
          onClick={() => act({ type: "overlay-close" })}
        >
          <X />
        </Button>
      </nav>
      {!snapshot.cards.some((card) => card.visible) && (
        <div className="desktop-overlay-empty">
          <LayoutGrid aria-hidden />
          <h1>
            {panels.length
              ? text("所有面板已收起", "All panels are hidden")
              : text("暂无桌面插件", "No desktop panels")}
          </h1>
          <p>
            {panels.length
              ? text("从面板列表重新显示。", "Show panels from the panel list.")
              : text(
                  "先添加桌面便签、流量窗或截图图钉。",
                  "Add a desktop note, traffic widget or pinned image.",
                )}
          </p>
          <Button variant="outline" onClick={() => act({ type: "overlay-settings" })}>
            {text("打开设置", "Open settings")}
          </Button>
        </div>
      )}
      {snapshot.cards
        .filter((card) => card.visible)
        .map((card, index) => {
          const panel = panels.find((entry) => entry.cardId === card.id);
          return panel ? (
            <OverlayPanel
              key={card.id}
              panel={panel}
              card={card}
              origin={origin}
              snapshot={snapshot}
              stackOrder={index}
              send={send}
              onMenuChange={setMenuOpen}
              onDragChange={dragChanged}
            />
          ) : null;
        })}
      {error && (
        <Alert variant="destructive" className="desktop-overlay-error">
          <AlertDescription>{error}</AlertDescription>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={text("关闭提示", "Dismiss error")}
            onClick={() => setError(undefined)}
          >
            <X />
          </Button>
        </Alert>
      )}
    </main>
  );
}

function OverlayPanel({
  panel,
  card,
  origin,
  snapshot,
  stackOrder,
  send,
  onMenuChange,
  onDragChange,
}: {
  panel: DesktopOverlayPanel;
  card: LayerRenderCard;
  origin: Rect;
  snapshot: LayerSnapshot;
  stackOrder: number;
  send: Send;
  onMenuChange: (open: boolean) => void;
  onDragChange: (dragging: boolean) => void;
}) {
  const frame = useRef<HTMLElement>(null);
  const moveFrame = useRef<number | undefined>(undefined);
  const gesture = useRef<
    { pointerId: number; startX: number; startY: number; initial: Rect; latest: Rect } | undefined
  >(undefined);
  const [moving, setMoving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const zh = snapshot.locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const Icon = kindIcons[panel.kind];
  const action = (operation: "show" | "hide" | "pin" | "passthrough" | "open", value?: boolean) =>
    send({
      type: "overlay-panel",
      cardId: card.id,
      action: operation,
      ...(value === undefined ? {} : { value }),
    });
  const clamp = (bounds: Rect): Rect => ({
    ...bounds,
    x: Math.max(origin.x + 12, Math.min(bounds.x, origin.x + origin.width - bounds.width - 12)),
    y: Math.max(origin.y + 100, Math.min(bounds.y, origin.y + origin.height - bounds.height - 16)),
  });
  const cancel = useCallback(() => {
    gesture.current = undefined;
    if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = undefined;
    if (frame.current) frame.current.style.transform = "";
    setMoving(false);
    onDragChange(false);
  }, [onDragChange]);
  useEffect(() => {
    if (!moving) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || !gesture.current) return;
      event.preventDefault();
      event.stopPropagation();
      cancel();
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [moving, cancel]);
  useEffect(
    () => () => {
      if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
      onDragChange(false);
    },
    [onDragChange],
  );
  const start = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      initial: { ...card.bounds },
      latest: { ...card.bounds },
    };
    setMoving(true);
    onDragChange(true);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    current.latest = clamp({
      ...current.initial,
      x: current.initial.x + event.clientX - current.startX,
      y: current.initial.y + event.clientY - current.startY,
    });
    if (moveFrame.current !== undefined) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = undefined;
      const active = gesture.current;
      if (active && frame.current)
        frame.current.style.transform = `translate(${active.latest.x - active.initial.x}px, ${active.latest.y - active.initial.y}px)`;
    });
  };
  const finish = (event: PointerEvent<HTMLElement>) => {
    const current = gesture.current;
    if (!current || current.pointerId !== event.pointerId) return;
    move(event);
    const next = current.latest;
    gesture.current = undefined;
    if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = undefined;
    if (frame.current)
      frame.current.style.transform = `translate(${next.x - current.initial.x}px, ${next.y - current.initial.y}px)`;
    setMoving(false);
    onDragChange(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
    void send({ type: "overlay-layout", cardId: card.id, bounds: next })
      .catch(() => {})
      .finally(() => {
        if (frame.current) frame.current.style.transform = "";
      });
  };
  const note = card.payload as unknown as Partial<CapsuleSnapshot> | undefined;
  const unavailable = card.status && card.status !== "active";
  return (
    <section
      ref={frame}
      className={`desktop-overlay-panel ${moving ? "desktop-overlay-panel-moving" : ""}`}
      data-overlay-panel={card.id}
      aria-label={panel.title}
      style={{
        left: card.bounds.x - origin.x,
        top: card.bounds.y - origin.y - 36,
        width: card.bounds.width,
        zIndex: moving ? 900 : 10 + stackOrder,
      }}
    >
      <header
        className="desktop-overlay-panel-header"
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancel}
        onLostPointerCapture={() => {
          if (gesture.current) cancel();
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape" && gesture.current) {
            event.stopPropagation();
            event.preventDefault();
            cancel();
          }
        }}
      >
        <Icon aria-hidden />
        <span
          className="desktop-overlay-panel-title"
          role="button"
          tabIndex={0}
          title={text("拖动或用方向键移动面板", "Drag or use arrow keys to move this panel")}
          onKeyDown={(event) => {
            const delta: Record<string, [number, number]> = {
              ArrowLeft: [-10, 0],
              ArrowRight: [10, 0],
              ArrowUp: [0, -10],
              ArrowDown: [0, 10],
            };
            if (!delta[event.key]) return;
            event.preventDefault();
            event.stopPropagation();
            const [x, y] = delta[event.key];
            void send({
              type: "overlay-layout",
              cardId: card.id,
              bounds: clamp({ ...card.bounds, x: card.bounds.x + x, y: card.bounds.y + y }),
            }).catch(() => {});
          }}
        >
          {panel.title}
        </span>
        <GripHorizontal className="desktop-overlay-panel-grip" aria-hidden />
        <DropdownMenu onOpenChange={onMenuChange}>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                title={text("面板设置", "Panel settings")}
                aria-label={text("面板设置", "Panel settings")}
              />
            }
          >
            <SlidersHorizontal />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="desktop-overlay-menu">
            <DropdownMenuGroup>
              <DropdownMenuLabel>{panel.title}</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={panel.pinned}
                onCheckedChange={(value) => void action("pin", value).catch(() => {})}
              >
                <Pin />
                {text("退出后保持置顶", "Keep on top after closing")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuCheckboxItem
                checked={panel.inputMode === "passive"}
                onCheckedChange={(value) => void action("passthrough", value).catch(() => {})}
              >
                <MousePointer2 />
                {text("常驻时鼠标穿透", "Click through outside the bar")}
              </DropdownMenuCheckboxItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => void action("open").catch(() => {})}>
                <ExternalLink />
                {panel.kind === "screenshot"
                  ? text("继续编辑截图", "Edit screenshot")
                  : text("打开详情", "Open details")}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={
            panel.pinned
              ? text("取消置顶", "Unpin")
              : text("退出后保持置顶", "Keep on top after closing")
          }
          aria-label={
            panel.pinned
              ? text("取消置顶", "Unpin")
              : text("退出后保持置顶", "Keep on top after closing")
          }
          aria-pressed={panel.pinned}
          onClick={() => void action("pin", !panel.pinned).catch(() => {})}
        >
          {panel.pinned ? <Pin /> : <PinOff />}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={text("收起面板", "Hide panel")}
          aria-label={text("收起面板", "Hide panel")}
          onClick={() => void action("hide").catch(() => {})}
        >
          <X />
        </Button>
      </header>
      <div
        className={`desktop-overlay-panel-content desktop-overlay-panel-${panel.kind}`}
        style={{ height: card.bounds.height }}
        onPointerEnter={() => setHovered(true)}
        onPointerLeave={() => setHovered(false)}
      >
        <LayerErrorBoundary
          label={panel.title}
          onError={(value) => {
            void send({
              type: "fault",
              cardId: card.id,
              code: "overlay-card",
              message: getErrorMessage(value),
            }).catch(() => {});
          }}
        >
          {unavailable ? (
            <div className="layer-card-fault">
              {card.reason ?? text("面板暂不可用", "Panel unavailable")}
            </div>
          ) : card.renderKind === "declarative" && card.template ? (
            <>
              <DeclarativeCard
                template={card.template}
                data={card.data}
                images={card.images}
                disabled={false}
                locale={snapshot.locale}
                onAction={(actionId) =>
                  send({ type: "widget-invoke", cardId: card.id, actionId }).then(() => {})
                }
              />
              <Button
                variant="ghost"
                size="icon-sm"
                className="desktop-overlay-details"
                aria-label={text("打开流量详情", "Open traffic details")}
                title={text("打开流量详情", "Open traffic details")}
                onClick={() => void action("open").catch(() => {})}
              >
                <ExternalLink />
              </Button>
            </>
          ) : card.renderKind === "screenshot" && card.screenshot ? (
            <ScreenshotCard
              image={card.screenshot}
              title={panel.title}
              width={card.bounds.width}
              scaleFactor={snapshot.scaleFactor}
              pinned={panel.pinned}
              disabled={false}
              locale={snapshot.locale}
              onAction={(operation, value) =>
                operation === "edit"
                  ? action("open")
                  : operation === "pin"
                    ? action("pin", !panel.pinned)
                    : operation === "close" || operation === "hide"
                      ? action("hide")
                      : send({
                          type: "screenshot-invoke",
                          cardId: card.id,
                          action: operation,
                          ...(value === undefined ? {} : { value }),
                        })
              }
            />
          ) : (
            <div className="desktop-overlay-note">
              <StickyNote aria-hidden />
              <h2>{note?.note?.title || note?.items?.[0]?.title || panel.title}</h2>
              <p>{note?.note?.content?.slice(0, 1600)}</p>
              <Button variant="secondary" onClick={() => void action("open").catch(() => {})}>
                <ExternalLink />
                {text("打开便签", "Open note")}
              </Button>
            </div>
          )}
        </LayerErrorBoundary>
      </div>
      {panel.kind === "traffic" && hovered && !moving && (
        <TrafficRanking
          card={card}
          above={card.bounds.y + card.bounds.height + 230 > origin.y + origin.height}
          alignRight={card.bounds.x + 360 > origin.x + origin.width}
          zh={zh}
        />
      )}
    </section>
  );
}

function TrafficRanking({
  card,
  above,
  alignRight,
  zh,
}: {
  card: LayerRenderCard;
  above: boolean;
  alignRight: boolean;
  zh: boolean;
}) {
  const lists = [
    { key: "download-top", title: zh ? "下载排行" : "Top downloads" },
    { key: "upload-top", title: zh ? "上传排行" : "Top uploads" },
  ];
  return (
    <div
      className={`desktop-overlay-ranking ${above ? "desktop-overlay-ranking-above" : ""}`}
      style={alignRight ? { left: "auto", right: 0 } : undefined}
      role="status"
    >
      {lists.map(({ key, title }) => {
        const value = card.data?.values[key];
        const rows = isWidgetRankRows(value) ? value : [];
        return (
          <div key={key}>
            <h3>{title}</h3>
            {rows.length ? (
              rows.map((row) => (
                <p key={row.id}>
                  <span>{row.label}</span>
                  <strong>{row.valueText}</strong>
                </p>
              ))
            ) : (
              <p className="desktop-overlay-ranking-empty">
                {zh ? "暂无程序数据" : "No process data"}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}

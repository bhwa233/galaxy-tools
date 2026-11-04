import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import {
  ExternalLink,
  GripHorizontal,
  Image,
  LayoutGrid,
  MousePointer2,
  Network,
  Puzzle,
  Pin,
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
import "./desktop-overlay.css";
import { DesktopPanelToolbar } from "./DesktopPanelToolbar";

type Send = (request: LayerClientRequest) => Promise<unknown>;
const kindIcons = { notes: StickyNote, traffic: Network, screenshot: Image, utools: Puzzle };

/** Management chrome lives in one existing trusted surface; plugin content
 * remains mounted in each source's persistent LayerCardFrame below. */
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
  const panels = snapshot.overlay?.panels ?? [];
  const zh = snapshot.locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const epoch = snapshot.overlay?.epoch;
  const send: Send = useCallback(
    async (request) => {
      setError(undefined);
      try {
        return await client.request({
          ...request,
          ...(epoch === undefined ? {} : { overlayEpoch: epoch }),
        });
      } catch (value) {
        setError(getErrorMessage(value));
        throw value;
      }
    },
    [client, epoch],
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
        document.querySelector('[data-overlay-moving], [role="menu"]')
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
  const categories = [
    { kind: "notes" as const, title: text("便签", "Notes") },
    { kind: "traffic" as const, title: text("流量", "Traffic") },
    { kind: "screenshot" as const, title: text("截图图钉", "Pinned images") },
    { kind: "utools" as const, title: "uTools" },
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
      {!panels.some((panel) => panel.selected) && (
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

export function LayerCardFrame({
  panel,
  card,
  origin,
  snapshot,
  stackOrder,
  send,
  children,
  ...props
}: {
  panel?: DesktopOverlayPanel;
  card: LayerRenderCard;
  origin: Rect;
  snapshot: LayerSnapshot;
  stackOrder: number;
  send: Send;
  children: ReactNode;
} & HTMLAttributes<HTMLElement>) {
  const moveFrame = useRef<number | undefined>(undefined);
  const gesture = useRef<number | undefined>(undefined);
  const [moving, setMoving] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [previewHeight, setPreviewHeight] = useState(card.hover?.size.height ?? 0);
  const onPreviewHeight = useCallback(
    (height: number) => {
      setPreviewHeight(Math.min(card.hover?.size.height ?? 0, height));
    },
    [card.hover?.size.height],
  );
  const zh = snapshot.locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const Icon = panel ? kindIcons[panel.kind] : StickyNote;
  const action = (operation: "show" | "hide" | "pin" | "passthrough" | "open", value?: boolean) =>
    send({
      type: "overlay-panel",
      cardId: card.id,
      action: operation,
      ...(value === undefined ? {} : { value }),
    });
  const area = snapshot.overlay?.workArea ?? origin;
  const clamp = (bounds: Rect): Rect => ({
    ...bounds,
    x: Math.max(area.x + 12, Math.min(bounds.x, area.x + area.width - bounds.width - 12)),
    y: Math.max(area.y + 110, Math.min(bounds.y, area.y + area.height - bounds.height - 16)),
  });
  const cancel = useCallback(() => {
    const id = gesture.current;
    gesture.current = undefined;
    if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = undefined;
    setMoving(false);
    if (id !== undefined)
      void send({ type: "overlay-pointer", cardId: card.id, pointerId: id, phase: "cancel" }).catch(
        () => {},
      );
  }, [send, card.id]);
  useEffect(() => {
    if (!moving) return;
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing || gesture.current === undefined) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      cancel();
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [moving, cancel]);
  useEffect(() => {
    gesture.current = undefined;
    setMoving(false);
    setHovered(false);
    setSettingsOpen(false);
    return () => {
      if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
      moveFrame.current = undefined;
    };
  }, [snapshot.overlay?.epoch, card.visible]);
  const previewVisible =
    !!panel && card.visible && !!card.hover && hovered && !moving && !settingsOpen;
  const managed = !!panel && !!snapshot.overlay;
  const overlayEpoch = snapshot.overlay?.epoch;
  useEffect(() => {
    if (!managed) return;
    void send({ type: "overlay-preview", cardId: card.id, visible: previewVisible }).catch(
      () => {},
    );
  }, [previewVisible, managed, overlayEpoch, send, card.id]);
  const start = (event: PointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest("button")) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = event.pointerId;
    setMoving(true);
    void send({
      type: "overlay-pointer",
      cardId: card.id,
      pointerId: event.pointerId,
      phase: "start",
      clientPoint: { x: event.clientX, y: event.clientY },
    }).catch(cancel);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current !== event.pointerId || moveFrame.current !== undefined) return;
    moveFrame.current = requestAnimationFrame(() => {
      moveFrame.current = undefined;
      if (gesture.current !== undefined)
        void send({
          type: "overlay-pointer",
          cardId: card.id,
          pointerId: gesture.current,
          phase: "move",
        }).catch(cancel);
    });
  };
  const finish = (event: PointerEvent<HTMLElement>) => {
    if (gesture.current !== event.pointerId) return;
    if (moveFrame.current !== undefined) cancelAnimationFrame(moveFrame.current);
    moveFrame.current = undefined;
    gesture.current = undefined;
    setMoving(false);
    void send({
      type: "overlay-pointer",
      cardId: card.id,
      pointerId: event.pointerId,
      phase: "end",
    }).catch(() => {});
    if (event.currentTarget.hasPointerCapture(event.pointerId))
      event.currentTarget.releasePointerCapture(event.pointerId);
  };
  return (
    <section
      {...props}
      className={
        panel
          ? `desktop-overlay-panel ${moving ? "desktop-overlay-panel-moving" : ""}`
          : props.className
      }
      data-overlay-panel={panel ? card.id : undefined}
      data-overlay-moving={moving || undefined}
      aria-label={panel?.title ?? props["aria-label"]}
      data-controls-visible={moving || settingsOpen || undefined}
      onPointerEnter={(event) => {
        setHovered(true);
        props.onPointerEnter?.(event);
      }}
      onPointerLeave={(event) => {
        setHovered(false);
        props.onPointerLeave?.(event);
      }}
      style={{
        left: card.bounds.x - origin.x,
        top: card.bounds.y - origin.y,
        width: card.bounds.width,
        height: card.bounds.height,
        display: card.visible ? undefined : "none",
        ...props.style,
        zIndex: panel
          ? moving
            ? 900
            : hovered || settingsOpen
              ? 800
              : 10 + stackOrder
          : card.order,
      }}
    >
      {panel && (
        <DesktopPanelToolbar
          locale={snapshot.locale}
          pinned={panel.pinned}
          onPin={() => void action("pin", !panel.pinned).catch(() => {})}
          onHide={() => void action("hide").catch(() => {})}
          style={
            card.overlayControls
              ? {
                  left: card.overlayControls.x - card.bounds.x,
                  top: card.overlayControls.y - card.bounds.y,
                  bottom: "auto",
                  width: card.overlayControls.width,
                }
              : card.bounds.x + 280 > area.x + area.width
                ? { left: "auto", right: 0 }
                : undefined
          }
          onPointerDown={start}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={cancel}
          onLostPointerCapture={() => {
            if (gesture.current !== undefined) cancel();
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape" && gesture.current !== undefined) {
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
            {panel?.title}
          </span>
          <GripHorizontal className="desktop-overlay-panel-grip" aria-hidden />
          <DropdownMenu
            open={settingsOpen}
            onOpenChange={(open) => {
              setSettingsOpen(open);
              void send({
                type: "overlay-preview",
                cardId: card.id,
                visible: open,
                region: "menu",
              }).catch(() => {});
            }}
          >
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
        </DesktopPanelToolbar>
      )}
      <div
        key="content"
        className={panel ? "desktop-overlay-panel-content" : "layer-card-content"}
        onClick={panel?.kind === "traffic" ? () => void action("open").catch(() => {}) : undefined}
      >
        {children}
      </div>
      {card.hover && previewVisible && (
        <div
          className={
            card.bounds.y + card.bounds.height + previewHeight + 8 > area.y + area.height
              ? "desktop-overlay-preview desktop-overlay-preview-above"
              : "desktop-overlay-preview"
          }
          style={{
            width: Math.min(card.hover.size.width, area.width - 24),
            maxHeight: card.hover.size.height,
            ...(card.overlayPreview
              ? {
                  left: card.overlayPreview.x - card.bounds.x,
                  top: card.overlayPreview.y - card.bounds.y,
                  bottom: "auto",
                  width: card.overlayPreview.width,
                  maxHeight: card.overlayPreview.height,
                }
              : {}),
            ...(!card.overlayPreview &&
            card.bounds.x + card.hover.size.width > area.x + area.width - 12
              ? { left: "auto", right: 0 }
              : {}),
          }}
        >
          <DeclarativeCard
            template={card.hover.template}
            data={card.data}
            images={card.images}
            disabled={false}
            locale={snapshot.locale}
            onContentHeight={onPreviewHeight}
            onAction={async (actionId) => {
              await send({ type: "widget-invoke", cardId: card.id, actionId });
            }}
          />
        </div>
      )}
    </section>
  );
}

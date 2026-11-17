import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent,
  type ReactNode,
  type HTMLAttributes,
} from "react";
import {
  AppWindow,
  Check,
  ExternalLink,
  GripHorizontal,
  Image,
  LayoutGrid,
  MoreHorizontal,
  Network,
  Puzzle,
  Plus,
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
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from "../../components/ui/context-menu";
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../../components/ui/command";
import { getErrorMessage } from "../notes/api";
import { DeclarativeCard } from "./DeclarativeCard";
import "./desktop-overlay.css";
import { DesktopPanelToolbar } from "./DesktopPanelToolbar";

type Send = (request: LayerClientRequest) => Promise<unknown>;
const kindIcons = {
  notes: StickyNote,
  traffic: Network,
  screenshot: Image,
  utools: Puzzle,
  window: AppWindow,
};

/** Management chrome lives in one existing trusted surface; plugin content
 * remains mounted in each source's persistent LayerCardFrame below. */
export function DesktopOverlayView({
  snapshot,
  client,
  active = true,
}: {
  snapshot: LayerSnapshot;
  client: LayerClient;
  active?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());
  const [error, setError] = useState<string>();
  const [menuOpen, setMenuOpen] = useState<string>();
  const [addOpen, setAddOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [selectedLauncher, setSelectedLauncher] = useState<string>();
  const transient = useRef<{ id: string; kind: "modal" | "menu"; key: string } | undefined>(
    undefined,
  );
  const addingRef = useRef(false);
  const addButton = useRef<HTMLButtonElement>(null);
  const panels = snapshot.overlay?.panels ?? [];
  const launchers = snapshot.overlay?.launchers;
  const zh = snapshot.locale.startsWith("zh");
  const text = (cn: string, en: string) => (zh ? cn : en);
  const epoch = snapshot.overlay?.epoch;
  const session = useRef({ epoch, active });
  useLayoutEffect(() => {
    session.current = { epoch, active };
    transient.current = undefined;
    addingRef.current = false;
    // eslint-disable-next-line react/set-state-in-effect -- Reset transient UI before revealing a new session while preserving its management chrome.
    setError(undefined);
    setMenuOpen(undefined);
    setAddOpen(false);
    setAdding(false);
    setSelectedLauncher(undefined);
  }, [epoch, active]);
  const send: Send = useCallback(
    async (request) => {
      setError(undefined);
      try {
        const result = await client.request({
          ...request,
          ...(epoch === undefined ? {} : { overlayEpoch: epoch }),
        });
        if (session.current.epoch !== epoch || !session.current.active)
          throw new Error("Card desktop session ended");
        return result;
      } catch (value) {
        if (session.current.epoch === epoch && session.current.active)
          setError(getErrorMessage(value));
        throw value;
      }
    },
    [client, epoch],
  );
  const act = (request: LayerClientRequest) => void send(request).catch(() => {});
  const openTransient = async (key: string, kind: "modal" | "menu") => {
    if (transient.current?.key === key) return;
    const current = { id: crypto.randomUUID(), kind, key };
    transient.current = current;
    try {
      await send({ type: "overlay-transient", id: current.id, kind, open: true });
      if (transient.current !== current) return;
      if (kind === "modal") {
        setSelectedLauncher(undefined);
        setAddOpen(true);
      } else setMenuOpen(key);
    } catch {
      if (transient.current === current) transient.current = undefined;
    }
  };
  const closeTransient = async (key: string, activateCardId?: string) => {
    const current = transient.current;
    if (current?.key !== key) return;
    transient.current = undefined;
    if (current.kind === "modal") setAddOpen(false);
    else setMenuOpen(undefined);
    let focusHost = false;
    try {
      const result = (await send({
        type: "overlay-transient",
        ...current,
        open: false,
        activateCardId,
      })) as { focusHost?: boolean } | undefined;
      focusHost = result?.focusHost === true;
    } catch {
      // The host clears constraints before acknowledging a failed restoration.
    }
    if (focusHost && current.kind === "modal" && !activateCardId && !transient.current)
      addButton.current?.focus();
  };
  const changeMenu = (key: string, open: boolean) => {
    if (open) void openTransient(key, "menu");
    else void closeTransient(key);
  };
  const launch = async (pluginId: string, commandId: string) => {
    const current = transient.current;
    if (addingRef.current || current?.kind !== "modal") return;
    addingRef.current = true;
    setAdding(true);
    setSelectedLauncher(pluginId + "/" + commandId);
    try {
      const result = (await send({
        type: "overlay-launch",
        pluginId,
        commandId,
        transientId: current.id,
      })) as { cardId?: string } | undefined;
      if (transient.current === current) await closeTransient(current.key, result?.cardId);
    } catch {
      // Keep both the dialog and its durable create intent for an explicit retry.
    } finally {
      if (session.current.epoch === epoch && session.current.active) {
        addingRef.current = false;
        setAdding(false);
      }
    }
  };
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  useEffect(() => {
    if (!active) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== "Escape" ||
        event.defaultPrevented ||
        event.isComposing ||
        menuOpen ||
        transient.current ||
        document.querySelector('[data-overlay-moving], [role="menu"], [role="dialog"]')
      )
        return;
      event.preventDefault();
      void send({ type: "overlay-close" }).catch(() => {});
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [active, menuOpen, send]);
  const showGroup = async (pluginId: string, show: boolean) => {
    const matching = panels.filter((panel) => (panel.pluginId ?? panel.kind) === pluginId);
    for (const panel of matching)
      await send({ type: "overlay-panel", cardId: panel.cardId, action: show ? "show" : "hide" });
  };
  const categories = [
    ...new Map(
      panels.map((panel) => [
        panel.pluginId ?? panel.kind,
        {
          pluginId: panel.pluginId ?? panel.kind,
          title: panel.pluginTitle ?? panel.title,
          icon: panel.pluginIcon,
          kind: panel.kind,
        },
      ]),
    ).values(),
  ];
  return (
    <main
      hidden={!active}
      className="desktop-overlay"
      data-desktop-overlay="true"
      onPointerDown={(event) => {
        if (transient.current || menuOpen || addOpen) return;
        if (event.target === event.currentTarget && event.button === 0)
          act({ type: "overlay-close" });
      }}
    >
      <nav className="desktop-overlay-toolbar" aria-label={text("卡片桌面", "Card desktop")}>
        <div className="desktop-overlay-brand">
          <LayoutGrid aria-hidden />
          <span>spark233</span>
        </div>
        <div className="desktop-overlay-divider" />
        {categories.slice(0, 6).map(({ pluginId, kind, title, icon }) => {
          const Icon = kindIcons[kind];
          const group = panels.filter((panel) => (panel.pluginId ?? panel.kind) === pluginId);
          return (
            <ContextMenu
              key={pluginId}
              open={menuOpen === pluginId}
              onOpenChange={(open) => changeMenu(pluginId, open)}
            >
              <ContextMenuTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="desktop-overlay-tool"
                    title={title}
                    aria-label={title}
                    aria-pressed={group.some((panel) => panel.selected)}
                    disabled={!group.length}
                    onClick={() => void showGroup(pluginId, true).catch(() => {})}
                  />
                }
              >
                {icon ? <img src={icon} alt="" className="size-5" /> : <Icon />}
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => void showGroup(pluginId, false).catch(() => {})}>
                  {text("收起这一组", "Hide this group")}
                </ContextMenuItem>
                {group.map((panel) => (
                  <ContextMenuItem
                    key={panel.cardId}
                    onSelect={() =>
                      act({ type: "overlay-panel", cardId: panel.cardId, action: "show" })
                    }
                  >
                    {panel.title}
                  </ContextMenuItem>
                ))}
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {categories.length > 6 && (
          <DropdownMenu
            open={menuOpen === "more"}
            onOpenChange={(open) => changeMenu("more", open)}
          >
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="desktop-overlay-tool"
                  title={text("更多插件", "More plugins")}
                  aria-label={text("更多插件", "More plugins")}
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="center" className="desktop-overlay-menu">
              <DropdownMenuGroup>
                {categories.slice(6).map(({ pluginId, title }) => (
                  <DropdownMenuItem
                    key={pluginId}
                    onSelect={() => void showGroup(pluginId, true).catch(() => {})}
                  >
                    {title}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuGroup>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="desktop-overlay-divider" />
        {launchers && (
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="desktop-overlay-tool"
            title={text("添加插件", "Add plugin")}
            aria-label={text("添加插件", "Add plugin")}
            ref={addButton}
            onClick={() => void openTransient("add", "modal")}
          >
            <Plus />
          </Button>
        )}
        <DropdownMenu
          open={menuOpen === "panels"}
          onOpenChange={(open) => changeMenu("panels", open)}
        >
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
              <DropdownMenuItem onSelect={() => act({ type: "overlay-arrange" })}>
                <LayoutGrid />
                {text("整理布局", "Arrange panels")}
              </DropdownMenuItem>
              {categories.map((category) => (
                <DropdownMenuItem
                  key={category.pluginId}
                  onSelect={() => void showGroup(category.pluginId, false).catch(() => {})}
                >
                  {text("收起", "Hide")} {category.title}
                </DropdownMenuItem>
              ))}
              {!!categories.length && <DropdownMenuSeparator />}
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
                  <DropdownMenuItem
                    key={panel.cardId}
                    onSelect={() =>
                      act({
                        type: "overlay-panel",
                        cardId: panel.cardId,
                        action: "show",
                      })
                    }
                  >
                    <Icon />
                    <span className="desktop-overlay-menu-title">{panel.title}</span>
                    {panel.selected && <Check className="ml-auto size-3" />}
                  </DropdownMenuItem>
                );
              })}
              {panels.map((panel) => (
                <DropdownMenuItem
                  key={"close:" + panel.cardId}
                  onSelect={() =>
                    act({ type: "overlay-panel", cardId: panel.cardId, action: "close" })
                  }
                >
                  <X />
                  {text("关闭", "Close")} {panel.title}
                </DropdownMenuItem>
              ))}
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
      <CommandDialog
        open={addOpen}
        onOpenChange={(open) => {
          if (!open) void closeTransient("add");
        }}
        title={text("添加插件", "Add plugin")}
        description={text("添加插件支持的业务窗口", "Add a supported plugin window")}
        className="desktop-overlay-launcher"
      >
        <Command
          onKeyDownCapture={(event) => {
            if (event.key === "Escape" && event.nativeEvent.isComposing) event.stopPropagation();
          }}
        >
          <CommandInput
            autoFocus
            disabled={adding}
            placeholder={text("搜索插件", "Search plugins")}
          />
          {adding && (
            <p role="status" className="px-3 py-2 text-sm text-muted-foreground">
              {text("正在打开窗口…", "Opening window…")}
            </p>
          )}
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <CommandList>
            <CommandEmpty>{text("没有可打开的插件窗口", "No plugin windows")}</CommandEmpty>
            {[...new Set((launchers ?? []).map((item) => item.pluginId))].map((pluginId) => (
              <CommandGroup
                key={pluginId}
                heading={launchers?.find((item) => item.pluginId === pluginId)?.plugin}
              >
                {(launchers ?? [])
                  .filter((item) => item.pluginId === pluginId)
                  .map((item) => (
                    <CommandItem
                      key={`${item.pluginId}/${item.commandId}`}
                      value={`${item.title} ${item.plugin} ${item.pluginId}/${item.commandId}`}
                      data-launcher={`${item.pluginId}/${item.commandId}`}
                      disabled={
                        adding ||
                        (!!selectedLauncher &&
                          selectedLauncher !== `${item.pluginId}/${item.commandId}`)
                      }
                      onSelect={() => void launch(item.pluginId, item.commandId)}
                    >
                      <AppWindow />
                      <span className="desktop-overlay-menu-title">{item.title}</span>
                      {item.plugin !== item.title && (
                        <span className="desktop-overlay-menu-title text-xs text-muted-foreground">
                          {item.plugin}
                        </span>
                      )}
                    </CommandItem>
                  ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </CommandDialog>
      {error && !addOpen && (
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
  const contentPress = useRef<{ x: number; y: number; dragged: boolean } | undefined>(undefined);
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
  const action = (
    operation: "show" | "hide" | "pin" | "passthrough" | "open" | "close",
    value?: boolean,
  ) =>
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
    contentPress.current = undefined;
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
  const start = (event: PointerEvent<HTMLElement>, mode: "move" | "resize" = "move") => {
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
      mode,
      clientPoint: { x: event.clientX, y: event.clientY },
    }).catch(cancel);
  };
  const move = (event: PointerEvent<HTMLElement>) => {
    if (
      contentPress.current &&
      Math.hypot(event.clientX - contentPress.current.x, event.clientY - contentPress.current.y) > 4
    )
      contentPress.current.dragged = true;
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
      onPointerDown={(event) => {
        if (panel) {
          void action("show").catch(() => {});
          if (
            card.chrome === "none" &&
            card.renderKind === "declarative" &&
            !(event.target as HTMLElement).closest('button, input, textarea, a, [role="button"]')
          ) {
            contentPress.current = { x: event.clientX, y: event.clientY, dragged: false };
            start(event);
          }
        }
        props.onPointerDown?.(event);
      }}
      onPointerMove={(event) => {
        move(event);
        props.onPointerMove?.(event);
      }}
      onPointerUp={(event) => {
        const press = contentPress.current;
        contentPress.current = undefined;
        const active = gesture.current === event.pointerId;
        finish(event);
        if (active && press && !press.dragged && card.primaryAction)
          void send({ type: "widget-invoke", cardId: card.id, actionId: card.primaryAction }).catch(
            () => {},
          );
        props.onPointerUp?.(event);
      }}
      onPointerCancel={(event) => {
        cancel();
        props.onPointerCancel?.(event);
      }}
      onLostPointerCapture={(event) => {
        if (gesture.current !== undefined) cancel();
        props.onLostPointerCapture?.(event);
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
      {panel && card.chrome !== "none" && (
        <DesktopPanelToolbar
          locale={snapshot.locale}
          pinned={panel.pinned}
          canPin={false}
          onPin={() => void action("pin", !panel.pinned).catch(() => {})}
          onHide={() => void action("close").catch(() => {})}
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
          onPointerDown={(event) => start(event)}
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
      <div key="content" className={panel ? "desktop-overlay-panel-content" : "layer-card-content"}>
        {children}
      </div>
      {panel && card.resize && (
        <div
          className="absolute bottom-0 right-0 size-4 cursor-se-resize touch-none"
          aria-hidden="true"
          onPointerDown={(event) => start(event, "resize")}
          onPointerMove={move}
          onPointerUp={finish}
          onPointerCancel={cancel}
        />
      )}
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

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  AppWindow,
  Check,
  Copy,
  Ellipsis,
  Lock,
  Minus,
  MonitorDown,
  Pin,
  Square,
  X,
  type LucideIcon,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

import type { WindowMode } from "../../../shared/window-mode";
export type { WindowMode };
export type RunState = "unsaved" | "busy" | "error";

export interface StatusBarMenuItem {
  id: string;
  label: string;
  destructive?: boolean;
  onSelect: () => void;
}

const TEXT = {
  zh: {
    mode: "窗口模式",
    normal: "普通窗口",
    topmost: "置顶",
    desktop: "常驻桌面",
    more: "更多",
    minimize: "最小化",
    maximize: "最大化",
    restore: "还原",
    close: "关闭",
    unpin: "移出桌面",
    unsaved: "有未保存的修改",
    busy: "正在处理",
    error: "出错",
    lock: "锁定位置",
    locked: "位置已锁定",
    hint: (shortcut: string) => `已放到桌面，按 ${shortcut} 随时呼出`,
  },
  en: {
    mode: "Window mode",
    normal: "Normal window",
    topmost: "Always on top",
    desktop: "Keep on desktop",
    more: "More",
    minimize: "Minimize",
    maximize: "Maximize",
    restore: "Restore",
    close: "Close",
    unpin: "Remove from desktop",
    unsaved: "Unsaved changes",
    busy: "Working",
    error: "Error",
    lock: "Lock position",
    locked: "Position locked",
    hint: (shortcut: string) => `Kept on the desktop. Press ${shortcut} to bring it up anytime`,
  },
};
export const statusBarText = (locale: string) => (locale.startsWith("en") ? TEXT.en : TEXT.zh);

const MODE_ICONS: Record<WindowMode, LucideIcon> = {
  normal: AppWindow,
  topmost: Pin,
  desktop: MonitorDown,
};

/**
 * The host status bar shared by every plugin window: title, run state, window
 * mode, a "more" menu and window controls. On the desktop the minimize and
 * maximize controls go away and close means "remove from desktop".
 */
export function StatusBar({
  title,
  subtitle,
  locale,
  runState,
  mode,
  onModeChange,
  menu,
  maximized,
  maximizable = true,
  onMinimize,
  onToggleMaximize,
  onClose,
  onMouseDown,
  nativeMenus,
  locked = false,
  hint,
  highlighted = false,
  onLockChange,
  collapsed: collapsedInput,
  onPeek,
  children,
}: {
  title: string;
  subtitle?: string;
  locale: string;
  runState?: RunState;
  mode?: WindowMode;
  onModeChange?: (mode: WindowMode) => void;
  menu?: StatusBarMenuItem[];
  maximized: boolean;
  maximizable?: boolean;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
  onMouseDown?: React.MouseEventHandler<HTMLElement>;
  /**
   * Windows whose page sits in a view above the bar cannot show DOM popups
   * below it; the owner opens a native menu at the given button position.
   */
  nativeMenus?: {
    mode: (anchor: { x: number; y: number }) => void;
    more: (anchor: { x: number; y: number }) => void;
  };
  /** Desktop card locked in place: the bar no longer unfolds on hover. */
  locked?: boolean;
  /** One-time "kept on the desktop" hint: the overlay shortcut to mention. */
  hint?: string;
  /** Briefly marks a card that was just located. */
  highlighted?: boolean;
  onLockChange?: (locked: boolean) => void;
  /**
   * Folded state decided by the owner (Web shells, where the host moves the
   * page). Left undefined, the bar folds itself on an unfocused desktop card.
   */
  collapsed?: boolean;
  /** Hovering the folded strip asks the owner to unfold it. */
  onPeek?: () => void;
  children?: ReactNode;
}) {
  const anchor = (event: React.MouseEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    return { x: Math.round(rect.left), y: Math.round(rect.bottom) };
  };
  const text = statusBarText(locale);
  const current = mode ?? "normal";
  const onDesktop = current === "desktop";
  const ModeIcon = MODE_ICONS[current];
  const fold = useDesktopFold(onDesktop, locked);
  const collapsed = collapsedInput ?? fold.collapsed;
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  const showMenuLock = onDesktop && !!onLockChange;
  if (collapsed)
    return (
      <header
        data-window-mode={current}
        data-collapsed=""
        aria-label={title}
        className="h-1.5 shrink-0 bg-border transition-colors hover:bg-primary/50"
        onMouseEnter={() => {
          if (locked) return;
          clearTimeout(peekTimer.current);
          peekTimer.current = setTimeout(() => (onPeek ? onPeek() : fold.peek(true)), 250);
        }}
        onMouseLeave={() => clearTimeout(peekTimer.current)}
      />
    );
  const notice = hint ? text.hint(hint) : subtitle;
  return (
    <header
      data-window-mode={current}
      data-highlighted={highlighted ? "" : undefined}
      className={
        "electron-title-drag relative z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background pr-3 pl-4 transition-shadow select-none" +
        (highlighted ? " ring-2 ring-primary ring-inset" : "")
      }
      onMouseDown={onMouseDown}
      onMouseLeave={() => fold.peek(false)}
    >
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
        {onDesktop && locked && (
          <Lock
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-label={text.locked}
            role="img"
          />
        )}
        {notice && (
          <span
            data-status-notice={hint ? "hint" : undefined}
            className={
              "min-w-0 truncate text-xs " + (hint ? "text-primary" : "text-muted-foreground")
            }
          >
            {notice}
          </span>
        )}
        {runState && (
          <span
            role="status"
            title={text[runState]}
            aria-label={text[runState]}
            data-run-state={runState}
            className={
              runState === "error"
                ? "size-2 shrink-0 rounded-full bg-destructive"
                : runState === "busy"
                  ? "size-2.5 shrink-0 animate-spin rounded-full border-2 border-muted-foreground border-t-transparent"
                  : "size-2 shrink-0 rounded-full bg-primary"
            }
          />
        )}
      </div>
      <div className="electron-title-controls flex shrink-0 items-center gap-1 text-muted-foreground">
        {children}
        {children && <div className="mx-1 h-4 w-px bg-border" />}
        {nativeMenus && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              title={`${text.mode}：${text[current]}`}
              aria-label={`${text.mode}：${text[current]}`}
              onClick={(event) => nativeMenus.mode(anchor(event))}
            >
              <ModeIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              title={text.more}
              aria-label={text.more}
              onClick={(event) => nativeMenus.more(anchor(event))}
            >
              <Ellipsis />
            </Button>
          </>
        )}
        {!nativeMenus && onModeChange && (
          <DropdownMenu onOpenChange={fold.menu}>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  title={`${text.mode}：${text[current]}`}
                  aria-label={`${text.mode}：${text[current]}`}
                />
              }
            >
              <ModeIcon />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {(["normal", "topmost", "desktop"] as const).map((value) => {
                const Icon = MODE_ICONS[value];
                return (
                  <DropdownMenuItem
                    key={value}
                    data-window-mode-option={value}
                    onClick={() => value !== current && onModeChange(value)}
                  >
                    <Icon />
                    <span className="flex-1">{text[value]}</span>
                    {value === current && <Check />}
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        {!nativeMenus && (!!menu?.length || showMenuLock) && (
          <DropdownMenu onOpenChange={fold.menu}>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" title={text.more} aria-label={text.more} />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {showMenuLock && (
                <DropdownMenuItem data-lock-option="" onClick={() => onLockChange(!locked)}>
                  <Lock />
                  <span className="flex-1">{text.lock}</span>
                  {locked && <Check />}
                </DropdownMenuItem>
              )}
              {showMenuLock && !!menu?.length && <DropdownMenuSeparator />}
              {(menu ?? []).map((item, index) => (
                <span key={item.id} className="contents">
                  {item.destructive && index > 0 && <DropdownMenuSeparator />}
                  <DropdownMenuItem
                    variant={item.destructive ? "destructive" : "default"}
                    onClick={item.onSelect}
                  >
                    {item.label}
                  </DropdownMenuItem>
                </span>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <div className="mx-1 h-4 w-px bg-border" />
        {!onDesktop && (
          <>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onMinimize}
              title={text.minimize}
              aria-label={text.minimize}
            >
              <Minus />
            </Button>
            {maximizable && (
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={onToggleMaximize}
                title={maximized ? text.restore : text.maximize}
                aria-label={maximized ? text.restore : text.maximize}
              >
                {maximized ? <Copy /> : <Square />}
              </Button>
            )}
          </>
        )}
        <Button
          variant="ghost"
          size="icon-sm"
          className="hover:bg-destructive/10 hover:text-destructive"
          onClick={onClose}
          title={onDesktop ? text.unpin : text.close}
          aria-label={onDesktop ? text.unpin : text.close}
        >
          <X />
        </Button>
      </div>
    </header>
  );
}

/**
 * Folding of a host-rendered desktop card's bar: shown while the window is
 * focused, a menu is open or the strip is hovered (not when locked).
 */
function useDesktopFold(onDesktop: boolean, locked: boolean) {
  const [focused, setFocused] = useState(() => document.hasFocus());
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => {
    const focus = () => setFocused(true);
    const blur = () => setFocused(false);
    const leave = () => setHovered(false);
    window.addEventListener("focus", focus);
    window.addEventListener("blur", blur);
    document.documentElement.addEventListener("mouseleave", leave);
    return () => {
      window.removeEventListener("focus", focus);
      window.removeEventListener("blur", blur);
      document.documentElement.removeEventListener("mouseleave", leave);
    };
  }, []);
  return {
    collapsed: onDesktop && !focused && !menuOpen && !(hovered && !locked),
    peek: setHovered,
    menu: setMenuOpen,
  };
}

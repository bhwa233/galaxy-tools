import type { ReactNode } from "react";
import {
  AppWindow,
  Check,
  Copy,
  Ellipsis,
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
  return (
    <header
      data-window-mode={current}
      className="electron-title-drag relative z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background pr-3 pl-4 select-none"
      onMouseDown={onMouseDown}
    >
      <div className="flex min-w-0 items-center gap-2">
        <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
        {subtitle && (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{subtitle}</span>
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
          <DropdownMenu>
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
        {!nativeMenus && !!menu?.length && (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button variant="ghost" size="icon-sm" title={text.more} aria-label={text.more} />
              }
            >
              <Ellipsis />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {menu.map((item, index) => (
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

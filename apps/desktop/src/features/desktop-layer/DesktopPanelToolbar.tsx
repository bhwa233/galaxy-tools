import type { HTMLAttributes, ReactNode } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import "./desktop-overlay.css";

/** Shared chrome for host-rendered cards and compatibility-owned windows. */
export function DesktopPanelToolbar({
  children,
  pinned,
  canPin = true,
  onPin,
  onHide,
  locale,
  ...props
}: {
  children: ReactNode;
  pinned: boolean;
  canPin?: boolean;
  onPin(): void;
  onHide(): void;
  locale: string;
} & HTMLAttributes<HTMLElement>) {
  const zh = locale.startsWith("zh");
  const pinLabel = pinned
    ? zh
      ? "取消置顶"
      : "Stop keeping on top"
    : zh
      ? "置顶"
      : "Always on top";
  const hideLabel = zh ? "关闭" : "Close";
  return (
    <header {...props} className="desktop-overlay-panel-header">
      {children}
      {canPin && (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          title={pinLabel}
          aria-label={pinLabel}
          aria-pressed={pinned}
          onClick={onPin}
        >
          {pinned ? <Pin /> : <PinOff />}
        </Button>
      )}
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        title={hideLabel}
        aria-label={hideLabel}
        onClick={onHide}
      >
        <X />
      </Button>
    </header>
  );
}

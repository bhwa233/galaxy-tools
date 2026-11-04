import type { HTMLAttributes, ReactNode } from "react";
import { Pin, PinOff, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import "./desktop-overlay.css";

/** Shared chrome for host-rendered cards and compatibility-owned windows. */
export function DesktopPanelToolbar({
  children,
  pinned,
  onPin,
  onHide,
  locale,
  ...props
}: {
  children: ReactNode;
  pinned: boolean;
  onPin(): void;
  onHide(): void;
  locale: string;
} & HTMLAttributes<HTMLElement>) {
  const zh = locale.startsWith("zh");
  const pinLabel = pinned
    ? zh
      ? "取消置顶"
      : "Unpin"
    : zh
      ? "退出后保持置顶"
      : "Keep on top after closing";
  const hideLabel = zh ? "收起面板" : "Hide panel";
  return (
    <header {...props} className="desktop-overlay-panel-header">
      {children}
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

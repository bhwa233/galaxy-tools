import type { MouseEventHandler, ReactNode } from "react";
import { Copy, Minus, Square, X } from "lucide-react";
import { Button } from "./button.js";

interface WindowTitleBarProps {
  title: string;
  children?: ReactNode;
  isMacOS?: boolean;
  isMaximized: boolean;
  maximizable?: boolean;
  labels: { minimize: string; maximize: string; restore: string; close: string };
  onMouseDown?: MouseEventHandler<HTMLElement>;
  onMinimize: () => void;
  onToggleMaximize: () => void;
  onClose: () => void;
}

/** Shared workspace chrome extracted from the host title bar. Window ownership
 * and lifecycle stay with each caller's existing host or sandboxed SDK bridge. */
export function WindowTitleBar({
  title,
  children,
  isMacOS = false,
  isMaximized,
  maximizable = true,
  labels,
  onMouseDown,
  onMinimize,
  onToggleMaximize,
  onClose,
}: WindowTitleBarProps) {
  return (
    <header
      className={`electron-title-drag relative z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background pr-3 select-none ${isMacOS ? "pl-20" : "pl-4"}`}
      onMouseDown={onMouseDown}
    >
      <h1 className="min-w-0 truncate text-sm font-semibold">{title}</h1>
      <div className="electron-title-controls flex shrink-0 items-center gap-1 text-muted-foreground">
        {children}
        {!isMacOS && (
          <>
            {children && <div className="mx-1 h-4 w-px bg-border" />}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onMinimize}
              title={labels.minimize}
              aria-label={labels.minimize}
            >
              <Minus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={onToggleMaximize}
              disabled={!maximizable}
              title={isMaximized ? labels.restore : labels.maximize}
              aria-label={isMaximized ? labels.restore : labels.maximize}
            >
              {isMaximized ? <Copy /> : <Square />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hover:bg-destructive/10 hover:text-destructive"
              onClick={onClose}
              title={labels.close}
              aria-label={labels.close}
            >
              <X />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}

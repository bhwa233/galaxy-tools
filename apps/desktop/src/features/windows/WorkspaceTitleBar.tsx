import { useEffect, useEffectEvent, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Copy, Minus, Square, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { getCurrentWindow } from "../../platform/desktop";
import { usePluginWindow } from "./PluginWindowContext";
import {
  closeCurrentWindow,
  isCurrentWindowMaximized,
  minimizeCurrentWindow,
  startCurrentWindowDrag,
  toggleMaximizeCurrentWindow,
} from "./controls";

interface Props {
  title: string;
  children?: ReactNode;
  onClose?: () => void | Promise<void>;
  onError: (error: unknown) => void;
}

/** Reuse the notes title bar's appearance and existing window bridge. Each
 * workspace supplies its own actions and retains its existing close policy. */
export function WorkspaceTitleBar({
  title,
  children,
  onClose = closeCurrentWindow,
  onError,
}: Props) {
  const { t } = useTranslation();
  const windowInfo = usePluginWindow();
  const [isMaximized, setIsMaximized] = useState(false);
  const isMacOS = /Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac");
  const reportStateError = useEffectEvent(onError);

  useEffect(() => {
    let disposed = false;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const maximized = await isCurrentWindowMaximized();
        if (!disposed && request === revision) setIsMaximized(maximized);
      } catch (error) {
        if (!disposed && request === revision) reportStateError(error);
      }
    };
    const stop = getCurrentWindow().onResized(() => void refresh());
    void refresh();
    void stop.catch((error) => {
      if (!disposed) reportStateError(error);
    });
    return () => {
      disposed = true;
      void stop.then((off) => off()).catch(() => {});
    };
  }, []);

  const perform = async (operation: () => void | Promise<void>) => {
    try {
      await operation();
    } catch (error) {
      onError(error);
    }
  };
  const onMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button, input, textarea, a, [role='button']")
    )
      return;
    void perform(event.detail === 2 ? toggleMaximizeCurrentWindow : startCurrentWindowDrag);
  };

  return (
    <header
      className={`electron-title-drag relative z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background pr-3 select-none ${isMacOS ? "pl-20" : "pl-4"}`}
      onMouseDown={onMouseDown}
    >
      <h1 className="min-w-0 truncate text-sm font-semibold">{windowInfo?.title ?? title}</h1>
      <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
        {children}
        {!isMacOS && (
          <>
            {children && <div className="mx-1 h-4 w-px bg-border" />}
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void perform(minimizeCurrentWindow)}
              title={t("main.window.minimize")}
              aria-label={t("main.window.minimize")}
            >
              <Minus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => void perform(toggleMaximizeCurrentWindow)}
              disabled={windowInfo?.maximizable === false}
              title={t(isMaximized ? "main.window.restore" : "main.window.maximize")}
              aria-label={t(isMaximized ? "main.window.restore" : "main.window.maximize")}
            >
              {isMaximized ? <Copy /> : <Square />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hover:bg-destructive/10 hover:text-destructive"
              onClick={() => void perform(onClose)}
              title={t("main.window.close")}
              aria-label={t("main.window.close")}
            >
              <X />
            </Button>
          </>
        )}
      </div>
    </header>
  );
}

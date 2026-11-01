import { useEffect, useEffectEvent, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { WindowTitleBar } from "@spark233/ui/components";
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
    <WindowTitleBar
      title={windowInfo?.title ?? title}
      isMacOS={isMacOS}
      isMaximized={isMaximized}
      maximizable={windowInfo?.maximizable !== false}
      labels={{
        minimize: t("main.window.minimize"),
        maximize: t("main.window.maximize"),
        restore: t("main.window.restore"),
        close: t("main.window.close"),
      }}
      onMouseDown={onMouseDown}
      onMinimize={() => void perform(minimizeCurrentWindow)}
      onToggleMaximize={() => void perform(toggleMaximizeCurrentWindow)}
      onClose={() => void perform(onClose)}
    >
      {children}
    </WindowTitleBar>
  );
}

import { useEffect, useEffectEvent, useState, type MouseEvent, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "../../platform/desktop";
import { useWindowMode } from "./useWindowMode";
import { usePluginWindow } from "./PluginWindowContext";
import { StatusBar, type RunState } from "./StatusBar";
import {
  closeCurrentWindow,
  isCurrentWindowMaximized,
  minimizeCurrentWindow,
  startCurrentWindowDrag,
  toggleMaximizeCurrentWindow,
} from "./controls";

interface Props {
  title: string;
  /** Short context shown next to the title, e.g. the current entry. */
  subtitle?: string;
  runState?: RunState;
  children?: ReactNode;
  onClose?: () => void | Promise<void>;
  onError: (error: unknown) => void;
}

/** The host status bar of a trusted workspace window. Each workspace supplies
 * its own actions and keeps its close policy; window modes come from the host. */
export function WorkspaceTitleBar({
  title,
  subtitle,
  runState,
  children,
  onClose = closeCurrentWindow,
  onError,
}: Props) {
  const { i18n } = useTranslation();
  const windowInfo = usePluginWindow();
  const [isMaximized, setIsMaximized] = useState(false);
  const windowMode = useWindowMode();
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

  // One Esc policy for every workspace window: close through the workspace's own
  // close path (saving/cancel confirmations included), unless something more
  // local owns the key: an open dialog or menu, IME composition, or a text field
  // that still holds text. A desktop card is not closed by Esc.
  const closeOnEscape = useEffectEvent(() => {
    if (windowMode.mode !== "desktop") void perform(onClose);
  });
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (
        document.querySelector(
          '[role="dialog"], [role="alertdialog"], [role="menu"], [data-slot$="-content"][data-open]',
        )
      )
        return;
      if (
        (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
        target.value
      )
        return;
      if (target?.isContentEditable) return;
      event.preventDefault();
      closeOnEscape();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
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
  const onDesktop = windowMode.mode === "desktop";

  return (
    <StatusBar
      title={windowInfo?.title ?? title}
      subtitle={subtitle}
      runState={runState}
      locale={i18n.resolvedLanguage ?? "zh-CN"}
      mode={windowMode.mode}
      onModeChange={
        windowMode.onModeChange && ((next) => void perform(() => windowMode.onModeChange!(next)))
      }
      maximized={isMaximized}
      maximizable={windowInfo?.maximizable !== false}
      onMouseDown={onMouseDown}
      onMinimize={() => void perform(minimizeCurrentWindow)}
      onToggleMaximize={() => void perform(toggleMaximizeCurrentWindow)}
      // On the desktop "close" only removes the card; nothing is saved or stopped.
      onClose={() => void perform(onDesktop ? closeCurrentWindow : onClose)}
    >
      {children}
    </StatusBar>
  );
}

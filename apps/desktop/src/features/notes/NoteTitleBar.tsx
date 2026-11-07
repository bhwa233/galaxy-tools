import { memo } from "react";
import { useTranslation } from "react-i18next";
import { CircleArrowUp, Info, Settings, StickyNote } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NoteSession } from "./useNoteSession";
import { usePluginWindow } from "../windows/PluginWindowContext";
import { StatusBar } from "../windows/StatusBar";
import { useWindowMode } from "../windows/useWindowMode";
import { closeCurrentWindow } from "../windows/controls";
import { showToast } from "../../components/Toast";
import { getErrorMessage } from "../../platform/errors";

type Props = Pick<
  NoteSession,
  | "isMacOS"
  | "handleTitleBarMouseDown"
  | "t"
  | "handleOpenNotepad"
  | "handleOpenSettings"
  | "handleOpenAbout"
  | "aboutButtonExpanded"
  | "aboutButtonTitle"
  | "aboutUpdateReminder"
  | "aboutButtonLabel"
  | "handleMinimize"
  | "handleMaximize"
  | "isMaximized"
  | "handleClose"
>;
/** The notes manager on the shared host status bar, with its own actions. */
export const NoteTitleBar = memo(function NoteTitleBar({
  handleTitleBarMouseDown,
  t,
  handleOpenNotepad,
  handleOpenSettings,
  handleOpenAbout,
  aboutButtonExpanded,
  aboutButtonTitle,
  aboutUpdateReminder,
  aboutButtonLabel,
  handleMinimize,
  handleMaximize,
  isMaximized,
  handleClose,
}: Props) {
  const windowInfo = usePluginWindow();
  const windowMode = useWindowMode();
  const { i18n } = useTranslation();
  const report = (error: unknown) => showToast(getErrorMessage(error));
  return (
    <StatusBar
      title={windowInfo?.title ?? t("main.window.manager")}
      locale={i18n.resolvedLanguage ?? "zh-CN"}
      mode={windowMode.mode}
      onModeChange={
        windowMode.onModeChange && ((next) => void windowMode.onModeChange!(next).catch(report))
      }
      locked={windowMode.locked}
      hint={windowMode.hint}
      highlighted={windowMode.highlighted}
      onLockChange={
        windowMode.onLockChange && ((value) => void windowMode.onLockChange!(value).catch(report))
      }
      maximized={isMaximized}
      onMouseDown={handleTitleBarMouseDown}
      onMinimize={handleMinimize}
      onToggleMaximize={handleMaximize}
      // On the desktop "close" only removes the card from the desktop.
      onClose={
        windowMode.mode === "desktop" ? () => void closeCurrentWindow().catch(report) : handleClose
      }
    >
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void handleOpenNotepad()}
        title={t("main.window.quickNotepad")}
        aria-label={t("main.window.quickNotepad")}
      >
        <StickyNote />
      </Button>
      <Button
        variant="ghost"
        size="icon-sm"
        onClick={() => void handleOpenSettings()}
        title={t("main.window.settings")}
        aria-label={t("main.window.settings")}
      >
        <Settings />
      </Button>
      <Button
        variant="ghost"
        size={aboutButtonExpanded ? "sm" : "icon-sm"}
        onClick={handleOpenAbout}
        title={aboutButtonTitle}
        aria-label={aboutButtonTitle}
      >
        {aboutUpdateReminder.hasPendingUpdate ? (
          <CircleArrowUp data-testid="main-about-update-icon" className="text-primary" />
        ) : (
          <Info data-testid="main-about-info-icon" />
        )}
        {aboutUpdateReminder.hasPendingUpdate && aboutButtonExpanded && (
          <span data-testid="main-about-update-label">{aboutButtonLabel}</span>
        )}
      </Button>
    </StatusBar>
  );
});

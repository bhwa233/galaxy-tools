import { memo } from "react";
import { CircleArrowUp, Copy, Info, Minus, Settings, Square, StickyNote, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { NoteSession } from "./useNoteSession";
import { usePluginWindow } from "../windows/PluginWindowContext";

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
export const NoteTitleBar = memo(function NoteTitleBar({
  isMacOS,
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
  return (
    <header
      className={`electron-title-drag relative z-10 flex h-12 shrink-0 items-center justify-between gap-3 border-b bg-background pr-3 select-none ${isMacOS ? "pl-20" : "pl-4"}`}
      onMouseDown={handleTitleBarMouseDown}
    >
      <h1 className="truncate text-sm font-semibold">
        {windowInfo?.title ?? t("main.window.manager")}
      </h1>
      <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
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
        {!isMacOS && (
          <>
            <div className="mx-1 h-4 w-px bg-border" />
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleMinimize}
              title={t("main.window.minimize")}
              aria-label={t("main.window.minimize")}
            >
              <Minus />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={handleMaximize}
              title={t(isMaximized ? "main.window.restore" : "main.window.maximize")}
              aria-label={t(isMaximized ? "main.window.restore" : "main.window.maximize")}
            >
              {isMaximized ? <Copy /> : <Square />}
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              className="hover:bg-destructive/10 hover:text-destructive"
              onClick={handleClose}
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
});

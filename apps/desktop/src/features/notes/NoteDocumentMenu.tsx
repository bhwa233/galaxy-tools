import { ChevronLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memo } from "react";
import { POPUP_VIEWPORT_MARGIN } from "../../components/popupPosition";
import { showToast } from "../../components/Toast";
import { ReminderPicker } from "../reminders/ReminderPicker";
import type { NoteSession } from "./useNoteSession";
type Props = Pick<
  NoteSession,
  | "noteMenu"
  | "noteMenuTarget"
  | "noteMenuRef"
  | "noteMenuClosing"
  | "noteMenuPosition"
  | "noteMenuMode"
  | "noteContextMenuItems"
  | "handleNoteMenuAction"
  | "setNoteMenuMode"
  | "t"
  | "reminderItems"
  | "setNoteMenuClosing"
  | "handleMoveNote"
  | "categories"
>;
export const NoteDocumentMenu = memo(function NoteDocumentMenu({
  noteMenu,
  noteMenuTarget,
  noteMenuRef,
  noteMenuClosing,
  noteMenuPosition,
  noteMenuMode,
  noteContextMenuItems,
  handleNoteMenuAction,
  setNoteMenuMode,
  t,
  reminderItems,
  setNoteMenuClosing,
  handleMoveNote,
  categories,
}: Props) {
  return (
    noteMenu &&
    noteMenuTarget && (
      <div
        ref={noteMenuRef}
        className={`popup-menu fixed z-[9999] min-w-[168px] p-1 bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 rounded-lg overflow-x-hidden overflow-y-auto select-none ${noteMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
        style={{
          left: noteMenuPosition?.x ?? noteMenu.x,
          top: noteMenuPosition?.y ?? noteMenu.y,
          maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {noteMenuMode === "main" ? (
          <div key="main" className="animate-menu-slide-right">
            {noteContextMenuItems.map((item) => (
              <Button
                variant="ghost"
                size="sm"
                key={item.action}
                data-note-action={item.action}
                onClick={() => handleNoteMenuAction(item.action)}
                className={`w-full justify-start px-2 text-sm transition-colors cursor-pointer ${
                  item.tone === "danger"
                    ? "text-destructive hover:bg-destructive/10 hover:text-destructive"
                    : "text-foreground hover:bg-accent hover:text-accent-foreground"
                }`}
              >
                <span>{item.label}</span>
              </Button>
            ))}
          </div>
        ) : noteMenuMode === "reminder" ? (
          <div key="reminder" className="animate-menu-slide-left">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNoteMenuMode("main")}
              className="w-full justify-start gap-1.5 px-2 text-sm text-muted-foreground hover:bg-muted transition-colors cursor-pointer border-b border-border"
            >
              <ChevronLeft className="size-3.5" />
              <span>{t("common.back", { defaultValue: "返回" })}</span>
            </Button>
            <ReminderPicker
              noteId={noteMenuTarget.id}
              scopeItems={reminderItems.filter((item) => item.noteId === noteMenuTarget.id)}
              onDone={() => setNoteMenuClosing(true)}
              onError={showToast}
            />
          </div>
        ) : (
          <div key="move" className="animate-menu-slide-left">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setNoteMenuMode("main")}
              className="w-full justify-start gap-1.5 px-2 text-sm text-muted-foreground hover:bg-muted transition-colors cursor-pointer border-b border-border"
            >
              <ChevronLeft className="size-3.5" />
              <span>{t("common.back", { defaultValue: "返回" })}</span>
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => void handleMoveNote(noteMenuTarget.id, "")}
              className="w-full justify-start text-left px-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              {t("main.category.uncategorized", { defaultValue: "未分类" })}
            </Button>
            {categories.map((cat) => (
              <Button
                variant="ghost"
                size="sm"
                key={cat}
                onClick={() => void handleMoveNote(noteMenuTarget.id, cat)}
                className="w-full justify-start text-left px-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
              >
                {cat}
              </Button>
            ))}
          </div>
        )}
      </div>
    )
  );
});

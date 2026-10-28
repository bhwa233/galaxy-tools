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
        className={`popup-menu fixed z-[9999] min-w-[168px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none ${noteMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
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
            {noteContextMenuItems.map((item, index) => (
              <button
                key={item.action}
                data-note-action={item.action}
                onClick={() => handleNoteMenuAction(item.action)}
                className={`w-full flex items-center justify-between px-3 py-1.5 text-[12px] font-body transition-colors cursor-pointer ${
                  item.tone === "danger"
                    ? "text-red-400 hover:bg-danger-bg hover:text-red-500"
                    : "text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo"
                } ${index > 0 ? "border-t border-paper-deep/20" : ""}`}
              >
                <span>{item.label}</span>
              </button>
            ))}
          </div>
        ) : noteMenuMode === "reminder" ? (
          <div key="reminder" className="animate-menu-slide-left">
            <button
              onClick={() => setNoteMenuMode("main")}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body text-ink-ghost hover:bg-paper-warm transition-colors cursor-pointer border-b border-paper-deep/20"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <span>{t("common.back", { defaultValue: "返回" })}</span>
            </button>
            <ReminderPicker
              noteId={noteMenuTarget.id}
              scopeItems={reminderItems.filter((item) => item.noteId === noteMenuTarget.id)}
              onDone={() => setNoteMenuClosing(true)}
              onError={showToast}
            />
          </div>
        ) : (
          <div key="move" className="animate-menu-slide-left">
            <button
              onClick={() => setNoteMenuMode("main")}
              className="w-full flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-body text-ink-ghost hover:bg-paper-warm transition-colors cursor-pointer border-b border-paper-deep/20"
            >
              <svg
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="15 18 9 12 15 6" />
              </svg>
              <span>{t("common.back", { defaultValue: "返回" })}</span>
            </button>
            <button
              onClick={() => void handleMoveNote(noteMenuTarget.id, "")}
              className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
            >
              {t("main.category.uncategorized", { defaultValue: "未分类" })}
            </button>
            {categories.map((cat) => (
              <button
                key={cat}
                onClick={() => void handleMoveNote(noteMenuTarget.id, cat)}
                className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
              >
                {cat}
              </button>
            ))}
          </div>
        )}
      </div>
    )
  );
});

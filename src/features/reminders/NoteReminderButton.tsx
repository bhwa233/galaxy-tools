import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { useReminders } from "./useReminders";
import { ReminderPopover } from "./ReminderPopover";
import { formatReminderTime } from "./ReminderPicker";

interface Props {
  noteId: string | null;
  ensureNoteSaved?: () => Promise<string | null>;
  disabled?: boolean;
  className?: string;
  onError(message: string): void;
}

/** One reminder entry per note, shared by the main editor, small window and tile. */
export function NoteReminderButton({
  noteId,
  ensureNoteSaved,
  disabled,
  className = "",
  onError,
}: Props) {
  const { t } = useTranslation();
  const items = useReminders();
  const noteItems = items
    .filter((item) => item.noteId === noteId)
    .sort((a, b) => a.fireAt.localeCompare(b.fireAt));
  const [open, setOpen] = useState<{ noteId: string; x: number; y: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (open && open.noteId !== noteId) setOpen(null);
  }, [noteId, open]);
  const label = t("reminder.noteButton", { defaultValue: "便签提醒" });
  const title = noteItems[0]
    ? `${label} · ${t("reminder.hasReminder", { time: formatReminderTime(noteItems[0].fireAt), defaultValue: "已设提醒：{{time}}" })}`
    : label;
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        data-note-reminder-button="true"
        data-has-reminder={noteItems.length ? "true" : undefined}
        aria-haspopup="dialog"
        aria-label={label}
        aria-expanded={Boolean(open)}
        aria-pressed={noteItems.length > 0}
        title={title}
        disabled={disabled || busy || (!noteId && !ensureNoteSaved)}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={async (event) => {
          event.stopPropagation();
          if (open) {
            setOpen(null);
            return;
          }
          const bounds = event.currentTarget.getBoundingClientRect();
          setBusy(true);
          try {
            const id = noteId ?? (await ensureNoteSaved?.());
            if (!id)
              throw new Error(
                t("reminder.saveFirstFailed", { defaultValue: "保存便签失败，暂时无法设置提醒" }),
              );
            if (alive.current) setOpen({ noteId: id, x: bounds.right, y: bounds.bottom + 4 });
          } catch (error) {
            if (alive.current) onError(error instanceof Error ? error.message : String(error));
          } finally {
            if (alive.current) setBusy(false);
          }
        }}
        className={`electron-no-drag relative w-7 h-7 shrink-0 inline-flex items-center justify-center rounded-lg transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${noteItems.length ? "text-bamboo bg-bamboo/10" : "text-ink-ghost hover:text-bamboo hover:bg-paper-warm"} ${className}`}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9M10 21h4" />
        </svg>
        {noteItems.length > 0 && (
          <span
            aria-hidden="true"
            className="absolute top-1 right-1 w-1.5 h-1.5 rounded-full bg-bamboo"
          />
        )}
      </button>
      {open &&
        createPortal(
          <ReminderPopover
            noteId={open.noteId}
            x={open.x}
            y={open.y}
            anchorElement={buttonRef.current}
            scopeItems={items.filter((item) => item.noteId === open.noteId)}
            onClose={() => setOpen(null)}
            onDone={() => setOpen(null)}
            onError={onError}
          />,
          document.body,
        )}
    </>
  );
}

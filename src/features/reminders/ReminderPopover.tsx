import { useEffect, useRef } from "react";
import { ReminderPicker, type ReminderPickerProps } from "./ReminderPicker";
import { useTranslation } from "react-i18next";
import { useViewportPopupPosition } from "../../components/popupPosition";

interface ReminderPopoverProps extends ReminderPickerProps {
  x: number;
  y: number;
  onClose: () => void;
  anchorElement?: HTMLElement | null;
}

/** Note reminder panel, constrained to the window with outside-click/Escape dismissal. */
export function ReminderPopover({ x, y, onClose, anchorElement, ...picker }: ReminderPopoverProps) {
  const { t } = useTranslation();
  const anchor = useRef({ x, y });
  const { popupRef: ref, popupPosition } = useViewportPopupPosition(
    anchor.current,
    picker.scopeItems.length,
  );
  useEffect(() => {
    const handler = (event: PointerEvent) => {
      if (anchorElement?.contains(event.target as Node)) return;
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    document.addEventListener("pointerdown", handler);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", handler);
      document.removeEventListener("keydown", escape);
    };
  }, [onClose, anchorElement]);
  return (
    <div
      ref={ref}
      role="dialog"
      aria-label={t("reminder.noteButton", { defaultValue: "便签提醒" })}
      data-note-reminder-panel="true"
      className="popup-menu fixed z-[9999] w-[260px] max-w-[calc(100vw-8px)] max-h-[calc(100vh-8px)] overflow-y-auto py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg animate-menu-enter shadow-[0_6px_24px_rgba(26,26,24,0.12)]"
      style={{ left: popupPosition?.x ?? x, top: popupPosition?.y ?? y }}
      onMouseDown={(event) => event.stopPropagation()}
    >
      <div className="px-3 pt-1 pb-2 text-[12px] font-medium text-ink-soft">
        {t("reminder.noteButton", { defaultValue: "便签提醒" })}
      </div>
      <ReminderPicker {...picker} />
    </div>
  );
}

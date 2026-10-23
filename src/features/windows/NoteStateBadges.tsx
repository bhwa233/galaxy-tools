import { useTranslation } from "react-i18next";
import type { NoteWindowState } from "./noteWindowState";
// Reuse the paper's pin action and existing Tailwind/theme tokens; these badges are domain state,
// not a new generic control library. The text and native button keep the state visible and accessible.
export function NoteStateBadges({
  state,
  onTogglePin,
}: {
  state: NoteWindowState;
  onTogglePin?: () => void;
}) {
  const { t } = useTranslation();
  const pinLabel = t(state.pinned ? "noteState.unpin" : "noteState.pin");
  return (
    <span
      className="inline-flex items-center gap-1 shrink-0"
      data-note-window-state={state.presence}
    >
      <button
        type="button"
        data-note-pin={state.pinned ? "true" : "false"}
        aria-label={pinLabel}
        title={pinLabel}
        aria-pressed={state.pinned}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => {
          event.stopPropagation();
          onTogglePin?.();
        }}
        className={`inline-flex items-center gap-0.5 rounded px-1 py-0.5 text-[10px] cursor-pointer transition-colors ${state.pinned ? "text-bamboo bg-bamboo-mist font-medium" : "text-ink-ghost/60 hover:text-bamboo hover:bg-bamboo-mist/60"}`}
      >
        <svg
          width="10"
          height="10"
          viewBox="0 0 24 24"
          fill={state.pinned ? "currentColor" : "none"}
          stroke="currentColor"
          strokeWidth="1.8"
          aria-hidden="true"
        >
          <path d="M9 3h6v5l3 5v2H6v-2l3-5V3Zm3 12v6" />
        </svg>
        {state.pinned && <span>{t("noteState.pinned")}</span>}
      </button>
      <span
        className={`rounded px-1 py-0.5 text-[10px] ${state.presence === "desktop" ? "text-bamboo bg-bamboo-mist/60" : state.presence === "capsule" ? "text-bamboo-light bg-bamboo-mist/40" : "text-ink-ghost/70"}`}
        data-note-presence={state.presence}
      >
        {t(`noteState.${state.presence}`)}
      </span>
    </span>
  );
}

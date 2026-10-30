import { Suspense, memo } from "react";
import { AboutPanel } from "./notePresentation";
import type { NoteSession } from "./useNoteSession";
type Props = Pick<
  NoteSession,
  | "sidePanelExpanded"
  | "mountedSidePanel"
  | "settingsOverlay"
  | "visibleSidePanel"
  | "sidePanelContentVisible"
  | "handleCloseAbout"
>;
export const NoteUpdatePanel = memo(function NoteUpdatePanel({
  sidePanelExpanded,
  mountedSidePanel,
  settingsOverlay,
  visibleSidePanel,
  sidePanelContentVisible,
  handleCloseAbout,
}: Props) {
  return (
    <div
      className={`relative shrink-0 bg-background overflow-hidden h-full transition-[width] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
        sidePanelExpanded || mountedSidePanel ? "border-l border-border" : "border-l-0"
      } ${
        settingsOverlay
          ? `absolute right-0 top-0 bottom-0 z-30 ${visibleSidePanel ? "w-[360px] shadow-xl" : "w-0"}`
          : `${sidePanelExpanded ? "w-[360px]" : "w-0"}`
      }`}
    >
      <div
        className={`absolute inset-0 w-[360px] h-full transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          mountedSidePanel === "about"
            ? sidePanelContentVisible && visibleSidePanel === "about"
              ? "translate-x-0 opacity-100"
              : "pointer-events-none translate-x-4 opacity-0"
            : "pointer-events-none translate-x-4 opacity-0"
        }`}
      >
        {mountedSidePanel === "about" ? (
          <Suspense fallback={null}>
            <AboutPanel onClose={handleCloseAbout} />
          </Suspense>
        ) : null}
      </div>
    </div>
  );
});

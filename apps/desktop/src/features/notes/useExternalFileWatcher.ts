import type { Dispatch, RefObject, SetStateAction } from "react";
import { useEffect } from "react";
import { getFileModifiedTime, readExternalFile } from "./api";
import { SaveState, useLoadEpoch } from "./notePresentation";
import type { ExternalFile } from "./types";
interface WatcherOptions {
  selectedExternalFile: ExternalFile | null;
  lastExternalSaveRef: RefObject<number>;
  saveStateRef: RefObject<SaveState>;
  loadEpoch: ReturnType<typeof useLoadEpoch>;
  contentValueRef: RefObject<string>;
  selectedIdRef: RefObject<string | null>;
  externalFileMtimeRef: RefObject<number>;
  setContent: Dispatch<SetStateAction<string>>;
  setSaveState: Dispatch<SetStateAction<SaveState>>;
}

export function useExternalFileWatcher({
  selectedExternalFile,
  lastExternalSaveRef,
  saveStateRef,
  loadEpoch,
  contentValueRef,
  selectedIdRef,
  externalFileMtimeRef,
  setContent,
  setSaveState,
}: WatcherOptions) {
  useEffect(() => {
    if (!selectedExternalFile) return;
    let disposed = false;
    let inFlight = false;
    const interval = window.setInterval(async () => {
      if (
        disposed ||
        inFlight ||
        document.visibilityState === "hidden" ||
        Date.now() - lastExternalSaveRef.current < 2000 ||
        ["dirty", "saving", "error"].includes(saveStateRef.current)
      )
        return;
      inFlight = true;
      const epoch = loadEpoch.peek();
      const contentBefore = contentValueRef.current;
      const current = () =>
        !disposed &&
        loadEpoch.isCurrent(epoch) &&
        selectedIdRef.current === selectedExternalFile.id &&
        contentValueRef.current === contentBefore &&
        !["dirty", "saving", "error"].includes(saveStateRef.current);
      try {
        const mtime = await getFileModifiedTime(selectedExternalFile.filePath);
        if (!current() || mtime === externalFileMtimeRef.current) return;
        const fileContent = await readExternalFile(selectedExternalFile.filePath);
        if (!current()) return;
        externalFileMtimeRef.current = mtime;
        contentValueRef.current = fileContent;
        saveStateRef.current = "saved";
        setContent(fileContent);
        setSaveState("saved");
      } catch {
        // Keep the current draft if the file was deleted or became inaccessible.
      } finally {
        inFlight = false;
      }
    }, 1000);
    return () => {
      disposed = true;
      window.clearInterval(interval);
    };
  }, [selectedExternalFile, loadEpoch]);
  return {};
}

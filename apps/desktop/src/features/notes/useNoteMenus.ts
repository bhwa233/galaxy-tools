import { useCallback, useEffect, useState } from "react";
import { useViewportPopupPosition } from "../../components/popupPosition";
import { CategoryMenuState, NoteMenuState } from "./notePresentation";

export function useNoteMenus(categoryCount: number) {
  const [noteMenu, setNoteMenu] = useState<NoteMenuState | null>(null);
  const [noteMenuClosing, setNoteMenuClosing] = useState(false);
  const [noteMenuMode, setNoteMenuMode] = useState<"main" | "move" | "reminder">("main");
  const [categoryMenu, setCategoryMenu] = useState<CategoryMenuState | null>(null);
  const [categoryMenuClosing, setCategoryMenuClosing] = useState(false);
  const [categoryMenuConfirmDelete, setCategoryMenuConfirmDelete] = useState(false);
  const [categoryMenuHoverSuppressed, setCategoryMenuHoverSuppressed] = useState(false);
  const { popupRef: noteMenuRef, popupPosition: noteMenuPosition } = useViewportPopupPosition(
    noteMenu,
    `${noteMenuMode}:${categoryCount}`,
  );
  const { popupRef: categoryMenuRef, popupPosition: categoryMenuPosition } =
    useViewportPopupPosition(categoryMenu, categoryMenuConfirmDelete);
  useEffect(() => {
    function closeMenus() {
      setNoteMenuClosing(true);
      setCategoryMenuClosing(true);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") closeMenus();
    }

    document.addEventListener("mousedown", closeMenus);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("mousedown", closeMenus);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, []);
  useEffect(() => {
    if (!noteMenuClosing || !noteMenu) return;
    const timer = window.setTimeout(() => {
      setNoteMenu(null);
      setNoteMenuClosing(false);
      setNoteMenuMode("main");
    }, 150);
    return () => window.clearTimeout(timer);
  }, [noteMenuClosing, noteMenu]);
  useEffect(() => {
    if (!categoryMenuClosing || !categoryMenu) return;
    const timer = window.setTimeout(() => {
      setCategoryMenu(null);
      setCategoryMenuClosing(false);
      setCategoryMenuConfirmDelete(false);
      setCategoryMenuHoverSuppressed(false);
    }, 150);
    return () => window.clearTimeout(timer);
  }, [categoryMenuClosing, categoryMenu]);
  useEffect(() => {
    if (!categoryMenuHoverSuppressed || !categoryMenu) return;
    const releaseHover = () => setCategoryMenuHoverSuppressed(false);
    window.addEventListener("mousemove", releaseHover, { once: true });
    window.addEventListener("mousedown", releaseHover, { once: true });
    return () => {
      window.removeEventListener("mousemove", releaseHover);
      window.removeEventListener("mousedown", releaseHover);
    };
  }, [categoryMenuHoverSuppressed, categoryMenu]);
  const switchCategoryMenuPanel = useCallback((confirmDelete: boolean) => {
    setCategoryMenuHoverSuppressed(true);
    setCategoryMenuConfirmDelete(confirmDelete);
    (document.activeElement as HTMLElement | null)?.blur();
  }, []);
  return {
    noteMenu,
    setNoteMenu,
    noteMenuClosing,
    setNoteMenuClosing,
    noteMenuMode,
    setNoteMenuMode,
    categoryMenu,
    setCategoryMenu,
    categoryMenuClosing,
    setCategoryMenuClosing,
    categoryMenuConfirmDelete,
    setCategoryMenuConfirmDelete,
    categoryMenuHoverSuppressed,
    setCategoryMenuHoverSuppressed,
    noteMenuRef,
    noteMenuPosition,
    categoryMenuRef,
    categoryMenuPosition,
    switchCategoryMenuPanel,
  };
}

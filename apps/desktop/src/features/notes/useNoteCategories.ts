import { useCallback, type Dispatch, type SetStateAction } from "react";
import { showToast } from "../../components/Toast";
import { getErrorMessage } from "../../platform/errors";
import { createCategory, deleteCategory, renameCategory } from "./api";

interface Options {
  categoryInputValue: string;
  setShowCategoryInput: Dispatch<SetStateAction<boolean>>;
  setCategories: Dispatch<SetStateAction<string[]>>;
  setCategoryInputValue: Dispatch<SetStateAction<string>>;
  renameCategoryValue: string;
  setRenamingCategory: Dispatch<SetStateAction<string | null>>;
  setRenameCategoryValue: Dispatch<SetStateAction<string>>;
  refreshNotes: () => Promise<unknown>;
  activeCategory: string;
  setActiveCategory: Dispatch<SetStateAction<string>>;
  setCollapsedCategories: Dispatch<SetStateAction<Set<string>>>;
}

/** Category create/rename/delete/collapse, split out of the note session. */
export function useNoteCategories({
  categoryInputValue,
  setShowCategoryInput,
  setCategories,
  setCategoryInputValue,
  renameCategoryValue,
  setRenamingCategory,
  setRenameCategoryValue,
  refreshNotes,
  activeCategory,
  setActiveCategory,
  setCollapsedCategories,
}: Options) {
  const handleCreateCategory = useCallback(async () => {
    const name = categoryInputValue.trim();
    if (!name) {
      setShowCategoryInput(false);
      return;
    }
    try {
      await createCategory(name);
      setCategories((prev) => [...prev, name].sort());
      setShowCategoryInput(false);
      setCategoryInputValue("");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [categoryInputValue, setShowCategoryInput, setCategories, setCategoryInputValue]);

  const handleRenameCategory = useCallback(
    async (oldName: string) => {
      const newName = renameCategoryValue.trim();
      if (!newName || newName === oldName) {
        setRenamingCategory(null);
        return;
      }

      try {
        await renameCategory(oldName, newName);
        await refreshNotes();
        setRenamingCategory(null);
        setRenameCategoryValue("");
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [renameCategoryValue, setRenamingCategory, refreshNotes, setRenameCategoryValue],
  );

  const handleDeleteCategory = useCallback(
    async (name: string) => {
      try {
        await deleteCategory(name);
        await refreshNotes();
        if (activeCategory === name) {
          setActiveCategory("");
        }
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [refreshNotes, activeCategory, setActiveCategory],
  );

  const toggleCategoryCollapse = useCallback(
    (category: string) => {
      setCollapsedCategories((prev) => {
        const next = new Set(prev);
        if (next.has(category)) {
          next.delete(category);
        } else {
          next.add(category);
        }
        return next;
      });
    },
    [setCollapsedCategories],
  );

  return {
    handleCreateCategory,
    handleRenameCategory,
    handleDeleteCategory,
    toggleCategoryCollapse,
  };
}

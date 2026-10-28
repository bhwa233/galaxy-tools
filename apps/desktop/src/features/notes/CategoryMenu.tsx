import { memo } from "react";
import { POPUP_VIEWPORT_MARGIN } from "../../components/popupPosition";
import type { NoteSession } from "./useNoteSession";
type Props = Pick<
  NoteSession,
  | "categoryMenu"
  | "categoryMenuRef"
  | "categoryMenuClosing"
  | "categoryMenuHoverSuppressed"
  | "categoryMenuPosition"
  | "categoryMenuConfirmDelete"
  | "t"
  | "handleDeleteCategory"
  | "setCategoryMenuClosing"
  | "switchCategoryMenuPanel"
  | "setRenamingCategory"
  | "setRenameCategoryValue"
>;
export const CategoryMenu = memo(function CategoryMenu({
  categoryMenu,
  categoryMenuRef,
  categoryMenuClosing,
  categoryMenuHoverSuppressed,
  categoryMenuPosition,
  categoryMenuConfirmDelete,
  t,
  handleDeleteCategory,
  setCategoryMenuClosing,
  switchCategoryMenuPanel,
  setRenamingCategory,
  setRenameCategoryValue,
}: Props) {
  return (
    categoryMenu && (
      <div
        ref={categoryMenuRef}
        className={`popup-menu fixed z-[9999] min-w-[140px] py-1.5 bg-cloud/95 backdrop-blur-sm border border-paper-deep/50 rounded-lg overflow-x-hidden overflow-y-auto select-none ${categoryMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
        data-hover-suppressed={categoryMenuHoverSuppressed ? "" : undefined}
        style={{
          left: categoryMenuPosition?.x ?? categoryMenu.x,
          top: categoryMenuPosition?.y ?? categoryMenu.y,
          maxWidth: `calc(100vw - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
          maxHeight: `calc(100vh - ${POPUP_VIEWPORT_MARGIN * 2}px)`,
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        {categoryMenuConfirmDelete ? (
          <div key="category-confirm" className="animate-menu-slide-left">
            <div className="px-3 py-1.5 text-[11px] font-body text-ink-faint border-b border-paper-deep/20">
              {t("main.category.confirmDelete", {
                category: categoryMenu.category,
                defaultValue: "确认删除「{{category}}」？",
              })}
            </div>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                void handleDeleteCategory(categoryMenu.category);
                setCategoryMenuClosing(true);
              }}
              className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer outline-none"
            >
              {t("main.category.confirmDeleteAction", { defaultValue: "确认删除" })}
            </button>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => switchCategoryMenuPanel(false)}
              className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer outline-none"
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </button>
          </div>
        ) : (
          <div key="category-main" className="animate-menu-slide-right">
            <button
              onClick={() => {
                setCategoryMenuClosing(true);
                setRenamingCategory(categoryMenu.category);
                setRenameCategoryValue(categoryMenu.category);
              }}
              className="w-full text-left px-3 py-1.5 text-[12px] font-body text-ink-soft hover:bg-bamboo-mist/60 hover:text-bamboo transition-colors cursor-pointer"
            >
              {t("main.category.rename", { defaultValue: "重命名" })}
            </button>
            <button
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => switchCategoryMenuPanel(true)}
              className="w-full text-left px-3 py-1.5 text-[12px] font-body text-red-400 hover:bg-danger-bg hover:text-red-500 transition-colors cursor-pointer border-t border-paper-deep/20 outline-none"
            >
              {t("main.category.delete", { defaultValue: "删除分类" })}
            </button>
          </div>
        )}
      </div>
    )
  );
});

import { Button } from "@/components/ui/button";
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
        className={`popup-menu fixed z-[9999] min-w-[140px] p-1 bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 rounded-lg overflow-x-hidden overflow-y-auto select-none ${categoryMenuClosing ? "animate-menu-exit" : "animate-menu-enter"}`}
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
            <div className="px-3 py-1.5 text-xs font-body text-muted-foreground border-b border-border">
              {t("main.category.confirmDelete", {
                category: categoryMenu.category,
                defaultValue: "确认删除「{{category}}」？",
              })}
            </div>
            <Button
              variant="ghost"
              size="sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => {
                void handleDeleteCategory(categoryMenu.category);
                setCategoryMenuClosing(true);
              }}
              className="w-full justify-start text-left px-2 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer outline-none"
            >
              {t("main.category.confirmDeleteAction", { defaultValue: "确认删除" })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => switchCategoryMenuPanel(false)}
              className="w-full justify-start text-left px-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer outline-none"
            >
              {t("common.cancel", { defaultValue: "取消" })}
            </Button>
          </div>
        ) : (
          <div key="category-main" className="animate-menu-slide-right">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setCategoryMenuClosing(true);
                setRenamingCategory(categoryMenu.category);
                setRenameCategoryValue(categoryMenu.category);
              }}
              className="w-full justify-start text-left px-2 text-sm text-foreground hover:bg-accent hover:text-accent-foreground transition-colors cursor-pointer"
            >
              {t("main.category.rename", { defaultValue: "重命名" })}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => switchCategoryMenuPanel(true)}
              className="w-full justify-start text-left px-2 text-sm text-destructive hover:bg-destructive/10 hover:text-destructive transition-colors cursor-pointer border-t border-border outline-none"
            >
              {t("main.category.delete", { defaultValue: "删除分类" })}
            </Button>
          </div>
        )}
      </div>
    )
  );
});

import { memo } from "react";
import { ChevronRight, FileInput, FileText, Folder, Plus, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import { ReminderBadge } from "../reminders/ReminderBadge";
import { NoteStateBadges } from "../windows/NoteStateBadges";
import type { CategoryGroup } from "./noteUtils";
import { formatShortDate, formatTime, getDisplayTitle } from "./noteUtils";
import type { NoteSession } from "./useNoteSession";
type Props = Pick<
  NoteSession,
  | "sidebarCollapsed"
  | "sidebarWidth"
  | "searchQuery"
  | "setSearchQuery"
  | "t"
  | "handleNewNote"
  | "handleImportNote"
  | "filteredNotes"
  | "externalFiles"
  | "showCategoryInput"
  | "categoryInputValue"
  | "handleCreateCategory"
  | "setShowCategoryInput"
  | "setCategoryInputValue"
  | "selectedId"
  | "hoveredId"
  | "handleSelectExternalFile"
  | "setHoveredId"
  | "handleRemoveExternalFile"
  | "categoryGroups"
  | "dragOverCategory"
  | "setDragOverCategory"
  | "handleMoveNote"
  | "handleSelectNote"
  | "handleOpenNoteMenu"
  | "stateFor"
  | "toggleNotePin"
  | "noteReminderMap"
  | "collapsedCategories"
  | "toggleCategoryCollapse"
  | "setCategoryMenu"
  | "setCategoryMenuClosing"
  | "setCategoryMenuConfirmDelete"
  | "renamingCategory"
  | "renameCategoryValue"
  | "setRenameCategoryValue"
  | "handleRenameCategory"
  | "setRenamingCategory"
  | "isLoading"
>;
export const NoteSidebar = memo(function NoteSidebar({
  sidebarCollapsed,
  sidebarWidth,
  searchQuery,
  setSearchQuery,
  t,
  handleNewNote,
  handleImportNote,
  filteredNotes,
  externalFiles,
  showCategoryInput,
  categoryInputValue,
  handleCreateCategory,
  setShowCategoryInput,
  setCategoryInputValue,
  selectedId,
  hoveredId,
  handleSelectExternalFile,
  setHoveredId,
  handleRemoveExternalFile,
  categoryGroups,
  dragOverCategory,
  setDragOverCategory,
  handleMoveNote,
  handleSelectNote,
  handleOpenNoteMenu,
  stateFor,
  toggleNotePin,
  noteReminderMap,
  collapsedCategories,
  toggleCategoryCollapse,
  setCategoryMenu,
  setCategoryMenuClosing,
  setCategoryMenuConfirmDelete,
  renamingCategory,
  renameCategoryValue,
  setRenameCategoryValue,
  handleRenameCategory,
  setRenamingCategory,
  isLoading,
}: Props) {
  return (
    <div
      className="border-r border-border bg-sidebar shrink-0 overflow-hidden"
      style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
    >
      <div className="flex flex-col h-full" style={{ width: `${sidebarWidth}px` }}>
        <div className="shrink-0 space-y-3 border-b p-3">
          <InputGroup className="bg-background">
            <InputGroupAddon>
              <Search className="size-4" />
            </InputGroupAddon>
            <InputGroupInput
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("main.sidebar.searchPlaceholder")}
              aria-label={t("main.sidebar.searchPlaceholder")}
            />
            {searchQuery && (
              <InputGroupAddon align="inline-end">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={() => setSearchQuery("")}
                  title={t("main.sidebar.clearSearch")}
                  aria-label={t("main.sidebar.clearSearch")}
                >
                  <X />
                </Button>
              </InputGroupAddon>
            )}
          </InputGroup>
          <div className="flex items-center gap-2">
            <Button size="sm" className="min-w-0 flex-1" onClick={handleNewNote}>
              <Plus data-icon="inline-start" />
              <span className="truncate">{t("main.sidebar.newNote")}</span>
            </Button>
            <Button
              variant="outline"
              size="icon-sm"
              onClick={() => void handleImportNote()}
              title={t("main.sidebar.importMarkdown")}
              aria-label={t("main.sidebar.importMarkdown")}
            >
              <FileInput />
            </Button>
          </div>
        </div>

        <div className="flex shrink-0 items-center justify-between gap-2 px-3 py-2">
          <span className="text-xs text-muted-foreground font-body">
            {t("common.noteCount", {
              count: filteredNotes.length,
              defaultValue: "{{count}} 张便签",
            })}
            {externalFiles.length > 0
              ? ` · ${t("common.externalFileCount", {
                  count: externalFiles.length,
                  defaultValue: "{{count}} 个外部文件",
                })}`
              : ""}
          </span>
          <Button
            variant="ghost"
            size="icon-xs"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (showCategoryInput && categoryInputValue.trim()) {
                void handleCreateCategory();
                return;
              }
              setShowCategoryInput(true);
            }}
            className="text-xs text-muted-foreground hover:text-primary transition-colors cursor-pointer"
            title={t("main.category.new", { defaultValue: "新建分类" })}
          >
            <Plus className="size-3.5" />
          </Button>
        </div>

        {showCategoryInput && (
          <div className="px-3 pb-2 shrink-0">
            <Input
              type="text"
              autoFocus
              value={categoryInputValue}
              onChange={(e) => setCategoryInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void handleCreateCategory();
                if (e.key === "Escape") {
                  setShowCategoryInput(false);
                  setCategoryInputValue("");
                }
              }}
              onBlur={() => void handleCreateCategory()}
              placeholder={t("main.category.placeholder", { defaultValue: "输入分类名…" })}
              className="w-full px-2.5 h-7 rounded-lg text-sm"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <div className="space-y-0.5">
            {externalFiles.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-xs text-muted-foreground font-body">
                  {t("main.externalFiles.title", { defaultValue: "外部文件" })}
                </div>
                {externalFiles.map((file) => {
                  const isSelected = file.id === selectedId;
                  const isHovered = file.id === hoveredId;

                  return (
                    <div
                      key={file.id}
                      role="button"
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          void handleSelectExternalFile(file.id);
                        }
                      }}
                      onClick={() => void handleSelectExternalFile(file.id)}
                      onMouseEnter={() => setHoveredId(file.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      className={`w-full text-left rounded-lg px-3 py-2.5 cursor-pointer group relative ${
                        isSelected ? "bg-accent" : isHovered ? "bg-muted" : "bg-transparent"
                      }`}
                    >
                      <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
                        <span
                          className={`text-sm min-w-0 font-medium truncate flex items-center gap-1.5 ${
                            isSelected ? "text-accent-foreground" : "text-foreground"
                          }`}
                        >
                          <FileText className="size-3.5 shrink-0" />
                          {file.title}
                        </span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveExternalFile(file.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 focus-visible:opacity-100 text-muted-foreground hover:text-destructive transition-colors p-0.5"
                          title={t("main.externalFiles.remove", {
                            defaultValue: "从列表移除",
                          })}
                        >
                          <X className="size-3.5" />
                        </Button>
                      </div>

                      <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2  pl-[18px]">
                        {file.filePath}
                      </p>
                    </div>
                  );
                })}
              </>
            )}

            {categoryGroups.map((group: CategoryGroup) => {
              if (!group.category) {
                return (
                  <div
                    key="__uncategorized__"
                    className={`rounded-lg transition-colors duration-200 ${
                      dragOverCategory === "" ? "bg-accent ring-1 ring-primary/30" : ""
                    }`}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOverCategory("");
                    }}
                    onDragLeave={(e) => {
                      if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                        setDragOverCategory(null);
                      }
                    }}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverCategory(null);
                      const noteId = e.dataTransfer.getData("text/plain");
                      if (noteId) void handleMoveNote(noteId, "");
                    }}
                  >
                    {group.notes.map((note) => {
                      const isSelected = note.id === selectedId;
                      const isHovered = note.id === hoveredId;
                      return (
                        <div
                          key={note.id}
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData("text/plain", note.id);
                            e.dataTransfer.effectAllowed = "move";
                          }}
                          onClick={() => void handleSelectNote(note.id)}
                          data-note-id={note.id}
                          onContextMenu={(event) => handleOpenNoteMenu(event, note.id)}
                          onMouseEnter={() => setHoveredId(note.id)}
                          onMouseLeave={() => setHoveredId(null)}
                          className={`w-full text-left rounded-lg px-3 py-2.5 cursor-pointer group relative ${
                            isSelected ? "bg-accent" : isHovered ? "bg-muted" : "bg-transparent"
                          }`}
                        >
                          <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
                            <span
                              className={`text-sm min-w-0 font-medium truncate ${
                                isSelected ? "text-accent-foreground" : "text-foreground"
                              }`}
                            >
                              {getDisplayTitle(note, t)}
                            </span>
                            <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                              {formatShortDate(note.updatedAt)}
                            </span>
                          </div>
                          <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 ">
                            {note.preview || t("common.blankNote", { defaultValue: "空白便签" })}
                          </p>
                          <div className="mt-1">
                            <NoteStateBadges
                              state={stateFor(note.id)}
                              onTogglePin={() => void toggleNotePin(note.id)}
                            />
                            {noteReminderMap.get(note.id) && (
                              <ReminderBadge item={noteReminderMap.get(note.id)!.item} />
                            )}
                          </div>
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {formatTime(note.updatedAt)}
                            </span>
                            <span className="text-xs text-muted-foreground">·</span>
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {t("common.wordCount", {
                                count: note.wordCount,
                                defaultValue: "{{count}} 字",
                              })}
                            </span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                );
              }

              const isCollapsed = collapsedCategories.has(group.category);

              return (
                <div key={group.category} className="mb-2">
                  <div
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg group/cat cursor-pointer select-none transition-colors duration-200 ${
                      dragOverCategory === group.category
                        ? "bg-accent border border-primary ring-1 ring-primary/30"
                        : isCollapsed
                          ? "bg-transparent border border-transparent hover:bg-muted"
                          : "bg-transparent border border-transparent hover:bg-muted"
                    }`}
                    onClick={() => toggleCategoryCollapse(group.category)}
                    onContextMenu={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      setCategoryMenu({
                        x: e.clientX,
                        y: e.clientY,
                        category: group.category,
                      });
                      setCategoryMenuClosing(false);
                      setCategoryMenuConfirmDelete(false);
                    }}
                    onDragOver={(e) => {
                      e.preventDefault();
                      e.dataTransfer.dropEffect = "move";
                      setDragOverCategory(group.category);
                    }}
                    onDragLeave={() => setDragOverCategory(null)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragOverCategory(null);
                      const noteId = e.dataTransfer.getData("text/plain");
                      if (noteId) void handleMoveNote(noteId, group.category);
                    }}
                  >
                    <ChevronRight
                      className={`size-3.5 shrink-0 text-muted-foreground ${isCollapsed ? "" : "rotate-90"}`}
                    />
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    {renamingCategory === group.category ? (
                      <Input
                        type="text"
                        autoFocus
                        value={renameCategoryValue}
                        onChange={(e) => setRenameCategoryValue(e.target.value)}
                        onKeyDown={(e) => {
                          e.stopPropagation();
                          if (e.key === "Enter") void handleRenameCategory(group.category);
                          if (e.key === "Escape") setRenamingCategory(null);
                        }}
                        onBlur={() => void handleRenameCategory(group.category)}
                        onClick={(e) => e.stopPropagation()}
                        className="h-7 min-w-0 flex-1 px-2 text-xs"
                      />
                    ) : (
                      <span className="text-xs text-muted-foreground font-medium truncate">
                        {group.category}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground font-body ml-auto shrink-0">
                      {group.notes.length}
                    </span>
                  </div>

                  <div className={`category-body ${isCollapsed ? "" : "expanded"}`}>
                    <div
                      className="category-body-inner space-y-0.5 pb-1 pt-1"
                      onDragOver={(e) => {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = "move";
                        setDragOverCategory(group.category);
                      }}
                      onDragLeave={(e) => {
                        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
                          setDragOverCategory(null);
                        }
                      }}
                      onDrop={(e) => {
                        e.preventDefault();
                        setDragOverCategory(null);
                        const noteId = e.dataTransfer.getData("text/plain");
                        if (noteId) void handleMoveNote(noteId, group.category);
                      }}
                    >
                      {group.notes.length === 0 ? (
                        <div className="px-3 py-3 text-center text-xs text-muted-foreground">
                          {t("main.category.emptyFolder", { defaultValue: "空文件夹" })}
                        </div>
                      ) : (
                        group.notes.map((note) => {
                          const isSelected = note.id === selectedId;
                          const isHovered = note.id === hoveredId;

                          return (
                            <div
                              key={note.id}
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData("text/plain", note.id);
                                e.dataTransfer.effectAllowed = "move";
                              }}
                              onClick={() => void handleSelectNote(note.id)}
                              data-note-id={note.id}
                              onContextMenu={(event) => handleOpenNoteMenu(event, note.id)}
                              onMouseEnter={() => setHoveredId(note.id)}
                              onMouseLeave={() => setHoveredId(null)}
                              className={`w-full text-left rounded-lg mx-1 px-2.5 py-2 cursor-pointer group relative ${
                                isSelected ? "bg-accent" : isHovered ? "bg-muted" : "bg-transparent"
                              }`}
                              style={{ width: "calc(100% - 8px)" }}
                            >
                              <div className="mb-1 flex min-w-0 items-center justify-between gap-2">
                                <span
                                  className={`text-sm min-w-0 font-medium truncate ${
                                    isSelected ? "text-accent-foreground" : "text-foreground"
                                  }`}
                                >
                                  {getDisplayTitle(note, t)}
                                </span>
                                <span className="text-xs text-muted-foreground tabular-nums shrink-0">
                                  {formatShortDate(note.updatedAt)}
                                </span>
                              </div>

                              <p className="text-xs text-muted-foreground leading-relaxed line-clamp-2 ">
                                {note.preview ||
                                  t("common.blankNote", { defaultValue: "空白便签" })}
                              </p>

                              <div className="mt-1">
                                <NoteStateBadges
                                  state={stateFor(note.id)}
                                  onTogglePin={() => void toggleNotePin(note.id)}
                                />
                                {noteReminderMap.get(note.id) && (
                                  <ReminderBadge item={noteReminderMap.get(note.id)!.item} />
                                )}
                              </div>
                              <div className="flex items-center gap-2 mt-1">
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {formatTime(note.updatedAt)}
                                </span>
                                <span className="text-xs text-muted-foreground">·</span>
                                <span className="text-xs text-muted-foreground tabular-nums">
                                  {t("common.wordCount", {
                                    count: note.wordCount,
                                    defaultValue: "{{count}} 字",
                                  })}
                                </span>
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {!isLoading && filteredNotes.length === 0 && externalFiles.length === 0 && (
              <div className="px-3 py-8 text-center text-sm text-muted-foreground leading-relaxed">
                {searchQuery
                  ? t("main.search.noResults", { defaultValue: "没有匹配的便签" })
                  : t("main.search.empty", { defaultValue: "还没有便签" })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
});

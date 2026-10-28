import { memo } from "react";
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
      className="border-r border-paper-deep/30 bg-paper/40 shrink-0 overflow-hidden transition-[width] duration-[600ms]"
      style={{ width: sidebarCollapsed ? 0 : sidebarWidth }}
    >
      <div className="flex flex-col h-full" style={{ width: `${sidebarWidth}px` }}>
        <div className="px-3 pt-3 pb-2 shrink-0">
          <div className="flex items-center gap-2 px-2.5 h-8 rounded-lg bg-paper-warm/80 border border-paper-deep/40 focus-within:border-bamboo/30 focus-within:bg-cloud transition-all">
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="text-ink-ghost shrink-0"
            >
              <circle cx="11" cy="11" r="8" />
              <path d="m21 21-4.35-4.35" />
            </svg>
            <input
              type="text"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              placeholder={t("main.sidebar.searchPlaceholder", { defaultValue: "搜索便签…" })}
              className="flex-1 text-[12px] font-body text-ink placeholder:text-ink-ghost/60 bg-transparent"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="text-ink-ghost hover:text-ink-faint transition-colors cursor-pointer"
                title={t("main.sidebar.clearSearch", { defaultValue: "清空搜索" })}
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
        </div>

        <div className="px-3 pb-2 shrink-0 space-y-1">
          <button
            onClick={handleNewNote}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-bamboo hover:bg-bamboo-mist/60 transition-all cursor-pointer group"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              className="group-hover:rotate-90 transition-transform duration-200"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
            <span>{t("main.sidebar.newNote", { defaultValue: "新建便签" })}</span>
          </button>
          <button
            onClick={() => void handleImportNote()}
            className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg text-[12px] font-body text-ink-faint hover:text-bamboo hover:bg-bamboo-mist/50 transition-all cursor-pointer group"
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 3v12" />
              <path d="m7 10 5 5 5-5" />
              <path d="M5 21h14" />
            </svg>
            <span>{t("main.sidebar.importMarkdown", { defaultValue: "导入 Markdown" })}</span>
          </button>
        </div>

        <div className="flex items-center justify-between px-5 pb-1.5 shrink-0">
          <span className="text-[10px] text-ink-ghost font-mono tracking-wider uppercase">
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
          <button
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              if (showCategoryInput && categoryInputValue.trim()) {
                void handleCreateCategory();
                return;
              }
              setShowCategoryInput(true);
            }}
            className="text-[10px] text-ink-ghost hover:text-bamboo transition-colors cursor-pointer"
            title={t("main.category.new", { defaultValue: "新建分类" })}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
            >
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>

        {showCategoryInput && (
          <div className="px-3 pb-2 shrink-0">
            <input
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
              className="w-full px-2.5 h-7 rounded-lg text-[12px] font-body text-ink bg-paper-warm/80 border border-paper-deep/40 focus:border-bamboo/30 placeholder:text-ink-ghost/60"
            />
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 pb-2">
          <div className="space-y-0.5">
            {externalFiles.length > 0 && (
              <>
                <div className="px-3 py-1.5 text-[10px] text-ink-ghost/50 font-mono tracking-wider uppercase">
                  {t("main.externalFiles.title", { defaultValue: "外部文件" })}
                </div>
                {externalFiles.map((file) => {
                  const isSelected = file.id === selectedId;
                  const isHovered = file.id === hoveredId;

                  return (
                    <button
                      key={file.id}
                      onClick={() => void handleSelectExternalFile(file.id)}
                      onMouseEnter={() => setHoveredId(file.id)}
                      onMouseLeave={() => setHoveredId(null)}
                      className={`w-full text-left rounded-xl px-3 py-2.5 transition-all duration-[600ms] cursor-pointer group relative ${
                        isSelected
                          ? "bg-bamboo-mist/70"
                          : isHovered
                            ? "bg-paper-warm/70"
                            : "bg-transparent"
                      }`}
                    >
                      <div
                        className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                          isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                        }`}
                      />

                      <div className="flex items-baseline justify-between mb-0.5">
                        <span
                          className={`text-[13px] font-display font-medium truncate pr-2 transition-colors flex items-center gap-1.5 ${
                            isSelected ? "text-bamboo" : "text-ink-soft"
                          }`}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                            className="shrink-0 opacity-60"
                          >
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                            <polyline points="14 2 14 8 20 8" />
                          </svg>
                          {file.title}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            handleRemoveExternalFile(file.id);
                          }}
                          className="opacity-0 group-hover:opacity-100 text-ink-ghost hover:text-red-400 transition-all p-0.5"
                          title={t("main.externalFiles.remove", {
                            defaultValue: "从列表移除",
                          })}
                        >
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            strokeLinecap="round"
                          >
                            <line x1="18" y1="6" x2="6" y2="18" />
                            <line x1="6" y1="6" x2="18" y2="18" />
                          </svg>
                        </button>
                      </div>

                      <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors pl-[18px]">
                        {file.filePath}
                      </p>
                    </button>
                  );
                })}
              </>
            )}

            {categoryGroups.map((group: CategoryGroup) => {
              if (!group.category) {
                return (
                  <div
                    key="__uncategorized__"
                    className={`rounded-lg transition-all duration-200 ${
                      dragOverCategory === "" ? "bg-bamboo/10 ring-1 ring-bamboo/20" : ""
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
                          className={`w-full text-left rounded-xl px-3 py-2.5 transition-all duration-[600ms] cursor-pointer group relative ${
                            isSelected
                              ? "bg-bamboo-mist/70"
                              : isHovered
                                ? "bg-paper-warm/70"
                                : "bg-transparent"
                          }`}
                        >
                          <div
                            className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                              isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                            }`}
                          />
                          <div className="flex items-baseline justify-between mb-0.5">
                            <span
                              className={`text-[13px] font-display font-medium truncate pr-2 transition-colors ${
                                isSelected ? "text-bamboo" : "text-ink-soft"
                              }`}
                            >
                              {getDisplayTitle(note, t)}
                            </span>
                            <span className="text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">
                              {formatShortDate(note.updatedAt)}
                            </span>
                          </div>
                          <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors">
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
                            <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                              {formatTime(note.updatedAt)}
                            </span>
                            <span className="text-[10px] text-ink-ghost/40">·</span>
                            <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
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
                <div key={group.category} className="px-2 mb-0.5">
                  <div
                    className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg group/cat cursor-pointer select-none transition-all duration-200 ${
                      dragOverCategory === group.category
                        ? "bg-bamboo/15 border border-bamboo/40 ring-1 ring-bamboo/20"
                        : isCollapsed
                          ? "bg-transparent border border-bamboo/15"
                          : "bg-bamboo/8 border border-bamboo/15 rounded-b-none"
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
                    <svg
                      width="10"
                      height="10"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className={`text-bamboo/50 shrink-0 transition-transform duration-200 ${isCollapsed ? "" : "rotate-90"}`}
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      className="text-bamboo/50 shrink-0"
                    >
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    {renamingCategory === group.category ? (
                      <input
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
                        className="flex-1 min-w-0 px-1 text-[10px] font-mono text-ink bg-paper-warm/80 border border-bamboo/30 rounded"
                      />
                    ) : (
                      <span className="text-[11px] text-bamboo/70 font-medium truncate">
                        {group.category}
                      </span>
                    )}
                    <span className="text-[9px] text-bamboo/40 font-mono ml-auto shrink-0">
                      {group.notes.length}
                    </span>
                  </div>

                  <div className={`category-body ${isCollapsed ? "" : "expanded"}`}>
                    <div
                      className="category-body-inner bg-bamboo/[0.03] border border-t-0 border-bamboo/10 rounded-b-lg pb-1 pt-1"
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
                        <div className="px-3 py-3 text-center text-[11px] text-ink-ghost/50">
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
                              className={`w-full text-left rounded-lg mx-1 px-2.5 py-2 transition-all duration-[600ms] cursor-pointer group relative ${
                                isSelected
                                  ? "bg-bamboo-mist/70"
                                  : isHovered
                                    ? "bg-paper-warm/70"
                                    : "bg-transparent"
                              }`}
                              style={{ width: "calc(100% - 8px)" }}
                            >
                              <div
                                className={`absolute left-0 top-1/2 -translate-y-1/2 w-[3px] rounded-r-full bg-bamboo/60 transition-all duration-[600ms] ${
                                  isSelected ? "h-5 opacity-100" : "h-0 opacity-0"
                                }`}
                              />

                              <div className="flex items-baseline justify-between mb-0.5">
                                <span
                                  className={`text-[13px] font-display font-medium truncate pr-2 transition-colors ${
                                    isSelected ? "text-bamboo" : "text-ink-soft"
                                  }`}
                                >
                                  {getDisplayTitle(note, t)}
                                </span>
                                <span className="text-[10px] text-ink-ghost font-mono tabular-nums shrink-0">
                                  {formatShortDate(note.updatedAt)}
                                </span>
                              </div>

                              <p className="text-[11px] text-ink-ghost leading-relaxed line-clamp-2 group-hover:text-ink-faint transition-colors">
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
                                <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
                                  {formatTime(note.updatedAt)}
                                </span>
                                <span className="text-[10px] text-ink-ghost/40">·</span>
                                <span className="text-[10px] text-ink-ghost/60 font-mono tabular-nums">
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
              <div className="px-3 py-8 text-center text-[12px] text-ink-ghost leading-relaxed">
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

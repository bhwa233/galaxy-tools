import { memo } from "react";
import { SlidingButtonGroup } from "../../components/SlidingButtonGroup";
import { showToast } from "../../components/Toast";
import { MarkdownPreviewLazy as MarkdownPreview } from "../markdown/MarkdownPreviewLazy";
import { NoteReminderButton } from "../reminders/NoteReminderButton";
import { showNoteOnDesktop } from "../windows/api";
import { getErrorMessage } from "./api";
import { applyFormat } from "./notePresentation";
import { formatShortDate, formatTime } from "./noteUtils";
import { NOTE_TITLE_MAX_LENGTH } from "./types";
import type { NoteSession } from "./useNoteSession";
type Props = Pick<
  NoteSession,
  | "setSidebarCollapsed"
  | "sidebarCollapsed"
  | "t"
  | "selectedId"
  | "toggleNotePin"
  | "isExternal"
  | "pinTitle"
  | "selectedNotePinned"
  | "saveCurrentNote"
  | "handleUndo"
  | "handleRedo"
  | "saveState"
  | "deleteConfirm"
  | "deleteExiting"
  | "setDeleteExiting"
  | "setDeleteConfirm"
  | "handleDeleteNote"
  | "viewModeOptions"
  | "viewMode"
  | "setViewMode"
  | "noteTransitionKey"
  | "title"
  | "titleValueRef"
  | "setTitle"
  | "markDirty"
  | "contentRef"
  | "selectedExternalFile"
  | "selectedNote"
  | "charCount"
  | "saveStateLabel"
  | "splitContainerRef"
  | "isLoading"
  | "splitRatio"
  | "toolbarButtons"
  | "setDraftContent"
  | "content"
  | "contentValueRef"
  | "setContent"
  | "imagePasteHandler"
  | "imageDropHandler"
  | "imageDragOverHandler"
  | "handleEditorScroll"
  | "settingsConfig"
  | "isResizingSplit"
  | "setIsResizingSplit"
  | "previewScrollRef"
  | "handlePreviewScroll"
  | "deferredContent"
  | "handlePreviewContentChange"
  | "imageBaseDir"
  | "lineCount"
  | "handleCleanUnusedImages"
  | "byteSize"
>;
export const EditorPane = memo(function EditorPane({
  setSidebarCollapsed,
  sidebarCollapsed,
  t,
  selectedId,
  toggleNotePin,
  isExternal,
  pinTitle,
  selectedNotePinned,
  saveCurrentNote,
  handleUndo,
  handleRedo,
  saveState,
  deleteConfirm,
  deleteExiting,
  setDeleteExiting,
  setDeleteConfirm,
  handleDeleteNote,
  viewModeOptions,
  viewMode,
  setViewMode,
  noteTransitionKey,
  title,
  titleValueRef,
  setTitle,
  markDirty,
  contentRef,
  selectedExternalFile,
  selectedNote,
  charCount,
  saveStateLabel,
  splitContainerRef,
  isLoading,
  splitRatio,
  toolbarButtons,
  setDraftContent,
  content,
  contentValueRef,
  setContent,
  imagePasteHandler,
  imageDropHandler,
  imageDragOverHandler,
  handleEditorScroll,
  settingsConfig,
  isResizingSplit,
  setIsResizingSplit,
  previewScrollRef,
  handlePreviewScroll,
  deferredContent,
  handlePreviewContentChange,
  imageBaseDir,
  lineCount,
  handleCleanUnusedImages,
  byteSize,
}: Props) {
  return (
    <div className="flex-1 flex flex-col min-w-0">
      <div className="flex items-center justify-between px-4 h-10 border-b border-paper-deep/20 shrink-0 bg-paper/20">
        <div className="flex items-center gap-1">
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer"
            title={
              sidebarCollapsed
                ? t("main.window.expandSidebar", { defaultValue: "展开侧栏" })
                : t("main.window.collapseSidebar", { defaultValue: "收起侧栏" })
            }
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>

          <div className="h-4 w-px bg-paper-deep/30 mx-1" />

          <button
            onClick={() => {
              if (selectedId) void toggleNotePin(selectedId);
            }}
            disabled={!selectedId || isExternal}
            aria-label={pinTitle}
            aria-pressed={selectedNotePinned}
            data-note-pin-toolbar="true"
            className={`w-7 h-7 flex items-center justify-center rounded-lg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed ${
              selectedNotePinned
                ? "text-bamboo bg-bamboo-mist/40 hover:text-red-400 hover:bg-danger-bg"
                : "text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50"
            }`}
            title={pinTitle}
          >
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1 1 1 0 0 1 1 1z" />
            </svg>
          </button>

          <button
            type="button"
            disabled={!selectedId || isExternal}
            data-show-desktop-toolbar="true"
            title={t("noteMenu.showOnDesktop")}
            aria-label={t("noteMenu.showOnDesktop")}
            onClick={() => {
              if (!selectedId) return;
              void (async () => {
                try {
                  if (await saveCurrentNote()) await showNoteOnDesktop(selectedId);
                } catch (error) {
                  showToast(getErrorMessage(error));
                }
              })();
            }}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-bamboo hover:bg-bamboo-mist/50 cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              aria-hidden="true"
            >
              <rect x="3" y="4" width="18" height="13" rx="2" />
              <path d="M8 21h8m-4-4v4" />
            </svg>
          </button>

          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleUndo}
            disabled={!selectedId}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title={t("main.editor.undo", { defaultValue: "撤销（Ctrl+Z）" })}
            aria-label={t("main.editor.undoLabel", { defaultValue: "撤销" })}
          >
            <svg
              data-testid="main-editor-undo-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
            </svg>
          </button>

          <button
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleRedo}
            disabled={!selectedId}
            className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title={t("main.editor.redo", { defaultValue: "重做（Ctrl+Y）" })}
            aria-label={t("main.editor.redoLabel", { defaultValue: "重做" })}
          >
            <svg
              data-testid="main-editor-redo-icon"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              style={{ transform: "scaleX(-1)" }}
            >
              <path d="M9 14 4 9l5-5" />
              <path d="M4 9h10a6 6 0 0 1 0 12h-1" />
            </svg>
          </button>

          <button
            onClick={() => void saveCurrentNote(true)}
            disabled={!selectedId || saveState === "saving"}
            className="px-2.5 h-7 flex items-center justify-center rounded-lg text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            title={t("common.save", { defaultValue: "保存" })}
          >
            {t("common.save", { defaultValue: "保存" })}
          </button>

          {deleteConfirm ? (
            <div
              className={`flex items-center gap-1 ml-1 ${deleteExiting ? "animate-delete-confirm-exit" : "animate-delete-confirm"}`}
            >
              <span className="text-[11px] text-red-400 whitespace-nowrap">
                {t("main.editor.confirmDelete", { defaultValue: "确认删除？" })}
              </span>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setDeleteExiting(true);
                  setTimeout(() => {
                    setDeleteExiting(false);
                    setDeleteConfirm(false);
                    void handleDeleteNote();
                  }, 150);
                }}
                className="px-2 h-6 rounded-md text-[11px] text-cloud bg-red-400 hover:bg-red-500 transition-colors cursor-pointer whitespace-nowrap outline-none"
              >
                {t("common.delete", { defaultValue: "删除" })}
              </button>
              <button
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setDeleteExiting(true);
                  setTimeout(() => {
                    setDeleteExiting(false);
                    setDeleteConfirm(false);
                  }, 150);
                }}
                className="px-2 h-6 rounded-md text-[11px] text-ink-faint hover:text-ink-soft hover:bg-paper-warm transition-colors cursor-pointer outline-none"
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </button>
            </div>
          ) : (
            <button
              onClick={() => setDeleteConfirm(true)}
              disabled={!selectedId}
              className="w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:text-red-400 hover:bg-danger-bg transition-all cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
              title={t("noteMenu.delete", { defaultValue: "删除便签" })}
            >
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="3,6 5,6 21,6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <NoteReminderButton
            noteId={selectedId}
            disabled={!selectedId || isExternal}
            onError={showToast}
          />
          <SlidingButtonGroup
            options={viewModeOptions}
            value={viewMode}
            onChange={setViewMode}
            buttonClassName="px-3 py-1"
          />
        </div>
      </div>

      <div
        key={noteTransitionKey}
        className="animate-note-enter px-6 pt-4 pb-2 shrink-0 border-b border-paper-deep/15"
      >
        <input
          type="text"
          maxLength={isExternal ? undefined : NOTE_TITLE_MAX_LENGTH}
          value={title}
          onChange={(event) => {
            titleValueRef.current = event.target.value;
            setTitle(event.target.value);
            markDirty();
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              contentRef.current?.focus();
            }
          }}
          placeholder={t("common.untitledNote", { defaultValue: "无标题便签" })}
          disabled={!selectedId}
          className="w-full text-[20px] font-display font-bold text-ink placeholder:text-ink-ghost/50 tracking-wide disabled:opacity-60"
        />
        <div className="flex items-center gap-3 mt-1.5">
          <span className="text-[10px] text-ink-ghost font-mono tabular-nums truncate max-w-[200px]">
            {selectedExternalFile
              ? t("main.externalFile.label", {
                  path: selectedExternalFile.filePath,
                  defaultValue: "外部文件 · {{path}}",
                })
              : selectedNote
                ? `${formatShortDate(selectedNote.updatedAt)} ${formatTime(selectedNote.updatedAt)}`
                : "--"}
          </span>
          <span className="text-[10px] text-ink-ghost/40">·</span>
          <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
            {t("common.wordCount", { count: charCount, defaultValue: "{{count}} 字" })}
          </span>
          <span className="text-[10px] text-ink-ghost/40">·</span>
          <span
            key={saveState}
            className={`text-[10px] font-mono tabular-nums animate-status-fade ${
              saveState === "error"
                ? "text-red-400"
                : saveState === "dirty"
                  ? "text-amber-500/70"
                  : "text-bamboo/60"
            }`}
          >
            {saveStateLabel[saveState]}
          </span>
        </div>
      </div>

      <div key={viewMode} ref={splitContainerRef} className="flex-1 flex min-h-0 animate-view-fade">
        {!selectedId && !isLoading ? (
          <div className="flex-1 flex items-center justify-center text-[13px] text-ink-ghost">
            {t("main.editor.emptyHint", { defaultValue: "选择或新建一张便签" })}
          </div>
        ) : (
          <>
            {(viewMode === "edit" || viewMode === "split") && (
              <div
                className="flex flex-col min-h-0 shrink-0"
                style={{ width: viewMode === "split" ? `${splitRatio * 100}%` : "100%" }}
              >
                <div className="flex items-center gap-0.5 px-4 pt-2 pb-1 shrink-0">
                  {toolbarButtons.map((button) => (
                    <button
                      key={button.label}
                      title={button.title}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        if (contentRef.current) {
                          applyFormat(
                            contentRef.current,
                            button.action,
                            t,
                            setDraftContent,
                            markDirty,
                          );
                        }
                      }}
                      className={`w-6 h-6 flex items-center justify-center rounded text-[11px] text-ink-ghost hover:text-ink-faint hover:bg-paper-warm transition-all cursor-pointer ${button.style}`}
                    >
                      {button.label}
                    </button>
                  ))}
                </div>

                <div className="flex-1 overflow-hidden px-5 pb-4">
                  <textarea
                    ref={contentRef}
                    data-tab-indent="true"
                    value={content}
                    onChange={(event) => {
                      contentValueRef.current = event.target.value;
                      setContent(event.target.value);
                      markDirty();
                    }}
                    onPaste={imagePasteHandler}
                    onDrop={imageDropHandler}
                    onDragOver={imageDragOverHandler}
                    onScroll={handleEditorScroll}
                    className="w-full h-full leading-[1.9] text-ink-soft font-body placeholder:text-ink-ghost/40"
                    style={{
                      fontSize: `${settingsConfig?.fontSize ?? 14}px`,
                      tabSize: `var(--tab-indent-size, 2)`,
                    }}
                    placeholder={t("main.editor.contentPlaceholder", {
                      defaultValue: "开始写作……",
                    })}
                    spellCheck={false}
                    disabled={!selectedId}
                  />
                </div>
              </div>
            )}

            {viewMode === "split" && (
              <div
                className={`w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center ${isResizingSplit ? "bg-bamboo/30" : "hover:bg-bamboo/20"} transition-colors`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsResizingSplit(true);
                }}
              >
                <div
                  className={`absolute inset-y-0 -left-1.5 -right-1.5 ${isResizingSplit ? "" : "group-hover:bg-bamboo/5"}`}
                />
                {/* 拖拽手柄指示器 */}
                <div className="relative z-10 flex flex-col gap-[3px] opacity-0 group-hover:opacity-100 transition-opacity">
                  <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                  <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                  <div className="w-[3px] h-[3px] rounded-full bg-ink-ghost/60" />
                </div>
              </div>
            )}

            {viewMode === "split" && (
              <div className="flex flex-col min-h-0 min-w-0 flex-1">
                {viewMode === "split" && (
                  <div className="px-4 pt-2.5 pb-1 shrink-0">
                    <span className="text-[10px] text-ink-ghost/60 font-mono tracking-widest uppercase">
                      {t("main.editor.previewLabel", { defaultValue: "Preview" })}
                    </span>
                  </div>
                )}
                <div
                  ref={previewScrollRef}
                  onScroll={handlePreviewScroll}
                  className="flex-1 overflow-y-auto px-6 pb-6 pt-1"
                >
                  <MarkdownPreview
                    content={deferredContent}
                    onContentChange={selectedId ? handlePreviewContentChange : undefined}
                    fontSize={settingsConfig?.fontSize ?? 14}
                    renderHtml={settingsConfig?.renderHtmlMarkdown ?? false}
                    imageBaseDir={imageBaseDir ?? undefined}
                    imageDisplay={settingsConfig?.imageDisplay ?? "show"}
                  />
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <div className="flex items-center justify-between px-4 h-7 border-t border-paper-deep/20 bg-paper/30 shrink-0">
        <div className="flex items-center gap-3">
          <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
            {t("main.statusBar.lineNumber", {
              count: lineCount,
              defaultValue: "Ln {{count}}",
            })}
          </span>
          <span className="text-[10px] text-ink-ghost/40">|</span>
          <span className="text-[10px] text-ink-ghost font-mono">
            {t("main.statusBar.format", { defaultValue: "Markdown + LaTeX" })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {selectedId && !isExternal && content.includes("images/") && (
            <>
              <button
                type="button"
                onClick={() => void handleCleanUnusedImages()}
                className="text-[10px] text-ink-ghost hover:text-bamboo font-mono cursor-pointer transition-colors"
              >
                {t("main.images.cleanUnused", { defaultValue: "清理未使用图片" })}
              </button>
              <span className="text-[10px] text-ink-ghost/40">|</span>
            </>
          )}
          <span className="text-[10px] text-ink-ghost font-mono">
            {t("main.statusBar.encoding", { defaultValue: "UTF-8" })}
          </span>
          <span className="text-[10px] text-ink-ghost/40">|</span>
          <span className="text-[10px] text-ink-ghost font-mono tabular-nums">
            {t("main.statusBar.byteSize", { size: byteSize, defaultValue: "{{size}} KB" })}
          </span>
        </div>
      </div>
    </div>
  );
});

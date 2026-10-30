import { Monitor, PanelLeft, Pin, Redo2, Trash2, Undo2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { memo } from "react";
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
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background">
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b bg-background px-4 py-2">
        <div className="flex flex-wrap items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="size-7 p-0 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer"
            title={
              sidebarCollapsed
                ? t("main.window.expandSidebar", { defaultValue: "展开侧栏" })
                : t("main.window.collapseSidebar", { defaultValue: "收起侧栏" })
            }
          >
            <PanelLeft />
          </Button>

          <div className="h-4 w-px bg-paper-deep/30 mx-1" />

          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              if (selectedId) void toggleNotePin(selectedId);
            }}
            disabled={!selectedId || isExternal}
            aria-label={pinTitle}
            aria-pressed={selectedNotePinned}
            data-note-pin-toolbar="true"
            className={`size-7 p-0 flex items-center justify-center rounded-lg transition-colors cursor-pointer disabled:opacity-50 ${
              selectedNotePinned
                ? "text-accent-foreground bg-accent hover:bg-accent"
                : "text-muted-foreground hover:text-primary hover:bg-accent"
            }`}
            title={pinTitle}
          >
            <Pin className={selectedNotePinned ? "fill-current" : undefined} />
          </Button>

          <Button
            variant="ghost"
            size="sm"
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
            className="size-7 p-0 flex items-center justify-center rounded-lg text-muted-foreground hover:text-primary hover:bg-accent cursor-pointer disabled:opacity-50"
          >
            <Monitor aria-hidden="true" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleUndo}
            disabled={!selectedId}
            className="size-7 p-0 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50"
            title={t("main.editor.undo", { defaultValue: "撤销（Ctrl+Z）" })}
            aria-label={t("main.editor.undoLabel", { defaultValue: "撤销" })}
          >
            <Undo2 data-testid="main-editor-undo-icon" aria-hidden="true" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onMouseDown={(event) => event.preventDefault()}
            onClick={handleRedo}
            disabled={!selectedId}
            className="size-7 p-0 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50"
            title={t("main.editor.redo", { defaultValue: "重做（Ctrl+Y）" })}
            aria-label={t("main.editor.redoLabel", { defaultValue: "重做" })}
          >
            <Redo2 data-testid="main-editor-redo-icon" aria-hidden="true" />
          </Button>

          <Button
            variant="ghost"
            size="sm"
            onClick={() => void saveCurrentNote(true)}
            disabled={!selectedId || saveState === "saving"}
            className="px-2.5 h-7 flex items-center justify-center rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer disabled:opacity-50"
            title={t("common.save", { defaultValue: "保存" })}
          >
            {t("common.save", { defaultValue: "保存" })}
          </Button>

          {deleteConfirm ? (
            <div
              className={`flex items-center gap-1 ml-1 ${deleteExiting ? "animate-delete-confirm-exit" : "animate-delete-confirm"}`}
            >
              <span className="text-xs text-destructive whitespace-nowrap">
                {t("main.editor.confirmDelete", { defaultValue: "确认删除？" })}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setDeleteExiting(true);
                  setTimeout(() => {
                    setDeleteExiting(false);
                    setDeleteConfirm(false);
                    void handleDeleteNote();
                  }, 150);
                }}
                className="px-2 h-6 rounded-md text-xs text-destructive bg-destructive/10 hover:bg-destructive/20 transition-colors cursor-pointer whitespace-nowrap outline-none"
              >
                {t("common.delete", { defaultValue: "删除" })}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setDeleteExiting(true);
                  setTimeout(() => {
                    setDeleteExiting(false);
                    setDeleteConfirm(false);
                  }, 150);
                }}
                className="px-2 h-6 rounded-md text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer outline-none"
              >
                {t("common.cancel", { defaultValue: "取消" })}
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteConfirm(true)}
              disabled={!selectedId}
              className="size-7 p-0 flex items-center justify-center rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors cursor-pointer disabled:opacity-50"
              title={t("noteMenu.delete", { defaultValue: "删除便签" })}
            >
              <Trash2 />
            </Button>
          )}
        </div>

        <div className="flex items-center gap-2">
          <NoteReminderButton
            noteId={selectedId}
            disabled={!selectedId || isExternal}
            onError={showToast}
            className="text-muted-foreground! aria-pressed:bg-accent! aria-pressed:text-accent-foreground!"
          />
          <div
            role="group"
            aria-label={t("main.editor.viewMode")}
            className="flex items-center gap-1"
          >
            {viewModeOptions.map((option) => (
              <Button
                key={option.value}
                size="sm"
                variant={viewMode === option.value ? "secondary" : "ghost"}
                aria-pressed={viewMode === option.value}
                onClick={() => setViewMode(option.value)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        </div>
      </div>

      <div key={noteTransitionKey} className="shrink-0 border-b px-5 py-4">
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
          className="w-full bg-transparent text-xl font-semibold text-foreground placeholder:text-muted-foreground tracking-wide disabled:opacity-60"
        />
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <span className="text-xs text-muted-foreground font-body tabular-nums truncate max-w-[200px]">
            {selectedExternalFile
              ? t("main.externalFile.label", {
                  path: selectedExternalFile.filePath,
                  defaultValue: "外部文件 · {{path}}",
                })
              : selectedNote
                ? `${formatShortDate(selectedNote.updatedAt)} ${formatTime(selectedNote.updatedAt)}`
                : "--"}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground font-body tabular-nums">
            {t("common.wordCount", { count: charCount, defaultValue: "{{count}} 字" })}
          </span>
          <span className="text-xs text-muted-foreground">·</span>
          <span
            key={saveState}
            className={`text-xs font-body tabular-nums ${
              saveState === "error"
                ? "text-destructive"
                : saveState === "dirty"
                  ? "text-muted-foreground"
                  : "text-primary"
            }`}
          >
            {saveStateLabel[saveState]}
          </span>
        </div>
      </div>

      <div key={viewMode} ref={splitContainerRef} className="flex-1 flex min-h-0">
        {!selectedId && !isLoading ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
            {t("main.editor.emptyHint", { defaultValue: "选择或新建一张便签" })}
          </div>
        ) : (
          <>
            {(viewMode === "edit" || viewMode === "split") && (
              <div
                className="flex flex-col min-h-0 shrink-0"
                style={{ width: viewMode === "split" ? `${splitRatio * 100}%` : "100%" }}
              >
                <div className="flex shrink-0 flex-wrap items-center gap-0.5 px-4 py-2">
                  {toolbarButtons.map((button) => (
                    <Button
                      variant="ghost"
                      size="sm"
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
                      className={`size-7 p-0 flex items-center justify-center rounded text-xs text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer ${button.style}`}
                    >
                      {button.label}
                    </Button>
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
                    className="w-full h-full leading-[1.9] text-foreground font-body placeholder:text-muted-foreground"
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
                className={`w-1.5 shrink-0 cursor-col-resize group relative flex items-center justify-center ${isResizingSplit ? "bg-primary/30" : "hover:bg-primary/20"} transition-colors`}
                onMouseDown={(e) => {
                  e.preventDefault();
                  setIsResizingSplit(true);
                }}
              >
                <div
                  className={`absolute inset-y-0 -left-1.5 -right-1.5 ${isResizingSplit ? "" : "group-hover:bg-primary/5"}`}
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
                  <div className="shrink-0 px-5 py-2">
                    <span className="text-xs text-muted-foreground font-body ">
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

      <div className="flex min-h-8 shrink-0 flex-wrap items-center justify-between gap-2 border-t bg-muted/20 px-4 py-1 text-muted-foreground">
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground font-body tabular-nums">
            {t("main.statusBar.lineNumber", {
              count: lineCount,
              defaultValue: "Ln {{count}}",
            })}
          </span>
          <span className="text-xs text-muted-foreground">|</span>
          <span className="text-xs text-muted-foreground font-body">
            {t("main.statusBar.format", { defaultValue: "Markdown + LaTeX" })}
          </span>
        </div>
        <div className="flex items-center gap-3">
          {selectedId && !isExternal && content.includes("images/") && (
            <>
              <Button
                variant="ghost"
                size="sm"
                type="button"
                onClick={() => void handleCleanUnusedImages()}
                className="text-xs text-muted-foreground hover:text-primary font-body cursor-pointer transition-colors"
              >
                {t("main.images.cleanUnused", { defaultValue: "清理未使用图片" })}
              </Button>
              <span className="text-xs text-muted-foreground">|</span>
            </>
          )}
          <span className="text-xs text-muted-foreground font-body">
            {t("main.statusBar.encoding", { defaultValue: "UTF-8" })}
          </span>
          <span className="text-xs text-muted-foreground">|</span>
          <span className="text-xs text-muted-foreground font-body tabular-nums">
            {t("main.statusBar.byteSize", { size: byteSize, defaultValue: "{{size}} KB" })}
          </span>
        </div>
      </div>
    </div>
  );
});

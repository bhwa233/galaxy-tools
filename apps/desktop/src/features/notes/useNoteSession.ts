import type { MouseEvent } from "react";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { showToast } from "../../components/Toast";
import { getCurrentWindow, listen } from "../../platform/desktop";
import { cleanUnusedImages, saveImageFromPath } from "../images/api";
import { useImageBaseDir } from "../images/useImageBaseDir";
import { insertTextAtCursor, useImagePaste } from "../images/useImagePaste";
import { exportMarkdownNote, importMarkdownNote } from "../importExport/api";
import { useReminders } from "../reminders/useReminders";
import { getConfig, normalizeViewMode, openSettingsWindow } from "../settings/api";
import type { AppConfig, ViewMode } from "../settings/types";
import { dismissAboutUpdateReminderText } from "../update/presentation";
import {
  hideNoteOnDesktop,
  openNotepadWindow,
  setNotePinned,
  showNoteOnDesktop,
  takeStartupFile,
} from "../windows/api";
import {
  closeCurrentWindow,
  isCurrentWindowMaximized,
  minimizeCurrentWindow,
  startCurrentWindowDrag,
  toggleMaximizeCurrentWindow,
} from "../windows/controls";
import type { NoteWindowState } from "../windows/noteWindowState";
import { useNoteWindowStates } from "../windows/useNoteWindowStates";
import {
  createCategory,
  createNote,
  deleteCategory,
  deleteNote,
  getErrorMessage,
  getFileModifiedTime,
  getNote,
  listCategories,
  listNotes,
  moveNoteCategory,
  readExternalFile,
  renameCategory,
  saveExternalFile,
  updateNote,
} from "./api";
import { getNoteContextMenuItems, type NoteContextMenuAction } from "./noteContextMenu";
import {
  FormatAction,
  SaveState,
  SidePanelMode,
  runEditorCommand,
  useLoadEpoch,
} from "./notePresentation";
import { countNoteChars, filterNotes, groupNotesByCategory, metadataFromNote } from "./noteUtils";
import type { ExternalFile, Note, NoteMetadata } from "./types";
import { useExternalFileWatcher } from "./useExternalFileWatcher";
import { useNoteClosePreparation, useNoteDocument } from "./useNoteDocument";
import { useNoteMenus } from "./useNoteMenus";
import { useSplitScrollSync } from "./useSplitScrollSync";
import { useUpdateReminder } from "./useUpdateReminder";

/** Owns document transitions and editor state; views receive typed, scoped props. */
export function useNoteSession({
  initialConfig = undefined,
}: import("./notePresentation").MainWindowProps = {}) {
  const { t } = useTranslation();
  const [historyNoteId, setHistoryNoteId] = useState<string>();
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [externalFiles, setExternalFiles] = useState<ExternalFile[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState("");
  const [viewMode, setViewMode] = useState<ViewMode>(
    normalizeViewMode(initialConfig?.defaultViewMode ?? "edit"),
  );
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [content, setContent] = useState("");
  const [title, setTitle] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const pendingTaskAnchorRef = useRef<string | null>(null);
  const [aboutOpen, setAboutOpen] = useState(false);
  const [mountedSidePanel, setMountedSidePanel] = useState<SidePanelMode | null>(null);
  const [sidePanelContentVisible, setSidePanelContentVisible] = useState(false);
  const { aboutUpdateReminder, setAboutUpdateReminder } = useUpdateReminder();
  const [settingsConfig, setSettingsConfig] = useState<AppConfig | null>(initialConfig ?? null);
  useEffect(() => {
    const subscription = listen("config-changed", ({ payload }) => {
      setSettingsConfig(payload);
    });
    return () => {
      void subscription.then((stop) => stop());
    };
  }, []);
  const configuredViewMode = settingsConfig?.defaultViewMode;
  useEffect(() => {
    if (configuredViewMode !== undefined) setViewMode(normalizeViewMode(configuredViewMode));
  }, [configuredViewMode]);
  const [noteTransitionKey, setNoteTransitionKey] = useState(0);
  const [deleteConfirm, setDeleteConfirm] = useState(false);
  const [deleteExiting, setDeleteExiting] = useState(false);
  const noteWindowStates = useNoteWindowStates();
  const pinnedIds = useMemo(
    () =>
      new Set(
        Object.values(noteWindowStates)
          .filter((state) => state.pinned)
          .map((state) => state.noteId),
      ),
    [noteWindowStates],
  );
  const stateFor = useCallback(
    (id: string): NoteWindowState =>
      noteWindowStates[id] ?? { noteId: id, pinned: false, presence: "unopened", view: "notepad" },
    [noteWindowStates],
  );
  const [categories, setCategories] = useState<string[]>([]);
  const {
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
    noteMenuRef,
    noteMenuPosition,
    categoryMenuRef,
    categoryMenuPosition,
    switchCategoryMenuPanel,
  } = useNoteMenus(categories.length);
  const [collapsedCategories, setCollapsedCategories] = useState<Set<string>>(new Set());
  const [activeCategory, setActiveCategory] = useState<string>("");
  const [showCategoryInput, setShowCategoryInput] = useState(false);
  const [categoryInputValue, setCategoryInputValue] = useState("");
  const [renamingCategory, setRenamingCategory] = useState<string | null>(null);
  const [renameCategoryValue, setRenameCategoryValue] = useState("");
  const [dragOverCategory, setDragOverCategory] = useState<string | null>(null);
  const [settingsOverlay, setSettingsOverlay] = useState(() =>
    typeof window !== "undefined" ? window.innerWidth < 1080 : true,
  );
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);
  const [splitRatio, setSplitRatio] = useState(0.5);
  const [isResizingSplit, setIsResizingSplit] = useState(false);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const windowLabelRef = useRef("main");
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const externalFileMtimeRef = useRef<number>(0);
  const lastExternalSaveRef = useRef<number>(0);
  const imageBaseDir = useImageBaseDir();
  const saveStateRef = useRef(saveState);
  const isMacOS = useMemo(() => {
    return (
      typeof navigator !== "undefined" &&
      (/Mac|iPhone|iPad/.test(navigator.platform) || navigator.userAgent.includes("Mac"))
    );
  }, []);
  saveStateRef.current = saveState;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const setDraftContent = useCallback((next: string) => {
    contentValueRef.current = next;
    setContent(next);
  }, []);
  const titleValueRef = useRef(title);
  titleValueRef.current = title;
  const notesRef = useRef(notes);
  notesRef.current = notes;
  const externalFilesRef = useRef(externalFiles);
  externalFilesRef.current = externalFiles;
  // 每次"应用/切换当前便签"都会自增；异步加载完成后若 epoch 已变化，说明用户
  // 已切换到别处，该次结果直接丢弃，避免旧的加载结果覆盖新选中的便签
  const loadEpoch = useLoadEpoch();
  // 串行化所有保存请求，避免自动保存与切换触发的保存并发写同一张便签

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selectedId) ?? null,
    [notes, selectedId],
  );
  const selectedNoteRef = useRef(selectedNote);
  selectedNoteRef.current = selectedNote;

  const selectedExternalFile = useMemo(
    () => externalFiles.find((f) => f.id === selectedId) ?? null,
    [externalFiles, selectedId],
  );

  const isExternal = selectedExternalFile !== null;
  const isExternalRef = useRef(isExternal);
  isExternalRef.current = isExternal;

  const noteMenuTarget = useMemo(
    () => notes.find((note) => note.id === noteMenu?.noteId) ?? null,
    [noteMenu?.noteId, notes],
  );
  const noteContextMenuItems = useMemo(
    () =>
      getNoteContextMenuItems(t, noteMenu?.noteId ? noteWindowStates[noteMenu.noteId] : undefined),
    [t, noteMenu?.noteId, noteWindowStates],
  );
  const reminderItems = useReminders();
  const noteReminderMap = useMemo(() => {
    const map = new Map<string, { fireAt: string; item: (typeof reminderItems)[number] }>();
    for (const item of reminderItems) {
      const existing = map.get(item.noteId);
      if (!existing || Date.parse(item.fireAt) < Date.parse(existing.fireAt))
        map.set(item.noteId, { fireAt: item.fireAt, item });
    }
    return map;
  }, [reminderItems]);
  const saveStateLabel = useMemo<Record<SaveState, string>>(
    () => ({
      idle: t("main.statusBar.saveState.idle", { defaultValue: "未选择" }),
      dirty: t("main.statusBar.saveState.dirty", { defaultValue: "未保存" }),
      saving: t("main.statusBar.saveState.saving", { defaultValue: "保存中" }),
      saved: t("main.statusBar.saveState.saved", { defaultValue: "已保存" }),
      error: t("main.statusBar.saveState.error", { defaultValue: "保存失败" }),
    }),
    [t],
  );
  const toolbarButtons = useMemo<
    { label: string; title: string; style: string; action: FormatAction }[]
  >(
    () => [
      {
        label: "B",
        title: t("main.toolbar.bold", { defaultValue: "粗体" }),
        style: "font-bold",
        action: "bold",
      },
      {
        label: "I",
        title: t("main.toolbar.italic", { defaultValue: "斜体" }),
        style: "italic",
        action: "italic",
      },
      {
        label: "H",
        title: t("main.toolbar.heading", { defaultValue: "标题" }),
        style: "font-bold",
        action: "heading",
      },
      {
        label: "—",
        title: t("main.toolbar.hr", { defaultValue: "分割线" }),
        style: "",
        action: "hr",
      },
      {
        label: "•",
        title: t("main.toolbar.ul", { defaultValue: "无序列表" }),
        style: "",
        action: "ul",
      },
      {
        label: "1.",
        title: t("main.toolbar.ol", { defaultValue: "有序列表" }),
        style: "font-mono text-[9px]",
        action: "ol",
      },
      {
        label: "<>",
        title: t("main.toolbar.code", { defaultValue: "代码" }),
        style: "font-mono text-[9px]",
        action: "code",
      },
      {
        label: "❝",
        title: t("main.toolbar.quote", { defaultValue: "引用" }),
        style: "",
        action: "quote",
      },
      {
        label: "∑",
        title: t("main.toolbar.inlineMath", { defaultValue: "行内公式" }),
        style: "font-mono text-[11px]",
        action: "inlineMath",
      },
      {
        label: "∫",
        title: t("main.toolbar.blockMath", { defaultValue: "块级公式" }),
        style: "font-mono text-[11px]",
        action: "blockMath",
      },
    ],
    [t],
  );
  const viewModeOptions = useMemo(
    () => [
      {
        value: "edit" as ViewMode,
        label: t("settings.defaultView.edit", { defaultValue: "编辑" }),
      },
      {
        value: "split" as ViewMode,
        label: t("settings.defaultView.split", { defaultValue: "分栏" }),
      },
    ],
    [t],
  );
  const visibleSidePanel: SidePanelMode | null = aboutOpen ? "about" : null;
  const sidePanelExpanded = visibleSidePanel !== null;
  const openAboutPanel = useCallback(() => {
    setAboutOpen(true);
    setAboutUpdateReminder((current) => dismissAboutUpdateReminderText(current));
  }, [setAboutUpdateReminder]);

  const filteredNotes = useMemo(() => filterNotes(notes, searchQuery), [notes, searchQuery]);

  const categoryGroups = useMemo(
    () => groupNotesByCategory(filteredNotes, categories, pinnedIds),
    [filteredNotes, categories, pinnedIds],
  );

  // 打字时输入框优先响应：预览渲染与字数/字节统计使用延迟值，
  // 连续输入期间 React 会自动合并这些重计算，停顿时再追上
  const deferredContent = useDeferredValue(content);

  const lineCount = useMemo(() => deferredContent.split("\n").length, [deferredContent]);
  const byteSize = useMemo(
    () => (new TextEncoder().encode(deferredContent).length / 1024).toFixed(1),
    [deferredContent],
  );
  const charCount = useMemo(() => countNoteChars(deferredContent), [deferredContent]);

  const applyNote = useCallback(
    (note: Note) => {
      // 立刻同步各 ref，保证保存快照与守卫在下一次渲染前就能读到最新值
      loadEpoch.bump();
      selectedIdRef.current = note.id;
      titleValueRef.current = note.title;
      contentValueRef.current = note.content;
      saveStateRef.current = "saved";
      setSelectedId(note.id);
      setTitle(note.title);
      setContent(note.content);
      setSaveState("saved");
      setNoteTransitionKey((k) => k + 1);
    },
    [loadEpoch],
  );

  const replaceNoteMetadata = useCallback((note: Note) => {
    const metadata = metadataFromNote(note);
    setNotes((current) => {
      const exists = current.some((item) => item.id === metadata.id);
      const next = exists
        ? current.map((item) => (item.id === metadata.id ? metadata : item))
        : [metadata, ...current];
      return [...next].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    });
  }, []);

  const performSave = useCallback(
    async (force = false): Promise<boolean> => {
      // 非强制保存（自动保存、切换前保存）在没有未保存修改时直接视为成功
      if (!force && !["dirty", "saving", "error"].includes(saveStateRef.current)) return true;
      const id = selectedIdRef.current;
      if (!id) return false;

      // 在保存瞬间对当前便签做快照；之后用户切换便签不影响本次写入的内容，
      // 保存完成后也只在"仍停留在这张便签"时才更新保存状态
      const titleSnapshot = titleValueRef.current;
      const contentSnapshot = contentValueRef.current;
      const stillCurrent = () => selectedIdRef.current === id;
      const settleSaveState = (state: SaveState) => {
        if (!stillCurrent()) return;
        saveStateRef.current = state;
        setSaveState(state);
      };

      const externalFile = externalFilesRef.current.find((file) => file.id === id) ?? null;

      settleSaveState("saving");
      try {
        if (externalFile) {
          const observedMtime = await getFileModifiedTime(externalFile.filePath);
          if (observedMtime !== externalFileMtimeRef.current) {
            if (!force || !window.confirm(t("main.confirm.externalConflict")))
              throw new Error(t("errors.externalConflict"));
          }
          await saveExternalFile(externalFile.filePath, contentSnapshot);
          lastExternalSaveRef.current = Date.now();
          const mtime = await getFileModifiedTime(externalFile.filePath);
          if (stillCurrent()) {
            externalFileMtimeRef.current = mtime;
          }
          settleSaveState(contentValueRef.current === contentSnapshot ? "saved" : "dirty");
        } else {
          const category = notesRef.current.find((note) => note.id === id)?.category ?? "";
          const note = await updateNote(id, {
            title: titleSnapshot,
            content: contentSnapshot,
            category,
          });
          replaceNoteMetadata(note);
          const contentChanged =
            contentValueRef.current !== contentSnapshot || titleValueRef.current !== titleSnapshot;
          settleSaveState(contentChanged ? "dirty" : "saved");
        }
        return !stillCurrent() || saveStateRef.current === "saved";
      } catch (error) {
        settleSaveState("error");
        showToast(getErrorMessage(error));
        return false;
      }
    },
    [replaceNoteMetadata, t],
  );

  const { save: saveCurrentNote, pending: pendingSaves } = useNoteDocument(performSave);

  // Reuse the existing save queue and load epoch. Preparing a target never
  // replaces a draft: only the latest request with an unchanged, saved source commits.
  const transitionGeneration = useRef(0);
  const switchDocument = useCallback(
    async (prepareTarget: () => Promise<() => void>): Promise<boolean> => {
      const generation = ++transitionGeneration.current;
      loadEpoch.bump();
      const current = () => generation === transitionGeneration.current;
      setIsLoading(true);
      try {
        if (!(await saveCurrentNote()) || !current()) return false;
        const id = selectedIdRef.current;
        const sourceTitle = titleValueRef.current;
        const sourceContent = contentValueRef.current;
        const commit = await prepareTarget();
        if (
          !current() ||
          selectedIdRef.current !== id ||
          titleValueRef.current !== sourceTitle ||
          contentValueRef.current !== sourceContent ||
          ["dirty", "saving", "error"].includes(saveStateRef.current)
        )
          return false;
        commit();
        return true;
      } catch (error) {
        if (current()) showToast(getErrorMessage(error));
        return false;
      } finally {
        if (current()) setIsLoading(false);
      }
    },
    [loadEpoch, saveCurrentNote],
  );

  const loadNote = useCallback(
    (id: string, taskText?: string) =>
      switchDocument(async () => {
        const note = await getNote(id);
        return () => {
          applyNote(note);
          pendingTaskAnchorRef.current = taskText ?? null;
          replaceNoteMetadata(note);
        };
      }),
    [applyNote, replaceNoteMetadata, switchDocument],
  );

  const refreshNotes = useCallback(async () => {
    const [loadedNotes, loadedCategories] = await Promise.all([listNotes(), listCategories()]);
    setNotes(loadedNotes);
    setCategories(loadedCategories);
    return loadedNotes;
  }, []);

  const clearCurrentNote = useCallback(() => {
    loadEpoch.bump();
    selectedIdRef.current = null;
    titleValueRef.current = "";
    contentValueRef.current = "";
    saveStateRef.current = "idle";
    setSelectedId(null);
    setTitle("");
    setContent("");
    setSaveState("idle");
  }, [loadEpoch]);

  const loadExternalFile = useCallback(
    (filePath: string) =>
      switchDocument(async () => {
        const [fileContent, mtime] = await Promise.all([
          readExternalFile(filePath),
          getFileModifiedTime(filePath),
        ]);
        const fileName = filePath.replaceAll("\\", "/").split("/").pop() ?? filePath;
        const displayTitle = fileName.replace(/\.(md|markdown|txt)$/i, "");
        return () => {
          loadEpoch.bump();
          setExternalFiles((current) =>
            current.some((f) => f.id === filePath)
              ? current
              : [...current, { id: filePath, title: displayTitle, filePath }],
          );
          selectedIdRef.current = filePath;
          titleValueRef.current = displayTitle;
          contentValueRef.current = fileContent;
          saveStateRef.current = "saved";
          setSelectedId(filePath);
          setTitle(displayTitle);
          setContent(fileContent);
          setSaveState("saved");
          setNoteTransitionKey((k) => k + 1);
          externalFileMtimeRef.current = mtime;
        };
      }),
    [loadEpoch, switchDocument],
  );

  useEffect(() => {
    try {
      windowLabelRef.current = getCurrentWindow().label;
    } catch {
      windowLabelRef.current = "main";
    }
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function bootstrap() {
      const initialEpoch = loadEpoch.peek();
      setIsLoading(true);
      try {
        const [loadedConfig, loadedNotes, loadedCategories] = await Promise.all([
          getConfig(),
          listNotes(),
          listCategories(),
        ]);
        if (cancelled) return;
        setSettingsConfig(loadedConfig);

        setViewMode(normalizeViewMode(loadedConfig.defaultViewMode));
        setNotes(loadedNotes);
        setCategories(loadedCategories);
        setCollapsedCategories(new Set(loadedCategories));
        if (loadedNotes[0] && loadEpoch.isCurrent(initialEpoch)) {
          const note = await getNote(loadedNotes[0].id);
          if (
            !cancelled &&
            loadEpoch.isCurrent(initialEpoch) &&
            !["dirty", "saving", "error"].includes(saveStateRef.current)
          )
            applyNote(note);
        } else if (!loadedNotes[0] && loadEpoch.isCurrent(initialEpoch)) {
          clearCurrentNote();
        }

        if (!cancelled) {
          const startupFile = await takeStartupFile();
          if (!cancelled && startupFile) {
            await loadExternalFile(startupFile);
          }
        }
      } catch (error) {
        if (!cancelled) showToast(getErrorMessage(error));
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyNote, clearCurrentNote, loadEpoch, loadExternalFile]);
  useEffect(() => {
    if (visibleSidePanel) {
      setMountedSidePanel(visibleSidePanel);
      setSidePanelContentVisible(false);

      const frame = window.requestAnimationFrame(() => {
        setSidePanelContentVisible(true);
      });

      return () => window.cancelAnimationFrame(frame);
    }

    setSidePanelContentVisible(false);
    if (!mountedSidePanel) return;

    const timer = window.setTimeout(() => {
      setMountedSidePanel((current) => (current === mountedSidePanel ? null : current));
    }, 320);

    return () => window.clearTimeout(timer);
  }, [mountedSidePanel, visibleSidePanel]);

  useEffect(() => {
    const unlisten = listen("notes-changed", () => {
      // 记录事件到达时的 epoch；其间用户一旦切换/加载了便签，本次同步即过期，
      // 不再用过期的列表快照去改选中或回填内容，避免把选中"拉回"刚保存的旧便签
      const epochAtEvent = loadEpoch.peek();
      const isStale = () => !loadEpoch.isCurrent(epochAtEvent);
      void refreshNotes()
        .then((loaded) => {
          if (isStale()) return;
          const currentId = selectedIdRef.current;
          if (!currentId) return;
          const stillExists = loaded.some((n) => n.id === currentId);
          if (stillExists) {
            if (!["dirty", "saving", "error"].includes(saveStateRef.current)) {
              void getNote(currentId)
                .then((note) => {
                  if (isStale()) return;
                  if (selectedIdRef.current !== currentId) return;
                  if (["dirty", "saving", "error"].includes(saveStateRef.current)) {
                    return;
                  }
                  titleValueRef.current = note.title;
                  contentValueRef.current = note.content;
                  saveStateRef.current = "saved";
                  setTitle(note.title);
                  setContent(note.content);
                  setSaveState("saved");
                })
                .catch(() => undefined);
            }
          } else if (
            selectedNoteRef.current &&
            !["dirty", "saving", "error"].includes(saveStateRef.current)
          ) {
            if (loaded[0]) {
              void loadNote(loaded[0].id);
            } else {
              clearCurrentNote();
            }
          }
        })
        .catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes, loadNote, clearCurrentNote, loadEpoch]);

  useEffect(() => {
    function handleFocus() {
      void refreshNotes();
    }
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [refreshNotes]);

  useEffect(() => {
    const onResize = () => setSettingsOverlay(window.innerWidth < 1080);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    const unlisten = listen("open-external-file", (event) => {
      void loadExternalFile(event.payload);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadExternalFile]);

  useEffect(() => {
    const TEXT_RE = /\.(md|markdown|txt)$/i;
    const IMAGE_RE = /\.(png|jpe?g|gif|webp|bmp|svg)$/i;

    const unlisten = getCurrentWindow().onDragDropEvent((event) => {
      if (event.payload.type !== "drop") return;
      const textPaths: string[] = [];
      const imagePaths: string[] = [];

      for (const p of event.payload.paths) {
        if (TEXT_RE.test(p)) textPaths.push(p);
        else if (IMAGE_RE.test(p)) imagePaths.push(p);
      }

      if (textPaths.length) {
        void (async () => {
          for (const filePath of textPaths) {
            if (!(await loadExternalFile(filePath))) break;
          }
        })();
      }

      if (imagePaths.length > 0 && selectedIdRef.current && !isExternalRef.current) {
        const noteId = selectedIdRef.current;
        void (async () => {
          const textarea = contentRef.current;
          if (!textarea) return;
          try {
            const rels = await Promise.all(imagePaths.map((p) => saveImageFromPath(noteId, p)));
            const markdown = rels.map((rel) => `![](${rel})`).join("\n");
            if (selectedIdRef.current !== noteId) return;
            insertTextAtCursor(textarea, setDraftContent, markdown);
            saveStateRef.current = "dirty";
            setSaveState("dirty");
          } catch (error) {
            showToast(getErrorMessage(error));
          }
        })();
      }
    });

    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadExternalFile, setDraftContent]);

  // A lazy preview can commit after this effect; observe its actual DOM readiness.
  useEffect(() => {
    const taskText = pendingTaskAnchorRef.current;
    if (!taskText || contentValueRef.current !== deferredContent) return;
    if (viewMode === "edit") {
      setViewMode("split");
      return;
    }
    const preview = previewScrollRef.current;
    if (!preview) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let observer: MutationObserver | undefined;
    const locate = () => {
      const target = preview.querySelector<HTMLInputElement>(
        'input[data-task-label="' + CSS.escape(taskText) + '"]',
      );
      const row = target?.closest("li");
      if (!row) return;
      pendingTaskAnchorRef.current = null;
      observer?.disconnect();
      row.scrollIntoView({ behavior: "smooth", block: "center" });
      row.classList.add("task-flash");
      timer = setTimeout(() => row.classList.remove("task-flash"), 2400);
    };
    observer = new MutationObserver(locate);
    observer.observe(preview, { childList: true, subtree: true });
    locate();
    return () => {
      observer?.disconnect();
      clearTimeout(timer);
    };
  }, [deferredContent, viewMode, selectedId]);

  useEffect(() => {
    const unlisten = listen("open-about-panel", () => {
      openAboutPanel();
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [openAboutPanel]);

  useEffect(() => {
    const unlisten = listen("shortcut-register-failed", (event) => {
      showToast(event.payload, "warning");
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);
  useExternalFileWatcher({
    selectedExternalFile,
    lastExternalSaveRef,
    saveStateRef,
    loadEpoch,
    contentValueRef,
    selectedIdRef,
    externalFileMtimeRef,
    setContent,
    setSaveState,
  });

  useEffect(() => {
    const unlisten = listen("open-note", (event) => {
      const payload = event.payload;
      void loadNote(
        typeof payload === "string" ? payload : payload.noteId,
        typeof payload === "string" ? undefined : payload.taskText,
      );
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [loadNote]);

  useNoteClosePreparation({
    save: () => saveCurrentNote(true),
    isDirty: () =>
      pendingSaves.current > 0 || ["dirty", "saving", "error"].includes(saveStateRef.current),
    isSaved: () => saveStateRef.current === "saved" && pendingSaves.current === 0,
    label: () => windowLabelRef.current,
    onFailure: (error) => showToast(getErrorMessage(error)),
    failureMessage: t("errors.closeSaveFailed"),
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void saveCurrentNote(true);
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [saveCurrentNote]);

  useEffect(() => {
    if (!selectedId || saveState !== "dirty") return undefined;
    if (isExternal) {
      if (!settingsConfig?.externalFileAutoSave) return undefined;
    } else {
      if (!settingsConfig?.noteAutoSave) return undefined;
    }

    const timer = window.setTimeout(() => {
      void saveCurrentNote();
    }, 900);

    return () => window.clearTimeout(timer);
  }, [
    // content 与 title 用于在持续输入时不断重置防抖计时器
    content,
    title,
    isExternal,
    saveCurrentNote,
    saveState,
    selectedId,
    settingsConfig?.noteAutoSave,
    settingsConfig?.externalFileAutoSave,
  ]);

  const handleNewNote = useCallback(
    () =>
      switchDocument(async () => {
        const note = await createNote({ title: "", content: "", category: activeCategory });
        return () => {
          replaceNoteMetadata(note);
          applyNote(note);
        };
      }),
    [switchDocument, activeCategory, replaceNoteMetadata, applyNote],
  );

  const handleOpenSettings = useCallback(async () => {
    try {
      await openSettingsWindow({ page: "plugins", pluginId: "spark233.notes", tab: "config" });
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, []);

  const handleOpenAbout = useCallback(() => {
    setAboutOpen((open) => {
      const nextOpen = !open;
      if (nextOpen) {
        setAboutUpdateReminder((current) => dismissAboutUpdateReminderText(current));
      }
      return nextOpen;
    });
  }, [setAboutUpdateReminder]);

  const handleCloseAbout = useCallback(() => {
    setAboutOpen(false);
  }, []);

  const handleImportNote = useCallback(
    () =>
      switchDocument(async () => {
        const note = await importMarkdownNote(activeCategory);
        return () => {
          if (note) {
            replaceNoteMetadata(note);
            applyNote(note);
          }
        };
      }),
    [switchDocument, activeCategory, replaceNoteMetadata, applyNote],
  );

  const handleSelectNote = useCallback(
    (id: string) => {
      if (id === selectedIdRef.current) return;
      setDeleteConfirm(false);
      void loadNote(id);
    },
    [selectedIdRef, setDeleteConfirm, loadNote],
  );

  const handleSelectExternalFile = useCallback(
    (id: string) => {
      if (id === selectedIdRef.current) return;
      setDeleteConfirm(false);
      const file = externalFilesRef.current.find((f) => f.id === id);
      if (file) void loadExternalFile(file.filePath);
    },
    [selectedIdRef, setDeleteConfirm, externalFilesRef, loadExternalFile],
  );

  const handleRemoveExternalFile = useCallback(
    async (id: string) => {
      const remove = () => {
        setExternalFiles((current) => current.filter((f) => f.id !== id));
        if (selectedIdRef.current === id) clearCurrentNote();
      };
      if (selectedIdRef.current === id) await switchDocument(async () => remove);
      else remove();
    },
    [setExternalFiles, selectedIdRef, clearCurrentNote, switchDocument],
  );

  const handleDeleteNote = useCallback(
    async (noteId = selectedId) => {
      if (!noteId) return;

      setDeleteConfirm(false);
      try {
        await deleteNote(noteId);
        const remaining = await refreshNotes();
        if (noteId === selectedId && remaining[0]) {
          await loadNote(remaining[0].id);
        } else if (noteId === selectedId) {
          clearCurrentNote();
        }
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [selectedId, setDeleteConfirm, refreshNotes, loadNote, clearCurrentNote],
  );

  const handleOpenNoteMenu = useCallback(
    (event: MouseEvent<HTMLElement>, noteId: string) => {
      event.preventDefault();
      event.stopPropagation();

      setNoteMenuClosing(false);
      setNoteMenuMode("main");
      setHoveredId(noteId);
      setNoteMenu({
        x: event.clientX,
        y: event.clientY,
        noteId,
      });
    },
    [setNoteMenuClosing, setNoteMenuMode, setHoveredId, setNoteMenu],
  );

  const handleExportNote = useCallback(
    async (note: NoteMetadata) => {
      try {
        if (note.id === selectedId) {
          const saved = await saveCurrentNote();
          if (!saved) return;
        }

        await exportMarkdownNote({
          id: note.id,
          title: note.id === selectedId ? title : note.title,
        });
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [selectedId, saveCurrentNote, title],
  );

  const handleNoteMenuAction = (action: NoteContextMenuAction) => {
    const note = noteMenuTarget;
    if (!note) return;

    if (action === "history") {
      setNoteMenuClosing(true);
      void (async () => {
        if (await saveCurrentNote(true)) setHistoryNoteId(note.id);
      })().catch((error) => showToast(getErrorMessage(error)));
      return;
    }
    if (action === "desktop") {
      setNoteMenuClosing(true);
      void (async () => {
        try {
          // Only the context-menu target is opened. Its active draft must reach disk first.
          if (note.id === selectedIdRef.current && !(await saveCurrentNote())) return;
          await showNoteOnDesktop(note.id);
        } catch (error) {
          showToast(getErrorMessage(error));
        }
      })();
      return;
    }

    if (action === "pin") {
      setNoteMenuClosing(true);
      void toggleNotePin(note.id);
      return;
    }
    if (action === "reminder") {
      setNoteMenuMode("reminder");
      return;
    }
    if (action === "hide") {
      setNoteMenuClosing(true);
      void hideNoteOnDesktop(note.id).catch((error) => showToast(getErrorMessage(error)));
      return;
    }

    if (action === "export") {
      setNoteMenuClosing(true);
      void handleExportNote(note);
      return;
    }

    if (action === "move") {
      setNoteMenuMode("move");
      return;
    }

    setNoteMenuClosing(true);
    void handleDeleteNote(note.id);
  };

  const handleMoveNote = useCallback(
    async (noteId: string, targetCategory: string) => {
      setNoteMenuClosing(true);
      try {
        await moveNoteCategory(noteId, targetCategory);
        await refreshNotes();
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [setNoteMenuClosing, refreshNotes],
  );

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

  const markDirty = useCallback(() => {
    if (!selectedIdRef.current) return;
    saveStateRef.current = "dirty";
    setSaveState("dirty");
  }, []);

  const handlePreviewContentChange = useCallback(
    (nextContent: string) => {
      if (contentValueRef.current !== deferredContent) return;
      contentValueRef.current = nextContent;
      setContent(nextContent);
      markDirty();
    },
    [deferredContent, markDirty],
  );

  const ensureNoteSaved = useCallback(async (): Promise<string | null> => {
    if (selectedId) return selectedId;
    try {
      const note = await createNote({ title, content, category: activeCategory });
      replaceNoteMetadata(note);
      applyNote(note);
      return note.id;
    } catch {
      return null;
    }
  }, [selectedId, title, content, activeCategory, replaceNoteMetadata, applyNote]);

  const {
    handlePaste: imagePasteHandler,
    handleDrop: imageDropHandler,
    handleDragOver: imageDragOverHandler,
  } = useImagePaste({
    noteId: selectedId,
    textareaRef: contentRef,
    setContent: setDraftContent,
    markDirty,
    onEnsureNoteSaved: ensureNoteSaved,
    disabled: isExternal,
    autoCompress: settingsConfig?.imageAutoCompress ?? true,
    onError: showToast,
    t,
  });

  const handleCleanUnusedImages = useCallback(async () => {
    if (!selectedId || isExternal) return;
    try {
      const removed = await cleanUnusedImages(selectedId, content);
      if (removed.length > 0) {
        showToast(
          t("main.images.cleaned", {
            count: removed.length,
            defaultValue: "已清理 {{count}} 张图片",
          }),
          "info",
        );
      } else {
        showToast(t("main.images.cleanedNone", { defaultValue: "没有需要清理的图片" }), "info");
      }
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [selectedId, isExternal, content, t]);

  const handleUndo = useCallback(() => {
    if (!selectedId) return;
    const textarea = contentRef.current;
    if (runEditorCommand(textarea, "undo")) {
      setDraftContent(textarea?.value ?? content);
      markDirty();
    }
  }, [selectedId, contentRef, setDraftContent, content, markDirty]);

  const handleRedo = useCallback(() => {
    if (!selectedId) return;
    const textarea = contentRef.current;
    if (runEditorCommand(textarea, "redo")) {
      setDraftContent(textarea?.value ?? content);
      markDirty();
    }
  }, [selectedId, contentRef, setDraftContent, content, markDirty]);

  const handleOpenNotepad = useCallback(async () => {
    try {
      await openNotepadWindow();
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, []);

  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    void isCurrentWindowMaximized().then(setIsMaximized);
    const unlisten = getCurrentWindow().onResized(() => {
      void isCurrentWindowMaximized().then(setIsMaximized);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (!isResizingSidebar) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const newWidth = Math.min(Math.max(e.clientX, 180), 500);
      setSidebarWidth(newWidth);
    };
    const onMouseUp = () => setIsResizingSidebar(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSidebar]);

  useEffect(() => {
    if (!isResizingSplit) return;

    document.body.style.userSelect = "none";
    document.body.style.cursor = "col-resize";

    const onMouseMove = (e: globalThis.MouseEvent) => {
      const container = splitContainerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      setSplitRatio(Math.min(Math.max(ratio, 0.2), 0.8));
    };
    const onMouseUp = () => setIsResizingSplit(false);

    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.userSelect = "";
      document.body.style.cursor = "";
    };
  }, [isResizingSplit]);

  const { handleEditorScroll, handlePreviewScroll } = useSplitScrollSync({
    content: deferredContent,
    viewMode,
    selectedId,
    fontSize: settingsConfig?.fontSize,
    renderHtmlMarkdown: settingsConfig?.renderHtmlMarkdown,
    splitRatio,
    scrollSyncEnabled: settingsConfig?.splitScrollSync ?? true,
    contentRef,
    previewScrollRef,
    splitContainerRef,
  });

  const toggleNotePin = useCallback(
    async (id: string) => {
      try {
        await setNotePinned(id, !stateFor(id).pinned);
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [stateFor],
  );
  const selectedNotePinned = selectedId ? pinnedIds.has(selectedId) : false;
  const pinTitle = t(selectedNotePinned ? "noteState.unpin" : "noteState.pin");

  const toggleMaximize = useCallback(() => {
    void toggleMaximizeCurrentWindow().then(() => isCurrentWindowMaximized().then(setIsMaximized));
  }, [setIsMaximized]);

  const handleTitleBarMouseDown = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      if ((event.target as HTMLElement).closest("button")) return;
      if (event.button !== 0) return;
      if (event.detail === 2) {
        toggleMaximize();
        return;
      }
      void startCurrentWindowDrag().catch(() => undefined);
    },
    [toggleMaximize],
  );

  const handleMinimize = useCallback(() => {
    void minimizeCurrentWindow();
  }, []);

  const handleMaximize = useCallback(() => {
    toggleMaximize();
  }, [toggleMaximize]);

  const handleClose = useCallback(() => {
    void closeCurrentWindow();
  }, []);
  const aboutButtonLabel = t("settings.update.title", { defaultValue: "更新" });
  const aboutButtonExpanded = aboutUpdateReminder.showText;
  const aboutButtonTitle = aboutUpdateReminder.hasPendingUpdate
    ? aboutButtonLabel
    : t("main.window.about", { defaultValue: "关于" });
  return {
    settingsConfig,
    isMacOS,
    handleTitleBarMouseDown,
    title,
    selectedNote,
    t,
    handleOpenNotepad,
    handleOpenSettings,
    handleOpenAbout,
    aboutButtonExpanded,
    aboutButtonTitle,
    aboutUpdateReminder,
    aboutButtonLabel,
    handleMinimize,
    handleMaximize,
    isMaximized,
    handleClose,
    sidebarCollapsed,
    sidebarWidth,
    searchQuery,
    setSearchQuery,
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
    isResizingSidebar,
    setIsResizingSidebar,
    setSidebarCollapsed,
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
    titleValueRef,
    setTitle,
    markDirty,
    contentRef,
    selectedExternalFile,
    charCount,
    saveStateLabel,
    splitContainerRef,
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
    sidePanelExpanded,
    mountedSidePanel,
    settingsOverlay,
    visibleSidePanel,
    sidePanelContentVisible,
    handleCloseAbout,
    noteMenu,
    noteMenuTarget,
    noteMenuRef,
    noteMenuClosing,
    noteMenuPosition,
    noteMenuMode,
    historyNoteId,
    setHistoryNoteId,
    onRevisionRestored: (note: Note) => {
      if (selectedIdRef.current === note.id) applyNote(note);
      replaceNoteMetadata(note);
      void refreshNotes();
    },
    noteContextMenuItems,
    handleNoteMenuAction,
    setNoteMenuMode,
    reminderItems,
    setNoteMenuClosing,
    categories,
    categoryMenu,
    categoryMenuRef,
    categoryMenuClosing,
    categoryMenuHoverSuppressed,
    categoryMenuPosition,
    categoryMenuConfirmDelete,
    handleDeleteCategory,
    switchCategoryMenuPanel,
  };
}
export type NoteSession = ReturnType<typeof useNoteSession>;

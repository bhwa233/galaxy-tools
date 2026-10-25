import { useNoteWindowStates } from "../features/windows/useNoteWindowStates";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent } from "react";
import { useTranslation } from "react-i18next";
import {
  createNote,
  getErrorMessage,
  getNote,
  listNotes,
  updateNote,
  setNoteEditorMode,
} from "../features/notes/api";
import { MarkdownPreviewLazy as MarkdownPreview } from "../features/markdown/MarkdownPreviewLazy";
import { useImagePaste } from "../features/images/useImagePaste";
import { useImageBaseDir } from "../features/images/useImageBaseDir";
import { reportClosePreparation } from "../platform/desktop";
import type { ClosePrepareRequest } from "../platform/desktop";
import { showToast } from "./Toast";
import type { Note, NoteMetadata, NoteEditorMode } from "../features/notes/types";
import { DEFAULT_NOTE_EDITOR_MODE, NOTE_TITLE_MAX_LENGTH } from "../features/notes/types";
import { metadataFromNote } from "../features/notes/noteUtils";
import { invoke, listen } from "../platform/desktop";
import { getCurrentWindow } from "../platform/desktop";
import {
  animateCurrentWindowBounds,
  closeCurrentWindow,
  getCurrentWindowBounds,
  showCurrentWindow,
  startCurrentWindowDrag,
  startCurrentWindowDragWithOffset,
  startCurrentWindowResize,
} from "../features/windows/controls";
import type { ResizeDirection } from "../features/windows/controls";
import { getConfig } from "../features/settings/api";
import {
  DEFAULT_TILE_COLOR,
  normalizeTileColor,
  resolveTileColor,
} from "../features/settings/tileColor";
import type { TileColorMode, ImageDisplayMode } from "../features/settings/types";
import { NoteReminderButton } from "../features/reminders/NoteReminderButton";
import {
  shouldEnterPadFromTileOnDoubleClick,
  shouldReturnToTileAfterManualSave,
  shouldSaveBeforeSwitchingToTile,
} from "../features/windows/noteSurfaceSavePolicy";
import {
  NOTE_SURFACE_ACTION_EVENT,
  surfaceActionFromEvent,
} from "../features/windows/surfaceActions";
import {
  NOTE_SURFACE_MODE_EVENT,
  getSurfaceTargetBounds,
  surfaceModeFromEvent,
} from "../features/windows/surfaceMode";
import type { NoteSurfaceMode } from "../features/windows/surfaceMode";
import {
  emitTileWindowUnpinned,
  tileSurfaceModeUnpinNoteId,
} from "../features/windows/tileWindowEvents";
import { Tile } from "./Tile";

type NotePadStatus = "empty" | "opened" | "saved" | "dirty" | "saveFailed" | "copied";

interface NotePadProps {
  initialNoteId?: string;
  initialSurfaceMode?: NoteSurfaceMode;
  initialAutoSave?: boolean;
  initialTileColor?: string;
}

const surfaceResizeHandles: Array<{
  direction: ResizeDirection;
  className: string;
  size: string;
}> = [
  {
    direction: "NorthWest",
    size: "w-8 h-8",
    className: "top-0 left-0 cursor-nwse-resize",
  },
  {
    direction: "NorthEast",
    size: "w-5 h-5",
    className: "top-0 right-0 cursor-nesw-resize",
  },
  {
    direction: "SouthWest",
    size: "w-8 h-8",
    className: "bottom-0 left-0 cursor-nesw-resize",
  },
  {
    direction: "SouthEast",
    size: "w-5 h-5",
    className: "bottom-0 right-0 cursor-nwse-resize",
  },
];

function isTileControlDoubleClickTarget(target: EventTarget | null): boolean {
  return (
    target instanceof HTMLElement &&
    Boolean(target.closest('button,input,textarea,select,a,[data-surface-resize-handle="true"]'))
  );
}

const TILE_DRAG_START_THRESHOLD_PX = 5;

function SurfaceResizeHandles() {
  return (
    <>
      {surfaceResizeHandles.map((handle) => (
        <div
          key={handle.direction}
          aria-hidden="true"
          data-surface-resize-handle="true"
          data-resize-direction={handle.direction}
          onMouseDown={(event) => {
            event.stopPropagation();
            void startCurrentWindowResize(handle.direction).catch(() => undefined);
          }}
          className={`absolute ${handle.size} opacity-0 ${handle.className}`}
        />
      ))}
    </>
  );
}

export function NotePad({
  initialNoteId,
  initialSurfaceMode = "pad",
  initialAutoSave = true,
  initialTileColor = DEFAULT_TILE_COLOR,
}: NotePadProps) {
  const { t } = useTranslation();
  const [surfaceMode, setSurfaceMode] = useState<NoteSurfaceMode>(initialSurfaceMode);
  const surfaceModeRef = useRef(surfaceMode);
  surfaceModeRef.current = surfaceMode;
  const [notes, setNotes] = useState<NoteMetadata[]>([]);
  const [editingNoteId, setEditingNoteId] = useState<string | null>(null);
  const editingIdRef = useRef<string | null>(null);
  // Existing notes must finish loading before any action can treat the empty
  // initial editor as a new draft. New-note windows remain editable immediately.
  const [noteReady, setNoteReady] = useState(!initialNoteId);
  const noteReadyRef = useRef(noteReady);
  noteReadyRef.current = noteReady;
  const noteSaveQueue = useRef<Promise<unknown>>(Promise.resolve());
  const [title, setTitle] = useState("");
  const [content, setContent] = useState("");
  const [status, setStatus] = useState<NotePadStatus>("empty");
  const [noteSurfaceAutoSave, setNoteSurfaceAutoSave] = useState(initialAutoSave);
  const [tileColorRaw, setTileColorRaw] = useState(normalizeTileColor(initialTileColor));
  const [tileColorMode, setTileColorMode] = useState<TileColorMode>("system");
  const [surfaceFontSize, setSurfaceFontSize] = useState(14);
  const [editorMode, setEditorMode] = useState<NoteEditorMode>(DEFAULT_NOTE_EDITOR_MODE);
  const editorModeRef = useRef<NoteEditorMode>(editorMode);
  editorModeRef.current = editorMode;
  const [modeSaving, setModeSaving] = useState(false);
  const modeMutationRef = useRef(false);
  const [imageAutoCompress, setImageAutoCompress] = useState(true);
  const [imageDisplay, setImageDisplay] = useState<ImageDisplayMode>("show");
  const [tileDoubleClickToEdit, setTileDoubleClickToEdit] = useState(false);
  const [tileSaveReturnsToPin, setTileSaveReturnsToPin] = useState(false);
  const [tileColor, setTileColor] = useState(() =>
    resolveTileColor("system", normalizeTileColor(initialTileColor)),
  );
  const [isExiting, setIsExiting] = useState(false);
  const [draftAlwaysOnTop, setAlwaysOnTop] = useState(false);
  const noteWindowStates = useNoteWindowStates();
  const alwaysOnTop =
    (editingNoteId ? noteWindowStates[editingNoteId]?.pinned : undefined) ?? draftAlwaysOnTop;
  useEffect(() => {
    void invoke<boolean>("window_control", { action: "isAlwaysOnTop" })
      .then(setAlwaysOnTop)
      .catch(console.error);
  }, []);
  const toggleAlwaysOnTop = async () => {
    try {
      await invoke("window_control", { action: "alwaysOnTop", value: !alwaysOnTop });
      setAlwaysOnTop(!alwaysOnTop);
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };
  const topmostButton = (
    <button
      type="button"
      aria-pressed={alwaysOnTop}
      aria-label={t(alwaysOnTop ? "noteState.unpin" : "noteState.pin")}
      title={t(alwaysOnTop ? "noteState.unpin" : "noteState.pin")}
      data-note-pin-paper="true"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => void toggleAlwaysOnTop()}
      className={`relative z-10 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg leading-none transition-colors cursor-pointer ${alwaysOnTop ? "text-bamboo bg-bamboo/10" : "text-ink-ghost hover:text-bamboo hover:bg-paper-warm"}`}
    >
      <svg
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="block rotate-45"
        aria-hidden="true"
      >
        <path d="M12 17v5M5 17h14v-2l-4-3V6l2-2H7l2 2v6l-4 3z" />
      </svg>
    </button>
  );
  const titleRef = useRef<HTMLInputElement>(null);
  const contentRef = useRef<HTMLTextAreaElement>(null);
  const tileDragIntentRef = useRef<{ x: number; y: number } | null>(null);
  const windowLabelRef = useRef("");
  const statusRef = useRef<NotePadStatus>("empty");
  const contentValueRef = useRef(content);
  contentValueRef.current = content;
  const titleValueRef = useRef(title);
  titleValueRef.current = title;
  const tileColorModeRef = useRef(tileColorMode);
  tileColorModeRef.current = tileColorMode;
  const tileColorRawRef = useRef(tileColorRaw);
  tileColorRawRef.current = tileColorRaw;
  const isStandby = useRef(
    typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).get("standby") === "1",
  );
  // 窗口位于池中（standby 预热或已回收隐藏）时为 true：
  // 休眠期间跳过便签列表拉取，激活时统一刷新
  const dormantRef = useRef(isStandby.current);
  const hasEnteredOnce = useRef(false);
  const noteSyncEpoch = useRef(0);
  const pendingSaves = useRef(0);
  statusRef.current = status;

  const refreshNotes = useCallback(async () => {
    // 池中休眠的窗口不拉取便签列表，激活时会统一刷新
    if (dormantRef.current) return [] as NoteMetadata[];
    const loadedNotes = await listNotes();
    setNotes(loadedNotes);
    return loadedNotes;
  }, []);

  const applyNote = useCallback((note: Note) => {
    noteSyncEpoch.current += 1;
    titleValueRef.current = note.title;
    contentValueRef.current = note.content;
    statusRef.current = "opened";
    editingIdRef.current = note.id;
    setEditingNoteId(note.id);
    setTitle(note.title);
    setContent(note.content);
    editorModeRef.current = note.editorMode ?? DEFAULT_NOTE_EDITOR_MODE;
    setEditorMode(editorModeRef.current);
    setStatus("opened");
    noteReadyRef.current = true;
    setNoteReady(true);
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (initialNoteId) {
      noteReadyRef.current = false;
      setNoteReady(false);
    }

    async function bootstrap() {
      try {
        const [loadedConfig] = await Promise.all([getConfig(), refreshNotes()]);
        if (!cancelled) {
          setNoteSurfaceAutoSave(loadedConfig.noteSurfaceAutoSave);
          setSurfaceFontSize(loadedConfig.surfaceFontSize ?? 14);
          setImageAutoCompress(loadedConfig.imageAutoCompress ?? true);
          setImageDisplay(loadedConfig.imageDisplay ?? "show");
          setTileDoubleClickToEdit(loadedConfig.tileDoubleClickToEdit ?? false);
          setTileSaveReturnsToPin(loadedConfig.tileSaveReturnsToPin ?? false);
          setTileColorRaw(normalizeTileColor(loadedConfig.tileColor));
          setTileColorMode(loadedConfig.tileColorMode ?? "system");
          setTileColor(
            resolveTileColor(loadedConfig.tileColorMode ?? "system", loadedConfig.tileColor),
          );
        }
        if (initialNoteId) {
          const note = await getNote(initialNoteId);
          if (!cancelled) applyNote(note);
        }
      } catch (error) {
        if (!cancelled) showToast(getErrorMessage(error));
      }
    }

    void bootstrap();
    return () => {
      cancelled = true;
    };
  }, [applyNote, initialNoteId, refreshNotes]);

  useEffect(() => {
    if (noteReady) contentRef.current?.focus();
  }, [noteReady]);

  useEffect(() => {
    let disposed = false;
    const unlisten = listen("notes-changed", () => {
      const epoch = ++noteSyncEpoch.current;
      const id = editingIdRef.current;
      const titleBefore = titleValueRef.current,
        contentBefore = contentValueRef.current;
      const clean = () =>
        !pendingSaves.current && !["dirty", "saveFailed"].includes(statusRef.current);
      void refreshNotes()
        .then(async (loadedNotes) => {
          if (
            id &&
            !disposed &&
            editingIdRef.current === id &&
            epoch === noteSyncEpoch.current &&
            !modeMutationRef.current
          ) {
            const savedMode =
              loadedNotes.find((item) => item.id === id)?.editorMode ?? DEFAULT_NOTE_EDITOR_MODE;
            editorModeRef.current = savedMode;
            setEditorMode(savedMode);
          }
          if (!id || disposed || !clean()) return;
          const note = await getNote(id);
          // A late response may not replace a different note, a pending save, or local typing.
          if (
            disposed ||
            epoch !== noteSyncEpoch.current ||
            editingIdRef.current !== id ||
            !clean() ||
            titleValueRef.current !== titleBefore ||
            contentValueRef.current !== contentBefore
          )
            return;
          if (note.title === titleBefore && note.content === contentBefore) return;
          titleValueRef.current = note.title;
          contentValueRef.current = note.content;
          setTitle(note.title);
          setContent(note.content);
          statusRef.current = "saved";
          setStatus("saved");
        })
        .catch(() => undefined);
    });
    return () => {
      disposed = true;
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  useEffect(() => {
    if (isStandby.current) return;
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (!cancelled) {
          hasEnteredOnce.current = true;
          void showCurrentWindow()
            .then(() => contentRef.current?.focus())
            .catch(() => undefined);
        }
      });
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisten = listen<{
      tileColor?: string;
      tileColorMode?: TileColorMode;
      surfaceFontSize?: number;
      imageAutoCompress?: boolean;
      imageDisplay?: ImageDisplayMode;
      tileDoubleClickToEdit?: boolean;
      tileSaveReturnsToPin?: boolean;
      noteSurfaceAutoSave?: boolean;
    }>("config-changed", (event) => {
      const mode = event.payload.tileColorMode ?? tileColorModeRef.current;
      const raw = event.payload.tileColor ?? tileColorRawRef.current;
      setTileColorMode(mode);
      setTileColorRaw(normalizeTileColor(raw));
      setTileColor(resolveTileColor(mode, raw));
      if (event.payload.surfaceFontSize != null) setSurfaceFontSize(event.payload.surfaceFontSize);
      if (event.payload.imageAutoCompress != null)
        setImageAutoCompress(event.payload.imageAutoCompress);
      if (event.payload.imageDisplay != null) setImageDisplay(event.payload.imageDisplay);
      if (event.payload.tileDoubleClickToEdit != null)
        setTileDoubleClickToEdit(event.payload.tileDoubleClickToEdit);
      if (event.payload.tileSaveReturnsToPin != null)
        setTileSaveReturnsToPin(event.payload.tileSaveReturnsToPin);
      if (event.payload.noteSurfaceAutoSave != null)
        setNoteSurfaceAutoSave(event.payload.noteSurfaceAutoSave);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  useEffect(() => {
    if (tileColorMode !== "system") return;
    const observer = new MutationObserver(() => {
      setTileColor(resolveTileColor("system", tileColorRaw));
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, [tileColorMode, tileColorRaw]);

  useEffect(() => {
    let myLabel = "";
    try {
      myLabel = getCurrentWindow().label;
      windowLabelRef.current = myLabel;
    } catch {
      // not in Electron environment (tests)
    }

    const unlisten = listen<string>("notepad:activate", (event) => {
      if (event.payload !== myLabel) return;

      isStandby.current = false;
      dormantRef.current = false;
      hasEnteredOnce.current = true;
      editingIdRef.current = null;
      setEditingNoteId(null);
      noteReadyRef.current = true;
      setNoteReady(true);
      editorModeRef.current = DEFAULT_NOTE_EDITOR_MODE;
      setEditorMode(DEFAULT_NOTE_EDITOR_MODE);
      setTitle("");
      setContent("");
      setStatus("empty");
      setIsExiting(false);
      setSurfaceMode("pad");
      void refreshNotes().catch(() => undefined);
      void showCurrentWindow()
        .then(() => contentRef.current?.focus())
        .catch(() => undefined);
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, [refreshNotes]);

  const saveNote = useCallback((): Promise<Note> => {
    const run = noteSaveQueue.current
      .catch(() => undefined)
      .then(async () => {
        pendingSaves.current += 1;
        try {
          const currentId = editingIdRef.current;
          const titleSnapshot = titleValueRef.current;
          const contentSnapshot = contentValueRef.current;
          const existingCategory = notes.find((n) => n.id === currentId)?.category ?? "";
          const request = {
            title: titleSnapshot,
            content: contentSnapshot,
            category: existingCategory,
            ...(!currentId ? { editorMode: editorModeRef.current } : {}),
          };
          const note = currentId ? await updateNote(currentId, request) : await createNote(request);
          editingIdRef.current = note.id;
          setEditingNoteId(note.id);
          setNotes((current) => {
            const metadata = metadataFromNote(note);
            const exists = current.some((item) => item.id === note.id);
            const next = exists
              ? current.map((item) => (item.id === note.id ? metadata : item))
              : [metadata, ...current];
            return [...next].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
          });
          await invoke("surface_state", { noteId: note.id, mode: surfaceModeRef.current });
          const dirty =
            contentValueRef.current !== contentSnapshot || titleValueRef.current !== titleSnapshot;
          statusRef.current = dirty ? "dirty" : "saved";
          setStatus(statusRef.current);
          return note;
        } finally {
          pendingSaves.current -= 1;
        }
      });
    noteSaveQueue.current = run;
    return run;
  }, [notes]);

  // 通过 ref 持有最新的 saveNote，让下方的 Electron 监听只注册一次，
  // 避免每次输入（content 变化）都注销再重注册事件监听
  const saveNoteRef = useRef(saveNote);
  saveNoteRef.current = saveNote;

  useEffect(() => {
    const unlisten = listen<ClosePrepareRequest>("desktop:prepare-close", (event) => {
      const respond = async () => {
        const windowLabel = windowLabelRef.current || "notepad";
        if (!["dirty", "saveFailed"].includes(statusRef.current)) {
          await reportClosePreparation(event.payload.requestId, windowLabel, "ready");
          return;
        }

        try {
          await saveNoteRef.current();
          await reportClosePreparation(
            event.payload.requestId,
            windowLabel,
            statusRef.current === "saved" ? "ready" : "failed",
          );
        } catch (error) {
          setStatus("saveFailed");
          showToast(getErrorMessage(error));
          await reportClosePreparation(
            event.payload.requestId,
            windowLabel,
            "failed",
            getErrorMessage(error),
          );
        }
      };

      void respond().catch(async (error) => {
        await reportClosePreparation(
          event.payload.requestId,
          windowLabelRef.current || "notepad",
          "failed",
          getErrorMessage(error),
        ).catch(() => undefined);
      });
    });
    return () => {
      void unlisten.then((fn) => fn());
    };
  }, []);

  const hasDraftContent = useCallback(
    () => Boolean(editingNoteId || title.trim() || content.trim()),
    [content, editingNoteId, title],
  );

  const imageBaseDir = useImageBaseDir();

  const ensureNoteSaved = useCallback(async (): Promise<string | null> => {
    if (!noteReadyRef.current) return null;
    if (editingNoteId) return editingNoteId;
    try {
      const note = await saveNote();
      return note.id;
    } catch {
      return null;
    }
  }, [editingNoteId, saveNote]);

  const {
    handlePaste: imagePasteHandler,
    handleDrop: imageDropHandler,
    handleDragOver: imageDragOverHandler,
  } = useImagePaste({
    disabled: !noteReady,
    noteId: editingNoteId,
    textareaRef: contentRef,
    setContent: (nextContent) => {
      contentValueRef.current = nextContent;
      setContent(nextContent);
    },
    markDirty: () => {
      statusRef.current = "dirty";
      setStatus("dirty");
    },
    onEnsureNoteSaved: ensureNoteSaved,
    autoCompress: imageAutoCompress,
    onError: showToast,
    t,
  });

  const tileNoteId = editingNoteId ?? initialNoteId ?? "";

  const switchSurfaceMode = useCallback(
    async (nextMode: NoteSurfaceMode) => {
      const unpinnedNoteId = tileSurfaceModeUnpinNoteId(surfaceMode, nextMode, tileNoteId);
      setSurfaceMode(nextMode);
      if (unpinnedNoteId) {
        void emitTileWindowUnpinned(unpinnedNoteId).catch(() => undefined);
      }

      try {
        const currentBounds = await getCurrentWindowBounds();
        const targetBounds = getSurfaceTargetBounds(nextMode, currentBounds);

        await animateCurrentWindowBounds(targetBounds);
      } catch (error) {
        showToast(getErrorMessage(error));
      }
    },
    [surfaceMode, tileNoteId],
  );

  useEffect(() => {
    function handleSurfaceModeRequest(event: Event) {
      const nextMode = surfaceModeFromEvent(event);
      if (!nextMode) return;
      void switchSurfaceMode(nextMode);
    }

    window.addEventListener(NOTE_SURFACE_MODE_EVENT, handleSurfaceModeRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_MODE_EVENT, handleSurfaceModeRequest);
    };
  }, [switchSurfaceMode]);

  useEffect(() => {
    void invoke("surface_state", {
      noteId: editingNoteId ?? initialNoteId,
      mode: surfaceMode,
    }).catch(console.error);
  }, [surfaceMode, editingNoteId, initialNoteId]);

  const handleSave = useCallback(
    async ({ isAutoSave = false }: { isAutoSave?: boolean } = {}) => {
      if (!noteReadyRef.current) return;
      try {
        const savedNote = await saveNote();
        if (
          shouldReturnToTileAfterManualSave({
            enabled: tileSaveReturnsToPin,
            noteId: savedNote.id,
            currentMode: surfaceMode,
            isAutoSave,
          })
        ) {
          await switchSurfaceMode("tile");
        }
      } catch (error) {
        setStatus("saveFailed");
        showToast(getErrorMessage(error));
      }
    },
    [saveNote, surfaceMode, switchSurfaceMode, tileSaveReturnsToPin],
  );

  // 全局监听（Ctrl+S、表面动作）只注册一次，通过 ref 取最新回调，
  // 避免回调依赖 content 导致每次输入都重绑监听
  const handleSaveRef = useRef(handleSave);
  handleSaveRef.current = handleSave;

  const clearPendingTileDrag = useCallback(() => {
    tileDragIntentRef.current = null;
  }, []);

  useEffect(() => clearPendingTileDrag, [clearPendingTileDrag]);

  useEffect(() => {
    if (surfaceMode !== "tile" || !tileDoubleClickToEdit) {
      clearPendingTileDrag();
      return undefined;
    }

    const handleMouseMove = (event: globalThis.MouseEvent) => {
      const intent = tileDragIntentRef.current;
      if (!intent) return;
      // Pointer left the window during a missed mouseup, etc. — drop the stale intent.
      if ((event.buttons & 1) === 0) {
        clearPendingTileDrag();
        return;
      }

      const distanceX = event.screenX - intent.x;
      const distanceY = event.screenY - intent.y;
      const distance = Math.hypot(distanceX, distanceY);
      if (distance < TILE_DRAG_START_THRESHOLD_PX) return;

      tileDragIntentRef.current = null;
      // Compensate for the deadzone drift before handing off to the OS drag.
      void startCurrentWindowDragWithOffset(distanceX, distanceY).catch(() => undefined);
    };

    const handleMouseUp = () => clearPendingTileDrag();

    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, [clearPendingTileDrag, surfaceMode, tileDoubleClickToEdit]);

  const handleTileDoubleClick = useCallback(
    (event: MouseEvent<HTMLElement>) => {
      if (
        !shouldEnterPadFromTileOnDoubleClick(
          tileDoubleClickToEdit,
          isTileControlDoubleClickTarget(event.target),
        )
      ) {
        return;
      }

      clearPendingTileDrag();
      event.preventDefault();
      event.stopPropagation();
      void switchSurfaceMode("pad");
    },
    [clearPendingTileDrag, switchSurfaceMode, tileDoubleClickToEdit],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key === "s") {
        event.preventDefault();
        void handleSaveRef.current();
      }
    }

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, []);

  const handlePin = async () => {
    if (!noteReadyRef.current) return;
    try {
      if (shouldSaveBeforeSwitchingToTile(noteSurfaceAutoSave) || !editingNoteId) {
        await saveNote();
      }
      await switchSurfaceMode("tile");
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  };

  const handleClose = useCallback(() => {
    setIsExiting(true);
    // Main process requests a durable save before releasing the renderer.
    void closeCurrentWindow().catch((error) => {
      setIsExiting(false);
      showToast(getErrorMessage(error));
    });
  }, []);

  const copyTileContent = useCallback(async () => {
    if (!noteReadyRef.current) return;
    try {
      const clipboard = navigator.clipboard;
      if (!clipboard?.writeText) {
        throw new Error(t("notepad.error.copyUnsupported", { defaultValue: "当前环境不支持复制" }));
      }
      await clipboard.writeText(content);
      // 复制不能清除磁贴勾选产生的未保存状态，否则自动保存会被取消。
      setStatus((current) =>
        current === "dirty" || current === "saveFailed" ? current : "copied",
      );
    } catch (error) {
      showToast(getErrorMessage(error));
    }
  }, [content, t]);

  useEffect(() => {
    const fold = (event: KeyboardEvent) => {
      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        handleClose();
      }
    };
    document.addEventListener("keydown", fold);
    return () => document.removeEventListener("keydown", fold);
  }, [handleClose]);

  const handleCloseRef = useRef(handleClose);
  handleCloseRef.current = handleClose;
  const copyTileContentRef = useRef(copyTileContent);
  copyTileContentRef.current = copyTileContent;
  const switchSurfaceModeRef = useRef(switchSurfaceMode);
  switchSurfaceModeRef.current = switchSurfaceMode;
  useEffect(() => {
    const unlisten = listen<NoteSurfaceMode>("surface-mode-request", (event) => {
      if (event.payload === "pad" || event.payload === "tile")
        void switchSurfaceModeRef.current(event.payload);
    });
    return () => {
      void unlisten.then((dispose) => dispose());
    };
  }, []);

  useEffect(() => {
    function handleSurfaceActionRequest(event: Event) {
      const action = surfaceActionFromEvent(event);
      if (!action) return;

      if (action === "copy") {
        void copyTileContentRef.current();
        return;
      }

      if (action === "save") {
        void handleSaveRef.current();
        return;
      }

      if (action === "close") {
        void handleCloseRef.current();
        return;
      }

      void switchSurfaceModeRef.current("pad");
    }

    window.addEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    return () => {
      window.removeEventListener(NOTE_SURFACE_ACTION_EVENT, handleSurfaceActionRequest);
    };
  }, []);

  useEffect(() => {
    if (!noteSurfaceAutoSave || status !== "dirty") {
      return undefined;
    }
    if (!hasDraftContent()) return undefined;

    const timer = window.setTimeout(() => {
      void handleSave({ isAutoSave: true });
    }, 900);

    return () => window.clearTimeout(timer);
  }, [handleSave, hasDraftContent, noteSurfaceAutoSave, status]);

  const handleDrag = (event: MouseEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("button,input,textarea")) return;

    if (surfaceMode === "tile" && tileDoubleClickToEdit) {
      if (event.button !== 0 || event.detail > 1) return;
      clearPendingTileDrag();
      tileDragIntentRef.current = {
        x: event.screenX,
        y: event.screenY,
      };
      return;
    }

    void startCurrentWindowDrag().catch(() => undefined);
  };

  const changeEditorMode = async (next: NoteEditorMode) => {
    if (!noteReadyRef.current || next === editorModeRef.current || modeSaving) return;
    noteSyncEpoch.current += 1;
    const previous = editorModeRef.current;
    const id = editingIdRef.current;
    editorModeRef.current = next;
    setEditorMode(next);
    if (!id) return;
    modeMutationRef.current = true;
    setModeSaving(true);
    try {
      await setNoteEditorMode(id, next);
      if (editingIdRef.current === id) {
        editorModeRef.current = next;
        setEditorMode(next);
      }
    } catch (error) {
      if (editingIdRef.current === id) {
        editorModeRef.current = previous;
        setEditorMode(previous);
      }
      showToast(getErrorMessage(error));
    } finally {
      modeMutationRef.current = false;
      setModeSaving(false);
    }
  };

  const isTile = surfaceMode === "tile";
  const tileTitle = title.trim();
  const enterClass = hasEnteredOnce.current ? "" : "animate-window-enter";
  const surfaceWrapperClassName = `w-full h-screen flex flex-col bg-transparent p-0 ${enterClass}`;
  const padSurfaceClassName =
    "app-surface-frame relative noise-bg w-full h-full min-h-0 bg-cloud overflow-hidden flex flex-col flex-1 border border-paper-deep/70 shadow-[0_1px_10px_rgba(26,26,24,0.06)] transition-all duration-200 ease-out";

  return (
    <div
      className={surfaceWrapperClassName}
      aria-busy={!noteReady || isExiting}
      data-note-ready={noteReady}
    >
      {isTile ? (
        <Tile
          title={tileTitle || undefined}
          content={content}
          onContentChange={(nextContent) => {
            if (!noteReadyRef.current) return;
            contentValueRef.current = nextContent;
            setContent(nextContent);
            statusRef.current = "dirty";
            setStatus("dirty");
          }}
          color={tileColor}
          fontSize={surfaceFontSize}
          renderMarkdown={editorMode === "markdown"}
          imageBaseDir={imageBaseDir ?? undefined}
          imageDisplay={imageDisplay}
          width="100%"
          className="h-full cursor-default"
          data-surface-mode={surfaceMode}
          data-context-menu="tile"
          data-note-id={tileNoteId}
          onMouseDown={handleDrag}
          onDoubleClick={handleTileDoubleClick}
        >
          <button
            type="button"
            aria-label={t("contextMenu.tile.switchToPad")}
            title={t("contextMenu.tile.switchToPad")}
            data-surface-action="switchToPad"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void switchSurfaceMode("pad")}
            className="absolute top-2 right-10 z-10 w-7 h-7 flex items-center justify-center rounded-full text-ink-ghost/70 hover:text-bamboo hover:bg-bamboo-mist transition-colors cursor-pointer"
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
              <path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L9 17l-4 1 1-4Z" />
            </svg>
          </button>
          <div className="absolute top-2 right-18 z-10">
            <NoteReminderButton
              noteId={tileNoteId}
              disabled={!noteReady || isExiting}
              onError={showToast}
            />
          </div>
          <div className="absolute top-2 left-2 z-10">{topmostButton}</div>
          <button
            type="button"
            aria-label="折叠成胶囊"
            title="折叠成胶囊"
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => void handleClose()}
            className="absolute top-2 right-2 z-10 w-7 h-7 flex items-center justify-center rounded-full text-ink-ghost/70 hover:text-red-400 hover:bg-danger-bg/80 transition-colors cursor-pointer"
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
              <path d="m6 9 6 6 6-6" />
            </svg>
          </button>
          <SurfaceResizeHandles />
        </Tile>
      ) : (
        <div
          className={padSurfaceClassName}
          data-surface-mode={surfaceMode}
          data-note-id={editingNoteId ?? undefined}
        >
          <>
            <div
              className="electron-title-drag flex items-center justify-between px-3 pt-3 pb-0 cursor-default"
              onMouseDown={handleDrag}
            >
              <div className="flex h-7 flex-1 min-w-0 items-center gap-1 mr-1">
                {topmostButton}
                <input
                  ref={titleRef}
                  type="text"
                  data-note-title="true"
                  maxLength={NOTE_TITLE_MAX_LENGTH}
                  aria-label={t("notepad.placeholder.title", { defaultValue: "标题（可选）" })}
                  title={title || undefined}
                  value={title}
                  disabled={!noteReady}
                  onChange={(event) => {
                    if (!noteReadyRef.current) return;
                    titleValueRef.current = event.target.value;
                    statusRef.current = "dirty";
                    setTitle(event.target.value);
                    setStatus("dirty");
                  }}
                  onKeyDown={(event) => {
                    if (
                      !event.nativeEvent.isComposing &&
                      (event.key === "Enter" || event.key === "ArrowDown")
                    ) {
                      event.preventDefault();
                      contentRef.current?.focus();
                    }
                  }}
                  placeholder={t("notepad.placeholder.title", { defaultValue: "标题（可选）" })}
                  className="relative z-10 h-7 flex-1 min-w-0 py-0 font-display font-medium text-[11px] leading-7 text-ink placeholder:text-ink-ghost/60 truncate"
                />
              </div>

              <div className="ml-auto h-7 shrink-0 flex items-center gap-1">
                <div
                  className="electron-no-drag flex h-7 items-center rounded bg-paper-warm/70 p-0.5"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  {(["markdown", "text"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      data-note-editor-mode={value}
                      aria-pressed={editorMode === value}
                      disabled={!noteReady || modeSaving}
                      onClick={() => void changeEditorMode(value)}
                      className={`inline-flex h-6 items-center justify-center px-1.5 text-[10px] leading-none rounded cursor-pointer ${editorMode === value ? "text-bamboo bg-bamboo/10" : "text-ink-ghost"}`}
                    >
                      {value === "markdown"
                        ? "MD"
                        : t("notepad.textMode", { defaultValue: "文本" })}
                    </button>
                  ))}
                </div>
                <NoteReminderButton
                  noteId={editingNoteId}
                  ensureNoteSaved={ensureNoteSaved}
                  disabled={!noteReady || isExiting}
                  onError={showToast}
                />
                <button
                  disabled={!noteReady}
                  onClick={() => void handlePin()}
                  className="group w-7 h-7 flex items-center justify-center rounded-lg transition-all duration-200 cursor-pointer text-ink-ghost hover:text-ink-faint hover:bg-paper-warm"
                  title={t("notepad.tooltip.pinToTile", { defaultValue: "转为磁贴" })}
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
                    <rect x="3" y="3" width="7" height="7" rx="1" />
                    <rect x="14" y="3" width="7" height="7" rx="1" />
                    <rect x="3" y="14" width="7" height="7" rx="1" />
                    <rect x="14" y="14" width="7" height="7" rx="1" />
                  </svg>
                </button>

                <button
                  onClick={() => void handleClose()}
                  className="group w-7 h-7 flex items-center justify-center rounded-lg text-ink-ghost hover:bg-danger-bg hover:text-red-400 transition-all duration-200 cursor-pointer"
                  title="折叠成胶囊"
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  >
                    <path d="m6 9 6 6 6-6" />
                  </svg>
                </button>
              </div>
            </div>

            <div className="mx-4 mt-1 h-px bg-paper-deep/50" />

            <div
              data-pad-editor-body="true"
              className="px-4 pt-3 pb-2 flex flex-col flex-1 min-h-0"
            >
              <div className="flex-1 min-h-0" data-editor-mode={noteReady ? editorMode : undefined}>
                {editorMode === "markdown" ? (
                  <div
                    className="h-full overflow-y-auto leading-relaxed text-ink-soft"
                    data-pad-markdown="true"
                  >
                    {content.trim() ? (
                      <MarkdownPreview
                        content={content}
                        fontSize={surfaceFontSize}
                        imageBaseDir={imageBaseDir ?? undefined}
                        imageDisplay={imageDisplay}
                        onContentChange={(nextContent) => {
                          if (!noteReadyRef.current) return;
                          contentValueRef.current = nextContent;
                          statusRef.current = "dirty";
                          setContent(nextContent);
                          setStatus("dirty");
                        }}
                      />
                    ) : (
                      <p className="text-[12px] text-ink-ghost">
                        {t("notepad.markdownEmptyHint", {
                          defaultValue: "切换到文本模式，开始记录……",
                        })}
                      </p>
                    )}
                  </div>
                ) : (
                  <textarea
                    ref={contentRef}
                    data-tab-indent="true"
                    value={content}
                    disabled={!noteReady}
                    onChange={(event) => {
                      if (!noteReadyRef.current) return;
                      contentValueRef.current = event.target.value;
                      statusRef.current = "dirty";
                      setContent(event.target.value);
                      setStatus("dirty");
                    }}
                    onPaste={imagePasteHandler}
                    onDrop={imageDropHandler}
                    onDragOver={imageDragOverHandler}
                    onKeyDown={(event) => {
                      if (event.key === "ArrowUp") {
                        const area = contentRef.current;
                        if (
                          area &&
                          area.selectionStart === area.selectionEnd &&
                          !content.slice(0, area.selectionStart).includes("\n")
                        ) {
                          event.preventDefault();
                          titleRef.current?.focus();
                        }
                      }
                    }}
                    placeholder={t("notepad.placeholder.content", { defaultValue: "写点什么……" })}
                    className="w-full h-full min-h-0 pb-2 leading-relaxed text-ink-soft font-body placeholder:text-ink-ghost/50"
                    style={{
                      fontSize: `${surfaceFontSize}px`,
                      tabSize: "var(--tab-indent-size, 2)",
                    }}
                  />
                )}
              </div>
            </div>
          </>
          <SurfaceResizeHandles />
        </div>
      )}
    </div>
  );
}

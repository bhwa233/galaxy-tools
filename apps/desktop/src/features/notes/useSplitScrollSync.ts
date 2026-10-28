import { useCallback, useEffect, useRef, type RefObject } from "react";
import {
  createScrollSyncMap,
  interpolateScrollOffset,
  measureBlockOffsets,
  measurePreviewBlockOffsets,
  tagPreviewBlocks,
  type ScrollSyncMap,
} from "../markdown/scrollSync";
import type { ViewMode } from "../settings/types";

/** Reuse the existing scroll maps and DOM observers. Keep observers stable while
 * measuring the same deferred Markdown snapshot that is actually on screen. */
export function useSplitScrollSync({
  content,
  viewMode,
  selectedId,
  fontSize,
  renderHtmlMarkdown,
  splitRatio,
  scrollSyncEnabled,
  contentRef,
  previewScrollRef,
  splitContainerRef,
}: {
  content: string;
  viewMode: ViewMode;
  selectedId: string | null;
  fontSize?: number;
  renderHtmlMarkdown?: boolean;
  splitRatio: number;
  scrollSyncEnabled: boolean;
  contentRef: RefObject<HTMLTextAreaElement | null>;
  previewScrollRef: RefObject<HTMLDivElement | null>;
  splitContainerRef: RefObject<HTMLDivElement | null>;
}) {
  const latest = useRef({ content, viewMode, scrollSyncEnabled });
  latest.current = { content, viewMode, scrollSyncEnabled };
  const scrollMaps = useRef<{
    editorToPreview: ScrollSyncMap;
    previewToEditor: ScrollSyncMap;
  } | null>(null);
  const scrollSource = useRef<"editor" | "preview" | null>(null);
  const scrollSyncRafRef = useRef<number>(0);
  const scrollReleaseRafRef = useRef<number>(0);
  const measureDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const measureRafRef = useRef<number>(0);
  const measureControllerRef = useRef<AbortController | null>(null);
  const prevSelectedIdRef = useRef(selectedId);
  const cancelScrollMeasurement = useCallback(() => {
    if (measureDebounceRef.current) clearTimeout(measureDebounceRef.current);
    cancelAnimationFrame(measureRafRef.current);
    measureControllerRef.current?.abort();
  }, []);

  const cancelScheduledScrollSync = useCallback(() => {
    cancelAnimationFrame(scrollSyncRafRef.current);
    cancelAnimationFrame(scrollReleaseRafRef.current);
    scrollSyncRafRef.current = 0;
    scrollReleaseRafRef.current = 0;
    scrollSource.current = null;
  }, []);

  const scheduleScrollMeasurement = useCallback(
    (delayMs: number) => {
      const { content, viewMode, scrollSyncEnabled } = latest.current;
      if (viewMode !== "split" || !scrollSyncEnabled) return;
      if (!contentRef.current || !previewScrollRef.current) return;

      // 布局和测量稳定前先清空旧偏移量
      scrollMaps.current = null;
      cancelScrollMeasurement();

      const controller = new AbortController();
      measureControllerRef.current = controller;

      const measure = async () => {
        const textarea = contentRef.current;
        const preview = previewScrollRef.current;
        if (!textarea || !preview || textarea.value !== content) return;

        const editorOffsets = await measureBlockOffsets(content, textarea, controller.signal);
        if (controller.signal.aborted) return;

        tagPreviewBlocks(preview);
        const previewOffsets = measurePreviewBlockOffsets(preview);
        const editorMaxScroll = Math.max(0, textarea.scrollHeight - textarea.clientHeight);
        const previewMaxScroll = Math.max(0, preview.scrollHeight - preview.clientHeight);
        scrollMaps.current = {
          editorToPreview: createScrollSyncMap(
            editorOffsets,
            previewOffsets,
            editorMaxScroll,
            previewMaxScroll,
          ),
          previewToEditor: createScrollSyncMap(
            previewOffsets,
            editorOffsets,
            previewMaxScroll,
            editorMaxScroll,
          ),
        };
      };

      const runAfterLayout = () => {
        measureRafRef.current = requestAnimationFrame(() => {
          void measure();
        });
      };

      if (delayMs > 0) {
        measureDebounceRef.current = setTimeout(runAfterLayout, delayMs);
      } else {
        runAfterLayout();
      }
    },
    [cancelScrollMeasurement],
  );

  // 切换便签时通过 rAF 测量（不阻塞首帧渲染），编辑时 debounce 避免频繁重排
  useEffect(() => {
    if (viewMode !== "split" || !scrollSyncEnabled) {
      scrollMaps.current = null;
      cancelScrollMeasurement();
      cancelScheduledScrollSync();
      return;
    }

    const isNoteSwitch = prevSelectedIdRef.current !== selectedId;
    prevSelectedIdRef.current = selectedId;
    scheduleScrollMeasurement(isNoteSwitch ? 0 : 250);

    return () => {
      cancelScrollMeasurement();
    };
  }, [
    cancelScrollMeasurement,
    cancelScheduledScrollSync,
    content,
    scrollSyncEnabled,
    scheduleScrollMeasurement,
    selectedId,
    fontSize,
    renderHtmlMarkdown,
    splitRatio,
    viewMode,
  ]);

  useEffect(() => {
    if (viewMode !== "split") return;

    const observedElements: Element[] = [];
    if (splitContainerRef.current) observedElements.push(splitContainerRef.current);
    if (contentRef.current) observedElements.push(contentRef.current);
    if (previewScrollRef.current) observedElements.push(previewScrollRef.current);
    const previewContent = previewScrollRef.current?.querySelector<HTMLElement>(".font-body");
    if (previewContent) observedElements.push(previewContent);

    if (typeof ResizeObserver === "undefined") {
      const handleResize = () => scheduleScrollMeasurement(120);
      window.addEventListener("resize", handleResize);
      return () => window.removeEventListener("resize", handleResize);
    }

    if (observedElements.length === 0) return;

    const observer = new ResizeObserver(() => {
      scheduleScrollMeasurement(120);
    });
    observedElements.forEach((element) => observer.observe(element));

    const mutations = new MutationObserver(() => scheduleScrollMeasurement(120));
    if (previewScrollRef.current)
      mutations.observe(previewScrollRef.current, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      mutations.disconnect();
    };
  }, [scheduleScrollMeasurement, viewMode]);

  // Reset preview scroll on note switch
  useEffect(() => {
    if (previewScrollRef.current) {
      previewScrollRef.current.scrollTop = 0;
    }
  }, [selectedId]);

  const releaseScrollSourceAfterPaint = useCallback((source: "editor" | "preview") => {
    cancelAnimationFrame(scrollReleaseRafRef.current);
    scrollReleaseRafRef.current = requestAnimationFrame(() => {
      scrollReleaseRafRef.current = requestAnimationFrame(() => {
        if (scrollSource.current === source) scrollSource.current = null;
        scrollReleaseRafRef.current = 0;
      });
    });
  }, []);

  const scheduleSyncedScroll = useCallback(
    (source: "editor" | "preview") => {
      if (scrollSyncRafRef.current) return;
      scrollSyncRafRef.current = requestAnimationFrame(() => {
        scrollSyncRafRef.current = 0;
        const textarea = contentRef.current;
        const preview = previewScrollRef.current;
        const maps = scrollMaps.current;
        if (!textarea || !preview || !maps || scrollSource.current !== source) return;

        if (source === "editor") {
          preview.scrollTop = interpolateScrollOffset(maps.editorToPreview, textarea.scrollTop);
        } else {
          textarea.scrollTop = interpolateScrollOffset(maps.previewToEditor, preview.scrollTop);
        }
        releaseScrollSourceAfterPaint(source);
      });
    },
    [releaseScrollSourceAfterPaint],
  );

  const handleEditorScroll = useCallback(() => {
    if (viewMode !== "split" || !scrollSyncEnabled || !scrollMaps.current) return;
    if (scrollSource.current === "preview") return;

    scrollSource.current = "editor";
    cancelAnimationFrame(scrollReleaseRafRef.current);
    scrollReleaseRafRef.current = 0;
    scheduleSyncedScroll("editor");
  }, [scheduleSyncedScroll, scrollSyncEnabled, viewMode]);

  const handlePreviewScroll = useCallback(() => {
    if (viewMode !== "split" || !scrollSyncEnabled || !scrollMaps.current) return;
    if (scrollSource.current === "editor") return;

    scrollSource.current = "preview";
    cancelAnimationFrame(scrollReleaseRafRef.current);
    scrollReleaseRafRef.current = 0;
    scheduleSyncedScroll("preview");
  }, [scheduleSyncedScroll, scrollSyncEnabled, viewMode]);

  useEffect(() => cancelScheduledScrollSync, [cancelScheduledScrollSync]);

  return { handleEditorScroll, handlePreviewScroll };
}

import {
  ChevronDown,
  ChevronUp,
  ChevronsUpDown,
  File,
  FileArchive,
  FileCode,
  FileImage,
  FileMusic,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  Presentation,
  Search,
  Settings,
  type LucideIcon,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type {
  SearchActionResponse,
  SearchWorkspacePage,
  SearchWorkspaceRow,
} from "../../../shared/desktop-contract.js";
import { invoke, writeText } from "../../platform/desktop";
import {
  categories,
  emptyPage,
  fileTypeKey,
  formatFileSize,
  formatFileTime,
  highlightSegments,
  nextSortOption,
  parentDirectory,
  sortOptions,
  type CategoryId,
  type SearchMode,
  type SortField,
  type TypeLabelKey,
} from "./workspace";

const pageSize = 60;
const preferencePrefix = "search.workspace.";

const typeIcons: Record<TypeLabelKey, LucideIcon> = {
  typeFolder: Folder,
  typeExcel: FileSpreadsheet,
  typeWord: FileText,
  typePpt: Presentation,
  typePdf: FileText,
  typeImage: FileImage,
  typeVideo: FileVideo,
  typeAudio: FileMusic,
  typeArchive: FileArchive,
  typeCode: FileCode,
  typeText: FileText,
  typeExecutable: File,
  typeFile: File,
};

function readPreference<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = window.localStorage.getItem(preferencePrefix + key);
    return allowed.includes(value as T) ? (value as T) : fallback;
  } catch {
    return fallback;
  }
}

function writePreference(key: string, value: string): void {
  try {
    window.localStorage.setItem(preferencePrefix + key, value);
  } catch {
    // Persistence is a convenience; a blocked storage must not break search.
  }
}

function messageOf(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

export interface SearchWorkspaceProps {
  initialQuery?: string;
  onClose: () => void;
}

/** Explorer-style result table. The window asks the plugin for its own pages so
 * the launcher session is never consumed by the workspace. */
export function SearchWorkspace({ initialQuery, onClose }: SearchWorkspaceProps) {
  const { t, i18n } = useTranslation("search");
  const locale = i18n.resolvedLanguage ?? "zh-CN";
  const [mode, setMode] = useState<SearchMode>(() =>
    readPreference("mode", ["files", "content"] as const, "files"),
  );
  const [category, setCategory] = useState<CategoryId>(() =>
    readPreference(
      "category",
      categories.map((entry) => entry.id),
      "all",
    ),
  );
  const [sortId, setSortId] = useState<string>(() =>
    readPreference(
      "sort",
      sortOptions.map((entry) => entry.id),
      "relevance",
    ),
  );
  const sort = sortOptions.find((option) => option.id === sortId) ?? sortOptions[0]!;
  const [draft, setDraft] = useState(initialQuery ?? "");
  const [query, setQuery] = useState(() => (initialQuery ?? "").trim());
  const [rows, setRows] = useState<SearchWorkspaceRow[]>([]);
  const [page, setPage] = useState<SearchWorkspacePage>(emptyPage);
  const [status, setStatus] = useState<{ state: string; message?: string }>({ state: "ok" });
  const [busy, setBusy] = useState<"first" | "more" | undefined>();
  const [error, setError] = useState<string>();
  const [selectedId, setSelectedId] = useState<string>();
  const generation = useRef(0);
  const scroller = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  const applyResponse = useCallback((value: SearchActionResponse | undefined, reset: boolean) => {
    const items = (value?.items ?? []).filter((item) => item.commandId !== "next-page");
    setRows((previous) => (reset ? items : [...previous, ...items]));
    setPage(value?.searchPage ?? emptyPage());
    setStatus(value?.searchStatus ?? { state: "ok" });
    if (reset) setSelectedId(items[0]?.id);
  }, []);

  const loadFirst = useCallback(async () => {
    const mine = ++generation.current;
    if (!query) {
      setRows([]);
      setPage(emptyPage());
      setStatus({ state: "ok" });
      setError(undefined);
      setBusy(undefined);
      return;
    }
    setBusy("first");
    setError(undefined);
    try {
      const value = await invoke("search_action", {
        action: "query",
        query,
        mode,
        category,
        ...(mode === "files" && sort.field ? { sort: sort.field, sortDesc: sort.desc } : {}),
        limit: pageSize,
      });
      if (mine !== generation.current) return;
      applyResponse(value, true);
    } catch (failure) {
      if (mine === generation.current) setError(messageOf(failure));
    } finally {
      if (mine === generation.current) setBusy(undefined);
    }
  }, [applyResponse, category, mode, query, sort.desc, sort.field]);

  const loadMore = useCallback(async () => {
    const cursor = page.cursor;
    if (!cursor || busy) return;
    const mine = generation.current;
    setBusy("more");
    try {
      const value = await invoke("search_action", { action: "next-page", cursor });
      if (mine !== generation.current) return;
      applyResponse(value, false);
    } catch (failure) {
      if (mine === generation.current) setError(messageOf(failure));
    } finally {
      if (mine === generation.current) setBusy(undefined);
    }
  }, [applyResponse, busy, page.cursor]);

  // Typing settles before a query leaves the window.
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(draft.trim()), 300);
    return () => window.clearTimeout(timer);
  }, [draft]);

  // The host reuses one search window, so the launcher keys this component by
  // its handoff query: a new query remounts, an empty handoff keeps the view.
  useEffect(() => {
    const timer = window.setTimeout(() => void loadFirst(), 0);
    return () => window.clearTimeout(timer);
  }, [loadFirst]);

  useEffect(() => {
    if (!selectedId) return;
    // Scrolling by attribute keeps the row free to receive the menu trigger ref.
    scroller.current
      ?.querySelector<HTMLElement>(`[data-row-id="${CSS.escape(selectedId)}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedId]);

  const changeSort = (field: SortField) => {
    if (mode !== "files") return;
    const next = nextSortOption(field, sort);
    setSortId(next.id);
    writePreference("sort", next.id);
  };

  const chooseSort = (value: string) => {
    setSortId(value);
    writePreference("sort", value);
  };

  const runRow = async (action: "open" | "reveal" | "copy-path", row: SearchWorkspaceRow) => {
    const selection = row.parameters?.selection;
    if (!selection) return;
    try {
      await invoke("search_action", { action, selection });
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const copyName = async (row: SearchWorkspaceRow) => {
    try {
      await writeText(row.searchHit?.name ?? row.title);
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const installService = async () => {
    setBusy("first");
    setError(undefined);
    try {
      await invoke("search_action", { action: "install-service" });
      await loadFirst();
    } catch (failure) {
      setError(messageOf(failure));
    } finally {
      setBusy(undefined);
    }
  };

  const openSettings = async () => {
    try {
      await invoke("settings_open", { page: "plugins", pluginId: "spark233.search" });
    } catch (failure) {
      setError(messageOf(failure));
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!rows.length) return;
      const index = rows.findIndex((row) => row.id === selectedId);
      const next =
        event.key === "ArrowDown"
          ? Math.min(rows.length - 1, Math.max(0, index) + (index < 0 ? 0 : 1))
          : Math.max(0, (index < 0 ? rows.length : index) - 1);
      setSelectedId(rows[next]?.id);
      return;
    }
    if (event.key === "Enter" && selectedId) {
      const row = rows.find((entry) => entry.id === selectedId);
      if (row) {
        event.preventDefault();
        void runRow("open", row);
      }
      return;
    }
    if (event.key === "/" && event.target !== input.current) {
      event.preventDefault();
      input.current?.focus();
      return;
    }
    if (event.key === "Escape") onClose();
  };

  const onScroll = () => {
    const node = scroller.current;
    if (!node || busy || !page.cursor) return;
    if (node.scrollTop + node.clientHeight >= node.scrollHeight - 80) void loadMore();
  };

  const countLabel = (() => {
    if (page.total > 0)
      return t(page.approximate ? "resultCountApprox" : "resultCount", { count: page.total });
    if (rows.length > 0) return t("resultLoaded", { count: rows.length });
    return "";
  })();

  const sortLabel = t(sort.label);
  const sortableHead = (field: SortField, label: string, className: string) => {
    const active = mode === "files" && sort.field === field;
    const Icon = !active ? ChevronsUpDown : sort.desc ? ChevronDown : ChevronUp;
    return (
      <TableHead
        className={className}
        aria-sort={active ? (sort.desc ? "descending" : "ascending") : "none"}
      >
        <button
          type="button"
          onClick={() => changeSort(field)}
          disabled={mode !== "files"}
          className="flex w-full items-center gap-1 text-left hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
        >
          <span className="truncate">{label}</span>
          <Icon className="size-3 shrink-0 opacity-70" aria-hidden="true" />
        </button>
      </TableHead>
    );
  };

  const placeholder =
    mode === "content" ? t("workspaceContentPlaceholder") : t("workspacePlaceholder");

  return (
    <div className="flex min-h-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className="electron-title-drag flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        <div className="relative shrink-0">
          <Search
            className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden="true"
          />
          <Input
            ref={input}
            autoFocus
            value={draft}
            placeholder={placeholder}
            onChange={(event) => setDraft(event.target.value)}
            className="h-8 w-72 pl-7 text-sm"
            aria-label={placeholder}
          />
        </div>
        <div className="flex items-center gap-1">
          {(["files", "content"] as const).map((value) => (
            <Button
              key={value}
              type="button"
              size="sm"
              variant={mode === value ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={() => {
                setMode(value);
                writePreference("mode", value);
              }}
            >
              {t(value === "files" ? "workspaceFiles" : "workspaceContent")}
            </Button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-1">
          {busy === "first" && <Spinner className="size-4" />}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="size-7 p-0"
            onClick={() => void openSettings()}
            title={t("workspaceSettings")}
            aria-label={t("workspaceSettings")}
          >
            <Settings className="size-4" aria-hidden="true" />
          </Button>
        </div>
      </div>

      {error && (
        <Alert variant="destructive" className="mx-3 mt-2">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="flex min-h-0 flex-1">
        {mode === "files" && (
          <nav className="flex w-24 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-border p-1">
            {categories.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => {
                  setCategory(entry.id);
                  writePreference("category", entry.id);
                }}
                aria-pressed={category === entry.id}
                className={
                  category === entry.id
                    ? "rounded-md bg-accent px-2 py-1.5 text-left text-xs font-medium text-accent-foreground"
                    : "rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent/60 hover:text-accent-foreground"
                }
              >
                {t(entry.label)}
              </button>
            ))}
          </nav>
        )}

        <div
          ref={scroller}
          className="min-w-0 flex-1 overflow-auto"
          onScroll={onScroll}
          data-testid="search-results"
        >
          {status.state === "service-not-installed" ||
          status.state === "service-update-required" ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>
                  {t(
                    status.state === "service-not-installed"
                      ? "serviceMissingTitle"
                      : "serviceUpdateTitle",
                  )}
                </EmptyTitle>
                <EmptyDescription>
                  {t(
                    status.state === "service-not-installed"
                      ? "serviceMissingHelp"
                      : "serviceUpdateHelp",
                  )}
                </EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" size="sm" onClick={() => void installService()}>
                  {t("installService")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : status.state === "stale" ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("staleTitle")}</EmptyTitle>
                <EmptyDescription>{t("staleHelp")}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" size="sm" onClick={() => void loadFirst()}>
                  {t("retrySearch")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : status.state === "error" ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("errorTitle")}</EmptyTitle>
                <EmptyDescription>{status.message}</EmptyDescription>
              </EmptyHeader>
              <EmptyContent>
                <Button type="button" size="sm" onClick={() => void loadFirst()}>
                  {t("retrySearch")}
                </Button>
              </EmptyContent>
            </Empty>
          ) : !query ? (
            <Empty>
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <Search aria-hidden="true" />
                </EmptyMedia>
                <EmptyTitle>{t("emptyPrompt")}</EmptyTitle>
                <EmptyDescription>{t("emptyPromptHelp")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : rows.length === 0 && busy !== "first" ? (
            <Empty>
              <EmptyHeader>
                <EmptyTitle>{t("emptyTitle")}</EmptyTitle>
                <EmptyDescription>{t("emptyHelp")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <Table className="table-fixed" containerClassName="overflow-visible">
              <TableHeader className="sticky top-0 z-10 bg-background">
                <TableRow className="hover:bg-transparent">
                  {sortableHead("name", t("columnName"), "w-auto")}
                  <TableHead className="w-[30%]">{t("columnPath")}</TableHead>
                  {sortableHead("mtime", t("columnModified"), "w-[150px]")}
                  <TableHead className="w-[130px]">{t("columnType")}</TableHead>
                  {sortableHead("size", t("columnSize"), "w-[92px] text-right")}
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => {
                  const typeKey = fileTypeKey(row);
                  const Icon = typeIcons[typeKey];
                  const hit = row.searchHit;
                  const selected = row.id === selectedId;
                  return (
                    <ContextMenu key={row.id}>
                      <ContextMenuTrigger asChild>
                        <TableRow
                          data-row-id={row.id}
                          data-state={selected ? "selected" : undefined}
                          onClick={() => setSelectedId(row.id)}
                          onDoubleClick={() => void runRow("open", row)}
                          className={
                            selected
                              ? "h-[34px] cursor-default bg-accent hover:bg-accent"
                              : "h-[34px] cursor-default hover:bg-accent/50"
                          }
                        >
                          <TableCell className="overflow-hidden">
                            <span className="flex min-w-0 items-center gap-1.5">
                              <Icon
                                className="size-4 shrink-0 text-muted-foreground"
                                aria-hidden="true"
                              />
                              <span className="truncate text-[13px]">
                                {highlightSegments(hit?.name ?? row.title, query).map(
                                  ([text, matched], index) =>
                                    matched ? (
                                      <mark
                                        key={index}
                                        className="rounded-sm bg-primary/20 px-0.5 text-primary"
                                      >
                                        {text}
                                      </mark>
                                    ) : (
                                      <span key={index}>{text}</span>
                                    ),
                                )}
                              </span>
                            </span>
                          </TableCell>
                          <TableCell className="overflow-hidden">
                            <span className="block truncate text-xs text-muted-foreground">
                              {parentDirectory(hit?.path)}
                            </span>
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                            {formatFileTime(hit?.modified, locale)}
                          </TableCell>
                          <TableCell className="text-xs whitespace-nowrap text-muted-foreground">
                            {t(typeKey)}
                          </TableCell>
                          <TableCell className="text-right text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                            {formatFileSize(hit?.size, hit?.directory ?? false)}
                          </TableCell>
                        </TableRow>
                      </ContextMenuTrigger>
                      <ContextMenuContent>
                        <ContextMenuItem onSelect={() => void runRow("open", row)}>
                          {t("openFile")}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => void runRow("reveal", row)}>
                          {t("revealFile")}
                        </ContextMenuItem>
                        <ContextMenuSeparator />
                        <ContextMenuItem onSelect={() => void runRow("copy-path", row)}>
                          {t("copyPath")}
                        </ContextMenuItem>
                        <ContextMenuItem onSelect={() => void copyName(row)}>
                          {t("copyName")}
                        </ContextMenuItem>
                      </ContextMenuContent>
                    </ContextMenu>
                  );
                })}
              </TableBody>
            </Table>
          )}
          {busy === "more" && (
            <div className="flex items-center justify-center gap-2 py-2 text-xs text-muted-foreground">
              <Spinner className="size-3" />
              {t("loadingResults")}
            </div>
          )}
        </div>
      </div>

      <footer className="flex h-8 shrink-0 items-center justify-between border-t border-border px-3 text-xs text-muted-foreground">
        <span>
          {countLabel}
          {selectedId && page.total > 0 ? ` · ${t("selectedCount", { count: 1 })}` : ""}
        </span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-xs"
              disabled={mode !== "files"}
            >
              {t("sortTitle")}: {sortLabel}
              <ChevronDown className="size-3" aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup value={sort.id} onValueChange={chooseSort}>
              {sortOptions.map((option) => (
                <DropdownMenuRadioItem key={option.id} value={option.id}>
                  {t(option.label)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </footer>
    </div>
  );
}

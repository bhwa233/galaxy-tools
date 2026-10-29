import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  AppWindow,
  Copy,
  FileText,
  Pause,
  Pin,
  Play,
  Search,
  Settings,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { openSettingsWindow } from "../settings/api";
import type { ClipboardEntry, ClipboardKind, ClipboardPage, ClipboardRequest } from "./types";

export interface ClipboardWorkspaceProps {
  request: (command: ClipboardRequest) => Promise<unknown>;
  onClose?: () => void;
  compact?: boolean;
  revision?: number;
}
interface Detail extends ClipboardEntry {
  imageDataUrl?: string;
  invalidFiles: string[];
  previewError?: string;
}
const kinds: Array<{ id?: ClipboardKind; label: string }> = [
  { label: "全部" },
  { id: "text", label: "文字" },
  { id: "html", label: "HTML" },
  { id: "rtf", label: "RTF" },
  { id: "image", label: "图片" },
  { id: "files", label: "文件" },
];

export function ClipboardWorkspace({
  request,
  onClose,
  compact = false,
  revision = 0,
}: ClipboardWorkspaceProps) {
  const { t } = useTranslation("clipboard");
  const errorText = useCallback(
    (value: unknown) => {
      const message =
        value && typeof value === "object" && "message" in value
          ? String(value.message)
          : String(value);
      return t(message, { keySeparator: false, defaultValue: message });
    },
    [t],
  );
  const [page, setPage] = useState<ClipboardPage>();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ClipboardKind | "all" | "favorites">("all");
  const favoritesOnly = filter === "favorites";
  const kind = filter === "all" || filter === "favorites" ? undefined : filter;
  const [pageOffset, setPageOffset] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [detail, setDetail] = useState<Detail>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);

  const loadGeneration = useRef(0);
  const load = useCallback(
    async (generation: number) => {
      try {
        const result = (await request({
          action: "list",
          view: favoritesOnly ? "favorites" : "history",
          query,
          kind,
          limit: compact ? 30 : 100,
          offset: pageOffset,
        })) as ClipboardPage;
        if (generation !== loadGeneration.current) return;
        setPage(result);
        setSelected((previous) =>
          result.entries.some((entry) => entry.id === previous) ? previous : result.entries[0]?.id,
        );
      } catch (failure) {
        if (generation === loadGeneration.current) setError(errorText(failure));
      }
    },
    [request, favoritesOnly, query, kind, compact, pageOffset, errorText],
  );
  useEffect(() => setPageOffset(0), [favoritesOnly, query, kind]);
  useEffect(() => {
    const generation = ++loadGeneration.current;
    const timer = setTimeout(() => {
      void load(generation);
    }, 120);
    return () => {
      loadGeneration.current++;
      clearTimeout(timer);
    };
  }, [load, revision, version]);

  useEffect(() => {
    let active = true;
    if (!selected) {
      setDetail(undefined);
      return;
    }
    void request({ action: "detail", id: selected })
      .then((value) => {
        if (!active) return;
        const result = value as Detail;
        setDetail(result);
        if (result.thumbnailDataUrl)
          setPage((previous) =>
            previous
              ? {
                  ...previous,
                  entries: previous.entries.map((entry) =>
                    entry.id === result.id
                      ? { ...entry, thumbnailDataUrl: result.thumbnailDataUrl }
                      : entry,
                  ),
                }
              : previous,
          );
      })
      .catch((failure) => {
        if (active) setError(errorText(failure));
      });
    return () => {
      active = false;
    };
  }, [request, selected, revision, version, errorText]);

  const perform = useCallback(
    async (command: ClipboardRequest) => {
      setBusy(true);
      setError("");
      setNotice("");
      try {
        await request(command);
        setVersion((previous) => previous + 1);
        if (command.action === "paste") {
          setNotice(t("已向之前的目标应用发送粘贴按键"));
          onClose?.();
        }
        if (compact && command.action === "copy") onClose?.();
        return true;
      } catch (failure) {
        setError(errorText(failure));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [request, compact, onClose, errorText],
  );
  const copy = (id: string, action: "copy" | "paste", mode: "original" | "text" = "original") =>
    perform({ action, id, mode });
  const removeEntry = (id: string) => {
    setDetail(undefined);
    void perform({ action: "history.remove", ids: [id] });
  };
  const entryMenu = (entry: ClipboardEntry) => (
    <ContextMenuContent aria-label={t("条目操作")} onKeyDown={(event) => event.stopPropagation()}>
      <ContextMenuItem disabled={busy} onSelect={() => void copy(entry.id, "copy")}>
        <Copy />
        {t("复制原格式")}
      </ContextMenuItem>
      {(entry.kind === "html" || entry.kind === "rtf") && (
        <ContextMenuItem disabled={busy} onSelect={() => void copy(entry.id, "copy", "text")}>
          <FileText />
          {t("纯文本复制")}
        </ContextMenuItem>
      )}
      <ContextMenuSeparator />
      <ContextMenuItem
        disabled={busy}
        onSelect={() =>
          void perform({ action: "favorite", id: entry.id, enabled: !entry.favorite })
        }
      >
        <Star className={entry.favorite ? "fill-current text-primary" : undefined} />
        {entry.favorite ? t("取消收藏") : t("收藏")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem variant="destructive" disabled={busy} onSelect={() => removeEntry(entry.id)}>
        <Trash2 />
        {t("删除条目")}
      </ContextMenuItem>
    </ContextMenuContent>
  );
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (
      event.defaultPrevented ||
      target.closest("input,textarea,[role=menu],[contenteditable=true]") ||
      busy
    )
      return;
    if (
      event.key === "Enter" &&
      target.closest("button") &&
      !target.closest("[data-clipboard-select]")
    )
      return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose?.();
      return;
    }
    const entries = page?.entries ?? [],
      index = entries.findIndex((entry) => entry.id === selected);
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setSelected(
        entries[
          Math.min(Math.max(index + (event.key === "ArrowDown" ? 1 : -1), 0), entries.length - 1)
        ]?.id,
      );
    } else if (event.key === "Enter" && selected) {
      event.preventDefault();
      void copy(selected, compact ? (page?.settings.quickAction ?? "copy") : "copy");
    } else if (compact) {
      const quick =
        page?.settings.quickKeys === "function"
          ? /^F([1-9])$/.exec(event.key)?.[1]
          : /^[1-9]$/.test(event.key)
            ? event.key
            : undefined;
      if (quick && entries[Number(quick) - 1]) {
        event.preventDefault();
        void copy(entries[Number(quick) - 1].id, page?.settings.quickAction ?? "copy");
      }
    }
  };

  return (
    <section
      className="flex h-full min-h-0 flex-col bg-background text-foreground"
      onKeyDown={keys}
      tabIndex={-1}
      aria-label={t("剪贴板工作区")}
    >
      <header className="electron-title-drag flex flex-wrap items-center gap-2 border-b p-3">
        <strong className="mr-auto">{compact ? t("快捷剪贴板") : t("剪贴板历史")}</strong>
        {!compact && (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void perform({ action: "open-quick" })}
          >
            <AppWindow data-icon="inline-start" />
            {t("快捷剪贴板")}
          </Button>
        )}
        <Button
          variant="outline"
          size="sm"
          disabled={busy || !page}
          onClick={() =>
            void perform({ action: "settings", patch: { paused: !page?.settings.paused } })
          }
        >
          {page?.settings.paused ? <Play /> : <Pause />}
          {page?.settings.paused ? t("恢复记录") : t("暂停记录")}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("剪贴板设置")}
          onClick={() => {
            void openSettingsWindow({
              page: "plugins",
              pluginId: "spark233.clipboard",
              tab: "config",
            }).catch((value) => setError(errorText(value)));
          }}
        >
          <Settings />
        </Button>
        {onClose && (
          <Button variant="ghost" size="icon-sm" aria-label={t("关闭工作区")} onClick={onClose}>
            <X />
          </Button>
        )}
      </header>
      {error && (
        <p role="alert" className="border-b px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="px-3 py-1 text-sm text-muted-foreground">
          {notice}
        </p>
      )}
      {page?.nativeStatus && !page.nativeStatus.running && (
        <p role="alert" className="px-3 py-2 text-sm text-destructive">
          {t("监听已停止：")}
          {page.nativeStatus.error ? errorText(page.nativeStatus.error) : t("请重新启用插件")}
        </p>
      )}
      <div className="flex flex-col gap-2 border-b p-3">
        <InputGroup className="h-8! rounded-lg! border-input/30 bg-input/30 shadow-none! *:data-[slot=input-group-addon]:pl-2!">
          <InputGroupInput
            aria-label={t("搜索剪贴板")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <InputGroupAddon>
            <Search className="size-4 shrink-0 opacity-50" />
          </InputGroupAddon>
        </InputGroup>
        <div role="group" aria-label={t("内容筛选")} className="flex flex-wrap gap-1">
          {kinds.map((item) => (
            <Button
              key={item.id ?? "all"}
              size="xs"
              aria-pressed={filter === (item.id ?? "all")}
              variant={filter === (item.id ?? "all") ? "secondary" : "ghost"}
              onClick={() => setFilter(item.id ?? "all")}
            >
              {t(item.label, { defaultValue: item.label, keySeparator: false })}
            </Button>
          ))}
          <Button
            size="xs"
            aria-pressed={favoritesOnly}
            aria-label={t("只看收藏")}
            variant={favoritesOnly ? "secondary" : "ghost"}
            onClick={() => setFilter("favorites")}
          >
            <Star data-icon="inline-start" className="fill-current" />
            {t("收藏")}
          </Button>
        </div>
      </div>
      <div
        className={`grid min-h-0 flex-1 ${compact ? "grid-cols-1" : "grid-cols-[minmax(180px,0.7fr)_minmax(0,1.3fr)]"}`}
      >
        <div className="min-h-0 overflow-auto border-r">
          {!page?.entries.length && (
            <p className="p-6 text-sm text-muted-foreground">
              {page?.settings.paused
                ? t("记录已暂停。已有内容仍可使用。")
                : t("暂无匹配内容。复制的新内容会保存在这里。")}
            </p>
          )}
          {page?.entries.map((entry, index) => (
            <ContextMenu key={entry.id}>
              <ContextMenuTrigger asChild>
                <button
                  data-clipboard-select
                  className={`block w-full min-w-0 border-b px-3 py-2 text-left ${selected === entry.id ? "bg-accent" : "hover:bg-muted/50"}`}
                  onContextMenu={() => setSelected(entry.id)}
                  onClick={() => setSelected(entry.id)}
                  onDoubleClick={() => void copy(entry.id, "copy")}
                >
                  <div className="mb-1 flex items-center gap-1 text-xs text-muted-foreground">
                    {compact && index < 9 && (
                      <Badge variant="outline">
                        {page.settings.quickKeys === "function" ? "F" : ""}
                        {index + 1}
                      </Badge>
                    )}
                    {entry.pinned && <Pin className="size-3" />}
                    {entry.favorite && <Star className="size-3 fill-current" />}
                    <span>{t(`kind.${entry.kind}`)}</span>
                    <span className="ml-auto">×{entry.copies}</span>
                  </div>
                  {entry.thumbnailDataUrl && (
                    <img
                      src={entry.thumbnailDataUrl}
                      alt={t("图片缩略图")}
                      className="max-h-24 max-w-40 object-contain"
                    />
                  )}
                  <p
                    className="line-clamp-2 whitespace-pre-wrap break-words text-sm"
                    title={entry.preview}
                  >
                    {entry.kind === "files" && entry.files.length
                      ? entry.files.map((file) => file.split(/[/\\]/).pop() || file).join("\n")
                      : entry.preview || t(entry.kind === "image" ? "图片" : "剪贴板内容")}
                  </p>
                </button>
              </ContextMenuTrigger>
              {entryMenu(entry)}
            </ContextMenu>
          ))}
        </div>
        {!compact && (
          <div className="flex min-h-0 min-w-0 flex-col" aria-label={t("条目详情")}>
            {detail && detail.id === selected ? (
              <ContextMenu>
                <ContextMenuTrigger asChild className="select-text">
                  <div
                    className="flex min-h-0 flex-1 flex-col outline-none focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:ring-inset"
                    tabIndex={0}
                  >
                    <section
                      className="flex min-h-0 flex-1 flex-col gap-3 p-4"
                      aria-label={t("内容预览")}
                    >
                      <div className="flex shrink-0 items-center justify-between gap-3 text-xs text-muted-foreground">
                        <h3 className="font-medium">{t("内容预览")}</h3>
                        <span>{t("右键查看操作")}</span>
                      </div>
                      <div className="min-h-0 flex-1 overflow-auto">
                        {detail.previewError && (
                          <p role="status" className="mb-3 text-sm text-muted-foreground">
                            {t("缩略图不可用，原始图片仍可复制或导出")}
                          </p>
                        )}
                        {detail.kind === "image" && detail.imageDataUrl && (
                          <div className="flex h-full min-h-40 items-center justify-center overflow-hidden rounded-lg border border-border/60 bg-muted/20 p-3">
                            <img
                              src={detail.imageDataUrl}
                              alt={t("剪贴板图片预览")}
                              className="max-h-full max-w-full rounded object-contain"
                            />
                          </div>
                        )}
                        {!!detail.files.length && (
                          <div className="space-y-2">
                            {detail.files.map((filename) => (
                              <div
                                key={filename}
                                className="flex items-start gap-3 rounded-lg border border-border/60 bg-muted/10 p-3"
                              >
                                <FileText className="mt-0.5 size-5 shrink-0 text-muted-foreground" />
                                <div className="min-w-0 space-y-1">
                                  <p className="break-words text-sm font-medium">
                                    {filename.split(/[/\\]/).pop() || filename}
                                  </p>
                                  <p className="break-all text-xs text-muted-foreground">
                                    {filename}
                                  </p>
                                  {detail.invalidFiles.includes(filename) && (
                                    <p className="text-xs text-destructive">
                                      {t("（引用已失效）")}
                                    </p>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                        {detail.kind !== "image" && detail.kind !== "files" && (
                          <div className="rounded-lg border border-border/60 bg-muted/10 p-4 text-sm leading-relaxed whitespace-pre-wrap break-words">
                            {detail.text || t("剪贴板内容")}
                          </div>
                        )}
                        {detail.textTruncated && (
                          <p role="status" className="mt-3 text-xs text-muted-foreground">
                            {t("内容较大，仅预览前 256 Ki 字符。原始复制保持完整。")}
                          </p>
                        )}
                      </div>
                    </section>
                    <section
                      className="shrink-0 space-y-3 border-t px-4 py-3"
                      aria-label={t("条目信息")}
                    >
                      <h3 className="text-xs font-medium text-muted-foreground">{t("条目信息")}</h3>
                      <dl className="grid max-h-36 grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 overflow-auto text-xs">
                        <dt className="text-muted-foreground">{t("来源应用")}</dt>
                        <dd className="truncate" title={detail.source}>
                          {detail.sourceTitle ||
                            detail.source.split(/[/\\]/).pop() ||
                            t("未知应用")}
                        </dd>
                        <dt className="text-muted-foreground">{t("记录时间")}</dt>
                        <dd>
                          <time dateTime={new Date(detail.createdAt).toISOString()}>
                            {new Date(detail.createdAt).toLocaleString()}
                          </time>
                        </dd>
                        <dt className="text-muted-foreground">{t("内容格式")}</dt>
                        <dd className="truncate" title={detail.formats.join(" · ")}>
                          {t(`kind.${detail.kind}`)}
                        </dd>
                        {detail.note && (
                          <>
                            <dt className="text-muted-foreground">{t("备注")}</dt>
                            <dd className="whitespace-pre-wrap break-words">{detail.note}</dd>
                          </>
                        )}
                      </dl>
                    </section>
                  </div>
                </ContextMenuTrigger>
                {entryMenu(detail)}
              </ContextMenu>
            ) : (
              <div
                role={selected ? "status" : undefined}
                className="flex flex-1 items-center justify-center gap-2 p-6 text-sm text-muted-foreground"
              >
                {selected && <Spinner />}
                {selected ? t("正在加载预览…") : t("选择一条内容查看原始格式和操作。")}
              </div>
            )}
          </div>
        )}
      </div>
      <footer className="flex flex-wrap items-center gap-2 border-t p-2 text-xs text-muted-foreground">
        <span className="mr-auto">
          {page
            ? t("{{value0}} 条可见 · 原始资源 {{value1}} MiB · 数据库 {{value2}} MiB", {
                value0: page.total,
                value1: (page.statistics.bytes / 1048576).toFixed(1),
                value2: (page.statistics.databaseBytes / 1048576).toFixed(1),
              })
            : t("读取本地记录…")}
        </span>
        {compact ? (
          <span>
            {page?.settings.quickKeys === "function" ? "F1–F9" : "1–9"}{" "}
            {page?.settings.quickAction === "paste" ? t("回贴") : t("复制")}
            {t("· ↑↓选择 · Enter执行 · Esc关闭")}
          </span>
        ) : (
          <>
            <Button
              variant="ghost"
              size="xs"
              disabled={pageOffset === 0}
              onClick={() => setPageOffset((previous) => Math.max(0, previous - 100))}
            >
              {t("上一页")}
            </Button>
            <Button
              variant="ghost"
              size="xs"
              disabled={!page || pageOffset + page.entries.length >= page.total}
              onClick={() => setPageOffset((previous) => previous + 100)}
            >
              {t("下一页")}
            </Button>
          </>
        )}
      </footer>
    </section>
  );
}

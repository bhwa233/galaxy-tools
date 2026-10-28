import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@/components/ui/input-group";
import {
  AppWindow,
  Copy,
  CornerDownLeft,
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
  { label: "全部类型" },
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
  const [kind, setKind] = useState<ClipboardKind>();
  const [favoritesOnly, setFavoritesOnly] = useState(false);
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
  const keys = (event: KeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest("input,textarea,[contenteditable=true]") || busy) return;
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
      void copy(selected, page?.settings.quickAction ?? "copy");
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
      <header className="flex flex-wrap items-center gap-2 border-b p-3">
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
        <div className="flex flex-wrap gap-1">
          {kinds.map((item) => (
            <Button
              key={item.id ?? "all"}
              size="xs"
              variant={kind === item.id ? "secondary" : "ghost"}
              onClick={() => setKind(item.id)}
            >
              {t(item.label, { defaultValue: item.label, keySeparator: false })}
            </Button>
          ))}
          <Button
            size="xs"
            aria-pressed={favoritesOnly}
            aria-label={t("只看收藏")}
            variant={favoritesOnly ? "secondary" : "ghost"}
            onClick={() => setFavoritesOnly((previous) => !previous)}
          >
            <Star data-icon="inline-start" />
            {t("收藏")}
          </Button>
        </div>
      </div>
      <div
        className={`grid min-h-0 flex-1 ${compact ? "grid-cols-1" : "md:grid-cols-[minmax(230px,0.9fr)_minmax(0,1.2fr)]"}`}
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
            <div
              key={entry.id}
              className={`flex items-start gap-2 border-b px-3 py-2 ${selected === entry.id ? "bg-accent" : "hover:bg-muted/50"}`}
            >
              <button
                className="min-w-0 flex-1 text-left"
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
                  {entry.favorite && <Star className="size-3" />}
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
                <p className="line-clamp-3 whitespace-pre-wrap break-words text-sm">
                  {entry.preview || t(entry.kind === "image" ? "图片" : "剪贴板内容")}
                </p>
              </button>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={t("复制此条目")}
                disabled={busy}
                onClick={() => void copy(entry.id, "copy")}
              >
                <Copy />
              </Button>
            </div>
          ))}
        </div>
        {!compact && (
          <div className="min-h-0 flex flex-col gap-3 overflow-auto p-3">
            {detail ? (
              <>
                {/* Source and time live here; the list keeps only the content. */}
                <div className="flex flex-col gap-1 text-xs text-muted-foreground">
                  {detail.note && <p className="break-all">{detail.note}</p>}
                  <p className="break-all">
                    {[
                      detail.sourceTitle || detail.source,
                      new Date(detail.lastUsedAt).toLocaleString(),
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </p>
                </div>
                {detail.previewError && (
                  <p role="status">{t("缩略图不可用，原始图片仍可复制或导出")}</p>
                )}
                {detail.imageDataUrl && (
                  <img
                    src={detail.imageDataUrl}
                    alt={t("剪贴板图片预览")}
                    className="max-h-56 max-w-full rounded-md border object-contain"
                  />
                )}
                {!!detail.files.length && (
                  <div className="rounded-md border p-2 text-xs">
                    {detail.files.map((filename) => (
                      <p
                        key={filename}
                        className={
                          detail.invalidFiles.includes(filename)
                            ? "break-all text-destructive"
                            : "break-all"
                        }
                      >
                        {filename}
                        {detail.invalidFiles.includes(filename) ? t("（引用已失效）") : ""}
                      </p>
                    ))}
                  </div>
                )}
                {detail.kind !== "image" && detail.kind !== "files" && (
                  <div className="max-h-64 overflow-auto rounded-md border p-2 text-sm whitespace-pre-wrap break-words">
                    {detail.text || t("剪贴板内容")}
                  </div>
                )}
                {detail.textTruncated && (
                  <p role="status" className="text-xs text-muted-foreground">
                    {t("内容较大，仅预览前 256 Ki 字符。原始复制保持完整。")}
                  </p>
                )}
                <div className="flex flex-wrap gap-2">
                  <Button disabled={busy} onClick={() => void copy(detail.id, "copy")}>
                    <Copy />
                    {t("复制原格式")}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy}
                    onClick={() => void copy(detail.id, "paste")}
                  >
                    <CornerDownLeft />
                    {t("回贴原应用")}
                  </Button>
                  {(detail.kind === "html" || detail.kind === "rtf") && (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy}
                      onClick={() => void copy(detail.id, "copy", "text")}
                    >
                      {t("纯文本复制")}
                    </Button>
                  )}
                </div>
                <div className="flex flex-wrap gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() =>
                      void perform({
                        action: "favorite",
                        id: detail.id,
                        enabled: !detail.favorite,
                      })
                    }
                  >
                    <Star />
                    {detail.favorite ? t("取消收藏") : t("收藏")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => removeEntry(detail.id)}
                  >
                    <Trash2 />
                    {t("删除条目")}
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("来源：")}
                  {detail.source || t("未知应用")} · {new Date(detail.lastUsedAt).toLocaleString()}
                  {t("。复制仅修改剪贴板，回贴会恢复之前的应用并发送粘贴按键。")}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("选择一条内容查看原始格式和操作。")}
              </p>
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

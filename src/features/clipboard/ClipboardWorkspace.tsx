import { openSettingsWindow } from "../settings/api";
import { useTranslation } from "react-i18next";
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from "react";
import {
  Copy,
  CornerDownLeft,
  Star,
  Pin,
  Trash2,
  Pause,
  Play,
  Settings,
  Plus,
  X,
  ArrowUp,
  ArrowDown,
} from "lucide-react";
import { Button, Input, Textarea, Badge, Alert, AlertDescription } from "@spark233/ui/components";
import { MarkdownPreviewLazy } from "../markdown/MarkdownPreviewLazy";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import type {
  ClipboardEntry,
  ClipboardKind,
  ClipboardPage,
  ClipboardRequest,
  ClipboardEmoji,
  ClipboardDraft,
} from "./types";

export interface ClipboardWorkspaceProps {
  request: (command: ClipboardRequest) => Promise<unknown>;
  onClose?: () => void;
  compact?: boolean;
  revision?: number;
  onSendText?: (target: "notes" | "dictionary" | "ai", text: string) => Promise<void>;
  onSendImage?: (entryId: string) => Promise<void>;
  registerPrepare?: (flush: () => Promise<void>) => () => void;
  availableTextTargets: Record<"notes" | "dictionary" | "ai", boolean>;
  imageOcrAvailable: boolean;
  unavailableTargetReason: string;
}
interface Detail extends ClipboardEntry {
  originalText: string;
  edited: boolean;
  imageDataUrl?: string;
  invalidFiles: string[];
  draft?: ClipboardDraft;
  previewError?: string;
  formatPreviews?: { html?: string; rtf?: string; truncated?: boolean };
}
interface Cleanup {
  token: string;
  entries: ClipboardEntry[];
  count: number;
  bytes: number;
  hasMore?: boolean;
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
  onSendText,
  onSendImage,
  registerPrepare,
  availableTextTargets,
  imageOcrAvailable,
  unavailableTargetReason,
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
  const [view, setView] = useState<"history" | "favorites" | "all" | "emoji">("history");
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<ClipboardKind>();
  const [groupId, setGroupId] = useState<string>();
  const [pageOffset, setPageOffset] = useState(0);
  const [selected, setSelected] = useState<string>();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [detail, setDetail] = useState<Detail>();
  const [editing, setEditing] = useState("");
  const [note, setNote] = useState("");
  const [tags, setTags] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [version, setVersion] = useState(0);
  const [cleanup, setCleanup] = useState<Cleanup>();
  const [groupName, setGroupName] = useState("");
  const [emojis, setEmojis] = useState<ClipboardEmoji[]>([]);
  const [emojiSymbol, setEmojiSymbol] = useState("");
  const [emojiName, setEmojiName] = useState("");
  const [emojiGroup, setEmojiGroup] = useState(t("自定义"));
  const textEditor = useRef<HTMLTextAreaElement>(null);
  const drafts = useRef(new Map<string, ClipboardDraft>());
  const pendingDrafts = useRef<Promise<unknown>>(Promise.resolve());
  const flushDrafts = useCallback(async () => {
    await pendingDrafts.current.catch(() => {});
    for (const [id, draft] of drafts.current) await request({ action: "draft.save", id, ...draft });
  }, [request]);
  useEffect(() => registerPrepare?.(flushDrafts), [registerPrepare, flushDrafts]);
  const changeDraft = (field: keyof ClipboardDraft, value: string) => {
    if (!detail) return;
    const draft = { text: editing, note, tags, [field]: value };
    drafts.current.set(detail.id, draft);
    if (field === "text") setEditing(value);
    else if (field === "note") setNote(value);
    else setTags(value);
    const operation = pendingDrafts.current
      .catch(() => {})
      .then(() => request({ action: "draft.save", id: detail.id, ...draft }));
    pendingDrafts.current = operation;
    void operation.catch((failure) => setError(errorText(failure)));
  };

  const load = useCallback(async () => {
    try {
      const result = (await request({
        action: "list",
        view: view === "emoji" ? "history" : view,
        query,
        kind,
        groupId,
        limit: compact ? 30 : 100,
        offset: pageOffset,
      })) as ClipboardPage;
      setPage(result);
      setSelected((previous) =>
        result.entries.some((entry) => entry.id === previous) ? previous : result.entries[0]?.id,
      );
      if (view === "emoji")
        setEmojis((await request({ action: "emoji.list" })) as ClipboardEmoji[]);
    } catch (failure) {
      setError(errorText(failure));
    }
  }, [request, view, query, kind, groupId, compact, pageOffset, errorText]);
  useEffect(() => setPageOffset(0), [view, query, kind, groupId]);
  useEffect(() => {
    const timer = setTimeout(() => {
      void load();
    }, 120);
    return () => clearTimeout(timer);
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
        const draft = drafts.current.get(result.id) ?? result.draft;
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
        setEditing(draft?.text ?? result.text);
        setNote(draft?.note ?? result.note);
        setTags(draft?.tags ?? result.tags.join(", "));
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
        if (command.action === "update" || command.action === "draft.remove") await flushDrafts();
        const result = await request(command);
        if (
          command.action === "draft.remove" ||
          (command.action === "update" &&
            (command.editedText !== undefined ||
              command.note !== undefined ||
              command.tags !== undefined))
        )
          drafts.current.delete(command.id);
        setVersion((previous) => previous + 1);
        if (command.action === "copy" || command.action === "emoji.copy")
          setNotice(t("已复制，可在目标应用中粘贴"));
        if (command.action === "paste") {
          setNotice(t("已向之前的目标应用发送粘贴按键"));
          onClose?.();
        }
        if (compact && command.action === "copy") onClose?.();
        return result;
      } catch (failure) {
        setError(errorText(failure));
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [request, compact, onClose, flushDrafts, errorText],
  );
  const saveEditor = () =>
    detail &&
    perform({
      action: "update",
      id: detail.id,
      ...(detail.textTruncated
        ? {}
        : { editedText: editing === detail.originalText ? null : editing }),
      note,
      tags: tags
        .split(/[,，]/)
        .map((tag) => tag.trim())
        .filter(Boolean),
    });
  const copy = (
    id: string,
    action: "copy" | "paste",
    mode: "original" | "text" | "image-file" = "original",
  ) => perform({ action, id, mode });
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
  const previewCleanup = async () => {
    const result = await perform({
      action: "cleanup.preview",
      ...(checked.size ? { ids: [...checked] } : { outsideVisibleRange: true }),
    });
    if (result) setCleanup(result as Cleanup);
  };
  const send = async (target: "notes" | "dictionary" | "ai") => {
    if (!availableTextTargets[target]) {
      setError(unavailableTargetReason);
      return;
    }
    if (!detail || !onSendText) {
      setError(t("目标插件尚未连接"));
      return;
    }
    if (!editing.trim()) {
      setError(t("没有可发送的文字"));
      return;
    }
    setBusy(true);
    setError("");
    try {
      const start = textEditor.current?.selectionStart ?? 0,
        end = textEditor.current?.selectionEnd ?? 0;
      if (detail.textTruncated && end <= start)
        throw new Error(t("内容较大，请先选择需要发送的片段"));
      await onSendText(target, end > start ? editing.slice(start, end) : editing);
      setNotice(t("已发送所选文字"));
    } catch (failure) {
      setError(errorText(failure));
    } finally {
      setBusy(false);
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
            onClick={() =>
              void perform({
                action: "gallery.import",
                groupId: page?.groups.some(
                  (group) => group.id === groupId && group.kind === "gallery",
                )
                  ? groupId
                  : undefined,
              })
            }
          >
            <Plus data-icon="inline-start" />
            {t("导入图片")}
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
      <div className="flex flex-wrap gap-1 px-3 pt-2">
        {(
          [
            { id: "history", title: t("历史") },
            { id: "favorites", title: t("收藏") },
            { id: "all", title: t("全部保留内容") },
            { id: "emoji", title: t("表情符号") },
          ] as const
        ).map((tab) => (
          <Button
            key={tab.id}
            variant={view === tab.id ? "secondary" : "ghost"}
            size="sm"
            onClick={() => {
              setView(tab.id);
              setChecked(new Set());
            }}
          >
            {tab.title}
          </Button>
        ))}
      </div>
      <div className="flex flex-col gap-2 border-b p-3">
        <Input
          aria-label={t("搜索剪贴板")}
          placeholder={t("搜索正文、预览、标签、备注或来源应用")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {view !== "emoji" && (
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
          </div>
        )}
        {!!page?.groups.length && view !== "emoji" && (
          <div className="flex flex-wrap gap-1">
            <Button
              size="xs"
              variant={groupId ? "ghost" : "secondary"}
              onClick={() => setGroupId(undefined)}
            >
              {t("所有分组")}
            </Button>
            {page.groups.map((group) => (
              <Button
                key={group.id}
                size="xs"
                variant={groupId === group.id ? "secondary" : "ghost"}
                onClick={() => {
                  setView(group.kind === "gallery" ? "all" : "favorites");
                  setGroupId(group.id);
                }}
              >
                {t(group.name, { defaultValue: group.name, keySeparator: false })}
              </Button>
            ))}
          </div>
        )}
      </div>
      {view === "emoji" ? (
        <div className="min-h-0 flex-1 overflow-auto p-3">
          <div className="mb-3 flex flex-wrap gap-2">
            <Input
              className="w-24"
              value={emojiSymbol}
              placeholder={t("符号")}
              aria-label={t("新表情符号")}
              onChange={(event) => setEmojiSymbol(event.target.value)}
            />
            <Input
              className="w-36"
              value={emojiName}
              placeholder={t("名称")}
              aria-label={t("符号名称")}
              onChange={(event) => setEmojiName(event.target.value)}
            />
            <Input
              className="w-28"
              value={emojiGroup}
              placeholder={t("分组")}
              aria-label={t("符号分组")}
              onChange={(event) => setEmojiGroup(event.target.value)}
            />
            <Button
              disabled={!emojiSymbol || busy}
              onClick={() =>
                void perform({
                  action: "emoji.add",
                  symbol: emojiSymbol,
                  name: emojiName || emojiSymbol,
                  group: emojiGroup || t("自定义"),
                })
              }
            >
              <Plus />
              {t("添加")}
            </Button>
          </div>
          <div className="flex flex-wrap gap-2">
            {emojis
              .filter((emoji) => `${emoji.name} ${emoji.group} ${emoji.symbol}`.includes(query))
              .map((emoji) => (
                <div key={emoji.id} className="flex items-center rounded-md border">
                  <Button
                    variant="ghost"
                    title={t("{{value0}} · {{value1}} · 点击复制", {
                      value0: t(emoji.group, { defaultValue: emoji.group, keySeparator: false }),
                      value1: emoji.name,
                    })}
                    onClick={() => void perform({ action: "emoji.copy", id: emoji.id })}
                  >
                    <span className="text-2xl">{emoji.symbol}</span>
                    <span className="text-xs text-muted-foreground">{emoji.name}</span>
                    {!!emoji.lastUsedAt && <Badge variant="secondary">{t("最近")}</Badge>}
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t("删除{{value0}}", { value0: emoji.name })}
                    onClick={() => void perform({ action: "emoji.remove", id: emoji.id })}
                  >
                    <X />
                  </Button>
                </div>
              ))}
          </div>
        </div>
      ) : (
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
                {!compact && (
                  <Checkbox
                    className="mt-1"
                    aria-label={t("选择条目{{value0}}", { value0: index + 1 })}
                    checked={checked.has(entry.id)}
                    onCheckedChange={(value) =>
                      setChecked((previous) => {
                        const next = new Set(previous);
                        if (value) next.add(entry.id);
                        else next.delete(entry.id);
                        return next;
                      })
                    }
                  />
                )}
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
                  <p className="mt-1 truncate text-xs text-muted-foreground">
                    {entry.note ||
                      entry.sourceTitle ||
                      entry.source ||
                      new Date(entry.lastUsedAt).toLocaleString()}
                  </p>
                </button>
                {compact && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t("复制此条目")}
                    disabled={busy}
                    onClick={() => void copy(entry.id, "copy")}
                  >
                    <Copy />
                  </Button>
                )}
              </div>
            ))}
          </div>
          {!compact && (
            <div className="min-h-0 flex flex-col gap-3 overflow-auto p-3">
              {detail ? (
                <>
                  <div className="flex flex-wrap gap-1">
                    {detail.formats.map((format) => (
                      <Badge key={format} variant="outline">
                        {format}
                      </Badge>
                    ))}
                  </div>
                  {detail.previewError && (
                    <p role="status">{t("缩略图不可用，原始图片仍可复制或导出")}</p>
                  )}
                  {detail.textTruncated && (
                    <Alert>
                      <AlertDescription>
                        {t("内容较大，仅预览前 256 Ki 字符。原始复制保持完整，发送前请选择片段。")}
                      </AlertDescription>
                    </Alert>
                  )}
                  {detail.formatPreviews?.html && (
                    <details>
                      <summary>{t("HTML 安全预览")}</summary>
                      <MarkdownPreviewLazy
                        content={detail.formatPreviews.html}
                        renderHtml
                        imageDisplay="hidden"
                      />
                    </details>
                  )}
                  {detail.formatPreviews?.rtf && (
                    <details>
                      <summary>{t("RTF 源数据预览")}</summary>
                      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words text-xs">
                        {detail.formatPreviews.rtf}
                      </pre>
                    </details>
                  )}
                  {detail.formatPreviews?.truncated && (
                    <p role="status">{t("格式预览已截断，原始复制仍保留全部内容。")}</p>
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
                    <>
                      <Textarea
                        ref={textEditor}
                        aria-label={t("编辑条目文字")}
                        className="min-h-32"
                        value={editing}
                        disabled={busy}
                        readOnly={detail.textTruncated}
                        onChange={(event) => changeDraft("text", event.target.value)}
                      />
                      <div className="flex gap-2">
                        <Button
                          size="sm"
                          disabled={
                            busy ||
                            detail.textTruncated ||
                            (editing === detail.text &&
                              note === detail.note &&
                              tags === detail.tags.join(", "))
                          }
                          onClick={() => void saveEditor()}
                        >
                          {t("保存全部编辑")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy || !detail.edited}
                          onClick={() =>
                            void perform({ action: "update", id: detail.id, editedText: null })
                          }
                        >
                          {t("恢复原文并放弃草稿")}
                        </Button>
                      </div>
                    </>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button disabled={busy} onClick={() => void copy(detail.id, "copy")}>
                      <Copy />
                      {t(detail.edited ? "复制编辑文字" : "复制原格式")}
                    </Button>
                    <Button
                      variant="outline"
                      disabled={busy}
                      onClick={() => void copy(detail.id, "paste")}
                    >
                      <CornerDownLeft />
                      {t("回贴原应用")}
                    </Button>
                    {!!detail.text && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void copy(detail.id, "copy", "text")}
                        >
                          {t("纯文本复制")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void copy(detail.id, "paste", "text")}
                        >
                          {t("纯文本回贴")}
                        </Button>
                      </>
                    )}
                    {detail.kind === "image" && (
                      <>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void copy(detail.id, "copy", "image-file")}
                        >
                          {t("图片按文件复制")}
                        </Button>
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={busy}
                          onClick={() => void copy(detail.id, "paste", "image-file")}
                        >
                          {t("图片按文件回贴")}
                        </Button>
                      </>
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
                      onClick={() =>
                        void perform({
                          action: "update",
                          id: detail.id,
                          ...(view === "favorites"
                            ? { favoritePinned: !detail.favoritePinned }
                            : { pinned: !detail.pinned }),
                        })
                      }
                    >
                      <Pin />
                      {(view === "favorites" ? detail.favoritePinned : detail.pinned)
                        ? t("取消置顶")
                        : t("置顶")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void perform({
                          action: "update",
                          id: detail.id,
                          ...(view === "favorites"
                            ? { favoriteOrder: -Date.now() }
                            : { order: -Date.now() }),
                        })
                      }
                    >
                      <ArrowUp />
                      {t("移至顶部")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() =>
                        void perform({
                          action: "update",
                          id: detail.id,
                          ...(view === "favorites"
                            ? { favoriteOrder: Date.now() }
                            : { order: Date.now() }),
                        })
                      }
                    >
                      <ArrowDown />
                      {t("移至底部")}
                    </Button>
                  </div>
                  <Input
                    aria-label={t("条目备注")}
                    placeholder={t("备注")}
                    value={note}
                    disabled={busy}
                    onChange={(event) => changeDraft("note", event.target.value)}
                  />
                  <Input
                    aria-label={t("条目标签")}
                    placeholder={t("标签，以逗号分隔")}
                    value={tags}
                    disabled={busy}
                    onChange={(event) => changeDraft("tags", event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy}
                    onClick={() => void saveEditor()}
                  >
                    {t("保存全部编辑")}
                  </Button>
                  {(detail.draft || drafts.current.has(detail.id)) && (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => void perform({ action: "draft.remove", id: detail.id })}
                    >
                      {t("放弃未提交草稿")}
                    </Button>
                  )}
                  <div className="flex flex-wrap gap-1">
                    {page?.groups.map((group) => (
                      <Button
                        key={group.id}
                        size="xs"
                        variant={detail.groups.includes(group.id) ? "secondary" : "outline"}
                        onClick={() =>
                          void perform({
                            action: "update",
                            id: detail.id,
                            groups: detail.groups.includes(group.id)
                              ? detail.groups.filter((id) => id !== group.id)
                              : [...detail.groups, group.id],
                          })
                        }
                      >
                        {group.name}
                      </Button>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <Input
                      aria-label={t("新建图库或收藏分组")}
                      placeholder={t("新分组名称")}
                      value={groupName}
                      onChange={(event) => setGroupName(event.target.value)}
                    />
                    <Button
                      variant="outline"
                      disabled={busy || !groupName.trim()}
                      onClick={() =>
                        void perform({
                          action: "groups",
                          name: groupName,
                          kind: view === "favorites" ? "favorite" : "gallery",
                        })
                      }
                    >
                      <Plus />
                    </Button>
                    {groupId && (
                      <Button
                        variant="ghost"
                        aria-label={t("删除当前分组")}
                        onClick={() => {
                          void perform({ action: "groups", deleteId: groupId });
                          setGroupId(undefined);
                        }}
                      >
                        <Trash2 />
                      </Button>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {(["dictionary", "ai", "notes"] as const).map((target) => (
                      <Button
                        key={target}
                        size="sm"
                        variant="outline"
                        disabled={
                          busy || !detail.text || !onSendText || !availableTextTargets[target]
                        }
                        title={
                          !availableTextTargets[target]
                            ? unavailableTargetReason
                            : !onSendText
                              ? t("目标插件尚未连接")
                              : t("发送选中文字，没有选区时发送全文")
                        }
                        onClick={() => void send(target)}
                      >
                        {target === "notes"
                          ? t("发送便签")
                          : target === "ai"
                            ? t("AI 翻译")
                            : t("查词")}
                      </Button>
                    ))}
                    {detail.kind === "image" && (
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy || !onSendImage || !imageOcrAvailable}
                        title={!imageOcrAvailable ? unavailableTargetReason : undefined}
                        onClick={() => {
                          if (onSendImage) {
                            setBusy(true);
                            void onSendImage(detail.id)
                              .catch((failure) => setError(errorText(failure)))
                              .finally(() => setBusy(false));
                          }
                        }}
                      >
                        {t("图片取字")}
                      </Button>
                    )}
                  </div>
                  {(Object.values(availableTextTargets).some((available) => !available) ||
                    (detail.kind === "image" && !imageOcrAvailable)) && (
                    <p role="status" className="text-xs text-muted-foreground">
                      {unavailableTargetReason}
                    </p>
                  )}
                  <p className="text-xs text-muted-foreground">
                    {t("来源：")}
                    {detail.source || t("未知应用")} ·{" "}
                    {new Date(detail.lastUsedAt).toLocaleString()}
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
      )}
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
        {!compact && view !== "emoji" && (
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
        {compact ? (
          <span>
            {page?.settings.quickKeys === "function" ? "F1–F9" : "1–9"}{" "}
            {page?.settings.quickAction === "paste" ? t("回贴") : t("复制")}
            {t("· ↑↓选择 · Enter执行 · Esc关闭")}
          </span>
        ) : (
          <>
            <Button
              variant="outline"
              size="xs"
              disabled={busy || checked.size < 2}
              onClick={() => void perform({ action: "merge", ids: [...checked], kind: "text" })}
            >
              {t("合并文字")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={busy || checked.size < 2}
              onClick={() => void perform({ action: "merge", ids: [...checked], kind: "rich" })}
            >
              {t("合并图文")}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={busy || checked.size < 2}
              onClick={() => void perform({ action: "merge", ids: [...checked], kind: "files" })}
            >
              {t("合并文件引用")}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={busy || !checked.size}
              onClick={() => {
                void perform({ action: "history.remove", ids: [...checked] });
                setChecked(new Set());
              }}
            >
              {t("移出历史")}
            </Button>
            <Button
              variant="outline"
              size="xs"
              disabled={busy}
              onClick={() => void previewCleanup()}
            >
              {t("待清理预览")}
            </Button>
          </>
        )}
      </footer>
      <Dialog
        open={!!cleanup}
        onOpenChange={(open) => {
          if (!open) setCleanup(undefined);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("确认清理未引用内容")}</DialogTitle>
            <DialogDescription>
              {t(
                "收藏与图库分组引用会保留。此操作只删除下方预览中的内容；刚重新复制或新收藏的条目会再次检查。",
              )}
            </DialogDescription>
          </DialogHeader>
          <p>
            {cleanup?.count}
            {t("条，约")}
            {((cleanup?.bytes ?? 0) / 1048576).toFixed(1)} MiB
          </p>
          {cleanup?.hasMore && (
            <Alert>
              <AlertDescription>{t("还有更多待清理内容，请完成本批后重新预览。")}</AlertDescription>
            </Alert>
          )}
          <div className="max-h-60 overflow-auto">
            {cleanup?.entries.map((entry) => (
              <p key={entry.id} className="border-b py-2 text-sm">
                {entry.preview}
              </p>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCleanup(undefined)}>
              {t("取消")}
            </Button>
            <Button
              variant="destructive"
              disabled={busy || !cleanup?.count}
              onClick={async () => {
                if (
                  cleanup &&
                  (await perform({ action: "cleanup.confirm", token: cleanup.token }))
                ) {
                  setCleanup(undefined);
                  setChecked(new Set());
                }
              }}
            >
              {t("确认删除并回收资源")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  );
}

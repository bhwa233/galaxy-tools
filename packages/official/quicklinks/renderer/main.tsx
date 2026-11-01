import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import { createRoot } from "react-dom/client";
import { ExternalLink, FolderOpen, Globe, Link, Plus, Search, Trash2 } from "lucide-react";
import {
  Alert,
  AlertDescription,
  Badge,
  Button,
  Input,
  Spinner,
  Textarea,
  WindowTitleBar,
} from "@spark233/ui/components";
import { createPluginClient } from "../../../sdk/src/browser.js";
import type { JsonValue, PluginActivation, PluginTheme } from "../../../sdk/src/index.js";
import type { QuickLink, QuickLinkInput, QuickLinkResolution, QuickLinksState } from "../contract";
import { resolveTemplate, templateFields } from "../templates";
import "../../../../apps/desktop/src/App.css";
import "./quicklinks.css";

const client = createPluginClient();
const request = <T,>(commandId: string, parameters?: unknown) =>
  client.capability("node.backend", "invoke", {
    commandId,
    ...(parameters === undefined ? {} : { parameters: parameters as JsonValue }),
  }) as Promise<T>;
const execute = (commandId: string, input?: QuickLinkInput) =>
  client.capability("commands", "execute", {
    pluginId: "spark233.quicklinks",
    commandId,
    ...(input ? { text: JSON.stringify(input) } : {}),
  });

interface RunDraft {
  entry: QuickLink;
  entryRevision?: string;
  query: string;
  values: Record<string, string>;
}

function QuickLinksPage() {
  const [saved, setSaved] = useState<QuickLinksState>();
  const [entries, setEntries] = useState<QuickLink[]>([]);
  const [selected, setSelected] = useState<string>();
  const [filter, setFilter] = useState("");
  const [presets, setPresets] = useState(false);
  const [run, setRun] = useState<RunDraft>();
  const [maximized, setMaximized] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [closeRequested, setCloseRequested] = useState(false);
  const mounted = useRef(false);
  const lock = useRef(false);
  const dirty = Boolean(saved && JSON.stringify(entries) !== JSON.stringify(saved.entries));
  const current = entries.find((entry) => entry.id === selected);
  const draft = useRef({ dirty, busy, entries });
  useLayoutEffect(() => {
    draft.current = { dirty, busy, entries };
  }, [dirty, busy, entries]);
  const report = (value: unknown) => {
    if (mounted.current) setError(value instanceof Error ? value.message : String(value));
  };
  useEffect(() => {
    mounted.current = true;
    let active = true;
    const applyTheme = (theme: PluginTheme) => {
      document.documentElement.dataset.theme = theme.effective;
      document.documentElement.dataset.accent = theme.accent ?? "green";
    };
    const acceptActivation = (activation: PluginActivation) => {
      const value = activation.parameters as QuickLinkResolution | undefined;
      if (value?.kind === "prompt") {
        setRun({
          entry: value.entry,
          entryRevision: value.entryRevision,
          query: value.query,
          values: value.values,
        });
        setPresets(false);
        setSelected(value.entry.id);
        setError(undefined);
        setNotice(undefined);
      }
    };
    const stopTheme = client.onTheme(applyTheme);
    const stopActivation = client.onActivation(acceptActivation);
    const stopPrepare = client.onPrepareStop(() => {
      if (draft.current.busy || lock.current)
        return { ok: false, reason: "操作尚未完成，请稍后关闭。" };
      if (draft.current.dirty) {
        setCloseRequested(true);
        return { ok: false, reason: "快捷入口尚未保存，请先保存或放弃修改。" };
      }
      return { ok: true };
    });
    const syncWindow = () =>
      void client.window
        .isMaximized()
        .then((value) => {
          if (active) setMaximized(value);
        })
        .catch(report);
    window.addEventListener("resize", syncWindow);
    syncWindow();
    void client
      .context()
      .then((context) => {
        if (active) applyTheme(context.theme);
      })
      .catch(report);
    void request<QuickLinksState>("settings.get")
      .then((state) => {
        if (!active) return;
        setSaved(state);
        setEntries(state.entries);
        setSelected(state.entries[0]?.id);
        setError(undefined);
      })
      .catch(report);
    return () => {
      active = false;
      mounted.current = false;
      stopTheme();
      stopActivation();
      stopPrepare();
      window.removeEventListener("resize", syncWindow);
    };
  }, [retry]);
  const act = async (action: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(undefined);
    setNotice(undefined);
    try {
      await action();
    } catch (value) {
      report(value);
    } finally {
      lock.current = false;
      if (mounted.current) setBusy(false);
    }
  };
  const save = () =>
    act(async () => {
      if (!saved) return;
      const next = await request<QuickLinksState>("settings.save", {
        revision: saved.revision,
        entries,
      });
      if (!mounted.current) return;
      setSaved(next);
      setEntries(next.entries);
      setNotice("已保存");
      setCloseRequested(false);
    });
  const update = (patch: Partial<QuickLink>) => {
    setEntries((list) =>
      list.map((entry) => (entry.id === selected ? { ...entry, ...patch } : entry)),
    );
    setNotice(undefined);
  };
  const add = (preset?: QuickLink) => {
    const entry: QuickLink = preset
      ? { ...preset, id: crypto.randomUUID(), args: [...preset.args] }
      : {
          id: crypto.randomUUID(),
          title: "新的快捷入口",
          keyword: "",
          kind: "url",
          target: "https://www.bing.com/search?q={query}",
          args: [],
          cwd: "",
          enabled: true,
          description: "",
        };
    setEntries((list) => [...list, entry]);
    setSelected(entry.id);
    setFilter("");
    setPresets(false);
    setRun(undefined);
    setNotice(undefined);
  };
  const openEntry = (entry: QuickLink) => {
    setRun({ entry, query: "", values: {} });
    setError(undefined);
    setNotice(undefined);
  };
  const submitRun = (event: FormEvent) => {
    event.preventDefault();
    if (!run) return;
    void act(async () => {
      const result = await execute("run", {
        id: run.entry.id,
        ...(run.entryRevision ? { entryRevision: run.entryRevision } : {}),
        query: run.query,
        values: run.values,
      });
      if (mounted.current && result && typeof result === "object" && "ok" in result && result.ok) {
        setNotice(`已打开「${run.entry.title}」。`);
        setRun(undefined);
      }
    });
  };
  const close = async () => {
    if (dirty) {
      setCloseRequested(true);
      return;
    }
    await client.close();
  };
  return (
    <main className="quicklinks-app flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <WindowTitleBar
        title="快捷搜索与快开"
        isMaximized={maximized}
        labels={{ minimize: "最小化", maximize: "最大化", restore: "还原", close: "关闭" }}
        onMinimize={() => void client.window.minimize().catch(report)}
        onToggleMaximize={() => void client.window.toggleMaximize().catch(report)}
        onClose={() => void close().catch(report)}
      />
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-5 py-4">
        <div>
          <h2 className="text-base font-semibold">让常用入口带上你的输入</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            在启动器输入「关键词＋空格＋内容」，回车打开。例如：bd 天气
          </p>
        </div>
        <div className="flex items-center gap-2">
          {dirty && <Badge variant="outline">未保存</Badge>}
          <Button
            variant="outline"
            disabled={!dirty || busy}
            onClick={() => {
              if (saved) {
                setEntries(saved.entries);
                setSelected(saved.entries[0]?.id);
                setCloseRequested(false);
                setError(undefined);
              }
            }}
          >
            放弃修改
          </Button>
          <Button disabled={!saved || !dirty || busy} onClick={() => void save()}>
            {busy ? <Spinner /> : null}保存配置
          </Button>
        </div>
      </header>
      {error && (
        <Alert variant="destructive" className="quicklinks-alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {notice && (
        <p role="status" className="border-b px-5 py-2 text-sm text-primary">
          {notice}
        </p>
      )}
      {closeRequested && (
        <Alert className="quicklinks-alert">
          <AlertDescription>有未保存的修改，请保存或放弃修改。</AlertDescription>
        </Alert>
      )}
      {!saved ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3">
          {error ? (
            <Button variant="outline" onClick={() => setRetry((value) => value + 1)}>
              重新加载
            </Button>
          ) : (
            <>
              <Spinner />
              <span className="text-sm text-muted-foreground">正在读取快捷入口…</span>
            </>
          )}
        </div>
      ) : (
        <div className="quicklinks-layout min-h-0 flex-1">
          <aside className="flex min-h-0 flex-col border-r bg-muted/20">
            <div className="space-y-3 border-b p-4">
              <label className="relative block">
                <Search className="absolute left-3 top-2.5 size-4 text-muted-foreground" />
                <Input
                  aria-label="筛选快捷入口"
                  value={filter}
                  onChange={(event) => setFilter(event.target.value)}
                  placeholder="筛选名称或关键词"
                  className="pl-9"
                />
              </label>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" disabled={busy} onClick={() => add()}>
                  <Plus />
                  新增
                </Button>
                <Button
                  variant={presets ? "secondary" : "outline"}
                  className="flex-1"
                  onClick={() => {
                    setPresets((value) => !value);
                    setRun(undefined);
                  }}
                >
                  网站预设
                </Button>
              </div>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto p-2">
              {entries
                .filter((entry) =>
                  `${entry.title} ${entry.keyword}`
                    .toLocaleLowerCase()
                    .includes(filter.toLocaleLowerCase()),
                )
                .map((entry) => (
                  <button
                    type="button"
                    key={entry.id}
                    onClick={() => {
                      setSelected(entry.id);
                      setRun(undefined);
                      setPresets(false);
                    }}
                    className={`quicklinks-list-item ${entry.id === selected && !run ? "quicklinks-selected" : ""}`}
                  >
                    {entry.kind === "url" ? (
                      <Globe className="mt-0.5 size-4 shrink-0" />
                    ) : (
                      <Link className="mt-0.5 size-4 shrink-0" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">
                        {entry.title || "未命名入口"}
                      </span>
                      <span className="mt-1 block truncate font-mono text-xs text-muted-foreground">
                        {entry.keyword || "未设置关键词"}
                      </span>
                    </span>
                    {!entry.enabled && (
                      <span className="text-xs text-muted-foreground">已停用</span>
                    )}
                  </button>
                ))}
              {!entries.length && <p className="p-4 text-sm text-muted-foreground">暂无快捷入口</p>}
            </div>
            <p className="border-t p-3 text-xs text-muted-foreground">共 {entries.length} 个入口</p>
          </aside>
          <section className="min-h-0 overflow-y-auto p-5">
            {presets ? (
              <div className="space-y-4">
                <div>
                  <h3 className="font-semibold">添加常用预设</h3>
                </div>
                <div className="grid grid-cols-2 gap-3">
                  {saved.presets.map((preset) => {
                    const exists = entries.some(
                      (entry) =>
                        entry.keyword.toLocaleLowerCase() === preset.keyword.toLocaleLowerCase(),
                    );
                    return (
                      <Button
                        key={preset.id}
                        variant="outline"
                        className="h-auto justify-between p-4"
                        disabled={busy || exists}
                        title={exists ? "关键词已存在" : undefined}
                        onClick={() => add(preset)}
                      >
                        <span className="text-left">
                          {preset.title}
                          <span className="mt-1 block font-mono text-xs text-muted-foreground">
                            {preset.keyword}
                          </span>
                        </span>
                        <Plus />
                      </Button>
                    );
                  })}
                </div>
              </div>
            ) : run ? (
              <form className="space-y-5" onSubmit={submitRun}>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-semibold">{run.entry.title}</h3>
                  </div>
                  <Button variant="ghost" type="button" onClick={() => setRun(undefined)}>
                    返回管理
                  </Button>
                </div>
                {templateFields(run.entry).map((field) => (
                  <label key={field} className="quicklinks-field">
                    <span>{field === "query" ? "查询内容" : field}</span>
                    <Input
                      autoFocus={field === templateFields(run.entry)[0]}
                      value={field === "query" ? run.query : (run.values[field] ?? "")}
                      onChange={(event) =>
                        setRun({
                          ...run,
                          ...(field === "query"
                            ? { query: event.target.value }
                            : { values: { ...run.values, [field]: event.target.value } }),
                        })
                      }
                      required
                      maxLength={4096}
                    />
                  </label>
                ))}
                <Preview entry={run.entry} query={run.query} values={run.values} />
                <Button type="submit" disabled={busy || dirty || !run.entry.enabled}>
                  <ExternalLink />
                  {busy ? "正在打开…" : "打开"}
                </Button>
                {dirty && (
                  <p className="text-xs text-muted-foreground">请先保存配置，再使用快捷入口。</p>
                )}
              </form>
            ) : current ? (
              <div className="space-y-5">
                <div className="flex items-center justify-between gap-3">
                  <h3 className="font-semibold">编辑快捷入口</h3>
                  <div className="flex gap-2">
                    <Button
                      variant="outline"
                      disabled={dirty || busy || !current.enabled}
                      onClick={() => openEntry(current)}
                    >
                      <ExternalLink />
                      使用
                    </Button>
                    <Button
                      variant="ghost"
                      aria-pressed={current.enabled}
                      disabled={busy}
                      onClick={() => update({ enabled: !current.enabled })}
                    >
                      {current.enabled ? "已启用" : "已停用"}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="删除入口"
                      aria-label="删除入口"
                      disabled={busy}
                      onClick={() => {
                        setEntries((list) => list.filter((entry) => entry.id !== current.id));
                        setSelected(entries.find((entry) => entry.id !== current.id)?.id);
                      }}
                    >
                      <Trash2 />
                    </Button>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <label className="quicklinks-field">
                    <span>名称</span>
                    <Input
                      value={current.title}
                      onChange={(event) => update({ title: event.target.value })}
                      maxLength={160}
                      disabled={busy}
                    />
                  </label>
                  <label className="quicklinks-field">
                    <span>关键词</span>
                    <Input
                      value={current.keyword}
                      onChange={(event) => update({ keyword: event.target.value })}
                      placeholder="例如 bd、gh、浏览器"
                      maxLength={40}
                      disabled={busy}
                    />
                  </label>
                </div>
                <div className="flex gap-2">
                  <Button
                    variant={current.kind === "url" ? "secondary" : "outline"}
                    disabled={busy}
                    onClick={() =>
                      update({
                        kind: "url",
                        target: "https://www.bing.com/search?q={query}",
                        args: [],
                        cwd: "",
                      })
                    }
                  >
                    <Globe />
                    网页 / 应用链接
                  </Button>
                  <Button
                    variant={current.kind === "program" ? "secondary" : "outline"}
                    disabled={busy}
                    onClick={() =>
                      update({ kind: "program", target: "", args: ["{query}"], cwd: "" })
                    }
                  >
                    <Link />
                    程序
                  </Button>
                </div>
                <label className="quicklinks-field">
                  <span>{current.kind === "url" ? "网址模板" : "程序路径（EXE）"}</span>
                  <div className="flex gap-2">
                    <Input
                      className="font-mono text-xs"
                      value={current.target}
                      onChange={(event) => update({ target: event.target.value })}
                      disabled={busy}
                      placeholder={
                        current.kind === "url"
                          ? "https://example.com/search?q={query}"
                          : "C:\\Program Files\\App\\app.exe"
                      }
                    />
                    {current.kind === "program" && (
                      <Button
                        variant="outline"
                        title="选择程序"
                        disabled={busy}
                        onClick={() =>
                          void act(async () => {
                            const result = await execute("pick-program");
                            if (
                              result &&
                              typeof result === "object" &&
                              "path" in result &&
                              typeof result.path === "string"
                            )
                              update({ target: result.path });
                          })
                        }
                      >
                        <FolderOpen />
                      </Button>
                    )}
                  </div>
                </label>
                {current.kind === "program" && (
                  <>
                    <label className="quicklinks-field">
                      <span>启动参数（每行一个参数）</span>
                      <Textarea
                        className="min-h-24 font-mono text-xs"
                        value={current.args.join("\n")}
                        onChange={(event) =>
                          update({
                            args: event.target.value === "" ? [] : event.target.value.split("\n"),
                          })
                        }
                        placeholder={"--search\n{query}"}
                        disabled={busy}
                      />
                      <small>
                        路径含空格无需加引号；支持 {"{query}"} 和 {"{名称}"}。
                      </small>
                    </label>
                    <label className="quicklinks-field">
                      <span>工作目录（可选）</span>
                      <Input
                        value={current.cwd}
                        onChange={(event) => update({ cwd: event.target.value })}
                        placeholder="留空使用程序所在目录"
                        disabled={busy}
                      />
                    </label>
                  </>
                )}
                <label className="quicklinks-field">
                  <span>说明（可选）</span>
                  <Input
                    value={current.description}
                    onChange={(event) => update({ description: event.target.value })}
                    maxLength={500}
                    disabled={busy}
                  />
                </label>
                <details className="rounded-lg border bg-muted/20 p-4 text-xs leading-6 text-muted-foreground">
                  <summary className="cursor-pointer text-foreground">模板帮助</summary>
                  <div className="mt-2 space-y-1">
                    <p>
                      {"{query}"} 接收搜索内容，{"{名称}"} 会在打开前显示填写框。
                    </p>
                    <p>网址参数会自动编码，支持网页和应用链接。</p>
                    <p>
                      例如：{"https://github.com/{owner}/{repo}"}，或在程序参数中单独一行填写{" "}
                      {"{query}"}。
                    </p>
                  </div>
                </details>
                <Preview entry={current} query="示例 内容 & test" />
              </div>
            ) : (
              <div className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground">
                选择一个入口，或添加新的快捷搜索。
              </div>
            )}
          </section>
        </div>
      )}
    </main>
  );
}

function Preview({
  entry,
  query,
  values,
}: {
  entry: QuickLink;
  query: string;
  values?: Record<string, string>;
}) {
  let text: string;
  try {
    const preview = resolveTemplate(
      entry,
      query,
      values ??
        Object.fromEntries(
          templateFields(entry)
            .filter((field) => field !== "query")
            .map((field) => [
              field,
              field === "owner" ? "spark233" : field === "repo" ? "example" : "示例",
            ]),
        ),
    );
    text = preview.missing.length
      ? `等待填写：${preview.missing.join("、")}`
      : (preview.url ?? `${entry.target}\n${JSON.stringify(preview.args)}`);
  } catch (value) {
    text = value instanceof Error ? value.message : String(value);
  }
  return (
    <div className="rounded-lg border p-4">
      <p className="mb-2 text-xs font-medium text-muted-foreground">打开预览</p>
      <pre className="whitespace-pre-wrap break-all font-mono text-xs leading-6">{text}</pre>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<QuickLinksPage />);

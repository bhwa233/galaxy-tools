import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { JsonValue, PluginActivation, PluginLauncherPage } from "../../sdk/src/index.js";
import type {
  BackendContext,
  BackendPlugin,
} from "../../../apps/desktop/electron/plugins/backend-worker.js";
import { atomicWrite } from "../../../apps/desktop/electron/persistence.js";
import type { QuickLink, QuickLinkResolution, QuickLinksState } from "./contract.js";
import { resolveTemplate, validateQuickLinks } from "./templates.js";

const normalize = (value: string) => value.normalize("NFKC").toLocaleLowerCase();
const revisionOf = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const maxSettingsBytes = 192 * 1024;
const link = (
  id: string,
  title: string,
  keyword: string,
  target: string,
  description: string,
): QuickLink => ({
  id,
  title,
  keyword,
  target,
  description,
  kind: "url",
  args: [],
  cwd: "",
  enabled: true,
});
const presets: QuickLink[] = [
  link("baidu", "百度", "bd", "https://www.baidu.com/s?wd={query}", "搜索网页"),
  link("bing", "必应", "bing", "https://www.bing.com/search?q={query}", "搜索网页"),
  link("google", "Google", "gg", "https://www.google.com/search?q={query}", "搜索网页"),
  link(
    "bilibili",
    "哔哩哔哩",
    "bili",
    "https://search.bilibili.com/all?keyword={query}",
    "搜索视频",
  ),
  link("github", "GitHub", "gh", "https://github.com/search?q={query}", "搜索代码与仓库"),
  link("zhihu", "知乎", "zh", "https://www.zhihu.com/search?type=content&q={query}", "搜索问答"),
  link("maps", "高德地图", "map", "https://www.amap.com/search?query={query}", "搜索地点"),
  link(
    "github-repository",
    "GitHub 仓库",
    "repo",
    "https://github.com/{owner}/{repo}",
    "填写 owner 和 repo 打开仓库",
  ),
  link(
    "obsidian",
    "Obsidian 笔记",
    "obs",
    "obsidian://open?vault={vault}&file={file}",
    "填写笔记库和文件名，需已安装 Obsidian",
  ),
];
const defaults = presets.slice(0, 6);

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("请求参数格式不正确");
  return value as Record<string, unknown>;
}

export default function quicklinksBackend(lifetime: BackendContext): BackendPlugin {
  const file = path.join(lifetime.dataDir, "quicklinks.json");
  let entries: QuickLink[] | undefined;
  let revision = "";
  let accepting = true;
  let saving = Promise.resolve();
  const acceptedSaves = new Set<Promise<JsonValue>>();
  const read = (): QuickLink[] | undefined => {
    try {
      const metadata = fs.lstatSync(file);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > maxSettingsBytes)
        throw new Error("配置必须是有效的普通文件且不超过 192 KiB");
      const bytes = fs.readFileSync(file);
      if (bytes.length > maxSettingsBytes) throw new Error("配置超过大小限制");
      const saved = object(JSON.parse(bytes.toString("utf8")));
      if (saved.version !== 1) throw new Error("配置版本不受支持");
      return validateQuickLinks(saved.entries);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new Error(
        `快捷入口配置无法读取，原文件已保留：${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  };
  const load = () => {
    if (entries) return;
    entries = read() ?? validateQuickLinks(defaults);
    revision = revisionOf(entries);
  };
  const snapshot = (): QuickLinksState => ({
    revision,
    entries: structuredClone(entries!),
    presets: structuredClone(presets),
  });
  const resolve = (input: Record<string, unknown>): QuickLinkResolution => {
    const entry = entries!.find((candidate) => candidate.id === input.id && candidate.enabled);
    if (!entry) throw new Error("快捷入口不存在或已停用，请重新选择");
    const entryRevision = revisionOf(entry);
    if (input.entryRevision !== undefined && input.entryRevision !== entryRevision)
      throw new Error("快捷入口已修改，请重新搜索或选择后执行");
    if (input.query !== undefined && typeof input.query !== "string")
      throw new Error("查询内容必须为文本");
    const query = (input.query as string | undefined) ?? "";
    const value = resolveTemplate(entry, query, input.values);
    if (value.missing.length)
      return {
        kind: "prompt",
        entry: structuredClone(entry),
        entryRevision,
        query,
        fields: value.fields,
        values: value.values,
      };
    if (entry.kind === "url") return { kind: "url", url: value.url! };
    return { kind: "program", path: entry.target, args: value.args!, cwd: entry.cwd };
  };
  const search = (input: Record<string, unknown>): PluginLauncherPage => {
    if (typeof input.query !== "string" || input.query.length > 4096)
      throw new Error("搜索内容过长或格式不正确");
    const limit = input.limit ?? 12;
    if (!Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 100)
      throw new Error("结果数量必须为 1 到 100");
    const text = input.query.trim();
    const needle = normalize(text);
    const first = text.match(/^(\S+)(?:\s+([\s\S]*))?$/u);
    const english = input.locale === "en-US";
    const matches = entries!
      .filter((entry) => entry.enabled)
      .flatMap((entry) => {
        const keyword = normalize(entry.keyword);
        const title = normalize(entry.title);
        const exact = !!first && (normalize(first[1]) === keyword || normalize(first[1]) === title);
        const score = exact
          ? 3
          : keyword.startsWith(needle)
            ? 2
            : title.includes(needle) || keyword.includes(needle)
              ? 1
              : 0;
        return score ? [{ entry, score, query: exact ? (first![2]?.trim() ?? "") : "" }] : [];
      })
      .sort((a, b) => b.score - a.score);
    return {
      items: matches.slice(0, limit as number).map(({ entry, query }) => ({
        id: entry.id,
        title: query ? `${entry.title} · ${query.slice(0, 160)}` : entry.title,
        description: `${entry.keyword} · ${entry.description || entry.target}`,
        kind: entry.kind === "url" ? "quicklink" : "application",
        commandId: "run",
        parameters: { id: entry.id, entryRevision: revisionOf(entry), query },
      })),
      ...(matches.length
        ? {
            hint: english
              ? "Keyword + space + content; Enter to open or fill parameters."
              : "关键词 + 空格 + 内容；回车打开，缺少参数时会显示填写界面。",
          }
        : {}),
    };
  };
  return {
    activate(activation: PluginActivation, context: BackendContext) {
      context.signal.throwIfAborted();
      if (!accepting) throw new Error("快捷入口正在停止，请稍后重试");
      load();
      const input = activation.parameters === undefined ? {} : object(activation.parameters);
      switch (activation.commandId) {
        case "settings.get":
          return snapshot() as unknown as JsonValue;
        case "settings.save": {
          const next = validateQuickLinks(input.entries);
          const expected = input.revision;
          const operation = saving.then(() => {
            context.signal.throwIfAborted();
            // A second window or external edit must never be silently overwritten.
            const disk = read() ?? validateQuickLinks(defaults);
            const diskRevision = revisionOf(disk);
            if (diskRevision !== revision) {
              entries = disk;
              revision = diskRevision;
            }
            if (expected !== revision) throw new Error("快捷入口配置已更新，请重新加载后再保存");
            const serialized = JSON.stringify({ version: 1, entries: next }, null, 2) + "\n";
            if (Buffer.byteLength(serialized) > maxSettingsBytes)
              throw new Error("快捷入口配置超过大小限制");
            atomicWrite(file, serialized);
            entries = next;
            revision = revisionOf(next);
            return snapshot() as unknown as JsonValue;
          });
          saving = operation.then(
            () => {},
            () => {},
          );
          acceptedSaves.add(operation);
          void operation.finally(() => acceptedSaves.delete(operation)).catch(() => {});
          return operation;
        }
        case "resolve":
          return resolve(input) as unknown as JsonValue;
        case "search":
          return search(input) as unknown as JsonValue;
        default:
          throw new Error("未知的快捷入口后台命令");
      }
    },
    async prepareStop() {
      accepting = false;
      while (acceptedSaves.size) await Promise.allSettled(acceptedSaves);
      await saving;
      return { ok: true };
    },
    cancelStop() {
      accepting = true;
    },
    async stop() {
      accepting = false;
      while (acceptedSaves.size) await Promise.allSettled(acceptedSaves);
      await saving;
    },
  };
}

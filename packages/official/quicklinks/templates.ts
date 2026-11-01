import type { QuickLink } from "./contract.js";

const placeholder = /\{([\p{L}_][\p{L}\p{N}_-]{0,39})\}/gu;
const forbiddenField = new Set(["__proto__", "prototype", "constructor"]);
const protocols = new Set([
  "http:",
  "https:",
  "vscode:",
  "vscode-insiders:",
  "obsidian:",
  "notion:",
  "zotero:",
  "mailto:",
]);
const controls = /\p{Cc}/u;
const maximumValueLength = 4096;

// 查过现有应用入口与 URL：前者只支持固定 argv，后者不处理占位符。
// Mustache 等通用模板库支持本插件不需要的控制流和任意上下文访问。
// 因此仅实现 {字段} 替换；URL 使用原生 URL 校验与 encodeURIComponent 编码。
function fieldsIn(template: string): string[] {
  const names = [...template.matchAll(placeholder)].map((match) => match[1]);
  if (
    /[{}]/u.test(template.replace(placeholder, "")) ||
    names.some((name) => forbiddenField.has(name))
  )
    throw new Error("占位符请使用 {query} 或 {字段名}，字段名不能包含空格或嵌套括号");
  return names;
}

export function templateFields(entry: QuickLink): string[] {
  return [...new Set((entry.kind === "url" ? [entry.target] : entry.args).flatMap(fieldsIn))];
}

export function assertQuickLinkUrl(value: string): string {
  if (value.length > 16384 || controls.test(value) || /\s/u.test(value))
    throw new Error("链接包含空白、控制字符或超过长度限制");
  const pathname = value.match(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*([^?#]*)/iu)?.[1];
  // URL normalizes literal and percent-encoded dot segments even when template
  // values were encoded. Refuse them before normalization can change a fixed path.
  if (pathname?.split("/").some((segment) => /^(?:\.|%2e){1,2}$/iu.test(segment)))
    throw new Error("链接路径参数不能形成 . 或 .. 目录跳转");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("链接格式不正确，请填写完整协议");
  }
  if (!protocols.has(url.protocol) || url.username || url.password)
    throw new Error("仅支持 HTTP、HTTPS 和常用应用链接，不能包含账号密码");
  if (["http:", "https:"].includes(url.protocol) && !url.hostname)
    throw new Error("网页链接必须包含固定域名");
  if (url.href.length > 16384) throw new Error("编码后的链接超过长度限制");
  return url.href;
}

function validateUrlTemplate(value: string): void {
  fieldsIn(value);
  const scheme = value.match(/^[a-z][a-z\d+.-]*:/iu)?.[0];
  if (!scheme) throw new Error("链接协议必须固定，例如 https://");
  if (
    value.includes("\\") ||
    (scheme.toLowerCase() !== "mailto:" && !value.slice(scheme.length).startsWith("//"))
  )
    throw new Error("链接必须使用完整的 协议:// 格式，不能包含反斜杠");
  const authority = value.slice(scheme.length).match(/^\/\/([^/?#]*)/u)?.[1];
  if (authority && /[{}]/u.test(authority))
    throw new Error("链接域名必须固定，参数只能放在路径或查询中");
  assertQuickLinkUrl(value.replace(placeholder, "spark233"));
}

function windowsPath(value: string): boolean {
  return (
    /^(?:[a-z]:[\\/]|\\\\[^\\/]+[\\/][^\\/]+)/iu.test(value) &&
    !controls.test(value) &&
    !/[{}<>"|?*]/u.test(value)
  );
}

function string(value: unknown, name: string, maximum: number, empty = false): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    controls.test(value) ||
    (!empty && !value.trim())
  )
    throw new Error(`${name}为空、包含控制字符或超过长度限制`);
  return value;
}

export function validateQuickLinks(value: unknown): QuickLink[] {
  if (!Array.isArray(value) || value.length > 200) throw new Error("最多支持 200 个快捷入口");
  const ids = new Set<string>();
  const keywords = new Set<string>();
  return value.map((raw): QuickLink => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      throw new Error("快捷入口格式不正确");
    const entry = raw as Record<string, unknown>;
    const id = string(entry.id, "入口标识", 100);
    if (!/^[a-z\d][a-z\d._-]*$/iu.test(id) || ids.has(id)) throw new Error("入口标识无效或重复");
    const title = string(entry.title, "名称", 160).trim();
    const keyword = string(entry.keyword, "关键词", 40).trim();
    if (/\s/u.test(keyword) || keywords.has(keyword.normalize("NFKC").toLocaleLowerCase()))
      throw new Error("关键词不能包含空格或与其他入口重复");
    const kind = entry.kind;
    if (kind !== "url" && kind !== "program") throw new Error("入口类型不正确");
    const target = string(entry.target, "目标", kind === "url" ? 8192 : 32768).trim();
    if (!Array.isArray(entry.args) || entry.args.length > 64) throw new Error("程序参数格式不正确");
    const args = entry.args.map((argument) => string(argument, "程序参数", 4096, true));
    if (args.join("").length > 24000) throw new Error("程序参数总长度超过限制");
    const cwd = string(entry.cwd, "工作目录", 32768, true).trim();
    const description = string(entry.description, "说明", 500, true).trim();
    if (typeof entry.enabled !== "boolean") throw new Error("启用状态不正确");
    if (kind === "url") {
      if (args.length || cwd) throw new Error("链接入口不能设置程序参数或工作目录");
      validateUrlTemplate(target);
    } else {
      if (!windowsPath(target) || !/\.exe$/iu.test(target) || (cwd && !windowsPath(cwd)))
        throw new Error("请选择固定的 EXE 绝对路径和有效工作目录，参数请放在下方参数列表");
    }
    const result: QuickLink = {
      id,
      title,
      keyword,
      kind,
      target,
      args,
      cwd,
      enabled: entry.enabled,
      description,
    };
    if (templateFields(result).length > 16) throw new Error("一个入口最多支持 16 个参数字段");
    ids.add(id);
    keywords.add(keyword.normalize("NFKC").toLocaleLowerCase());
    return result;
  });
}

export function resolveTemplate(entry: QuickLink, query = "", supplied: unknown = {}) {
  string(query, "查询内容", maximumValueLength, true);
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied))
    throw new Error("参数值格式不正确");
  const fields = templateFields(entry);
  const raw = supplied as Record<string, unknown>;
  if (Object.keys(raw).some((key) => key !== "query" && !fields.includes(key)))
    throw new Error("参数包含模板未声明的字段");
  const values: Record<string, string> = Object.create(null);
  for (const field of fields) {
    const value = field === "query" ? query : Object.hasOwn(raw, field) ? raw[field] : "";
    values[field] = string(value, `参数 ${field}`, maximumValueLength, true);
  }
  if (Object.values(values).join("").length > 24000) throw new Error("参数值总长度超过限制");
  const missing = fields.filter((field) => !values[field].trim());
  if (missing.length) return { fields, values, missing };
  const substitute = (template: string, encode: boolean) =>
    template.replace(placeholder, (_match, field: string) =>
      encode ? encodeURIComponent(values[field]) : values[field],
    );
  if (entry.kind === "url")
    return { fields, values, missing, url: assertQuickLinkUrl(substitute(entry.target, true)) };
  const args = entry.args.map((argument) => substitute(argument, false));
  if (args.some((argument) => argument.length > 4096) || args.join("").length > 24000)
    throw new Error("替换后的程序参数超过长度限制");
  return { fields, values, missing, args };
}

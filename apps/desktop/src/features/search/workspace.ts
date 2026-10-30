import uiConfiguration from "../../../../../packages/official/search/config/ui.json";
import type { SearchWorkspacePage, SearchWorkspaceRow } from "../../../shared/desktop-contract.js";

export type SearchMode = "files" | "content";
export type CategoryId =
  | "all"
  | "folder"
  | "excel"
  | "word"
  | "ppt"
  | "pdf"
  | "image"
  | "video"
  | "audio"
  | "archive";
export type SortField = "name" | "size" | "mtime";

/** Column headers only sort by fields the index orders natively. */
export const sortableColumns = ["name", "mtime", "size"] as const;

export type CategoryLabelKey =
  | "categoryAll"
  | "categoryFolder"
  | "categoryExcel"
  | "categoryWord"
  | "categoryPpt"
  | "categoryPdf"
  | "categoryImage"
  | "categoryVideo"
  | "categoryAudio"
  | "categoryArchive";

export const categories = uiConfiguration.categories as Array<{
  id: CategoryId;
  label: CategoryLabelKey;
}>;

export type SortLabelKey =
  | "sortRelevance"
  | "sortNameAsc"
  | "sortNameDesc"
  | "sortModifiedDesc"
  | "sortModifiedAsc"
  | "sortSizeDesc"
  | "sortSizeAsc";

export interface SortOption {
  id: string;
  field?: SortField;
  desc: boolean;
  label: SortLabelKey;
}
export const sortOptions = uiConfiguration.sortOptions as SortOption[];
/** First click on a header picks the direction that reads naturally. */
const defaultDescending: Record<SortField, boolean> = uiConfiguration.defaultDescending;

export function sortOptionId(field: SortField | undefined, desc: boolean): string {
  if (!field) return "relevance";
  return `${field}-${desc ? "desc" : "asc"}`;
}

/** Ascending, then descending, then back to relevance. */
export function nextSortOption(field: SortField, current: SortOption): SortOption {
  if (current.field !== field) return findSortOption(field, defaultDescending[field]);
  if (current.desc === defaultDescending[field])
    return findSortOption(field, !defaultDescending[field]);
  return findSortOption(undefined, false);
}

export function findSortOption(field: SortField | undefined, desc: boolean): SortOption {
  return (
    sortOptions.find((option) => option.field === field && option.desc === desc) ?? sortOptions[0]!
  );
}

/** Microsoft office formats only; anything else has no category. */
export type TypeLabelKey =
  | "typeFolder"
  | "typeExcel"
  | "typeWord"
  | "typePpt"
  | "typePdf"
  | "typeImage"
  | "typeVideo"
  | "typeAudio"
  | "typeArchive"
  | "typeCode"
  | "typeText"
  | "typeExecutable"
  | "typeFile";

const extensionTypes: Array<{ key: TypeLabelKey; extensions: string[] }> = [
  { key: "typeExcel", extensions: ["xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx"] },
  { key: "typeWord", extensions: ["doc", "docx", "docm", "dot", "dotx"] },
  { key: "typePpt", extensions: ["ppt", "pptx", "pptm", "pps", "ppsx", "pot", "potx"] },
  { key: "typePdf", extensions: ["pdf"] },
  {
    key: "typeImage",
    extensions: [
      "jpg",
      "jpeg",
      "png",
      "gif",
      "webp",
      "bmp",
      "svg",
      "heic",
      "tif",
      "tiff",
      "ico",
      "raw",
    ],
  },
  {
    key: "typeVideo",
    extensions: ["mp4", "mkv", "avi", "mov", "wmv", "webm", "flv", "m4v", "mpeg", "mpg"],
  },
  {
    key: "typeAudio",
    extensions: ["mp3", "wav", "flac", "aac", "ogg", "m4a", "wma", "aiff", "opus"],
  },
  {
    key: "typeArchive",
    extensions: ["zip", "7z", "rar", "tar", "gz", "tgz", "iso", "cab", "xz", "bz2"],
  },
  {
    key: "typeCode",
    extensions: [
      "c",
      "h",
      "cc",
      "cpp",
      "hpp",
      "cs",
      "java",
      "js",
      "jsx",
      "ts",
      "tsx",
      "py",
      "rs",
      "go",
      "php",
      "html",
      "htm",
      "css",
      "scss",
      "sql",
      "ps1",
      "json",
      "xml",
      "yml",
      "yaml",
      "toml",
    ],
  },
  {
    key: "typeText",
    extensions: ["txt", "md", "markdown", "log", "csv", "rtf", "ini", "conf", "cfg"],
  },
  { key: "typeExecutable", extensions: ["exe", "msi", "bat", "cmd", "com", "dll", "lnk"] },
];
const typeByExtension = new Map<string, TypeLabelKey>(
  extensionTypes.flatMap((group) => group.extensions.map((extension) => [extension, group.key])),
);

/** Type text is our own mapping: the shell's localized type names are not
 * reachable without per-row shell calls and vary by machine. */
export function fileTypeKey(row: SearchWorkspaceRow): TypeLabelKey {
  if (row.searchHit?.directory) return "typeFolder";
  const extension = row.searchHit?.extension ?? "";
  return (extension && typeByExtension.get(extension)) || "typeFile";
}

const fileTimeEpochMs = 11_644_473_600_000n;

/** Index timestamps are Windows FILETIME ticks (100 ns since 1601). */
export function fileTimeToMillis(value: string | undefined): number | undefined {
  if (!value || !/^\d{1,20}$/.test(value)) return undefined;
  return Number(BigInt(value) / 10_000n) - Number(fileTimeEpochMs);
}

const dateFormatters = new Map<string, Intl.DateTimeFormat>();

export function formatFileTime(value: string | undefined, locale: string): string {
  const millis = fileTimeToMillis(value);
  if (millis === undefined) return "";
  const date = new Date(millis);
  if (Number.isNaN(date.getTime())) return "";
  let formatter = dateFormatters.get(locale);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" });
    dateFormatters.set(locale, formatter);
  }
  return formatter.format(date);
}

export function formatFileSize(value: string | undefined, directory: boolean): string {
  if (directory || !value) return "";
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let scaled = bytes / 1024;
  let unit = 0;
  while (scaled >= 1024 && unit < units.length - 1) {
    scaled /= 1024;
    unit += 1;
  }
  return `${scaled < 10 ? scaled.toFixed(1) : Math.round(scaled)} ${units[unit]}`;
}

export function parentDirectory(value: string | undefined): string {
  if (!value) return "";
  const index = Math.max(value.lastIndexOf("\\"), value.lastIndexOf("/"));
  return index > 0 ? value.slice(0, index) : value;
}

/** Case-insensitive literal highlight; pinyin hits have no literal to mark. */
export function highlightSegments(name: string, needle: string): Array<[string, boolean]> {
  const trimmed = needle.trim();
  if (!trimmed) return [[name, false]];
  const lowerName = name.toLowerCase();
  const lowerNeedle = trimmed.toLowerCase();
  const segments: Array<[string, boolean]> = [];
  let cursor = 0;
  for (;;) {
    const found = lowerName.indexOf(lowerNeedle, cursor);
    if (found < 0) break;
    if (found > cursor) segments.push([name.slice(cursor, found), false]);
    segments.push([name.slice(found, found + lowerNeedle.length), true]);
    cursor = found + lowerNeedle.length;
  }
  if (!segments.length) return [[name, false]];
  if (cursor < name.length) segments.push([name.slice(cursor), false]);
  return segments;
}

export function emptyPage(): SearchWorkspacePage {
  return { total: 0, approximate: false, hasMore: false };
}

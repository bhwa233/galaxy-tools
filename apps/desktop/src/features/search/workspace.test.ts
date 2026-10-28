import { describe, expect, it } from "vitest";
import type { SearchWorkspaceRow } from "../../../shared/desktop-contract.js";
import {
  fileTimeToMillis,
  fileTypeKey,
  formatFileSize,
  highlightSegments,
  nextSortOption,
  parentDirectory,
  sortOptions,
} from "./workspace";

const relevance = sortOptions.find((option) => option.id === "relevance")!;

function row(hit: Partial<NonNullable<SearchWorkspaceRow["searchHit"]>> = {}): SearchWorkspaceRow {
  const name = hit.name ?? "report.txt";
  return {
    id: "row",
    title: name,
    searchHit: {
      name,
      path: hit.path ?? "D:\\work\\report.txt",
      directory: hit.directory ?? false,
      ...(hit.size === undefined ? {} : { size: hit.size }),
      ...(hit.modified === undefined ? {} : { modified: hit.modified }),
      extension: hit.extension ?? "txt",
    },
  };
}

describe("file type labels", () => {
  it("maps Microsoft office formats apart", () => {
    expect(fileTypeKey(row({ extension: "docx" }))).toBe("typeWord");
    expect(fileTypeKey(row({ extension: "xlsm" }))).toBe("typeExcel");
    expect(fileTypeKey(row({ extension: "pptx" }))).toBe("typePpt");
    expect(fileTypeKey(row({ extension: "pdf" }))).toBe("typePdf");
  });

  it("falls back to a generic file for unknown extensions", () => {
    expect(fileTypeKey(row({ extension: "weird" }))).toBe("typeFile");
    expect(fileTypeKey(row({ extension: "" }))).toBe("typeFile");
  });

  it("keeps folders distinct from files", () => {
    expect(fileTypeKey(row({ directory: true, extension: "" }))).toBe("typeFolder");
  });
});

describe("result formatting", () => {
  it("formats sizes with one decimal below ten units", () => {
    expect(formatFileSize("512", false)).toBe("512 B");
    expect(formatFileSize("2048", false)).toBe("2.0 KB");
    expect(formatFileSize("1572864", false)).toBe("1.5 MB");
  });

  it("leaves folder sizes empty", () => {
    expect(formatFileSize("0", true)).toBe("");
    expect(formatFileSize(undefined, false)).toBe("");
  });

  it("converts Windows file time to Unix milliseconds", () => {
    const unixMs = Date.UTC(2026, 0, 13, 2, 4, 0);
    const fileTime = ((BigInt(unixMs) + 11_644_473_600_000n) * 10_000n).toString();
    expect(fileTimeToMillis(fileTime)).toBe(unixMs);
    expect(fileTimeToMillis(undefined)).toBeUndefined();
    expect(fileTimeToMillis("not-a-time")).toBeUndefined();
  });

  it("derives the containing directory", () => {
    expect(parentDirectory("D:\\work\\report.txt")).toBe("D:\\work");
    expect(parentDirectory(undefined)).toBe("");
  });
});

describe("column sorting", () => {
  it("cycles ascending, descending, then relevance", () => {
    const ascending = nextSortOption("name", relevance);
    expect(ascending.id).toBe("name-asc");
    const descending = nextSortOption("name", ascending);
    expect(descending.id).toBe("name-desc");
    expect(nextSortOption("name", descending).id).toBe("relevance");
  });

  it("starts modification time with the newest entry", () => {
    expect(nextSortOption("mtime", relevance).id).toBe("mtime-desc");
  });

  it("starts size with the largest entry", () => {
    expect(nextSortOption("size", relevance).id).toBe("size-desc");
  });
});

describe("match highlighting", () => {
  it("marks literal matches only", () => {
    expect(highlightSegments("report.xlsx", "xls")).toEqual([
      ["report.", false],
      ["xls", true],
      ["x", false],
    ]);
  });

  it("leaves a name unmarked when nothing matches", () => {
    expect(highlightSegments("report.xlsx", "预算")).toEqual([["report.xlsx", false]]);
    expect(highlightSegments("report.xlsx", "  ")).toEqual([["report.xlsx", false]]);
  });
});

import { describe, expect, it } from "vitest";
import { searchQueryWithCategory } from "./search-commands.js";

describe("search workspace category tokens", () => {
  it("appends a Microsoft office extension filter", () => {
    expect(searchQueryWithCategory("季度报表", "excel")).toBe("季度报表 ext:xls;xlsx;xlsm;xlsb");
    expect(searchQueryWithCategory("合同", "word")).toBe("合同 ext:doc;docx;docm");
  });

  it("uses the index kind tokens for broad categories", () => {
    expect(searchQueryWithCategory("照片", "image")).toBe("照片 type:image");
    expect(searchQueryWithCategory("", "folder")).toBe("type:folder");
  });

  it("leaves the query untouched for the all category", () => {
    expect(searchQueryWithCategory("  报表  ", "all")).toBe("报表");
    expect(searchQueryWithCategory("  报表  ")).toBe("报表");
  });

  it("ignores categories for content searches", () => {
    expect(searchQueryWithCategory("报表", "excel", "content")).toBe("报表");
    expect(searchQueryWithCategory("报表", "folder", "files")).toBe("报表 type:folder");
  });

  it("keeps the native request inside the needle limit", () => {
    const long = "字".repeat(9000);
    const value = searchQueryWithCategory(long, "excel");
    expect(value.length).toBeLessThanOrEqual(8192);
    expect(value.endsWith("ext:xls;xlsx;xlsm;xlsb")).toBe(true);
  });
});

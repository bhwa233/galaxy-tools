import { describe, expect, it } from "vitest";
import {
  buildPreview,
  countNoteChars,
  filterNotes,
  getDisplayTitle,
  groupNotesByCategory,
} from "./noteUtils";
import type { NoteMetadata } from "./types";

const notes: NoteMetadata[] = [
  {
    id: "1",
    title: "读书笔记",
    fileName: "1.md",
    category: "",
    createdAt: "2026-04-28T01:00:00Z",
    updatedAt: "2026-04-28T01:00:00Z",
    wordCount: 20,
    preview: "关于月亮与六便士",
  },
  {
    id: "2",
    title: "",
    fileName: "2.md",
    category: "日常",
    createdAt: "2026-04-28T02:00:00Z",
    updatedAt: "2026-04-28T02:00:00Z",
    wordCount: 12,
    preview: "周末采购清单",
  },
];

describe("note utilities", () => {
  it("uses title, preview, then untitled fallback for display title", () => {
    expect(getDisplayTitle(notes[0])).toBe("读书笔记");
    expect(getDisplayTitle(notes[1])).toBe("周末采购清单");
    expect(getDisplayTitle({ ...notes[1], preview: "" })).toBe("无标题便签");
  });

  it("builds compact previews and counts non-whitespace characters", () => {
    const content = "# 标题\n\n正文 第一行\n第二行";

    expect(buildPreview(content)).toBe("# 标题 正文 第一行 第二行");
    expect(countNoteChars(content)).toBe(11);
  });

  it("filters notes by title, preview, or file name without case sensitivity", () => {
    expect(filterNotes(notes, "读书").map((note) => note.id)).toEqual(["1"]);
    expect(filterNotes(notes, "采购").map((note) => note.id)).toEqual(["2"]);
    expect(filterNotes(notes, "2.MD").map((note) => note.id)).toEqual(["2"]);
    expect(filterNotes(notes, "   ").map((note) => note.id)).toEqual(["1", "2"]);
  });

  it("ranks pinned entries only inside their original category, then uses modification time", () => {
    const fixture = [
      { ...notes[0], id: "a-new", category: "A", updatedAt: "2026-10-03" },
      { ...notes[0], id: "a-old-pin", category: "A", updatedAt: "2026-10-01" },
      { ...notes[0], id: "a-new-pin", category: "A", updatedAt: "2026-10-02" },
      { ...notes[0], id: "b-pin", category: "B", updatedAt: "2026-10-04" },
      { ...notes[0], id: "uncategorized", category: "", updatedAt: "2026-10-05" },
    ];
    const groups = groupNotesByCategory(
      fixture,
      ["A", "B"],
      new Set(["a-old-pin", "a-new-pin", "b-pin"]),
    );
    expect(groups.find((g) => g.category === "A")?.notes.map((n) => n.id)).toEqual([
      "a-new-pin",
      "a-old-pin",
      "a-new",
    ]);
    expect(groups.find((g) => g.category === "A")?.latestUpdatedAt).toBe("2026-10-03");
    expect(groups.find((g) => g.category === "B")?.notes.map((n) => n.id)).toEqual(["b-pin"]);
    expect(groups.flatMap((g) => g.notes)).toHaveLength(fixture.length);
    expect(groups.find((g) => g.category === "")?.notes[0].id).toBe("uncategorized");
  });

  it("includes empty categories from allCategories list", () => {
    const groups = groupNotesByCategory(notes, ["日常", "工作"]);
    const categoryNames = groups.map((g) => g.category);
    expect(categoryNames).toContain("工作");
    const workGroup = groups.find((g) => g.category === "工作");
    expect(workGroup?.notes).toEqual([]);
  });
});

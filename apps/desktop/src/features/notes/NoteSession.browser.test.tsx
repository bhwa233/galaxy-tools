import { expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { MainWindow } from "./MainWindow";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import type { Note, SaveNoteRequest } from "./types";

// Regression: failed saves and edits arriving during a save/load used to be
// overwritten by note selection and open-external-file events.
it("keeps the active draft on save failure and rejects a stale document load", async () => {
  const first: Note = {
    id: "first",
    title: "第一篇",
    content: "original",
    category: "",
    fileName: "first.md",
    createdAt: "2026-10-28",
    updatedAt: "2026-10-28",
    wordCount: 8,
  };
  const second: Note = { ...first, id: "second", title: "第二篇", content: "second" };
  const notes = [first, second];
  let failSave = true;
  let finishSave: (() => void) | undefined;
  let delaySave = false;
  let finishLoad: (() => void) | undefined;
  let delayLoad = false;
  const desktop = installDesktopBridge({
    config_get: () => ({
      defaultViewMode: "edit",
      noteAutoSave: false,
      externalFileAutoSave: false,
    }),
    notes_list: () => notes.map((note) => ({ ...note, preview: note.content })),
    categories_list: () => [],
    note_window_states: () => ({ version: 0, notes: [] }),
    reminders_list: () => [],
    images_get_base_dir: () => "isolated/images",
    take_startup_file: () => null,
    update_status: () => ({ status: "idle", currentVersion: "1.2.0" }),
    window_control: () => false,
    notes_get: async (args) => {
      if (delayLoad)
        await new Promise<void>((resolve) => {
          finishLoad = resolve;
        });
      return notes.find((note) => note.id === (args as { id: string }).id);
    },
    notes_update: async (args) => {
      if (failSave) throw new Error("fixture disk full");
      if (delaySave)
        await new Promise<void>((resolve) => {
          finishSave = resolve;
        });
      const { id, request } = args as { id: string; request: SaveNoteRequest };
      const note = notes.find((entry) => entry.id === id)!;
      Object.assign(note, request);
      return note;
    },
    read_external_file: (args) => `external ${(args as { path: string }).path}`,
    get_file_modified_time: () => 1,
  });
  const view = await render(<MainWindow />);
  try {
    const editor = page.getByPlaceholder("开始写作……");
    await expect.element(editor).toHaveValue("original");
    await editor.fill("local draft");
    await page.getByText("第二篇", { exact: true }).click();
    await expect
      .poll(() => desktop.calls.filter((call) => call.command === "notes_update").length)
      .toBe(1);
    await expect.element(editor).toHaveValue("local draft");
    desktop.emit("open-external-file", "C:/isolated/external.md");
    await expect
      .poll(() => desktop.calls.filter((call) => call.command === "notes_update").length)
      .toBe(2);
    expect(desktop.calls.some((call) => call.command === "read_external_file")).toBe(false);
    failSave = false;
    delaySave = true;
    await page.getByText("第二篇", { exact: true }).click();
    await expect.poll(() => Boolean(finishSave)).toBe(true);
    await editor.fill("newer draft during save");
    finishSave!();
    await expect.element(editor).toHaveValue("newer draft during save");
    delaySave = false;
    delayLoad = true;
    await page.getByText("第二篇", { exact: true }).click();
    await expect.poll(() => Boolean(finishLoad)).toBe(true);
    await editor.fill("newer draft during load");
    finishLoad!();
    await expect.element(editor).toHaveValue("newer draft during load");
    delayLoad = false;
    await page.getByText("第二篇", { exact: true }).click();
    await expect.element(editor).toHaveValue("second");
    expect(first.content).toBe("newer draft during load");
    window.spark233Desktop!.droppedPaths = async () => [
      "C:/isolated/drop-one.md",
      "C:/isolated/drop-two.md",
    ];
    const transfer = new DataTransfer();
    transfer.items.add(new File(["first"], "drop-one.md"));
    transfer.items.add(new File(["second"], "drop-two.md"));
    document.dispatchEvent(
      new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
    await expect
      .element(page.getByRole("button", { name: "drop-one C:/isolated/drop-one", exact: false }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "drop-two C:/isolated/drop-two", exact: false }))
      .toBeVisible();
    await expect.element(editor).toHaveValue("external C:/isolated/drop-two.md");
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

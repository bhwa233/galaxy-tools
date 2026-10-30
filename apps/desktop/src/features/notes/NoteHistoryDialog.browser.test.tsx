import { it, expect } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { NoteHistoryDialog } from "./NoteHistoryDialog";

it("blocks restoration after save refusal and keeps the preview on a revision conflict", async () => {
  const versionId = "01234567-1234-4234-8234-012345678901";
  let saved = false,
    conflict = true,
    closed = false;
  const desktop = installDesktopBridge({
    notes_history: () => ({
      entries: [{ versionId, savedAt: "2026-10-30T00:00:00Z", title: "Previous", bytes: 12 }],
      currentRevision: "a".repeat(64),
    }),
    notes_revision: () => ({ title: "Previous", content: "previous text", category: "" }),
    notes_history_restore: () => {
      if (conflict) throw new Error("owned revision conflict");
      return {
        id: "note",
        title: "Previous",
        content: "previous text",
        category: "",
        createdAt: "",
        updatedAt: "",
        wordCount: 12,
      };
    },
  });
  const view = await render(
    <NoteHistoryDialog
      noteId="note"
      onClose={() => {
        closed = true;
      }}
      beforeRestore={async () => saved}
      onRestored={() => {}}
    />,
  );
  try {
    await page.getByRole("button", { name: /Previous/ }).click();
    await expect
      .element(page.getByRole("textbox", { name: "历史正文预览" }))
      .toHaveValue("previous text");
    await page.getByRole("button", { name: "恢复此版本", exact: true }).click();
    expect(desktop.calls.some((call) => call.command === "notes_history_restore")).toBe(false);
    saved = true;
    await page.getByRole("button", { name: "恢复此版本", exact: true }).click();
    await expect.element(page.getByText("owned revision conflict", { exact: true })).toBeVisible();
    expect(closed).toBe(false);
    await expect
      .element(page.getByRole("textbox", { name: "历史正文预览" }))
      .toHaveValue("previous text");
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/functional-note-history.png",
    });
    conflict = false;
    await page.getByRole("button", { name: "恢复此版本", exact: true }).click();
    await expect.poll(() => closed).toBe(true);
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

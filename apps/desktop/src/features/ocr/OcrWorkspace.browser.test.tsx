import { it, expect } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { installDesktopBridge } from "../../test/browser/desktop-bridge";
import { OcrWorkspace } from "./OcrWorkspace";
import { prepareHostWindow } from "../windows/hostPreparation";
import { selectionUnits } from "./OcrImage";
import type { OcrSession, OcrDocument } from "../../../shared/ocr-sessions";
const box = [
  [0, 0],
  [10, 0],
  [10, 10],
  [0, 10],
];
const result: OcrSession = {
  sessionId: "0123456789abcdef0123456789abcdef",
  text: "hello",
  width: 100,
  height: 30,
  source: { id: "owned-image" },
  createdAt: "2026-10-30T00:00:00Z",
  lines: [
    {
      text: "hello",
      box,
      characters: [
        { text: "h", box },
        { text: "ello", box },
      ],
    },
  ],
};

it("keeps edits on failed host preparation and restores a saved OCR draft", async () => {
  let refused = true,
    saved: OcrDocument | undefined;
  let holdSave = false,
    releaseSave: (() => void) | undefined;
  const desktop = installDesktopBridge({
    window_control: () => false,
    ocr_action: async (args) => {
      const request = args as { action: string; document: OcrDocument };
      if (request.action === "list")
        return [
          {
            sessionId: result.sessionId,
            title: "hello",
            createdAt: result.createdAt,
            edited: !!saved,
          },
        ];
      if (request.action === "get") return { ...result, draft: saved };
      if (request.action === "save") {
        if (refused) throw new Error("owned save failure");
        if (holdSave) {
          holdSave = false;
          await new Promise<void>((resolve) => {
            releaseSave = resolve;
          });
        }
        saved = request.document;
        return { ...result, draft: saved };
      }
      throw new Error("Unexpected OCR action");
    },
  });
  let view = await render(
    <OcrWorkspace
      initialResult={result}
      availableTargets={{ notes: true, dictionary: true, translate: true }}
      onClose={() => {}}
      onResult={() => {}}
    />,
  );
  try {
    await expect.element(page.getByRole("textbox")).toHaveValue("hello");
    await page.getByRole("textbox").fill("corrected text");
    await expect(prepareHostWindow()).rejects.toThrow();
    await expect.element(page.getByRole("textbox")).toHaveValue("corrected text");
    refused = false;
    await prepareHostWindow();
    expect(saved?.text).toBe("corrected text");
    holdSave = true;
    await page.getByRole("textbox").fill("intermediate text");
    const preparation = prepareHostWindow();
    await expect.poll(() => typeof releaseSave).toBe("function");
    await page.getByRole("textbox").fill("corrected text");
    releaseSave!();
    await preparation;
    expect(saved?.text).toBe("corrected text");
    await view.unmount();
    view = await render(
      <OcrWorkspace
        initialResult={result}
        availableTargets={{ notes: true, dictionary: true, translate: true }}
        onClose={() => {}}
        onResult={() => {}}
      />,
    );
    await expect.element(page.getByRole("textbox")).toHaveValue("corrected text");
    const units = selectionUnits(result, { text: "hello", ranges: [{ start: 0, end: 5 }] });
    expect(units.map(({ start, end }) => [start, end])).toEqual([
      [0, 1],
      [1, 5],
    ]);
    expect(selectionUnits(result, { text: "edited", ranges: [{ start: 0, end: 6 }] })).toHaveLength(
      1,
    );
    await page.getByRole("button", { name: "放大", exact: true }).click();
    await page.screenshot({
      path: "../../../../../local-build/browser-ui/screenshots/functional-ocr.png",
    });
    await expect.element(page.getByRole("textbox")).toHaveValue("corrected text");
  } finally {
    await view.unmount();
    desktop.restore();
  }
});

import fs from "node:fs";
import { z } from "zod";
import { atomicWrite, confined } from "../../persistence.js";
import type { OcrSession, OcrDocument, OcrSessionSummary } from "../../../shared/ocr-sessions.js";
const sessionId = z.string().regex(/^(?:[a-f\d]{32}|[a-f\d]{8}-(?:[a-f\d]{4}-){3}[a-f\d]{12})$/i);
const document = z
  .object({
    text: z.string().max(4 * 1024 * 1024),
    ranges: z
      .array(
        z
          .object({ start: z.number().int().nonnegative(), end: z.number().int().nonnegative() })
          .nullable(),
      )
      .max(50000),
  })
  .superRefine((value, ctx) => {
    if (
      value.ranges.some(
        (range) => range && (range.start > range.end || range.end > value.text.length),
      )
    )
      ctx.addIssue({ code: "custom", message: "Invalid OCR text ranges" });
  });
const result = z.object({
  sessionId,
  text: z.string().max(4 * 1024 * 1024),
  width: z.number().positive(),
  height: z.number().positive(),
  source: z.object({ id: z.string() }),
  lines: z
    .array(
      z.object({
        text: z.string(),
        box: z.array(z.array(z.number().finite()).length(2)).length(4),
        characters: z
          .array(
            z.object({
              text: z.string(),
              box: z.array(z.array(z.number().finite()).length(2)).length(4),
            }),
          )
          .max(50000)
          .optional(),
      }),
    )
    .max(50000),
  draft: document.optional(),
  createdAt: z.string(),
});
/** Existing capture outputs are temporary and retired by the native controller.
 * Keep recoverable edits and their image together in the plugin's backup domain. */
export class OcrSessions {
  private root: string;
  constructor(dataDir: string) {
    this.root = confined(dataDir, "workspace-sessions");
    fs.mkdirSync(this.root, { recursive: true });
  }
  private directory(id: string) {
    return confined(this.root, sessionId.parse(id));
  }
  get(id: string): OcrSession {
    const record = confined(this.directory(id), "record.json");
    if (fs.statSync(record).size > 64 * 1024 * 1024) throw new Error("OCR session is too large");
    const value = result.parse(JSON.parse(fs.readFileSync(record, "utf8")));
    if (value.sessionId !== id || value.source.id !== `ocr-history:${id}`)
      throw new Error("OCR session identity changed");
    return value;
  }
  image(id: string) {
    return confined(this.directory(id), "image.png");
  }
  list(): OcrSessionSummary[] {
    return fs
      .readdirSync(this.root)
      .filter((name) => sessionId.safeParse(name).success)
      .map((id) => {
        const value = this.get(id);
        return {
          sessionId: id,
          title: value.text.replace(/\s+/g, " ").slice(0, 48),
          createdAt: value.createdAt,
          edited: !!value.draft,
        };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  remember(input: Omit<OcrSession, "createdAt">, image: string): OcrSession {
    const value = result.parse({
      ...input,
      source: { id: `ocr-history:${input.sessionId}` },
      createdAt: new Date().toISOString(),
    });
    const directory = this.directory(value.sessionId);
    if (fs.existsSync(confined(directory, "record.json"))) return this.get(value.sessionId);
    fs.mkdirSync(directory, { recursive: true });
    try {
      atomicWrite(this.image(value.sessionId), fs.readFileSync(image));
      atomicWrite(confined(directory, "record.json"), JSON.stringify(value));
    } catch (error) {
      fs.rmSync(directory, { recursive: true, force: true });
      throw error;
    }
    // Edited sessions remain until explicit removal; only old unedited results expire.
    for (const entry of this.list()
      .filter((entry) => !entry.edited && entry.sessionId !== value.sessionId)
      .slice(19))
      this.remove(entry.sessionId);
    return value;
  }
  save(id: string, input: OcrDocument): OcrSession {
    const value = this.get(id),
      draft = document.parse(input);
    if (draft.ranges.length !== value.lines.length) throw new Error("OCR line count changed");
    const next = { ...value, draft };
    atomicWrite(confined(this.directory(id), "record.json"), JSON.stringify(next));
    return next;
  }
  remove(id: string) {
    fs.rmSync(this.directory(id), { recursive: true, force: true });
  }
}

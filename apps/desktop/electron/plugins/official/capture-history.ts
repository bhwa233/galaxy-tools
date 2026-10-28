import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite, canonical, confined } from "../../persistence.js";

/** Which native completion produced the image. Retained for display only. */
export const captureActions = ["copy", "save", "ocr"] as const;
export type CaptureAction = (typeof captureActions)[number];

const entry = z.object({
  id: z.string().regex(/^[\da-f]{32}$/),
  createdAt: z.number().int().nonnegative(),
  width: z.number().int().positive().max(65536),
  height: z.number().int().positive().max(65536),
  size: z.number().int().nonnegative(),
  action: z.enum(captureActions),
});
const index = z.object({ protocol: z.literal(1), entries: z.array(entry).max(500) });
export type CaptureHistoryEntry = z.infer<typeof entry>;

/**
 * Bounded, newest-first record of completed screenshots. One image per entry, and
 * the oldest image is deleted before its index entry so a crash can only leave a
 * stale row, never a file without a row.
 */
export class CaptureHistory {
  private readonly root: string;
  private readonly images: string;
  private readonly indexFile: string;
  private readonly maxEntries: number;
  constructor(dataDir: string, options: { maxEntries?: number } = {}) {
    this.root = confined(canonical(dataDir), "history");
    this.images = confined(this.root, "images");
    this.indexFile = confined(this.root, "index.json");
    this.maxEntries = z
      .number()
      .int()
      .min(1)
      .max(500)
      .parse(options.maxEntries ?? 50);
    fs.mkdirSync(this.images, { recursive: true });
  }
  list(): CaptureHistoryEntry[] {
    return this.read().filter((item) => fs.existsSync(this.file(item.id)));
  }
  /** Store a completed screenshot; returns undefined when the copy cannot be made. */
  add(
    source: string,
    meta: { width: number; height: number; action: CaptureAction },
  ): CaptureHistoryEntry | undefined {
    const real = fs.realpathSync(source),
      size = fs.statSync(real).size;
    if (size < 24 || size > 128 * 1024 * 1024) return;
    const id = randomUUID().replaceAll("-", "");
    const entry: CaptureHistoryEntry = {
      id,
      createdAt: Date.now(),
      width: meta.width,
      height: meta.height,
      size,
      action: meta.action,
    };
    fs.copyFileSync(real, this.file(id), fs.constants.COPYFILE_EXCL);
    // A damaged index must not block recording; the fresh entry wins over history.
    const entries = [entry, ...this.read().filter((item) => item.id !== id)];
    this.write(entries);
    this.trim(entries);
    return entry;
  }
  file(id: string): string {
    return confined(this.images, `${entry.shape.id.parse(id)}.png`);
  }
  remove(id: string): boolean {
    const entries = this.read();
    const remaining = entries.filter((item) => item.id !== id);
    if (remaining.length === entries.length) return false;
    fs.rmSync(this.file(id), { force: true });
    this.write(remaining);
    return true;
  }
  clear(): void {
    for (const item of this.read()) fs.rmSync(this.file(item.id), { force: true });
    this.write([]);
  }
  private read(): CaptureHistoryEntry[] {
    try {
      const parsed = index.parse(JSON.parse(fs.readFileSync(this.indexFile, "utf8")));
      return parsed.entries;
    } catch {
      return [];
    }
  }
  private write(entries: CaptureHistoryEntry[]): void {
    atomicWrite(this.indexFile, JSON.stringify({ protocol: 1, entries }));
  }
  private trim(entries: CaptureHistoryEntry[]): void {
    for (const item of entries.slice(this.maxEntries)) {
      fs.rmSync(this.file(item.id), { force: true });
    }
    if (entries.length > this.maxEntries) this.write(entries.slice(0, this.maxEntries));
  }
}

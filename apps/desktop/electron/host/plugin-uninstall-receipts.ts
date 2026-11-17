import fs from "node:fs";
import { z } from "zod";
import { AppError, atomicWrite, readJson } from "../persistence.js";

const receiptSchema = z.strictObject({
  id: z.uuid(),
  pluginId: z.string().min(1).max(200),
});
const receiptsSchema = z
  .strictObject({
    version: z.literal(1),
    receipts: z.array(receiptSchema).max(512),
  })
  .refine(
    (value) => new Set(value.receipts.map((receipt) => receipt.id)).size === value.receipts.length,
    "Duplicate uninstall receipt",
  );
type Receipt = z.infer<typeof receiptSchema>;

/** Reuse the layout store's atomic writer and damaged-file protection. A layout
 * intent cannot prove a separate manager mutation committed, so this small
 * success ledger is written only after uninstall has removed code and data.
 * Installation-index absence is deliberately never accepted as a receipt. */
export class PluginUninstallReceipts {
  private state: z.infer<typeof receiptsSchema> = { version: 1, receipts: [] };
  readError?: unknown;

  constructor(private readonly file: string) {
    try {
      if (fs.existsSync(file)) {
        if (fs.statSync(file).size > 256 * 1024)
          throw new Error("Uninstall receipts exceed 256 KiB");
        this.state = receiptsSchema.parse(readJson(file));
      }
    } catch (error) {
      this.readError = error;
    }
  }

  reload(): void {
    const next = new PluginUninstallReceipts(this.file);
    if (next.readError)
      throw new AppError(
        "window.uninstallReceiptsUnreadable",
        "卸载提交记录无法读取，原文件已保留",
      );
    this.state = next.state;
    this.readError = undefined;
  }

  record(receipt: Receipt): void {
    const checked = receiptSchema.parse({ id: receipt.id, pluginId: receipt.pluginId });
    const previous = this.state.receipts.find((value) => value.id === checked.id);
    if (previous) {
      if (previous.pluginId !== checked.pluginId)
        throw new AppError("window.uninstallReceiptMismatch", "卸载提交记录不属于此插件");
      return;
    }
    this.commit([...this.state.receipts, checked]);
  }

  outcome(intent: Receipt): "removed" | "unknown" {
    if (this.readError) return "unknown";
    return this.state.receipts.some(
      (value) => value.id === intent.id && value.pluginId === intent.pluginId,
    )
      ? "removed"
      : "unknown";
  }

  /** Keep only receipts still referenced by durable cleanup intents. Never evict
   * a pending receipt merely to make room for a newer uninstall. */
  retain(activeIntentIds: ReadonlySet<string>): void {
    const next = this.state.receipts.filter((value) => activeIntentIds.has(value.id));
    if (next.length !== this.state.receipts.length) this.commit(next);
  }

  private commit(receipts: Receipt[]): void {
    if (this.readError)
      throw new AppError(
        "window.uninstallReceiptsUnreadable",
        "卸载提交记录无法读取，原文件已保留",
      );
    const next = receiptsSchema.parse({ version: 1, receipts });
    atomicWrite(this.file, JSON.stringify(next));
    this.state = next;
  }
}

import { randomUUID } from "node:crypto";
import { AppError } from "./persistence.js";

interface SnapshotSelection {
  directory: string;
  manifestFingerprint: string;
}
interface Selection extends SnapshotSelection {
  caller: string;
  createdAt: number;
  restoring: boolean;
}

// Extracted from Main's existing maps. File/resource grants cannot represent a
// verified backup manifest or its in-flight restore; keep this authority local
// to backup previews, without another permission framework or dependency.
export class BackupSelections {
  private selections = new Map<string, Selection>();
  private inspections = new Map<string, symbol>();

  beginInspection(caller: string): symbol {
    this.revokeCaller(caller);
    const request = Symbol();
    this.inspections.set(caller, request);
    return request;
  }

  isInspectionCurrent(caller: string, request: symbol): boolean {
    return this.inspections.get(caller) === request;
  }

  register(caller: string, request: symbol, snapshot: SnapshotSelection): string {
    if (!this.isInspectionCurrent(caller, request)) throw this.changed();
    this.inspections.delete(caller);
    const now = Date.now();
    for (const [id, selection] of this.selections)
      if (now - selection.createdAt > 10 * 60 * 1000) this.selections.delete(id);
    const id = randomUUID();
    this.selections.set(id, { ...snapshot, caller, createdAt: now, restoring: false });
    return id;
  }

  revokeCaller(caller: string): void {
    this.inspections.delete(caller);
    for (const [id, selection] of this.selections)
      if (selection.caller === caller) this.selections.delete(id);
  }

  release(caller: string, id: string): void {
    this.owned(caller, id);
    this.selections.delete(id);
  }

  async restore<T>(
    caller: string,
    id: string,
    restore: (directory: string, manifestFingerprint: string) => Promise<T>,
  ): Promise<T> {
    const selection = this.owned(caller, id);
    if (!selection || Date.now() - selection.createdAt > 10 * 60 * 1000) {
      this.selections.delete(id);
      throw this.changed();
    }
    if (selection.restoring) throw new AppError("maintenance", "正在恢复此备份，请等待完成");
    selection.restoring = true;
    try {
      const report = await restore(selection.directory, selection.manifestFingerprint);
      this.selections.delete(id);
      return report;
    } finally {
      // An accepted transaction finishes even if its document is retired. A
      // recoverable save refusal leaves the original, still-owned token retryable.
      selection.restoring = false;
    }
  }

  private owned(caller: string, id: string): Selection | undefined {
    const selection = this.selections.get(id);
    if (selection && selection.caller !== caller)
      throw new AppError("permissionDenied", "备份选择不属于当前界面");
    return selection;
  }

  private changed(): AppError {
    return new AppError("backupSelectionChanged", "备份选择已失效，请重新检查备份");
  }
}

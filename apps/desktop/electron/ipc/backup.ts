import { dialog, type BrowserWindow } from "electron";
import { z } from "zod";
import type { PluginBackupService } from "../plugins/backup.js";
import type { BackupSelections } from "../backup-selections.js";
import { AppError } from "../persistence.js";

export async function handleBackupCommand(
  options: {
    service?: PluginBackupService;
    selections: BackupSelections;
    caller: (win: BrowserWindow) => string;
    currentCaller: (win: BrowserWindow) => string | undefined;
    ui: (zh: string, en: string) => string;
  },
  win: BrowserWindow,
  command: string,
  args: Record<string, unknown>,
) {
  const { service, selections, caller, currentCaller, ui } = options;
  if (!service) throw new Error("备份服务尚未就绪");
  if (command === "backup_create") {
    const picked = await dialog.showOpenDialog(win, {
      title: ui("选择备份保存位置", "Choose a backup destination"),
      properties: ["openDirectory", "createDirectory"],
    });
    if (picked.canceled || !picked.filePaths[0]) return;
    return service.create(picked.filePaths[0]);
  }
  if (command === "backup_inspect") {
    const owner = caller(win),
      request = selections.beginInspection(owner);
    const current = () =>
      !win.isDestroyed() &&
      currentCaller(win) === owner &&
      selections.isInspectionCurrent(owner, request);
    const picked = await dialog.showOpenDialog(win, {
      title: ui("选择 spark233 备份目录", "Choose a spark233 backup"),
      properties: ["openDirectory"],
    });
    if (!current()) throw new AppError("backupSelectionChanged", "备份选择已失效，请重新检查");
    if (picked.canceled || !picked.filePaths[0]) return;
    const { manifestFingerprint, ...inspection } = await service.inspect(picked.filePaths[0]);
    if (!current()) throw new AppError("backupSelectionChanged", "备份选择已失效，请重新检查");
    const selectionId = selections.register(owner, request, {
      directory: inspection.snapshotDirectory,
      manifestFingerprint,
    });
    return { ...inspection, selectionId };
  }
  const { selectionId } = z.strictObject({ selectionId: z.string().uuid() }).parse(args);
  if (command === "backup_selection_release") {
    selections.release(caller(win), selectionId);
    return;
  }
  if (command === "backup_restore")
    return selections.restore(caller(win), selectionId, (directory, fingerprint) =>
      service.restore(directory, fingerprint),
    );
  throw new AppError("invalidCommand", "未知备份操作");
}

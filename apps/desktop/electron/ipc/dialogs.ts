import { dialog, type BrowserWindow } from "electron";
import type { FileGrants } from "../security.js";
import type { DialogOptions } from "../../shared/desktop-contract.js";

export async function openDialog(win: BrowserWindow, args: DialogOptions, grants: FileGrants) {
  const result = await dialog.showOpenDialog(win, {
    title: args.title,
    defaultPath: args.defaultPath,
    properties: [
      args.directory ? "openDirectory" : "openFile",
      ...(args.multiple ? ["multiSelections" as const] : []),
    ],
    filters: args.filters,
  });
  if (result.canceled) return null;
  for (const file of result.filePaths) grants.grant(file, !!args.directory);
  return args.multiple ? result.filePaths : (result.filePaths[0] ?? null);
}
export async function saveDialog(win: BrowserWindow, args: DialogOptions, grants: FileGrants) {
  const result = await dialog.showSaveDialog(win, {
    title: args.title,
    defaultPath: args.defaultPath,
    filters: args.filters,
  });
  if (result.canceled || !result.filePath) return null;
  grants.grant(result.filePath);
  return result.filePath;
}

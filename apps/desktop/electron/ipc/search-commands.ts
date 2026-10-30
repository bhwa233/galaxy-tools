import { dialog } from "electron";
import path from "node:path";
import fs from "node:fs";
import { SearchHistoryStore } from "../plugins/official/search-history.js";
import { AppError } from "../persistence.js";
import type { PluginActivation } from "@spark233/sdk";
import type { RuntimeContext } from "../runtime.js";
import type { CommandHandler, CommandInvocation } from "./invocation.js";

/** One workspace window per host, so a stable caller identity keeps the
 * selections of earlier pages addressable while the user pages through. */
const callerId = "search-workspace";

/** Category tokens are Pulse query modifiers; the index itself needs nothing. */
const categories: Record<string, string> = {
  folder: "type:folder",
  excel: "ext:xls;xlsx;xlsm;xlsb",
  word: "ext:doc;docx;docm",
  ppt: "ext:ppt;pptx;pptm",
  pdf: "ext:pdf",
  image: "type:image",
  video: "type:video",
  audio: "type:audio",
  archive: "type:archive",
};
const needleLimit = 8192;

/** Appends the category modifier while keeping the native request bounded.
 * Categories are filename-index kinds, so an Instant content search ignores
 * them rather than filtering along the wrong dimension. */
export function searchQueryWithCategory(
  query: string,
  category?: string,
  mode: "files" | "content" = "files",
): string {
  const trimmed = query.trim();
  const token = mode === "files" && category ? categories[category] : undefined;
  if (!token) return trimmed.slice(0, needleLimit);
  const head = trimmed.slice(0, Math.max(0, needleLimit - token.length - 1));
  return head ? `${head} ${token}` : token;
}

export function createSearchCommands(ctx: Pick<RuntimeContext, "isHostView" | "pluginHost">) {
  async function run({ win, command, args, layout }: CommandInvocation): Promise<unknown> {
    if (command !== "search_action" && command !== "search_workspace") return;
    if (!ctx.isHostView(layout)) throw new AppError("permissionDenied", "搜索工作区仅限宿主界面");
    const manager = ctx.pluginHost?.manager;
    if (!manager) throw new Error("插件宿主尚未就绪");
    if (command === "search_workspace") {
      const store = new SearchHistoryStore(manager.dataDirectory("spark233.search"));
      if (args.action === "get") return store.get();
      if (args.action === "pick-directory") {
        const picked = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
        return {
          ...store.get(),
          ...(!picked.canceled && picked.filePaths[0] ? { directory: picked.filePaths[0] } : {}),
        };
      }
      if (args.action === "clear") return store.update("clear");
      if (args.action === "remove") return store.update("remove", undefined, args.id);
      if (args.action === "remember" || args.action === "save")
        return store.update(args.action, args.conditions, undefined, args.name);
      throw new AppError("invalidPayload", "未知搜索历史操作");
    }
    const activate = (activation: PluginActivation) =>
      manager.activate("spark233.search", activation);
    if (args.action === "query") {
      const directory = typeof args.directory === "string" ? args.directory : "";
      if (directory && (!path.isAbsolute(directory) || !fs.statSync(directory).isDirectory()))
        throw new AppError("invalidPayload", "搜索目录不可用");
      const query = searchQueryWithCategory(args.query, args.category, args.mode);
      if (!query)
        return {
          items: [],
          searchPage: { total: 0, approximate: false, hasMore: false },
          searchStatus: { state: "ok" },
        };
      return activate({
        commandId: args.mode === "content" ? "content" : "search",
        parameters: {
          callerId,
          query,
          ...(directory ? { directory } : {}),
          ...(args.sort ? { sort: args.sort, sortDesc: args.sortDesc === true } : {}),
          ...(args.limit ? { limit: args.limit } : {}),
        },
      });
    }
    if (args.action === "next-page")
      return activate({ commandId: "next-page", parameters: { callerId, cursor: args.cursor } });
    if (args.action === "install-service")
      return activate({ commandId: "install-service", parameters: { callerId } });
    return activate({
      commandId: args.action,
      parameters: { callerId, selection: args.selection },
    });
  }
  return { search_action: run, search_workspace: run } satisfies Record<string, CommandHandler>;
}

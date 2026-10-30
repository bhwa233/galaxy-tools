import { z } from "zod";
export const searchConditions = z.strictObject({
  query: z.string().trim().min(1).max(8192),
  mode: z.enum(["files", "content"]),
  directory: z.string().max(32768).default(""),
  category: z
    .enum(["all", "folder", "excel", "word", "ppt", "pdf", "image", "video", "audio", "archive"])
    .default("all"),
  sortId: z
    .enum([
      "relevance",
      "name-asc",
      "name-desc",
      "mtime-desc",
      "mtime-asc",
      "size-desc",
      "size-asc",
    ])
    .default("relevance"),
});
export type SearchConditions = z.infer<typeof searchConditions>;
export interface SavedSearch extends SearchConditions {
  id: string;
  name: string;
  at: string;
}
export interface SearchHistory {
  recent: SavedSearch[];
  saved: SavedSearch[];
  directory?: string;
}

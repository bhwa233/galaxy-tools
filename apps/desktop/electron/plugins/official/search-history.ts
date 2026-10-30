import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { atomicWrite, confined } from "../../persistence.js";
import {
  searchConditions,
  type SearchConditions,
  type SearchHistory,
} from "../../../shared/search-history.js";
const entry = searchConditions.extend({ id: z.uuid(), name: z.string().max(120), at: z.string() });
const schema = z.object({ recent: z.array(entry).max(50), saved: z.array(entry).max(50) });
/** Search queries are user data, so reuse the plugin's backed-up data domain. */
export class SearchHistoryStore {
  private file: string;
  constructor(dataDir: string) {
    this.file = confined(dataDir, "workspace-history.json");
  }
  get(): SearchHistory {
    if (!fs.existsSync(this.file)) return { recent: [], saved: [] };
    if (fs.statSync(this.file).size > 4 * 1024 * 1024)
      throw new Error("Search history is too large");
    return schema.parse(JSON.parse(fs.readFileSync(this.file, "utf8")));
  }
  update(
    action: "remember" | "save" | "remove" | "clear",
    input?: SearchConditions,
    id?: string,
    name?: string,
  ): SearchHistory {
    const state = this.get();
    if (action === "clear") state.recent = [];
    else if (action === "remove") {
      state.recent = state.recent.filter((entry) => entry.id !== id);
      state.saved = state.saved.filter((entry) => entry.id !== id);
    } else {
      const conditions = searchConditions.parse(input),
        key = JSON.stringify(conditions),
        target = action === "save" ? "saved" : "recent";
      if (
        target === "saved" &&
        state.saved.length >= 50 &&
        !state.saved.some((entry) => JSON.stringify(searchConditions.strip().parse(entry)) === key)
      )
        throw new Error("Saved search limit reached (50)");
      const next = {
        ...conditions,
        id: randomUUID(),
        name: (name?.trim() || conditions.query).slice(0, 120),
        at: new Date().toISOString(),
      };
      state[target] = [
        next,
        ...state[target].filter(
          (entry) => JSON.stringify(searchConditions.strip().parse(entry)) !== key,
        ),
      ].slice(0, 50);
    }
    atomicWrite(this.file, JSON.stringify(state));
    return state;
  }
}

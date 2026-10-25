import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

const normalize = (text) => text.normalize("NFKC").toLowerCase().trim();
const display = (text) => text.replaceAll("\\n", "\n");

export function openDictionary() {
  const database = new DatabaseSync(
    fileURLToPath(new URL("./data/ecdict.sqlite", import.meta.url)),
    { readOnly: true, allowExtension: false },
  );
  database.exec("PRAGMA query_only=ON");
  const metadata = Object.fromEntries(
    database
      .prepare("SELECT key,value FROM metadata")
      .all()
      .map((row) => [row.key, row.value]),
  );
  if (metadata.schemaVersion !== "1") {
    database.close();
    throw new Error("Unsupported offline dictionary schema");
  }
  const columns = "e.id,e.word,e.phonetic,e.translation,e.pos,e.tags,e.exchange";
  const exact = database.prepare(
    `SELECT ${columns} FROM entries e WHERE e.normalized=? ORDER BY e.rank LIMIT ?`,
  );
  const inflected = database.prepare(
    `SELECT DISTINCT ${columns} FROM forms f JOIN entries e ON e.id=f.entry_id WHERE f.form=? ORDER BY e.rank LIMIT ?`,
  );
  const prefix = database.prepare(
    `SELECT ${columns} FROM entries e WHERE e.normalized>=? AND e.normalized<? ORDER BY e.rank,e.normalized LIMIT ?`,
  );
  const byId = database.prepare(
    "SELECT id,word,phonetic,translation,definition,pos,tags,exchange FROM entries WHERE id=?",
  );
  const selections = new Map();
  const remember = (row) => {
    const id = `dict:${row.id}`;
    selections.delete(id);
    selections.set(id, row.id);
    while (selections.size > 512) selections.delete(selections.keys().next().value);
    return {
      id,
      title: row.word,
      description: display(row.translation).slice(0, 220),
      kind: "dictionary",
      commandId: "detail",
      parameters: { action: "detail", id },
    };
  };
  return {
    search(query, limit = 10) {
      if (typeof query !== "string" || query.length > 512)
        throw new Error("Dictionary query must be at most 512 characters");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30)
        throw new Error("Dictionary result limit must be between 1 and 30");
      const word = normalize(query);
      if (!word)
        return {
          kind: "dictionary-search",
          items: [],
          hint: "输入英文单词、词形或短语；本地查词不联网。",
        };
      const rows = new Map();
      for (const row of [...exact.all(word, limit), ...inflected.all(word, limit)])
        if (!rows.has(row.id)) rows.set(row.id, row);
      if (rows.size < limit)
        for (const row of prefix.all(word, word + "\uffff", limit))
          if (!rows.has(row.id)) rows.set(row.id, row);
      return {
        kind: "dictionary-search",
        items: [...rows.values()].slice(0, limit).map(remember),
        hint: "ECDICT 离线基础词库 · 词形与短语查询",
        entries: Number(metadata.entries),
        networkUsed: false,
      };
    },
    detail(id) {
      if (typeof id !== "string" || !selections.has(id))
        throw new Error("Dictionary selection expired; search again");
      const row = byId.get(selections.get(id));
      if (!row) throw new Error("Dictionary entry is unavailable");
      const related = inflected
        .all(normalize(row.word), 8)
        .filter((entry) => entry.id !== row.id)
        .map(remember);
      return {
        kind: "dictionary-entry",
        entry: {
          ...row,
          id,
          translation: display(row.translation),
          definition: display(row.definition),
        },
        related,
        networkUsed: false,
      };
    },
    close() {
      selections.clear();
      database.close();
    },
  };
}

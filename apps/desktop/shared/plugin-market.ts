export const pluginMarketSorts = ["auto", "name-asc", "name-desc", "rating", "voters"] as const;
export type PluginMarketSort = (typeof pluginMarketSorts)[number];

export interface PluginMarketEntry {
  pluginId: string;
  displayName: string;
  packageName?: string;
  author?: string;
  description?: string;
  rating?: number;
  voters?: number;
}
export interface UToolsCatalogEntry extends PluginMarketEntry {
  installedPluginId?: string;
  installedVersion?: string;
  sourceBound?: boolean;
  pageURL: string;
  iconURL?: string;
}
export interface UToolsCatalogRequest {
  query: string;
  sort: PluginMarketSort;
  page: number;
  refresh?: boolean;
}
export interface UToolsCatalogPage {
  items: UToolsCatalogEntry[];
  total: number;
  page: number;
  pageSize: number;
  fetchedAt: number;
  stale: boolean;
}

const names = new Intl.Collator("zh-CN-u-co-pinyin", { sensitivity: "base", numeric: true });
const normalized = (value: string) => value.normalize("NFKC").toLocaleLowerCase().trim();
const count = (value: number | undefined) =>
  Number.isSafeInteger(value) && value! >= 0 ? value! : -1;
const rating = (value: number | undefined) =>
  Number.isFinite(value) && value! > 0 && value! <= 5 ? value! : -1;

/** Reuse native collation and Array sorting. Product-specific ranking needs
 * exact/prefix matches and deterministic identity ties, not another search lib. */
export function sortPluginMarketEntries<T extends PluginMarketEntry>(
  entries: readonly T[],
  sort: PluginMarketSort,
  query = "",
): T[] {
  const needle = normalized(query).replace(/\s+/g, " ");
  const terms = needle.split(" ").filter(Boolean);
  return entries
    .map((item) => {
      const name = normalized(item.displayName);
      const author = normalized(item.author ?? "");
      const description = normalized(item.description ?? "");
      const fields = [
        name,
        author,
        description,
        normalized(item.packageName ?? ""),
        normalized(item.pluginId),
      ];
      const relevance =
        !needle || name === needle
          ? 0
          : name.startsWith(needle)
            ? 1
            : name.includes(needle)
              ? 2
              : author.includes(needle)
                ? 3
                : description.includes(needle)
                  ? 4
                  : 5;
      return { item, fields, relevance };
    })
    .filter(({ fields }) => terms.every((term) => fields.some((field) => field.includes(term))))
    .sort((a, b) => {
      const metric =
        sort === "rating"
          ? rating(b.item.rating) - rating(a.item.rating) ||
            count(b.item.voters) - count(a.item.voters)
          : sort === "voters"
            ? count(b.item.voters) - count(a.item.voters)
            : sort === "auto" && needle
              ? a.relevance - b.relevance
              : 0;
      if (metric) return metric;
      const nameOrder = names.compare(a.item.displayName, b.item.displayName);
      if (nameOrder) return sort === "name-desc" ? -nameOrder : nameOrder;
      // Collation can equate case or punctuation; ID ordering must still be total.
      return a.item.pluginId < b.item.pluginId ? -1 : a.item.pluginId > b.item.pluginId ? 1 : 0;
    })
    .map(({ item }) => item);
}

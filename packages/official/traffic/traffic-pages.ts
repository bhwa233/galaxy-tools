import { randomUUID } from "node:crypto";
import { assertWidgetJson, type JsonValue } from "../../sdk/src/index.js";
import type { TrafficState } from "./traffic-contract.js";

// The capability broker already bounds JSON results to 64 KiB. Keep business
// pages below that boundary and pin their data until the opaque cursor expires.
export class TrafficPages {
  private results = new Map<string, { command: string; at: number; pages: JsonValue[] }>();
  clear() {
    this.results.clear();
  }
  next(command: string, cursor: unknown): JsonValue {
    if (typeof cursor !== "string" || !/^[a-f0-9-]{36}:\d+$/.test(cursor))
      throw new Error("Invalid traffic cursor");
    const [id, rawIndex] = cursor.split(":");
    const result = this.results.get(id!);
    const index = Number(rawIndex);
    if (
      !result ||
      result.command !== command ||
      Date.now() - result.at > 30_000 ||
      !result.pages[index]
    )
      throw new Error("Traffic result expired; refresh the query");
    const value = result.pages[index]!;
    if (index === result.pages.length - 1) this.results.delete(id!);
    return value;
  }
  pack(command: string, input: TrafficState | object): JsonValue {
    // Optional fields are omitted on the JSON wire. Validate that same value:
    // real collecting/history states can contain message/durableThrough=undefined.
    const value = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const key = Array.isArray(value.processes) ? "processes" : "rows";
    const { icons: _icons, ...base } = value;
    const icons = (value.icons ?? {}) as Record<string, string>;
    const data = value[key] as Record<string, unknown>[];
    const items =
      key === "processes"
        ? data.flatMap((row) => {
            const instances = row.instances as unknown[];
            return instances.length > 8
              ? Array.from({ length: Math.ceil(instances.length / 8) }, (_, index) => ({
                  ...row,
                  instances: instances.slice(index * 8, index * 8 + 8),
                }))
              : [row];
          })
        : data;
    const pages: Record<string, unknown>[] = [];
    const sentIcons = new Set<string>();
    let page: Record<string, unknown> = {
      ...base,
      [key]: [],
      ...(key === "processes" ? { iconChunks: {} } : {}),
      nextCursor: null,
    };
    for (const row of items) {
      const iconId = typeof row.iconId === "string" ? row.iconId : "";
      const icon = !sentIcons.has(iconId) ? icons[iconId] : undefined;
      const chunks = icon ? { [iconId]: icon.match(/.{1,1536}/g)! } : {};
      const append = () => ({
        ...page,
        [key]: [...(page[key] as unknown[]), row],
        ...(key === "processes"
          ? { iconChunks: { ...(page.iconChunks as object), ...chunks } }
          : {}),
      });
      let next = append();
      try {
        assertWidgetJson(next, 48 * 1024, 12, 3500);
      } catch (error) {
        if (!(page[key] as unknown[]).length)
          throw new Error(
            `Traffic row exceeds the display budget: ${error instanceof Error ? error.message : String(error)}`,
            { cause: error },
          );
        pages.push(page);
        page = {
          ...base,
          [key]: [],
          ...(key === "processes" ? { iconChunks: {} } : {}),
          nextCursor: null,
        };
        next = append();
        assertWidgetJson(next, 48 * 1024, 12, 3500);
      }
      page = next;
      if (icon) sentIcons.add(iconId);
    }
    pages.push(page);
    const id = randomUUID();
    const packed = pages.map(
      (item, index) =>
        ({
          ...item,
          nextCursor: index + 1 < pages.length ? `${id}:${index + 1}` : null,
        }) as JsonValue,
    );
    if (pages.length > 1) {
      for (const [resultId, result] of this.results)
        if (Date.now() - result.at > 30_000) this.results.delete(resultId);
      while (this.results.size >= 8) this.results.delete(this.results.keys().next().value!);
      this.results.set(id, { command, at: Date.now(), pages: packed });
    }
    return packed[0]!;
  }
}

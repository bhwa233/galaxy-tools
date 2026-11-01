import type { TrafficCoverage } from "./traffic-contract.js";

// Native coverage intervals describe the queried window. Older services also
// marked quality partial after any lifetime loss; retain those counters for
// diagnostics without overriding a recovered window or hiding a current error.
export function trafficCoverage(value: Record<string, unknown>): TrafficCoverage {
  const quality =
    value.quality && typeof value.quality === "object" && !Array.isArray(value.quality)
      ? (value.quality as Record<string, unknown>)
      : {};
  if (quality.state === "unavailable") return "unavailable";
  const intervals = Array.isArray(value.coverage)
    ? value.coverage.map((row) =>
        row && typeof row === "object" ? (row as Record<string, unknown>) : {},
      )
    : [];
  if (intervals.some((row) => row.state === "gap")) return "gap";
  if (quality.state !== "partial") return "complete";
  const lifetimeLoss = [
    "eventsLost",
    "realtimeBuffersLost",
    "queueDropped",
    "parseErrors",
    "identityUnresolved",
  ].some(
    (key) =>
      typeof quality[key] === "string" &&
      /^[0-9]+$/.test(quality[key]) &&
      /[1-9]/.test(quality[key]),
  );
  return lifetimeLoss &&
    !quality.reason &&
    intervals.length > 0 &&
    intervals.every((row) => row.state === "covered")
    ? "complete"
    : "gap";
}

// History lists need one bounded status, not every interval on every wire page.
// Keep the interval path for an installed service that has not upgraded yet.
export function trafficHistoryCoverage(
  value: Record<string, unknown>,
  from: number,
  end: number,
): TrafficCoverage {
  if (value.coverageSummary !== undefined) {
    const summary = value.coverageSummary;
    if (!summary || typeof summary !== "object" || Array.isArray(summary))
      throw new Error("历史采集摘要无效，请重新连接采集器。");
    const item = summary as Record<string, unknown>;
    if (!["complete", "gap", "unavailable"].includes(String(item.state)))
      throw new Error("历史采集摘要无效，请重新连接采集器。");
    return item.state as TrafficCoverage;
  }
  const intervals = (Array.isArray(value.coverage) ? value.coverage : [])
    .filter((row): row is Record<string, unknown> => !!row && typeof row === "object")
    .filter((row) => row.state === "covered")
    .map((row) => [Date.parse(String(row.start)), Date.parse(String(row.end))])
    .filter(([start, stop]) => Number.isFinite(start) && Number.isFinite(stop))
    .sort((a, b) => a[0]! - b[0]!);
  let through = from;
  let observed = false;
  let gaps = false;
  for (const [start, stop] of intervals) {
    if (stop! <= from || start! >= end) continue;
    observed = true;
    if (start! > through + 1000) gaps = true;
    through = Math.max(through, stop!);
  }
  return !observed
    ? "unavailable"
    : gaps || through < end - 1000 || trafficCoverage(value) === "gap"
      ? "gap"
      : "complete";
}

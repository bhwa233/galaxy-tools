import { expect, test } from "vitest";
import { trafficCoverage, trafficHistoryCoverage } from "./traffic-quality";

test("a recovered window is usable after historical loss without hiding current gaps or errors", () => {
  // The installed service retained 4331 unresolved events while consecutive
  // current windows were covered, leaving the UI permanently in a gap state.
  const recovered = {
    quality: { state: "partial", identityUnresolved: "4331", reason: null },
    coverage: [{ state: "covered" }],
  };
  expect(trafficCoverage(recovered)).toBe("complete");
  expect(trafficCoverage({ ...recovered, coverage: [{ state: "gap" }] })).toBe("gap");
  expect(
    trafficCoverage({
      ...recovered,
      quality: { ...recovered.quality, reason: "storage-commit-failed" },
    }),
  ).toBe("gap");
  expect(trafficCoverage({ ...recovered, quality: { state: "unavailable" } })).toBe("unavailable");
  expect(trafficCoverage({ ...recovered, quality: { state: "partial" } })).toBe("gap");
});

test("bounded history summaries retain coverage without sending the full interval list", () => {
  // Oversized coverage metadata previously prevented the first historical row
  // from reaching the UI. New services return a bounded summary instead.
  expect(trafficHistoryCoverage({ coverageSummary: { state: "complete" } }, 0, 2000)).toBe(
    "complete",
  );
  expect(trafficHistoryCoverage({ coverageSummary: { state: "gap" } }, 0, 2000)).toBe("gap");
  expect(trafficHistoryCoverage({}, 0, 2000)).toBe("unavailable");
  expect(
    trafficHistoryCoverage(
      {
        coverage: [
          { state: "covered", start: new Date(0).toISOString(), end: new Date(2000).toISOString() },
        ],
      },
      0,
      2000,
    ),
  ).toBe("complete");
  expect(() =>
    trafficHistoryCoverage({ coverageSummary: { state: "invalid" } }, 0, 2000),
  ).toThrow();
});

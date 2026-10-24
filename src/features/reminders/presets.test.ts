import { describe, expect, it } from "vitest";
import { presetFireAt, remainingFormat, REMINDER_PRESETS } from "./presets";

const T = Date.UTC(2026, 9, 24, 10, 0, 0); // 2026-10-24 10:00 UTC

describe("presetFireAt", () => {
  it("computes minute offsets from now", () => {
    const now = new Date(T);
    expect(presetFireAt("15m", now).getTime()).toBe(T + 15 * 60_000);
    expect(presetFireAt("3h", now).getTime()).toBe(T + 180 * 60_000);
  });

  it("keeps today 18:00 when still ahead", () => {
    // 预设按本地墙钟时间计算，测试也用本地时间构造与断言。
    const at = presetFireAt("today-evening", new Date(2026, 9, 24, 10, 0, 0));
    expect(at.getHours()).toBe(18);
    expect(at.getDate()).toBe(24);
  });

  it("rolls today 18:00 to tomorrow when already past", () => {
    const at = presetFireAt("today-evening", new Date(2026, 9, 24, 19, 0, 0));
    expect(at.getDate()).toBe(25);
    expect(at.getHours()).toBe(18);
  });

  it("always targets tomorrow 9:00", () => {
    const at = presetFireAt("tomorrow-morning", new Date(2026, 9, 24, 10, 0, 0));
    expect(at.getDate()).toBe(25);
    expect(at.getHours()).toBe(9);
  });

  it("exposes every preset id exactly once", () => {
    const ids = REMINDER_PRESETS.map((preset) => preset.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain("today-evening");
  });
});

describe("remainingFormat", () => {
  it("formats minutes under an hour", () => {
    expect(remainingFormat(new Date(T + 29 * 60_000).toISOString(), T)).toMatchObject({
      kind: "minutes",
      value: 29,
    });
  });

  it("never shows zero minutes before firing", () => {
    expect(remainingFormat(new Date(T + 5_000).toISOString(), T)).toMatchObject({
      kind: "minutes",
      value: 1,
    });
  });

  it("formats hours under two days", () => {
    expect(remainingFormat(new Date(T + 5 * 3600_000).toISOString(), T)).toMatchObject({
      kind: "hours",
      value: 5,
    });
  });

  it("falls back to a datetime beyond two days", () => {
    expect(remainingFormat(new Date(T + 72 * 3600_000).toISOString(), T).kind).toBe("datetime");
  });
});

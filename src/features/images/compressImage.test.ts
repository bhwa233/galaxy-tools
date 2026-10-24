import { describe, expect, it } from "vitest";
import { COMPRESS_MAX_BYTES, COMPRESS_MAX_EDGE, planImageCompression } from "./compressImage";

describe("planImageCompression", () => {
  it("keeps small images untouched", () => {
    expect(planImageCompression(1024, 800, 600)).toEqual({
      compress: false,
      width: 800,
      height: 600,
    });
  });

  it("compresses when bytes exceed the limit even with small dimensions", () => {
    const plan = planImageCompression(COMPRESS_MAX_BYTES + 1, 1024, 768);
    expect(plan.compress).toBe(true);
    expect(plan.width).toBe(1024);
    expect(plan.height).toBe(768);
  });

  it("downscales so the long edge fits the limit", () => {
    const plan = planImageCompression(1024, 4096, 2048);
    expect(plan.compress).toBe(true);
    expect(plan.width).toBe(COMPRESS_MAX_EDGE);
    expect(plan.height).toBe(1024);
  });

  it("never upscales", () => {
    const plan = planImageCompression(COMPRESS_MAX_BYTES + 1, 100, 50);
    expect(plan.compress).toBe(true);
    expect(plan.width).toBe(100);
    expect(plan.height).toBe(50);
  });

  it("rejects invalid dimensions", () => {
    expect(planImageCompression(COMPRESS_MAX_BYTES + 1, 0, 0).compress).toBe(false);
    expect(planImageCompression(COMPRESS_MAX_BYTES + 1, Number.NaN, 100).compress).toBe(false);
  });
});

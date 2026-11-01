import { expect, test } from "vitest";
import { InterfaceRates, type InterfaceFrame } from "./traffic-sampler";

test("rates preserve 64-bit deltas and never turn resets or missing coverage into zero", () => {
  const rates = new InterfaceRates();
  const sample = (elapsedMs: number, rx: string, tx: string): InterfaceFrame => ({
    at: 100000 + elapsedMs,
    elapsedMs,
    adapters: [
      {
        id: "stable-nic",
        index: 18,
        name: "Ethernet",
        description: "Physical",
        addresses: ["192.0.2.10"],
        rx,
        tx,
      },
    ],
  });
  expect(rates.ingest(sample(0, "9007199254740993", "100")).rxBytesPerSecond).toBeNull();
  const complete = rates.ingest(sample(1000, "9007199254745089", "1124"));
  expect(complete.coverage).toBe("complete");
  expect(complete.rxBytesPerSecond).toBe(4096);
  expect(complete.txBytesPerSecond).toBe(1024);
  const reset = rates.ingest(sample(2000, "0", "0"));
  expect(reset.coverage).toBe("gap");
  expect(reset.rxBytesPerSecond).toBeNull();
  expect(reset.rxSeries).toEqual([]);
  const gap = rates.ingest(sample(10000, "1024", "1024"));
  expect(gap.coverage).toBe("gap");
  expect(gap.rxBytesPerSecond).toBeNull();
  const missing = rates.ingest({ at: 111000, elapsedMs: 11000, adapters: [] });
  expect(missing.coverage).toBe("unavailable");
  expect(missing.rxBytesPerSecond).toBeNull();
  rates.reset();
  expect(rates.ingest(sample(12000, "2048", "2048")).coverage).toBe("warming");
  const clockGap = rates.ingest({ ...sample(13000, "4096", "4096"), at: 999999 });
  expect(clockGap.coverage).toBe("gap");
  expect(clockGap.rxBytesPerSecond).toBeNull();
});

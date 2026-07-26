import { expect, test, describe } from "bun:test";
import { aggregateToMonths, archiveWindow } from "@/climate/aggregate";

describe("archiveWindow", () => {
  test("spans the requested number of whole years ending last year", () => {
    // 2016..2025 inclusive is ten whole years.
    const w = archiveWindow("2026-07-26", 10);
    expect(w.startDate).toBe("2016-01-01");
    expect(w.endDate).toBe("2025-12-31");
  });
});

describe("aggregateToMonths", () => {
  test("averages each month across years and counts rain days per year", () => {
    // Two Januaries (2023 + 2024); July present only in 2023 -- an asymmetric
    // year count so a per-month divisor can't be confused with a dataset-wide
    // one. July's first day sits exactly at the 1mm rain threshold to pin
    // ">=" against ">" and against a shifted RAIN_DAY_THRESHOLD_MM.
    const daily = {
      time: ["2023-01-01", "2023-01-02", "2024-01-01", "2024-01-02",
             "2023-07-01", "2023-07-02"],
      dewPoint: [5, 5, 7, 7, 23, 23],
      tempMax:  [10, 10, 12, 12, 30, 30],
      precip:   [0, 5, 0, 0, 1, 3],
    };
    const months = aggregateToMonths(daily);
    expect(months).toHaveLength(12);

    const jan = months.find((m) => m.month === 1)!;
    expect(jan.dewPointMean).toBeCloseTo(6, 5);
    expect(jan.tempMaxMean).toBeCloseTo(11, 5);
    // 1 rain day in 2023 (the 5mm day), 0 in 2024 -> mean 0.5
    expect(jan.rainDays).toBeCloseTo(0.5, 5);

    const jul = months.find((m) => m.month === 7)!;
    expect(jul.dewPointMean).toBeCloseTo(23, 5);
    expect(jul.tempMaxMean).toBeCloseTo(30, 5);
    // July only has 2023 data: the 1mm day counts (>= threshold) alongside
    // the 3mm day, so 2 rain days / 1 distinct year = 2. A dataset-wide
    // divisor (2 years, borrowed from January) would wrongly give 1 here.
    expect(jul.rainDays).toBeCloseTo(2, 5);
  });

  test("ignores null readings rather than treating them as zero", () => {
    const months = aggregateToMonths({
      time: ["2023-03-01", "2023-03-02"],
      dewPoint: [10, null],
      tempMax: [20, null],
      precip: [null, null],
    });
    const mar = months.find((m) => m.month === 3)!;
    expect(mar.dewPointMean).toBeCloseTo(10, 5);
    expect(mar.tempMaxMean).toBeCloseTo(20, 5);
  });

  test("months with no data return zeros rather than NaN", () => {
    const months = aggregateToMonths({ time: [], dewPoint: [], tempMax: [], precip: [] });
    expect(months).toHaveLength(12);
    for (const m of months) {
      expect(Number.isNaN(m.dewPointMean)).toBe(false);
      expect(m.dewPointMean).toBe(0);
      expect(m.tempMaxMean).toBe(0);
      expect(m.rainDays).toBe(0);
    }
  });
});

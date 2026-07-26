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
    // Two Januaries, two Julys. Jan: dew 5 and 7; Jul: dew 23 and 25.
    const daily = {
      time: ["2023-01-01", "2023-01-02", "2024-01-01", "2024-01-02",
             "2023-07-01", "2023-07-02", "2024-07-01", "2024-07-02"],
      dewPoint: [5, 5, 7, 7, 23, 23, 25, 25],
      tempMax:  [10, 10, 12, 12, 30, 30, 32, 32],
      precip:   [0, 5, 0, 0, 2, 3, 0, 0],
    };
    const months = aggregateToMonths(daily);
    expect(months).toHaveLength(12);

    const jan = months.find((m) => m.month === 1)!;
    expect(jan.dewPointMean).toBeCloseTo(6, 5);
    expect(jan.tempMaxMean).toBeCloseTo(11, 5);
    // 1 rain day in 2023, 0 in 2024 -> mean 0.5
    expect(jan.rainDays).toBeCloseTo(0.5, 5);

    const jul = months.find((m) => m.month === 7)!;
    expect(jul.dewPointMean).toBeCloseTo(24, 5);
    // Also assert the temperature axis, not just dew point: (30+30+32+32)/4 = 31.
    expect(jul.tempMaxMean).toBeCloseTo(31, 5);
    // 2 rain days in 2023, 0 in 2024 -> mean 1
    expect(jul.rainDays).toBeCloseTo(1, 5);

    // Four readings per month across the two years.
    expect(jan.dayCount).toBe(4);
    expect(jul.dayCount).toBe(4);
  });

  test("the rain-day divisor is per-month years, not dataset-wide years", () => {
    // Deliberately ASYMMETRIC: January spans 2023 and 2024, July spans 2023
    // only. With a correct per-month divisor July is 2/1 = 2. With a
    // dataset-wide divisor of 2 it would be 2/2 = 1. A symmetric fixture
    // cannot tell those two implementations apart.
    const months = aggregateToMonths({
      time: ["2023-01-01", "2023-01-02", "2024-01-01", "2024-01-02",
             "2023-07-01", "2023-07-02"],
      dewPoint: [5, 5, 7, 7, 23, 23],
      tempMax:  [10, 10, 12, 12, 30, 30],
      precip:   [0, 5, 0, 0, 2, 3],
    });
    // Jan: 1 rain day in 2023, 0 in 2024, 2 years seen -> 0.5
    expect(months.find((m) => m.month === 1)!.rainDays).toBeCloseTo(0.5, 5);
    // Jul: 2 rain days in 2023, 1 year seen -> 2
    expect(months.find((m) => m.month === 7)!.rainDays).toBeCloseTo(2, 5);
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
    // Assert the temperature axis too. Coercing null to 0 here would halve
    // this to 10 and still pass a dew-point-only assertion.
    expect(mar.tempMaxMean).toBeCloseTo(20, 5);
    // Only one of the two days carried a dew-point reading.
    expect(mar.dayCount).toBe(1);
  });

  test("a day at exactly the 1mm threshold counts as a rain day", () => {
    const months = aggregateToMonths({
      time: ["2023-04-01", "2023-04-02"],
      dewPoint: [10, 10],
      tempMax: [20, 20],
      precip: [0.9, 1],
    });
    // 0.9mm is below the threshold, 1.0mm is exactly at it and must count.
    expect(months.find((m) => m.month === 4)!.rainDays).toBeCloseTo(1, 5);
  });

  test("months with no data return zeros rather than NaN, and report zero coverage", () => {
    const months = aggregateToMonths({ time: [], dewPoint: [], tempMax: [], precip: [] });
    expect(months).toHaveLength(12);
    // Assert calendar order explicitly — .find() elsewhere would not catch a reversal.
    expect(months.map((m) => m.month)).toEqual([1,2,3,4,5,6,7,8,9,10,11,12]);
    for (const m of months) {
      expect(Number.isNaN(m.dewPointMean)).toBe(false);
      expect(m.dewPointMean).toBe(0);
      // Dropping the years===0 guard would make these NaN, which propagates
      // into the scorer and makes the entire ranking order undefined.
      expect(m.tempMaxMean).toBe(0);
      expect(m.rainDays).toBe(0);
      // This is what stops a zero-filled month scoring 79 and ranking first.
      expect(m.dayCount).toBe(0);
    }
  });
});

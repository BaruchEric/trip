import { expect, test, describe } from "bun:test";
import {
  classifyDewPoint, scoreMonth, rankMonths, monthsWithoutData,
} from "@/comfort";
import type { MonthStats } from "@/comfort";

/**
 * Build a MonthStats with full coverage by default. `dayCount` defaults to 300
 * (roughly ten years of daily readings) so tests about scoring don't have to
 * restate it; the no-data tests override it to 0 explicitly.
 */
function stats(o: Partial<MonthStats> & { month: number }): MonthStats {
  return { dewPointMean: 12, tempMaxMean: 22, rainDays: 0, dayCount: 300, ...o };
}

describe("classifyDewPoint", () => {
  test("bands follow the spec thresholds", () => {
    expect(classifyDewPoint(5)).toBe("dry");
    expect(classifyDewPoint(12)).toBe("pleasant");
    expect(classifyDewPoint(15.9)).toBe("pleasant");
    expect(classifyDewPoint(16)).toBe("sticky");
    expect(classifyDewPoint(19.9)).toBe("sticky");
    expect(classifyDewPoint(20)).toBe("muggy");
    expect(classifyDewPoint(23.9)).toBe("muggy");
    expect(classifyDewPoint(24)).toBe("oppressive");
    expect(classifyDewPoint(28)).toBe("oppressive");
  });
});

describe("scoreMonth", () => {
  test("a pleasant dry month scores high", () => {
    const s = scoreMonth(stats({ month: 5, dewPointMean: 12, tempMaxMean: 22, rainDays: 4 }));
    expect(s.score).toBeGreaterThan(80);
    expect(s.band).toBe("pleasant");
  });

  // 23.4C is real Tokyo July data, probed from the live archive 2026-07-26.
  test("Tokyo July lands in the muggy band and scores badly", () => {
    const s = scoreMonth(stats({ month: 7, dewPointMean: 23.4, tempMaxMean: 30.5, rainDays: 12 }));
    expect(s.score).toBeLessThan(35);
    expect(s.band).toBe("muggy");
  });

  test("heat penalty applies above 30C even when dry", () => {
    const dryHot = scoreMonth(stats({ month: 7, dewPointMean: 8, tempMaxMean: 41 }));
    const dryMild = scoreMonth(stats({ month: 5, dewPointMean: 8, tempMaxMean: 24 }));
    expect(dryHot.score).toBeLessThan(dryMild.score);
    // Pin the magnitude, not just the ordering: with heat 2.5/C above 30,
    // dryHot is 95 - (41-30)*2.5 = 67.5 -> 68. Halving the coefficient
    // would keep the ordering true but break this.
    expect(dryHot.score).toBe(68);
    expect(dryMild.score).toBe(95);
  });

  test("cold penalty applies below 8C", () => {
    const cold = scoreMonth(stats({ month: 1, dewPointMean: -2, tempMaxMean: 2, rainDays: 5 }));
    const mild = scoreMonth(stats({ month: 4, dewPointMean: -2, tempMaxMean: 18, rainDays: 5 }));
    expect(cold.score).toBeLessThan(mild.score);
    // cold: 95 - (8-2)*2 - 5*1.2 = 77 ; mild: 95 - 6 = 89
    expect(cold.score).toBe(77);
    expect(mild.score).toBe(89);
  });

  test("rain penalty is monotonic", () => {
    const wet = scoreMonth(stats({ month: 6, dewPointMean: 13, tempMaxMean: 22, rainDays: 20 }));
    const dry = scoreMonth(stats({ month: 6, dewPointMean: 13, tempMaxMean: 22, rainDays: 2 }));
    expect(wet.score).toBeLessThan(dry.score);
    // 100 - 20*1.2 = 76 ; 100 - 2*1.2 = 97.6 -> 98
    expect(wet.score).toBe(76);
    expect(dry.score).toBe(98);
  });

  test("score is always clamped to 0-100", () => {
    const awful = scoreMonth(stats({ month: 8, dewPointMean: 30, tempMaxMean: 48, rainDays: 31 }));
    expect(awful.score).toBe(0);
  });

  test("verdict is a non-empty human string", () => {
    const s = scoreMonth(stats({ month: 5, dewPointMean: 12, tempMaxMean: 22, rainDays: 4 }));
    expect(s.verdict.length).toBeGreaterThan(0);
  });
});

describe("rankMonths", () => {
  test("sorts best-first and breaks ties by earlier month", () => {
    const ranked = rankMonths([
      stats({ month: 8, dewPointMean: 24, tempMaxMean: 33, rainDays: 8 }),
      stats({ month: 5, dewPointMean: 12, tempMaxMean: 22, rainDays: 4 }),
      stats({ month: 10, dewPointMean: 12, tempMaxMean: 22, rainDays: 4 }),
    ]);
    expect(ranked[0]!.month).toBe(5);
    expect(ranked[1]!.month).toBe(10);
    expect(ranked[2]!.month).toBe(8);
  });

  test("excludes months with no data instead of scoring their zeros", () => {
    // A zero-filled month would otherwise read as dew point 0C -> "dry" -> 95,
    // less a 16-point cold penalty = 79, and outrank a real muggy month.
    const ranked = rankMonths([
      stats({ month: 2, dewPointMean: 0, tempMaxMean: 0, rainDays: 0, dayCount: 0 }),
      stats({ month: 7, dewPointMean: 23, tempMaxMean: 31, rainDays: 10 }),
    ]);
    expect(ranked).toHaveLength(1);
    expect(ranked[0]!.month).toBe(7);
    expect(ranked.some((m) => m.month === 2)).toBe(false);
  });

  test("returns an empty ranking when no month has data", () => {
    const ranked = rankMonths([
      stats({ month: 1, dewPointMean: 0, tempMaxMean: 0, dayCount: 0 }),
      stats({ month: 2, dewPointMean: 0, tempMaxMean: 0, dayCount: 0 }),
    ]);
    expect(ranked).toEqual([]);
  });
});

describe("monthsWithoutData", () => {
  test("names exactly the months lacking coverage", () => {
    expect(monthsWithoutData([
      stats({ month: 1, dayCount: 0 }),
      stats({ month: 2, dayCount: 300 }),
      stats({ month: 3, dayCount: 0 }),
    ])).toEqual([1, 3]);
  });
});

import { expect, test, describe } from "bun:test";
import {
  classifyDewPoint, scoreMonth, rankMonths, monthsExcluded,
  partitionByComfort, BAND_SCORE,
} from "@/comfort";
import type { MonthStats } from "@/comfort";

/**
 * Build a MonthStats with full coverage by default. `dayCount` defaults to 300
 * (roughly ten years of daily readings) so tests about scoring don't have to
 * restate it; the no-data tests override it to 0 explicitly.
 */
function stats(o: Partial<MonthStats> & { month: number }): MonthStats {
  return {
    dewPointMean: 12, tempMaxMean: 22, rainDays: 0,
    dayCount: 300, expectedDays: 300, ...o,
  };
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

describe("monthsExcluded", () => {
  test("names exactly the months lacking coverage", () => {
    expect(monthsExcluded([
      stats({ month: 1, dayCount: 0 }),
      stats({ month: 2, dayCount: 300 }),
      stats({ month: 3, dayCount: 0 }),
    ]).map((m) => m.month)).toEqual([1, 3]);
  });
});

describe("partitionByComfort", () => {
  test("splits the ranking at the band cliff, best-first on each side", () => {
    const scored = rankMonths([
      stats({ month: 1, dewPointMean: 5 }),    // dry
      stats({ month: 6, dewPointMean: 18 }),   // sticky
      stats({ month: 7, dewPointMean: 22 }),   // muggy
      stats({ month: 8, dewPointMean: 26 }),   // oppressive
    ]);
    const { recommend, avoid } = partitionByComfort(scored);
    expect(recommend.map((m) => m.month)).toEqual([1, 6]);
    expect(avoid.map((m) => m.month)).toEqual([7, 8]);
  });

  test("the cliff is read from the bands, not restated", () => {
    // The avoid list used to be defined in render.ts while the band scores it
    // encodes lived here, so re-tuning the scores left the avoid list behind.
    // Every band at or below the muggy score must be on the avoid side.
    const scored = rankMonths(
      [5, 12, 18, 22, 26].map((dewPointMean, i) =>
        stats({ month: i + 1, dewPointMean }),
      ),
    );
    const { avoid } = partitionByComfort(scored);
    expect(avoid.every((m) => BAND_SCORE[m.band] <= BAND_SCORE.muggy)).toBe(true);
    expect(avoid.map((m) => m.band).sort()).toEqual(["muggy", "oppressive"]);
  });

  test("every scored month lands on exactly one side", () => {
    const scored = rankMonths(
      [2, 8, 14, 17, 21, 25].map((dewPointMean, i) =>
        stats({ month: i + 1, dewPointMean }),
      ),
    );
    const { recommend, avoid } = partitionByComfort(scored);
    expect(recommend.length + avoid.length).toBe(scored.length);
    expect(recommend.filter((r) => avoid.includes(r))).toEqual([]);
  });
});

describe("coverage threshold", () => {
  test("a thinly covered month is not ranked", () => {
    // dayCount spans the whole 10-year window, so a fully covered month sits at
    // 283-310. A month with 28 readings is ~9% coverage, not "a month of data" —
    // it would otherwise score ~95 off a handful of days and rank first.
    const ranked = rankMonths([
      stats({ month: 6, dewPointMean: 12, dayCount: 28, expectedDays: 300 }),
      stats({ month: 7, dewPointMean: 23, tempMaxMean: 31, rainDays: 10 }),
    ]);
    expect(ranked.map((m) => m.month)).toEqual([7]);
  });

  test("a thinly covered month is reported rather than vanishing", () => {
    // The trap this guards: the include and exclude rules are complementary, so
    // raising one and not the other makes a month neither ranked NOR reported —
    // it just disappears with nothing saying it existed.
    const excluded = monthsExcluded([
      stats({ month: 6, dayCount: 28, expectedDays: 300 }),
      stats({ month: 7, dayCount: 300, expectedDays: 300 }),
    ]);
    expect(excluded.map((m) => m.month)).toEqual([6]);
  });

  test("every month is either ranked or reported, never both, never neither", () => {
    // The property that makes the two rules impossible to drift apart. Spans the
    // threshold from empty to full so a one-sided edit fails here.
    const months = [0, 1, 28, 200, 239, 240, 241, 280, 300].map((dayCount, i) =>
      stats({ month: i + 1, dayCount, expectedDays: 300 }),
    );
    const ranked = rankMonths(months).map((m) => m.month);
    const excluded = monthsExcluded(months).map((m) => m.month);

    expect([...ranked, ...excluded].sort((a, b) => a - b)).toEqual(
      months.map((m) => m.month),
    );
    expect(ranked.filter((m) => excluded.includes(m))).toEqual([]);
  });

  test("coverage is judged as a fraction, not an absolute day count", () => {
    // A short window is not a broken one. 220 of 300 is thin; 220 of 250 is not.
    // A hardcoded day-count cutoff cannot tell these apart.
    const thin = rankMonths([stats({ month: 1, dayCount: 220, expectedDays: 300 })]);
    const fine = rankMonths([stats({ month: 1, dayCount: 220, expectedDays: 250 })]);
    expect(thin).toHaveLength(0);
    expect(fine).toHaveLength(1);
  });

  test("expectedDays of 0 is excluded rather than dividing by zero", () => {
    const ranked = rankMonths([stats({ month: 1, dayCount: 0, expectedDays: 0 })]);
    expect(ranked).toEqual([]);
    expect(monthsExcluded([stats({ month: 1, dayCount: 0, expectedDays: 0 })]))
      .toHaveLength(1);
  });

  test("scoreMonth refuses to score a month it should never have been handed", () => {
    // scoreMonth is exported, and only rankMonths gates coverage. A direct
    // caller passing a thin month used to get a confident ~95 back — the
    // phantom-79 bug through a side door. It has to enforce its own contract.
    expect(() => scoreMonth(stats({ month: 1, dayCount: 3, expectedDays: 300 })))
      .toThrow(/coverage/i);
    expect(() => scoreMonth(stats({ month: 1, dayCount: 300, expectedDays: 300 })))
      .not.toThrow();
  });

  test("the excluded report carries the coverage that caused it", () => {
    // "No data for Jun" is a lie when Jun has 28 readings. The number is what
    // lets a human tell a broken fetch from a genuinely unmeasured month.
    const [only] = monthsExcluded([
      stats({ month: 6, dayCount: 30, expectedDays: 300 }),
    ]);
    expect(only!.dayCount).toBe(30);
    expect(only!.expectedDays).toBe(300);
    expect(only!.coverage).toBeCloseTo(0.1, 5);
  });
});

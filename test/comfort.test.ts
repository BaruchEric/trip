import { expect, test, describe } from "bun:test";
import { classifyDewPoint, scoreMonth, rankMonths } from "@/comfort";

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
    const s = scoreMonth({ month: 5, dewPointMean: 12, tempMaxMean: 22, rainDays: 4 });
    expect(s.score).toBeGreaterThan(80);
    expect(s.band).toBe("pleasant");
  });

  // 23.4C is real Tokyo July data, probed from the live archive 2026-07-26.
  test("Tokyo July lands in the muggy band and scores badly", () => {
    const s = scoreMonth({ month: 7, dewPointMean: 23.4, tempMaxMean: 30.5, rainDays: 12 });
    expect(s.score).toBeLessThan(35);
    expect(s.band).toBe("muggy");
  });

  test("heat penalty applies above 30C even when dry", () => {
    const dryHot = scoreMonth({ month: 7, dewPointMean: 8, tempMaxMean: 41, rainDays: 0 });
    const dryMild = scoreMonth({ month: 5, dewPointMean: 8, tempMaxMean: 24, rainDays: 0 });
    expect(dryHot.score).toBeLessThan(dryMild.score);
  });

  test("cold penalty applies below 8C", () => {
    const cold = scoreMonth({ month: 1, dewPointMean: -2, tempMaxMean: 2, rainDays: 5 });
    const mild = scoreMonth({ month: 4, dewPointMean: -2, tempMaxMean: 18, rainDays: 5 });
    expect(cold.score).toBeLessThan(mild.score);
  });

  test("rain penalty is monotonic", () => {
    const wet = scoreMonth({ month: 6, dewPointMean: 13, tempMaxMean: 22, rainDays: 20 });
    const dry = scoreMonth({ month: 6, dewPointMean: 13, tempMaxMean: 22, rainDays: 2 });
    expect(wet.score).toBeLessThan(dry.score);
  });

  test("score is always clamped to 0-100", () => {
    const awful = scoreMonth({ month: 8, dewPointMean: 30, tempMaxMean: 48, rainDays: 31 });
    expect(awful.score).toBeGreaterThanOrEqual(0);
    expect(awful.score).toBeLessThanOrEqual(100);
  });

  test("verdict is a non-empty human string", () => {
    const s = scoreMonth({ month: 5, dewPointMean: 12, tempMaxMean: 22, rainDays: 4 });
    expect(s.verdict.length).toBeGreaterThan(0);
  });
});

describe("rankMonths", () => {
  test("sorts best-first and breaks ties by earlier month", () => {
    const ranked = rankMonths([
      { month: 8, dewPointMean: 24, tempMaxMean: 33, rainDays: 8 },
      { month: 5, dewPointMean: 12, tempMaxMean: 22, rainDays: 4 },
      { month: 10, dewPointMean: 12, tempMaxMean: 22, rainDays: 4 },
    ]);
    expect(ranked[0]!.month).toBe(5);
    expect(ranked[1]!.month).toBe(10);
    expect(ranked[2]!.month).toBe(8);
  });
});

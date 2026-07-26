import { expect, test, describe } from "bun:test";
import { renderMonthTable, renderVerdict, MONTH_NAMES } from "@/render";
import { rankMonths } from "@/comfort";

const TOKYOISH = rankMonths([
  { month: 1, dewPointMean: 1, tempMaxMean: 10, rainDays: 3, dayCount: 300 },
  { month: 5, dewPointMean: 13, tempMaxMean: 23, rainDays: 6, dayCount: 300 },
  { month: 7, dewPointMean: 23.4, tempMaxMean: 30.5, rainDays: 12, dayCount: 300 },
  { month: 11, dewPointMean: 9, tempMaxMean: 18, rainDays: 5, dayCount: 300 },
]);

describe("renderMonthTable", () => {
  test("lists months in calendar order regardless of rank", () => {
    const out = renderMonthTable("Tokyo", TOKYOISH);
    const lines = out.split("\n").filter((l) => MONTH_NAMES.some((m) => l.startsWith(m)));
    expect(lines[0]!.startsWith("Jan")).toBe(true);
    expect(lines[lines.length - 1]!.startsWith("Nov")).toBe(true);
  });

  test("includes the city name and the dew point column", () => {
    const out = renderMonthTable("Tokyo", TOKYOISH);
    expect(out).toContain("Tokyo");
    expect(out).toContain("23.4");
  });
});

describe("renderVerdict", () => {
  test("names the best month and warns about the worst stretch", () => {
    // Scores: May 93, Jan 91, Nov 89, Jul 14 -> best two are May and Jan.
    const out = renderVerdict(TOKYOISH);
    expect(out).toContain("May");
    expect(out.toLowerCase()).toContain("avoid");
    expect(out).toContain("Jul");
  });

  test("handles a single-month input without crashing", () => {
    const out = renderVerdict(rankMonths([
      { month: 3, dewPointMean: 10, tempMaxMean: 18, rainDays: 4, dayCount: 300 },
    ]));
    expect(out).toContain("Mar");
  });

  test("says so plainly when nothing has data, rather than inventing a verdict", () => {
    const out = renderVerdict(rankMonths([
      { month: 1, dewPointMean: 0, tempMaxMean: 0, rainDays: 0, dayCount: 0 },
    ]));
    expect(out.toLowerCase()).toContain("no climate data");
  });

  test("names the highest-dew-point month as the peak, not the mildest bad one", () => {
    // Real Tokyo shape: Sep is the highest-SCORING bad month (dew 20.3) but Aug
    // is the actual peak (dew 23.2). Reporting Sep understated the peak by 3C.
    const out = renderVerdict(rankMonths([
      { month: 1, dewPointMean: 0.5, tempMaxMean: 10, rainDays: 4, dayCount: 300 },
      { month: 7, dewPointMean: 22.3, tempMaxMean: 30, rainDays: 12, dayCount: 300 },
      { month: 8, dewPointMean: 23.2, tempMaxMean: 32, rainDays: 11, dayCount: 300 },
      { month: 9, dewPointMean: 20.3, tempMaxMean: 29, rainDays: 12, dayCount: 300 },
    ]));
    expect(out).toContain("23C in Aug");
    expect(out).not.toContain("20C in Sep");
  });

  test("never recommends a month it also tells you to avoid", () => {
    // Singapore shape: every month muggy or worse. The old code sliced the top
    // two of the full ranking and emitted "Go in Feb or Mar. Avoid Jan, Feb,
    // Mar, ... Dec." — recommending months it simultaneously warned against.
    const allMuggy = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1, dewPointMean: 23 + (i % 3) * 0.5, tempMaxMean: 31,
      rainDays: 14, dayCount: 300,
    }));
    const out = renderVerdict(rankMonths(allMuggy));
    expect(out).not.toMatch(/^Go in /m);
    expect(out.toLowerCase()).toContain("least bad");

    // And prove the general invariant: no recommended month appears on the
    // avoid list, for a city that has both good and bad months.
    const mixed = renderVerdict(rankMonths([
      { month: 2, dewPointMean: 5, tempMaxMean: 14, rainDays: 3, dayCount: 300 },
      { month: 8, dewPointMean: 24, tempMaxMean: 33, rainDays: 12, dayCount: 300 },
    ]));
    const goIn = mixed.match(/Go in (.+)\./);
    const avoid = mixed.match(/Avoid ([^-]+) -/);
    expect(goIn).not.toBeNull();
    expect(avoid).not.toBeNull();
    const recommended = goIn![1]!.split(" or ").map((s) => s.trim());
    const avoided = avoid![1]!.split(",").map((s) => s.trim());
    for (const r of recommended) expect(avoided).not.toContain(r);
  });
});

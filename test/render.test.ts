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
});

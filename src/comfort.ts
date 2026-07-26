export type ComfortBand = "dry" | "pleasant" | "sticky" | "muggy" | "oppressive";

export interface MonthStats {
  month: number;
  dewPointMean: number;
  tempMaxMean: number;
  rainDays: number;
  /**
   * Days that actually carried a dew-point reading. 0 means no data.
   * Without this, a zero-filled month reads as dew point 0 C -> "dry" -> 95
   * points and can outrank a real destination. Coverage has to be explicit;
   * it cannot be inferred from the means.
   */
  dayCount: number;
  /**
   * Days the archive window covered for this month, whether or not each one
   * carried a reading. Coverage is a FRACTION of this, never an absolute count:
   * the window is ~10 years, so a fully covered month sits at 283-310, and a
   * "28 days of data" rule would wave through 9% coverage. Storing the
   * denominator also keeps the rule correct if the window length ever changes.
   */
  expectedDays: number;
}

/**
 * Below this share of the window, a month is treated as unmeasured rather than
 * ranked. On real ERA5 data months are ~100% or 0% with nothing in between, so
 * the exact cutoff is not sensitive — this exists to catch a broken fetch, not
 * to make fine judgments.
 */
export const MIN_COVERAGE = 0.8;

export function coverageOf(stats: MonthStats): number {
  if (stats.expectedDays <= 0) return 0;
  return stats.dayCount / stats.expectedDays;
}

/**
 * The SINGLE coverage rule. Both the ranked set and the excluded set are
 * derived from this one predicate, so they cannot drift apart. Written as two
 * complementary comparisons, raising one and not the other would make a month
 * neither ranked nor reported — it would vanish with nothing naming it.
 */
export function hasEnoughCoverage(stats: MonthStats): boolean {
  return coverageOf(stats) >= MIN_COVERAGE;
}

export interface ExcludedMonth {
  month: number;
  dayCount: number;
  expectedDays: number;
  coverage: number;
}

export interface ScoredMonth extends MonthStats {
  band: ComfortBand;
  score: number;
  verdict: string;
}

/** Spec decision 2: dew point, never relative humidity. */
export function classifyDewPoint(celsius: number): ComfortBand {
  if (celsius < 10) return "dry";
  if (celsius < 16) return "pleasant";
  if (celsius < 20) return "sticky";
  if (celsius < 24) return "muggy";
  return "oppressive";
}

export const BAND_SCORE: Record<ComfortBand, number> = {
  dry: 95,
  pleasant: 100,
  sticky: 62,
  muggy: 30,
  oppressive: 8,
};

const BAND_TEXT: Record<ComfortBand, string> = {
  dry: "dry and comfortable",
  pleasant: "comfortable",
  sticky: "noticeably sticky",
  muggy: "muggy",
  oppressive: "oppressive",
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function scoreMonth(stats: MonthStats): ScoredMonth {
  // Enforced here as well as in rankMonths because scoreMonth is exported and
  // scoring a thin month is not a degraded answer, it is a confident wrong one:
  // an empty month reads as dew point 0 C -> "dry" -> 95 points. A caller that
  // reaches this directly has skipped the only gate that existed.
  if (!hasEnoughCoverage(stats)) {
    throw new Error(
      `month ${stats.month} has insufficient coverage to score ` +
      `(${stats.dayCount}/${stats.expectedDays} days, need ${MIN_COVERAGE * 100}%)`,
    );
  }

  const band = classifyDewPoint(stats.dewPointMean);

  // Humidity is the dominant term, per spec decision 2.
  let score = BAND_SCORE[band];

  // Heat penalty: nothing below 30C, then 2.5 points per degree over.
  if (stats.tempMaxMean > 30) score -= (stats.tempMaxMean - 30) * 2.5;

  // Cold penalty: nothing above 8C, then 2 points per degree under.
  if (stats.tempMaxMean < 8) score -= (8 - stats.tempMaxMean) * 2;

  // Rain penalty: 1.2 points per rainy day in the month.
  score -= stats.rainDays * 1.2;

  score = Math.round(clamp(score, 0, 100));

  const parts = [`${BAND_TEXT[band]} (dew pt ${stats.dewPointMean.toFixed(1)}C)`];
  if (stats.tempMaxMean > 32) parts.push(`hot, highs ${Math.round(stats.tempMaxMean)}C`);
  if (stats.tempMaxMean < 8) parts.push(`cold, highs ${Math.round(stats.tempMaxMean)}C`);
  if (stats.rainDays > 12) parts.push(`wet, ~${Math.round(stats.rainDays)} rain days`);

  return { ...stats, band, score, verdict: parts.join("; ") };
}

/**
 * Thinly covered months are EXCLUDED, not scored. A zero-filled month would
 * otherwise score 79 and outrank real destinations, and a month resting on a
 * handful of readings scores ~95 off noise.
 *
 * Pairs with `monthsExcluded`: both call `hasEnoughCoverage`, so every month
 * lands in exactly one of the two sets.
 */
export function rankMonths(stats: MonthStats[]): ScoredMonth[] {
  return stats
    .filter(hasEnoughCoverage)
    .map(scoreMonth)
    .sort((a, b) => b.score - a.score || a.month - b.month);
}

/**
 * The good/bad split, defined HERE rather than in the renderer.
 *
 * This lived in render.ts as a local `isBad`, one file away from the BAND_SCORE
 * table whose cliff it encodes — re-tune the scores and the avoid list silently
 * stays put. It also had to be re-derived by every consumer, and that
 * re-derivation is exactly what shipped two real bugs: a verdict that
 * recommended and avoided the same month, and one that named the mildest bad
 * month as the peak.
 *
 * Both sides come back ranked best-first, so callers never re-sort.
 */
export function partitionByComfort(
  months: ScoredMonth[],
): { recommend: ScoredMonth[]; avoid: ScoredMonth[] } {
  const ranked = [...months].sort(
    (a, b) => b.score - a.score || a.month - b.month,
  );
  const bad = (m: ScoredMonth) => BAND_SCORE[m.band] <= BAND_SCORE.muggy;
  return {
    recommend: ranked.filter((m) => !bad(m)),
    avoid: ranked.filter(bad),
  };
}

/**
 * Months present in the input but excluded from the ranking for thin coverage.
 * Carries the numbers, because "no data for Jun" is a lie when Jun holds 28
 * readings — the fraction is what separates a broken fetch from a genuinely
 * unmeasured month.
 */
export function monthsExcluded(stats: MonthStats[]): ExcludedMonth[] {
  return stats
    .filter((s) => !hasEnoughCoverage(s))
    .map((s) => ({
      month: s.month,
      dayCount: s.dayCount,
      expectedDays: s.expectedDays,
      coverage: coverageOf(s),
    }));
}

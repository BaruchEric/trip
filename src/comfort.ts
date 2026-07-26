export type ComfortBand = "dry" | "pleasant" | "sticky" | "muggy" | "oppressive";

export interface MonthStats {
  month: number;
  dewPointMean: number;
  tempMaxMean: number;
  rainDays: number;
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

const BAND_SCORE: Record<ComfortBand, number> = {
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

export function rankMonths(stats: MonthStats[]): ScoredMonth[] {
  return stats
    .map(scoreMonth)
    .sort((a, b) => b.score - a.score || a.month - b.month);
}

import type { MonthStats } from "@/comfort";

export const RAIN_DAY_THRESHOLD_MM = 1;

export interface DailyClimate {
  time: string[];
  dewPoint: (number | null)[];
  tempMax: (number | null)[];
  precip: (number | null)[];
}

/** Whole calendar years ending with the most recent complete year. */
export function archiveWindow(
  todayIso: string,
  years = 10,
): { startDate: string; endDate: string } {
  const lastFullYear = Number(todayIso.slice(0, 4)) - 1;
  return {
    startDate: `${lastFullYear - years + 1}-01-01`,
    endDate: `${lastFullYear}-12-31`,
  };
}

function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function aggregateToMonths(daily: DailyClimate): MonthStats[] {
  const dew: number[][] = Array.from({ length: 12 }, () => []);
  const temp: number[][] = Array.from({ length: 12 }, () => []);
  // rain days counted per (month, year) so the mean is "days per month", not "days total"
  const rain: Map<string, number>[] = Array.from({ length: 12 }, () => new Map());
  const yearsSeen: Set<string>[] = Array.from({ length: 12 }, () => new Set());

  for (let i = 0; i < daily.time.length; i++) {
    const stamp = daily.time[i];
    if (stamp === undefined) continue;
    const year = stamp.slice(0, 4);
    const idx = Number(stamp.slice(5, 7)) - 1;
    if (idx < 0 || idx > 11) continue;

    yearsSeen[idx]!.add(year);

    const d = daily.dewPoint[i];
    if (typeof d === "number") dew[idx]!.push(d);

    const t = daily.tempMax[i];
    if (typeof t === "number") temp[idx]!.push(t);

    const p = daily.precip[i];
    if (typeof p === "number" && p >= RAIN_DAY_THRESHOLD_MM) {
      rain[idx]!.set(year, (rain[idx]!.get(year) ?? 0) + 1);
    }
  }

  return Array.from({ length: 12 }, (_, idx) => {
    const years = yearsSeen[idx]!.size;
    const rainTotal = [...rain[idx]!.values()].reduce((a, b) => a + b, 0);
    return {
      month: idx + 1,
      dewPointMean: mean(dew[idx]!),
      tempMaxMean: mean(temp[idx]!),
      rainDays: years === 0 ? 0 : rainTotal / years,
      // Coverage of the PRIMARY signal. The means still read 0 for an empty
      // month; dayCount is what lets consumers tell "0 C" from "no data".
      dayCount: dew[idx]!.length,
    };
  });
}

import type { DailyClimate } from "@/climate/aggregate";
import { fetchJson } from "@/http";

const ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive";

// Canonical names verified against the live API 2026-07-26.
const DAILY_VARS = [
  "dew_point_2m_mean",
  "temperature_2m_max",
  "precipitation_sum",
] as const;

function numArray(v: unknown): (number | null)[] {
  if (!Array.isArray(v)) return [];
  return v.map((x) => (typeof x === "number" ? x : null));
}

export async function fetchDailyClimate(
  lat: number,
  lon: number,
  startDate: string,
  endDate: string,
  fetchFn?: typeof fetch,
  timeoutMs?: number,
): Promise<DailyClimate> {
  const url =
    `${ARCHIVE_URL}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${startDate}&end_date=${endDate}` +
    `&daily=${DAILY_VARS.join(",")}&timezone=auto` +
    // Pinned, not assumed. The comfort bands are Celsius constants and the rain
    // threshold is in mm; riding on the API's default would put the whole model
    // one upstream change away from silently ranking every city as unlivable.
    `&temperature_unit=celsius&precipitation_unit=mm`;

  const json = (await fetchJson(url, "Open-Meteo archive request", {
    fetchFn,
    timeoutMs,
  })) as { reason?: string; daily?: Record<string, unknown> };

  // Open-Meteo also reports failures on a 200, so the status check inside
  // fetchJson is not sufficient on its own.
  if (json.reason) {
    throw new Error(`Open-Meteo archive request failed: ${json.reason}`);
  }

  const daily = json.daily ?? {};
  const time = Array.isArray(daily.time) ? (daily.time as string[]) : [];
  const dewPoint = numArray(daily["dew_point_2m_mean"]);
  const tempMax = numArray(daily["temperature_2m_max"]);
  const precip = numArray(daily["precipitation_sum"]);

  // If the archive returns days but drops ONE variable entirely, every month
  // silently loses that axis. `dayCount` only tracks dew-point coverage, so a
  // missing precip array zeroes rainDays for all 12 months without excluding
  // or flagging anything — which removes the rain penalty DIFFERENTIALLY and
  // can reorder the ranking with no visible tell. That is the same failure
  // class dayCount exists to prevent, on the two axes it does not cover.
  // Fail loudly instead.
  // An array that is PRESENT but carries no usable numbers is the same failure
  // as an absent one, and checking only `.length` missed it: an all-null
  // temperature array left tempMaxMean at 0, so a muggy 29C August rendered as
  // "cold, highs 0C" while dayCount stayed healthy and nothing was excluded.
  const usable = (a: (number | null)[]) => a.some((v) => typeof v === "number");

  if (time.length > 0) {
    const missing = [
      !usable(dewPoint) ? "dew_point_2m_mean" : null,
      !usable(tempMax) ? "temperature_2m_max" : null,
      !usable(precip) ? "precipitation_sum" : null,
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      throw new Error(
        `Open-Meteo returned ${time.length} days but no usable data for: ${missing.join(", ")}`,
      );
    }
  }

  return { time, dewPoint, tempMax, precip };
}

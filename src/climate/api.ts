import type { DailyClimate } from "@/climate/aggregate";

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
  fetchFn: typeof fetch = fetch,
): Promise<DailyClimate> {
  const url =
    `${ARCHIVE_URL}?latitude=${lat}&longitude=${lon}` +
    `&start_date=${startDate}&end_date=${endDate}` +
    `&daily=${DAILY_VARS.join(",")}&timezone=auto`;

  const res = await fetchFn(url);
  const json = (await res.json()) as {
    reason?: string;
    daily?: Record<string, unknown>;
  };

  if (!res.ok || json.reason) {
    throw new Error(
      `Open-Meteo archive request failed (HTTP ${res.status}): ${json.reason ?? "unknown error"}`,
    );
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
  if (time.length > 0) {
    const missing = [
      dewPoint.length === 0 ? "dew_point_2m_mean" : null,
      tempMax.length === 0 ? "temperature_2m_max" : null,
      precip.length === 0 ? "precipitation_sum" : null,
    ].filter((v): v is string => v !== null);
    if (missing.length > 0) {
      throw new Error(
        `Open-Meteo returned ${time.length} days but no data for: ${missing.join(", ")}`,
      );
    }
  }

  return { time, dewPoint, tempMax, precip };
}

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
  return {
    time: Array.isArray(daily.time) ? (daily.time as string[]) : [],
    dewPoint: numArray(daily["dew_point_2m_mean"]),
    tempMax: numArray(daily["temperature_2m_max"]),
    precip: numArray(daily["precipitation_sum"]),
  };
}

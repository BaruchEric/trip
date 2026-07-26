import type { Client } from "@libsql/client";
import type { GeoCandidate } from "@/geocode";
import type { MonthStats } from "@/comfort";
import { fetchDailyClimate } from "@/climate/api";
import { aggregateToMonths, archiveWindow } from "@/climate/aggregate";

export async function upsertDestination(
  db: Client,
  c: GeoCandidate,
): Promise<number> {
  await db.execute({
    sql: `INSERT INTO destinations
            (name, country, country_code, latitude, longitude, timezone)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT (name, country_code) DO UPDATE SET
            latitude = excluded.latitude,
            longitude = excluded.longitude,
            timezone = excluded.timezone`,
    args: [c.name, c.country, c.countryCode ?? "", c.latitude, c.longitude, c.timezone],
  });

  const r = await db.execute({
    sql: `SELECT id FROM destinations WHERE name = ? AND country_code = ?`,
    args: [c.name, c.countryCode ?? ""],
  });
  return Number(r.rows[0]!.id);
}

export async function readMonths(
  db: Client,
  destinationId: number,
): Promise<MonthStats[] | null> {
  const r = await db.execute({
    sql: `SELECT month, dew_point_mean, temp_max_mean, rain_days, day_count
          FROM climate_months WHERE destination_id = ? ORDER BY month`,
    args: [destinationId],
  });
  if (r.rows.length === 0) return null;
  return r.rows.map((row) => ({
    month: Number(row.month),
    dewPointMean: Number(row.dew_point_mean),
    tempMaxMean: Number(row.temp_max_mean),
    rainDays: Number(row.rain_days),
    dayCount: Number(row.day_count),
  }));
}

export async function writeMonths(
  db: Client,
  destinationId: number,
  months: MonthStats[],
  fetchedAt: string,
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM climate_months WHERE destination_id = ?`,
    args: [destinationId],
  });
  await db.batch(
    months.map((m) => ({
      sql: `INSERT INTO climate_months
              (destination_id, month, dew_point_mean, temp_max_mean, rain_days,
               day_count, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [destinationId, m.month, m.dewPointMean, m.tempMaxMean, m.rainDays,
             m.dayCount, fetchedAt],
    })),
    "write",
  );
}

export async function getClimate(
  db: Client,
  candidate: GeoCandidate,
  opts: { todayIso?: string; force?: boolean; fetchFn?: typeof fetch } = {},
): Promise<MonthStats[]> {
  const todayIso = opts.todayIso ?? new Date().toISOString().slice(0, 10);
  const id = await upsertDestination(db, candidate);

  if (!opts.force) {
    const cached = await readMonths(db, id);
    if (cached) return cached;
  }

  const { startDate, endDate } = archiveWindow(todayIso);
  const daily = await fetchDailyClimate(
    candidate.latitude,
    candidate.longitude,
    startDate,
    endDate,
    opts.fetchFn,
  );
  const months = aggregateToMonths(daily);
  await writeMonths(db, id, months, todayIso);
  return months;
}

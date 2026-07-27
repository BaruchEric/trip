import type { Client } from "@libsql/client";

/** Measured travel between two points, as ONE router reported it.
 *
 *  Never an average, never a merge: `listLegs` returns one entry per source,
 *  and the decision of which to believe belongs to `@/plan/travel`. The two
 *  routers disagree by a median 4.7 minutes and a maximum of 25.1, and that
 *  disagreement is a fact about the city worth keeping. */
export interface MeasuredLeg {
  fromLat: number;
  fromLon: number;
  toLat: number;
  toLon: number;
  mode: string;
  source: string;
  minutes: number;
  meters: number;
  fetchedAt: string;
}

export const LEG_SOURCES = ["osrm-foot", "valhalla-pedestrian"] as const;
export type LegSource = (typeof LEG_SOURCES)[number];

/** ~1.1 m. Coordinates arrive from Nominatim with 7 decimals and pass through
 *  JSON and SQLite REAL on the way here; matching on the raw float would make
 *  a lookup miss over a difference no map can represent. */
export function roundCoord(x: number): number {
  return Math.round(x * 1e5) / 1e5;
}

/** The DIRECTED key, as a string, for in-memory lookup.
 *
 *  Directed because Valhalla pedestrian is: it models grade, so the uphill
 *  return over the same ground is a different number. Sorting the endpoints
 *  here — which is the obvious way to write this — would silently answer the
 *  uphill question with the downhill measurement. */
export function legKey(
  fromLat: number, fromLon: number, toLat: number, toLon: number, mode: string,
): string {
  return [
    roundCoord(fromLat), roundCoord(fromLon),
    roundCoord(toLat), roundCoord(toLon), mode,
  ].join("|");
}

export async function saveLeg(db: Client, leg: MeasuredLeg): Promise<void> {
  await db.execute({
    // REPLACE on the unique key: re-measuring the same leg from the same
    // router is a CORRECTION, not a second opinion. A second opinion is what
    // `source` is for.
    sql: `INSERT OR REPLACE INTO route_legs
            (from_lat, from_lon, to_lat, to_lon, mode, source, minutes, meters, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      roundCoord(leg.fromLat), roundCoord(leg.fromLon),
      roundCoord(leg.toLat), roundCoord(leg.toLon),
      leg.mode, leg.source, leg.minutes, leg.meters, leg.fetchedAt,
    ],
  });
}

export async function listLegs(db: Client): Promise<MeasuredLeg[]> {
  const r = await db.execute(
    `SELECT from_lat, from_lon, to_lat, to_lon, mode, source, minutes, meters, fetched_at
       FROM route_legs
      ORDER BY from_lat, from_lon, to_lat, to_lon, source`,
  );
  return r.rows.map((row) => ({
    fromLat: Number(row.from_lat), fromLon: Number(row.from_lon),
    toLat: Number(row.to_lat), toLon: Number(row.to_lon),
    mode: String(row.mode), source: String(row.source),
    minutes: Number(row.minutes), meters: Number(row.meters),
    fetchedAt: String(row.fetched_at),
  }));
}

export async function countLegs(db: Client): Promise<number> {
  const r = await db.execute(`SELECT COUNT(*) AS c FROM route_legs`);
  return Number(r.rows[0]!.c);
}

export async function clearLegs(db: Client): Promise<void> {
  await db.execute(`DELETE FROM route_legs`);
}

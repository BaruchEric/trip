import type { Client } from "@libsql/client";

export interface Segment {
  id: number;
  tripId: number;
  name: string;
  /** NULL when unknown. Never 0 — that is a real place in the Gulf of Guinea. */
  latitude: number | null;
  longitude: number | null;
  dwellMinutes: number;
  cost: number | null;
  tags: string[];
  /** NULL means hours are UNKNOWN, never "open all day". See M2-2. */
  opensMin: number | null;
  closesMin: number | null;
  closedDays: string[];
  status: string;
}

export type SegmentInput = Omit<Segment, "id" | "tripId" | "status">;

/** Tags and closed days share one column each, comma separated. A tag holding
 *  a comma would silently become two tags on read, so it is rejected here
 *  rather than corrupting the row. */
function joinList(values: string[], field: string): string {
  for (const v of values) {
    if (v.includes(",")) {
      throw new Error(`${field} value "${v}" may not contain a comma`);
    }
  }
  return values.join(",");
}

function splitList(raw: unknown): string[] {
  const s = typeof raw === "string" ? raw : "";
  return s === "" ? [] : s.split(",");
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export async function addSegment(
  db: Client,
  tripId: number,
  input: SegmentInput,
): Promise<number> {
  const tags = joinList(input.tags, "tag");
  const closedDays = joinList(input.closedDays, "closed day");

  const r = await db.execute({
    sql: `INSERT INTO segments
            (trip_id, name, latitude, longitude, dwell_minutes, cost,
             tags, opens_minutes, closes_minutes, closed_days)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
    args: [tripId, input.name, input.latitude, input.longitude,
           input.dwellMinutes, input.cost, tags,
           input.opensMin, input.closesMin, closedDays],
  });
  return Number(r.rows[0]!.id);
}

export async function listSegments(db: Client, tripId: number): Promise<Segment[]> {
  const r = await db.execute({
    sql: `SELECT id, trip_id, name, latitude, longitude, dwell_minutes, cost,
                 tags, opens_minutes, closes_minutes, closed_days, status
          FROM segments WHERE trip_id = ? ORDER BY id`,
    args: [tripId],
  });
  return r.rows.map((row) => ({
    id: Number(row.id),
    tripId: Number(row.trip_id),
    name: String(row.name),
    latitude: numOrNull(row.latitude),
    longitude: numOrNull(row.longitude),
    dwellMinutes: Number(row.dwell_minutes),
    cost: numOrNull(row.cost),
    tags: splitList(row.tags),
    opensMin: numOrNull(row.opens_minutes),
    closesMin: numOrNull(row.closes_minutes),
    closedDays: splitList(row.closed_days),
    status: String(row.status),
  }));
}

export async function removeSegment(
  db: Client,
  tripId: number,
  id: number,
): Promise<boolean> {
  // Confirm the segment actually belongs to this trip BEFORE touching
  // placements. Deleting placements first unconditionally (by segment_id
  // alone) would reach into another trip's segment when the id doesn't
  // belong to tripId — the scoped `segments` delete below would then
  // correctly no-op, but the placements row would already be gone.
  const owned = await db.execute({
    sql: `SELECT 1 FROM segments WHERE id = ? AND trip_id = ?`,
    args: [id, tripId],
  });
  if (owned.rows.length === 0) return false;

  // Placements reference segments, so the derived row goes first to satisfy
  // the foreign key.
  await db.execute({ sql: `DELETE FROM placements WHERE segment_id = ?`, args: [id] });
  const r = await db.execute({
    sql: `DELETE FROM segments WHERE id = ? AND trip_id = ?`,
    args: [id, tripId],
  });
  return r.rowsAffected > 0;
}

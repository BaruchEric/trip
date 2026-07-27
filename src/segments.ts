import type { Client } from "@libsql/client";
import { joinList, normalizeWeekday } from "@/validate";

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

function splitList(raw: unknown): string[] {
  const s = typeof raw === "string" ? raw : "";
  return s === "" ? [] : s.split(",");
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

/** Every check that must hold no matter which caller wrote the row. The CLI
 *  parsers already enforce most of these, which is exactly why they were
 *  unreachable defects until M3 started writing segments directly. */
function validate(input: SegmentInput): void {
  if (input.name.trim() === "") {
    throw new Error("segment name may not be blank");
  }
  if (!Number.isInteger(input.dwellMinutes) || input.dwellMinutes <= 0) {
    throw new Error(
      `invalid dwell ${input.dwellMinutes} (expected a positive whole number of minutes)`,
    );
  }
  // Empty and comma-bearing tags are rejected by joinList, called below.
  // Coordinates are a PAIR. One without the other is not a location, and
  // storing the half we have would make `latitude !== null` — the test the
  // compiler uses for placeability — true for a segment that cannot be placed.
  if ((input.latitude === null) !== (input.longitude === null)) {
    throw new Error("latitude and longitude must both be set, or both be null");
  }
  if (input.latitude !== null && Math.abs(input.latitude) > 90) {
    throw new Error(`invalid latitude ${input.latitude}`);
  }
  if (input.longitude !== null && Math.abs(input.longitude) > 180) {
    throw new Error(`invalid longitude ${input.longitude}`);
  }
  // opensMin is a clock time (0..1439). closesMin may be 1440, the end of the
  // day: `--hours=10:00-24:00` stores 1439 at the CLI, but callers and the
  // existing suite pass 1440 directly, and both mean "closes at midnight".
  if (input.opensMin !== null && (input.opensMin < 0 || input.opensMin > 1439)) {
    throw new Error(`invalid opening time ${input.opensMin}`);
  }
  if (input.closesMin !== null && (input.closesMin < 1 || input.closesMin > 1440)) {
    throw new Error(`invalid closing time ${input.closesMin}`);
  }
  // Cross-midnight (opens 20:00, closes 02:00) is rejected rather than stored:
  // the scheduler compares `start + dwell > closesMin` on a single day's
  // minutes (src/plan/schedule.ts:53), so a wrapped window would read as a
  // window that closes before it opens and silently reject every placement.
  if (
    input.opensMin !== null && input.closesMin !== null &&
    input.closesMin <= input.opensMin
  ) {
    throw new Error("opening hours must close after they open");
  }
}

export async function addSegment(
  db: Client,
  tripId: number,
  input: SegmentInput,
): Promise<number> {
  validate(input);
  const tags = joinList(input.tags, "tag");
  const closedDays = joinList(input.closedDays.map(normalizeWeekday), "closed day");

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

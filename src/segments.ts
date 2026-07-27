import type { Client } from "@libsql/client";
import { joinList, normalizeWeekday } from "@/validate";
import { unlinkSegment } from "@/mentions";

export interface Segment {
  id: number;
  tripId: number;
  name: string;
  /** OSM's own name, in local script (洪崖洞), when this segment came from a
   *  geocoded mention. NULL when unknown — the rendering shows it in
   *  parentheses beside `name`, which stays the words the video used. */
  localName: string | null;
  /** NULL when unknown. Never 0 — that is a real place in the Gulf of Guinea. */
  latitude: number | null;
  longitude: number | null;
  dwellMinutes: number;
  /** True when nobody supplied a dwell and the 60-minute default was applied.
   *  The number is a guess, so it is rendered with a [default] marker rather
   *  than passing as a measured value. */
  dwellIsDefault: boolean;
  cost: number | null;
  tags: string[];
  /** NULL means hours are UNKNOWN, never "open all day". See M2-2. */
  opensMin: number | null;
  closesMin: number | null;
  closedDays: string[];
  status: string;
  /** The video this came from, and the second mark it was said at. Both NULL
   *  for a hand-added segment. */
  sourceId: number | null;
  sourceAtSeconds: number | null;
}

/** Provenance is optional on the way IN: a hand-added segment genuinely has
 *  none, and every existing caller constructs one without it. */
export type SegmentInput =
  Omit<Segment,
    "id" | "tripId" | "status" | "localName" | "sourceId" | "sourceAtSeconds" | "dwellIsDefault">
  & Partial<Pick<Segment,
    "localName" | "sourceId" | "sourceAtSeconds" | "dwellIsDefault">>;

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
  // Number("") is 0 and Number("abc") is NaN — a geocoder response with a
  // missing or malformed field reaches here as NaN, which passes every
  // comparison silently (Math.abs(NaN) > 90 is false). Left unchecked, the
  // segment would be stored at an uncomparable coordinate that clustering
  // treats as neither near nor far from anything.
  if (
    input.latitude !== null &&
    (!Number.isFinite(input.latitude) || Math.abs(input.latitude) > 90)
  ) {
    throw new Error(`invalid latitude ${input.latitude}`);
  }
  if (
    input.longitude !== null &&
    (!Number.isFinite(input.longitude) || Math.abs(input.longitude) > 180)
  ) {
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
  // Provenance is only useful if it is true. A NaN here would render as a
  // garbage minute mark in the review queue — a corrupt value presented as a
  // fact, which is worse than the NULL that means "the extractor gave no
  // timestamp". Guarded here rather than upstream for the same reason as the
  // coordinate checks: the CLI parser is not the only caller.
  if (
    input.sourceAtSeconds !== undefined && input.sourceAtSeconds !== null &&
    (!Number.isInteger(input.sourceAtSeconds) || input.sourceAtSeconds < 0)
  ) {
    throw new Error(`invalid source timestamp ${input.sourceAtSeconds}`);
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
            (trip_id, name, local_name, latitude, longitude, dwell_minutes,
             dwell_is_default, cost, tags, opens_minutes, closes_minutes,
             closed_days, source_id, source_at_seconds)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
    args: [tripId, input.name.trim(), input.localName ?? null,
           input.latitude, input.longitude, input.dwellMinutes,
           input.dwellIsDefault ? 1 : 0, input.cost, tags,
           input.opensMin, input.closesMin, closedDays,
           input.sourceId ?? null, input.sourceAtSeconds ?? null],
  });
  return Number(r.rows[0]!.id);
}

export async function listSegments(
  db: Client,
  tripId: number,
  opts: { sourceId?: number } = {},
): Promise<Segment[]> {
  const args: number[] = [tripId];
  let sql = `SELECT id, trip_id, name, local_name, latitude, longitude,
                    dwell_minutes, dwell_is_default, cost, tags,
                    opens_minutes, closes_minutes, closed_days, status,
                    source_id, source_at_seconds
             FROM segments WHERE trip_id = ?`;
  if (opts.sourceId !== undefined) {
    sql += ` AND source_id = ?`;
    args.push(opts.sourceId);
  }
  sql += ` ORDER BY id`;
  const r = await db.execute({ sql, args });
  return r.rows.map((row) => ({
    id: Number(row.id),
    tripId: Number(row.trip_id),
    name: String(row.name),
    localName: row.local_name === null ? null : String(row.local_name),
    latitude: numOrNull(row.latitude),
    longitude: numOrNull(row.longitude),
    dwellMinutes: Number(row.dwell_minutes),
    dwellIsDefault: Number(row.dwell_is_default) === 1,
    cost: numOrNull(row.cost),
    tags: splitList(row.tags),
    opensMin: numOrNull(row.opens_minutes),
    closesMin: numOrNull(row.closes_minutes),
    closedDays: splitList(row.closed_days),
    status: String(row.status),
    sourceId: numOrNull(row.source_id),
    sourceAtSeconds: numOrNull(row.source_at_seconds),
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

  // mentions.segment_id has an ENFORCED foreign key to segments(id) — the
  // driver runs with PRAGMA foreign_keys = 1 — so without this the delete does
  // not dangle, it FAILS, with an opaque constraint error naming neither the
  // mention nor the video. Clearing the reference first turns that into the
  // honest outcome: the video still said this place, so the mention goes back
  // on the queue rather than being lost or blocking the delete.
  //
  // ORDER IS LOAD-BEARING: this runs AFTER the ownership check above.
  // unlinkSegment matches on segment_id alone with no trip scoping, so moving
  // it earlier would let a wrong-trip `seg rm` — which correctly returns false
  // and deletes nothing — still un-resolve ANOTHER trip's mention.
  await unlinkSegment(db, id, "segment deleted");

  // Placements reference segments, so the derived row goes first to satisfy
  // the foreign key.
  await db.execute({ sql: `DELETE FROM placements WHERE segment_id = ?`, args: [id] });
  const r = await db.execute({
    sql: `DELETE FROM segments WHERE id = ? AND trip_id = ?`,
    args: [id, tripId],
  });
  return r.rowsAffected > 0;
}

/** Correct a dwell without delete-and-re-add. Clearing dwell_is_default is the
 *  point: once a human or an agent has supplied a real number, it must stop
 *  being rendered as the 60-minute guess. */
export async function setSegmentDwell(
  db: Client,
  tripId: number,
  id: number,
  dwellMinutes: number,
): Promise<boolean> {
  if (!Number.isInteger(dwellMinutes) || dwellMinutes <= 0) {
    throw new Error(
      `invalid dwell ${dwellMinutes} (expected a positive whole number of minutes)`,
    );
  }
  const r = await db.execute({
    sql: `UPDATE segments SET dwell_minutes = ?, dwell_is_default = 0
          WHERE id = ? AND trip_id = ?`,
    args: [dwellMinutes, id, tripId],
  });
  return r.rowsAffected > 0;
}

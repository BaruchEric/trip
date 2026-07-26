import type { Client } from "@libsql/client";
import type { Pin, Placement } from "@/plan/types";

/** Placements are disposable, pins are not (decision 7). Every write here is
 *  built around that split: `savePlacements` rebuilds the plan wholesale and
 *  must never disturb a pin, because surviving `replan` is the only promise
 *  `pin` makes.
 *
 *  Migration 5 note: `pin_start_minutes` and `start_minutes` used to be one
 *  column. That worked for a TIMED pin, where the user's assertion and the
 *  compiled result are the same number — but a day-locked pin (`trip move`,
 *  startMin null) asserts a day and no time, while the compiler still owes
 *  it one. compile() only marks a timed pin `pinned: true`; a day-locked
 *  segment runs through the ordinary layout path and comes back
 *  `pinned: false`, same as a free segment. The old `savePlacements` did a
 *  plain INSERT for anything not `pinned`, which collided with `setPinned`'s
 *  row on the `segment_id` primary key the moment a day-locked pin got
 *  replanned. Splitting the columns and upserting fixes it: only
 *  `setPinned`/`clearPin` ever write `pinned` or `pin_start_minutes`; only
 *  `savePlacements` ever writes `start_minutes`, `day_number`, `ordinal`. */

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export async function savePlacements(
  db: Client,
  tripId: number,
  placements: Placement[],
): Promise<void> {
  // Scoped delete via the segments join: placements has no trip_id of its own.
  // Stale UNPINNED rows are dropped outright — a segment the compiler no
  // longer places should not linger. Pinned rows are never deleted here;
  // they are only ever touched by the upsert below, which leaves `pinned`
  // and `pin_start_minutes` alone.
  await db.execute({
    sql: `DELETE FROM placements
          WHERE pinned = 0
            AND segment_id IN (SELECT id FROM segments WHERE trip_id = ?)`,
    args: [tripId],
  });

  if (placements.length === 0) return;

  // Every compiled placement is written, pinned or not — that is what gives
  // a day-locked segment a real clock time instead of the NULL that used to
  // read as midnight. `pinned` is hardcoded 0 on the INSERT branch: a
  // segment can only reach the UPDATE branch already pinned (via
  // `setPinned`), so a fresh row is by definition one the user never pinned.
  await db.batch(
    placements.map((p) => ({
      sql: `INSERT INTO placements
              (segment_id, day_number, ordinal, start_minutes, pinned)
            VALUES (?, ?, ?, ?, 0)
            ON CONFLICT (segment_id) DO UPDATE SET
              day_number = excluded.day_number,
              ordinal = excluded.ordinal,
              start_minutes = excluded.start_minutes`,
      args: [p.segmentId, p.day, p.ordinal, p.startMin],
    })),
    "write",
  );
}

export async function readPlacements(
  db: Client,
  tripId: number,
): Promise<Placement[]> {
  const r = await db.execute({
    sql: `SELECT p.segment_id, p.day_number, p.ordinal, p.start_minutes,
                 p.pinned, s.dwell_minutes
          FROM placements p JOIN segments s ON s.id = p.segment_id
          WHERE s.trip_id = ?
          ORDER BY p.day_number, p.ordinal`,
    args: [tripId],
  });
  return r.rows.map((row) => ({
    segmentId: Number(row.segment_id),
    day: Number(row.day_number),
    ordinal: Number(row.ordinal),
    // `start_minutes` is now purely the COMPILED time (migration 5) — every
    // placement `savePlacements` writes gets one, pinned or not. It is only
    // ever NULL for a pinned segment that has never been through a
    // successful `savePlacements` (pinned before the first `trip plan`, or
    // permanently unplaceable, e.g. pinned to a day outside the trip).
    // Number(null) -> 0 still reads as midnight in that narrow window;
    // callers that display a single segment before any plan has run should
    // guard on that separately (see `trip day`'s "nothing planned yet").
    startMin: Number(row.start_minutes),
    endMin: Number(row.start_minutes) + Number(row.dwell_minutes),
    pinned: Number(row.pinned) === 1,
  }));
}

export async function readPins(db: Client, tripId: number): Promise<Pin[]> {
  const r = await db.execute({
    sql: `SELECT p.segment_id, p.day_number, p.pin_start_minutes
          FROM placements p JOIN segments s ON s.id = p.segment_id
          WHERE s.trip_id = ? AND p.pinned = 1
          ORDER BY p.segment_id`,
    args: [tripId],
  });
  return r.rows.map((row) => ({
    segmentId: Number(row.segment_id),
    day: Number(row.day_number),
    startMin: numOrNull(row.pin_start_minutes),
  }));
}

/** `startMin` null is a day-lock: the day is fixed, the time is still the
 *  compiler's to choose. That is what `trip move` produces. Writes only the
 *  assertion columns (`pinned`, `day_number`, `pin_start_minutes`) — never
 *  `start_minutes`, which belongs to `savePlacements` alone. On a fresh
 *  INSERT, `start_minutes` is simply omitted, so it lands NULL: "no plan has
 *  compiled this segment yet," not a value this function has any business
 *  asserting. */
export async function setPinned(
  db: Client,
  segmentId: number,
  day: number,
  startMin: number | null,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO placements
            (segment_id, day_number, ordinal, pin_start_minutes, pinned)
          VALUES (?, ?, 0, ?, 1)
          ON CONFLICT (segment_id) DO UPDATE SET
            day_number = excluded.day_number,
            -- Reset, not preserved: ordinal belongs to the compiler, and a
            -- pin re-asserted after a plan ran must not keep that plan's
            -- stale position. The next replan assigns a real one.
            ordinal = 0,
            pin_start_minutes = excluded.pin_start_minutes,
            pinned = 1`,
    args: [segmentId, day, startMin],
  });
}

export async function clearPin(db: Client, segmentId: number): Promise<boolean> {
  const r = await db.execute({
    sql: `DELETE FROM placements WHERE segment_id = ? AND pinned = 1`,
    args: [segmentId],
  });
  return r.rowsAffected > 0;
}

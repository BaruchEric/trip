import type { Client } from "@libsql/client";
import type { Pin, Placement } from "@/plan/types";

/** Placements are disposable, pins are not (decision 7). Every write here is
 *  built around that split: `savePlacements` rebuilds the plan wholesale and
 *  must never disturb a pin, because surviving `replan` is the only promise
 *  `pin` makes. */

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

export async function savePlacements(
  db: Client,
  tripId: number,
  placements: Placement[],
): Promise<void> {
  // Scoped delete via the segments join: placements has no trip_id of its own.
  await db.execute({
    sql: `DELETE FROM placements
          WHERE pinned = 0
            AND segment_id IN (SELECT id FROM segments WHERE trip_id = ?)`,
    args: [tripId],
  });

  const rows = placements.filter((p) => !p.pinned);
  if (rows.length === 0) return;

  await db.batch(
    rows.map((p) => ({
      sql: `INSERT INTO placements
              (segment_id, day_number, ordinal, start_minutes, pinned)
            VALUES (?, ?, ?, ?, 0)`,
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
    // HAZARD: `start_minutes` is NULL for a day-locked pin (`trip move`),
    // and `Placement.startMin` (Task 4) is typed non-nullable. Number(null)
    // coerces to 0, which reads as "midnight" — exactly the sentinel this
    // codebase's NULL-means-unknown rule forbids. This is a real gap: it is
    // unreachable from `savePlacements` (which never touches pinned rows),
    // but `readPlacements` selects pinned rows too, so any caller that reads
    // a day-locked pin back through here (e.g. `trip day`, Task 11) gets 0
    // instead of the compiler's chosen time. Flagged in task-9-report.md;
    // not fixed here because the fix is either a compile()-side change
    // (Task 8) or a Placement type change (Task 4), both out of this file's
    // scope.
    startMin: Number(row.start_minutes),
    endMin: Number(row.start_minutes) + Number(row.dwell_minutes),
    pinned: Number(row.pinned) === 1,
  }));
}

export async function readPins(db: Client, tripId: number): Promise<Pin[]> {
  const r = await db.execute({
    sql: `SELECT p.segment_id, p.day_number, p.start_minutes
          FROM placements p JOIN segments s ON s.id = p.segment_id
          WHERE s.trip_id = ? AND p.pinned = 1
          ORDER BY p.segment_id`,
    args: [tripId],
  });
  return r.rows.map((row) => ({
    segmentId: Number(row.segment_id),
    day: Number(row.day_number),
    startMin: numOrNull(row.start_minutes),
  }));
}

/** `startMin` null is a day-lock: the day is fixed, the time is still the
 *  compiler's to choose. That is what `trip move` produces. */
export async function setPinned(
  db: Client,
  segmentId: number,
  day: number,
  startMin: number | null,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO placements
            (segment_id, day_number, ordinal, start_minutes, pinned)
          VALUES (?, ?, 0, ?, 1)
          ON CONFLICT (segment_id) DO UPDATE SET
            day_number = excluded.day_number,
            start_minutes = excluded.start_minutes,
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

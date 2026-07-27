import type { Client, Row } from "@libsql/client";

export interface Pass {
  id: number;
  tripId: number;
  name: string;
  /** 1-based day numbers, matching `DayWindow.day` and `trip pin --day=`.
   *
   *  Day numbers rather than dates: they always resolve, where a date range
   *  would go stale the moment the trip is re-dated. The range is validated
   *  against the trip's real day count at the command layer, WHEN there is
   *  one — a trip with no dates has no day count, and a check that cannot be
   *  sure says nothing. */
  fromDay: number;
  toDay: number;
}

const SELECT = `SELECT id, trip_id, name, from_day, to_day FROM passes`;

function toPass(row: Row): Pass {
  return {
    id: Number(row.id),
    tripId: Number(row.trip_id),
    name: String(row.name),
    fromDay: Number(row.from_day),
    toDay: Number(row.to_day),
  };
}

export async function addPass(
  db: Client,
  tripId: number,
  name: string,
  fromDay: number,
  toDay: number,
): Promise<number> {
  const label = name.trim();
  if (label === "") throw new Error("pass name may not be blank");
  for (const [side, v] of [["from", fromDay], ["to", toDay]] as const) {
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`invalid ${side} day ${v} (days are numbered from 1)`);
    }
  }
  if (toDay < fromDay) {
    throw new Error(`day range ${fromDay}-${toDay} ends before it starts`);
  }
  const r = await db.execute({
    sql: `INSERT INTO passes (trip_id, name, from_day, to_day) VALUES (?, ?, ?, ?)`,
    args: [tripId, label, fromDay, toDay],
  });
  return Number(r.lastInsertRowid);
}

export async function listPasses(db: Client, tripId: number): Promise<Pass[]> {
  const r = await db.execute({
    sql: `${SELECT} WHERE trip_id = ? ORDER BY from_day, id`,
    args: [tripId],
  });
  return r.rows.map(toPass);
}

export async function getPass(
  db: Client,
  tripId: number,
  id: number,
): Promise<Pass | null> {
  const r = await db.execute({
    sql: `${SELECT} WHERE trip_id = ? AND id = ?`,
    args: [tripId, id],
  });
  const row = r.rows[0];
  return row ? toPass(row) : null;
}

export async function removePass(
  db: Client,
  tripId: number,
  id: number,
): Promise<boolean> {
  const r = await db.execute({
    sql: `DELETE FROM passes WHERE trip_id = ? AND id = ?`,
    args: [tripId, id],
  });
  return r.rowsAffected > 0;
}

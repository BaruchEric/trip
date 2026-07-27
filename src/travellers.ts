import type { Client, Row } from "@libsql/client";

export interface Traveller {
  id: number;
  tripId: number;
  label: string;
  /** YYYY-MM-DD. Never null.
   *
   *  A nullable birth date would have to MEAN something when a price rule is
   *  matched against it, and the only available meaning is "adult" — a guess
   *  wearing the costume of a fact, which is the shape of defect this repo has
   *  now hit three times (the zero-filled climate month, the 0,0 coordinate,
   *  the null-as-midnight opening hour). A traveller whose birth date is
   *  unknown is not a traveller this feature can price, and the honest
   *  response is to refuse the row. */
  birthDate: string;
}

const SELECT = `SELECT id, trip_id, label, birth_date FROM travellers`;

function toTraveller(row: Row): Traveller {
  return {
    id: Number(row.id),
    tripId: Number(row.trip_id),
    label: String(row.label),
    birthDate: String(row.birth_date),
  };
}

/** Storage-layer validation, not CLI-only: `ingest` and any future importer
 *  cross this seam without ever touching an argv parser. That is the M3/M4
 *  lesson, applied before it can bite rather than after. */
function validateBirthDate(raw: string): string {
  const s = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new Error(`invalid birth date "${raw}" (expected YYYY-MM-DD)`);
  }
  const d = new Date(`${s}T00:00:00Z`);
  // The round-trip check is the load-bearing half: Date happily rolls
  // "2026-02-30" forward into March and "1949-13-01" into 1950, both of which
  // the regex accepts. Comparing the normalised string back against the input
  // is the only way to catch a day that does not exist.
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
    throw new Error(`invalid birth date "${raw}" (no such day)`);
  }
  return s;
}

export async function addTraveller(
  db: Client,
  tripId: number,
  label: string,
  birthDate: string,
): Promise<number> {
  const name = label.trim();
  if (name === "") throw new Error("traveller label may not be blank");
  const born = validateBirthDate(birthDate);

  // Checked explicitly rather than left to the UNIQUE constraint, so the error
  // names the traveller instead of surfacing a SQLITE_CONSTRAINT string.
  const existing = await db.execute({
    sql: `${SELECT} WHERE trip_id = ? AND label = ?`,
    args: [tripId, name],
  });
  if (existing.rows.length > 0) {
    throw new Error(`this trip already has a traveller called "${name}"`);
  }

  const r = await db.execute({
    sql: `INSERT INTO travellers (trip_id, label, birth_date) VALUES (?, ?, ?)`,
    args: [tripId, name, born],
  });
  return Number(r.lastInsertRowid);
}

/** Oldest first, so the party reads in the order concessions apply. */
export async function listTravellers(db: Client, tripId: number): Promise<Traveller[]> {
  const r = await db.execute({
    sql: `${SELECT} WHERE trip_id = ? ORDER BY birth_date, id`,
    args: [tripId],
  });
  return r.rows.map(toTraveller);
}

export async function removeTraveller(
  db: Client,
  tripId: number,
  label: string,
): Promise<boolean> {
  const r = await db.execute({
    sql: `DELETE FROM travellers WHERE trip_id = ? AND label = ?`,
    args: [tripId, label.trim()],
  });
  return r.rowsAffected > 0;
}

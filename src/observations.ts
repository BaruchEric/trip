import type { Client, Row } from "@libsql/client";

/** What a SOURCE said a trip cost.
 *
 *  An observation is a fact about somebody else's trip. Using it for yours
 *  needs three things — the unit, what span it covered, and how many people
 *  it covered — and each one's absence has to stay visible, which is why two
 *  of them are nullable and the third is not. */
export interface CostObservation {
  id: number;
  tripId: number;
  /** NULL for a hand-entered figure. */
  sourceId: number | null;
  /** NULL means the source never said when. */
  atSeconds: number | null;
  label: string;
  amount: number;
  /** Never blank: an amount with no unit cannot be compared to anything. */
  currency: string;
  /** NULL is UNKNOWN. Both are needed to normalise. */
  coversDays: number | null;
  coversPeople: number | null;
}

export type CostObservationInput = Omit<CostObservation, "id" | "tripId">;

const SELECT = `SELECT id, trip_id, source_id, at_seconds, label, amount,
                       currency, covers_days, covers_people
                FROM cost_observations`;

function toObservation(row: Row): CostObservation {
  return {
    id: Number(row.id),
    tripId: Number(row.trip_id),
    sourceId: row.source_id === null ? null : Number(row.source_id),
    atSeconds: row.at_seconds === null ? null : Number(row.at_seconds),
    label: String(row.label),
    amount: Number(row.amount),
    currency: String(row.currency),
    coversDays: row.covers_days === null ? null : Number(row.covers_days),
    coversPeople: row.covers_people === null ? null : Number(row.covers_people),
  };
}

/** What a figure works out to per person per day.
 *
 *  DERIVED, stored nowhere, and null whenever either axis is unknown.
 *
 *  "$401 for four days" means something very different for one traveller
 *  than for two, so dividing by a guessed denominator produces a number more
 *  confident than its inputs — the one thing this repo's arithmetic may never
 *  be. Same rule M5's party total follows, for the same reason. */
export function perPersonPerDay(o: CostObservation): number | null {
  if (o.coversDays === null || o.coversPeople === null) return null;
  // Belt and braces: `validate` rejects these on the way in, but a row
  // written before this guard existed must not divide by zero into Infinity,
  // which would render as a number and read as a fact.
  if (o.coversDays <= 0 || o.coversPeople <= 0) return null;
  return o.amount / (o.coversDays * o.coversPeople);
}

/** Every check that must hold no matter which caller wrote the row. Storage
 *  layer, not CLI: the same seam `ingest` and `review resolve` cross without
 *  touching an argv parser, which is the M3/M4 lesson applied before it
 *  bites rather than after. */
function validate(input: CostObservationInput): void {
  if (input.label.trim() === "") throw new Error("label may not be blank");
  if (input.currency.trim() === "") {
    throw new Error(
      "currency may not be blank - an amount with no unit cannot be compared",
    );
  }
  if (!Number.isFinite(input.amount) || input.amount < 0) {
    throw new Error(
      `invalid amount ${input.amount} (expected a finite number >= 0)`,
    );
  }
  for (const [name, v] of [
    ["covers_days", input.coversDays],
    ["covers_people", input.coversPeople],
  ] as const) {
    if (v === null) continue;
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(
        `invalid ${name} ${v} (expected a whole number >= 1, ` +
        `or omit it entirely for unknown)`,
      );
    }
  }
  if (
    input.atSeconds !== null &&
    (!Number.isInteger(input.atSeconds) || input.atSeconds < 0)
  ) {
    throw new Error(`invalid timestamp ${input.atSeconds}`);
  }
}

export async function addObservation(
  db: Client,
  tripId: number,
  input: CostObservationInput,
): Promise<number> {
  validate(input);
  const r = await db.execute({
    sql: `INSERT INTO cost_observations
            (trip_id, source_id, at_seconds, label, amount, currency,
             covers_days, covers_people)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [tripId, input.sourceId, input.atSeconds, input.label.trim(),
           input.amount, input.currency.trim(), input.coversDays,
           input.coversPeople],
  });
  return Number(r.lastInsertRowid);
}

export async function listObservations(
  db: Client,
  tripId: number,
): Promise<CostObservation[]> {
  const r = await db.execute({
    sql: `${SELECT} WHERE trip_id = ? ORDER BY id`,
    args: [tripId],
  });
  return r.rows.map(toObservation);
}

export async function removeObservation(
  db: Client,
  tripId: number,
  id: number,
): Promise<boolean> {
  const r = await db.execute({
    sql: `DELETE FROM cost_observations WHERE trip_id = ? AND id = ?`,
    args: [tripId, id],
  });
  return r.rowsAffected > 0;
}

import type { Client, Row } from "@libsql/client";

export interface Trip {
  id: number;
  name: string;
  destinationId: number | null;
  startDate: string | null;
  endDate: string | null;
  mode: string;
  pace: string;
  lodgingTier: string;
  foodTier: string;
  /** null means unknown, so day 1 is treated as full (M2-3). */
  arrivalMin: number | null;
  departureMin: number | null;
  dayStartMin: number;
  dayEndMin: number;
}

const ACTIVE_KEY = "active_trip";

function toTrip(row: Row): Trip {
  return {
    id: Number(row.id),
    name: String(row.name),
    destinationId: row.destination_id === null ? null : Number(row.destination_id),
    startDate: row.start_date === null ? null : String(row.start_date),
    endDate: row.end_date === null ? null : String(row.end_date),
    mode: String(row.mode),
    pace: String(row.pace),
    lodgingTier: String(row.lodging_tier),
    foodTier: String(row.food_tier),
    arrivalMin: row.arrival_time === null ? null : Number(row.arrival_time),
    departureMin: row.departure_time === null ? null : Number(row.departure_time),
    dayStartMin: Number(row.day_start),
    dayEndMin: Number(row.day_end),
  };
}

const SELECT = `SELECT id, name, destination_id, start_date, end_date,
                       mode, pace, lodging_tier, food_tier,
                       arrival_time, departure_time, day_start, day_end
                FROM trips`;

export async function createTrip(
  db: Client,
  name: string,
  createdAt: string,
): Promise<Trip> {
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: [name, createdAt],
  });
  const t = await getTripByName(db, name);
  if (!t) throw new Error(`failed to create trip "${name}"`);
  return t;
}

export async function listTrips(db: Client): Promise<Trip[]> {
  const r = await db.execute(`${SELECT} ORDER BY created_at DESC, id DESC`);
  return r.rows.map(toTrip);
}

export async function getTripByName(db: Client, name: string): Promise<Trip | null> {
  const r = await db.execute({ sql: `${SELECT} WHERE name = ?`, args: [name] });
  const row = r.rows[0];
  return row ? toTrip(row) : null;
}

export async function setActiveTrip(db: Client, name: string): Promise<void> {
  const t = await getTripByName(db, name);
  if (!t) throw new Error(`no trip named "${name}"`);
  await db.execute({
    sql: `INSERT INTO app_state (key, value) VALUES (?, ?)
          ON CONFLICT (key) DO UPDATE SET value = excluded.value`,
    args: [ACTIVE_KEY, name],
  });
}

export async function getActiveTrip(db: Client): Promise<Trip | null> {
  const r = await db.execute({
    sql: `SELECT value FROM app_state WHERE key = ?`,
    args: [ACTIVE_KEY],
  });
  const row = r.rows[0];
  if (!row) return null;
  return getTripByName(db, String(row.value));
}

export async function setTripSchedule(
  db: Client,
  tripId: number,
  s: {
    startDate: string; endDate: string;
    arrivalMin: number | null; departureMin: number | null;
    dayStartMin: number; dayEndMin: number;
  },
): Promise<void> {
  await db.execute({
    sql: `UPDATE trips SET start_date = ?, end_date = ?, arrival_time = ?,
                           departure_time = ?, day_start = ?, day_end = ?
          WHERE id = ?`,
    args: [s.startDate, s.endDate, s.arrivalMin, s.departureMin,
           s.dayStartMin, s.dayEndMin, tripId],
  });
}

export async function setTripDestination(
  db: Client,
  tripId: number,
  destinationId: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE trips SET destination_id = ? WHERE id = ?`,
    args: [destinationId, tripId],
  });
}

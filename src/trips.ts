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
  };
}

const SELECT = `SELECT id, name, destination_id, start_date, end_date,
                       mode, pace, lodging_tier, food_tier FROM trips`;

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

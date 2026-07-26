import { createClient, type Client } from "@libsql/client";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

export const DEFAULT_DB_PATH = join(homedir(), ".trip", "trip.db");

export function openDb(path: string = DEFAULT_DB_PATH): Client {
  mkdirSync(dirname(path), { recursive: true });
  return createClient({ url: `file:${path}` });
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS destinations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     country TEXT,
     -- NOT NULL DEFAULT '' is deliberate: SQLite treats NULLs as distinct in a
     -- UNIQUE constraint, so a nullable country_code would silently insert a
     -- duplicate destination on every run for any geocode hit lacking one.
     country_code TEXT NOT NULL DEFAULT '',
     latitude REAL NOT NULL,
     longitude REAL NOT NULL,
     timezone TEXT,
     UNIQUE (name, country_code)
   )`,
  `CREATE TABLE IF NOT EXISTS trips (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL UNIQUE,
     destination_id INTEGER REFERENCES destinations(id),
     start_date TEXT,
     end_date TEXT,
     mode TEXT NOT NULL DEFAULT 'walking',
     pace TEXT NOT NULL DEFAULT 'normal',
     lodging_tier TEXT NOT NULL DEFAULT 'mid',
     food_tier TEXT NOT NULL DEFAULT 'casual',
     created_at TEXT NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS climate_months (
     destination_id INTEGER NOT NULL REFERENCES destinations(id),
     month INTEGER NOT NULL CHECK (month BETWEEN 1 AND 12),
     dew_point_mean REAL NOT NULL,
     temp_max_mean REAL NOT NULL,
     rain_days REAL NOT NULL,
     fetched_at TEXT NOT NULL,
     PRIMARY KEY (destination_id, month)
   )`,
  `CREATE TABLE IF NOT EXISTS app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL
   )`,
];

export async function migrate(db: Client): Promise<void> {
  for (const stmt of SCHEMA) await db.execute(stmt);
}

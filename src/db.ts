import { createClient, type Client } from "@libsql/client";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";

export const DEFAULT_DB_PATH = join(homedir(), ".trip", "trip.db");

export function openDb(path: string = DEFAULT_DB_PATH): Client {
  mkdirSync(dirname(path), { recursive: true });
  return createClient({ url: `file:${path}` });
}

// ---------------------------------------------------------------------------
// Schema migrations
//
// `migrate()` used to be a bare loop over CREATE TABLE IF NOT EXISTS, which
// made every additive change a silent no-op on an existing database. Adding
// `day_count` to the array below left older installs with a 6-column
// climate_months, and readMonths then threw `no such column: day_count` on
// every run — `trip when` permanently dead, with nothing in the output saying
// why.
//
// THE RULE: BASE_SCHEMA is frozen. It is what a version-0 database gets, and
// nothing else. Every subsequent change is a new numbered entry in MIGRATIONS.
// Editing BASE_SCHEMA instead is precisely the bug this exists to prevent, and
// `test/db.test.ts` fails loudly if you do (it compares an upgraded database's
// table shapes against a fresh one).
// ---------------------------------------------------------------------------

const BASE_SCHEMA = [
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

const VERSION_TABLE = `CREATE TABLE IF NOT EXISTS schema_version (
     version INTEGER PRIMARY KEY,
     applied_at TEXT NOT NULL
   )`;

interface Migration {
  version: number;
  /** Statements to apply, resolved against the live database so a step can
   *  inspect what is already there. Returning [] makes the step a no-op that
   *  still records its version. */
  statements: (db: Client) => Promise<string[]>;
}

async function hasColumn(
  db: Client,
  table: string,
  column: string,
): Promise<boolean> {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.some((row) => row.name === column);
}

const MIGRATIONS: Migration[] = [
  { version: 1, statements: async () => BASE_SCHEMA },
  {
    version: 2,
    // How many days actually carried a dew-point reading for a given month.
    // 0 means "no data", which must never be scored as though it were 0 C.
    //
    // Guarded, and the guard is load-bearing: `day_count` was retrofitted
    // directly into the schema before versioning existed, so databases created
    // between 09f1374 and this commit already HAVE the column while still
    // reporting version 0. An unguarded ALTER throws "duplicate column name"
    // on exactly those installs — including the live ~/.trip/trip.db.
    statements: async (db) =>
      (await hasColumn(db, "climate_months", "day_count"))
        ? []
        : [
            `ALTER TABLE climate_months
               ADD COLUMN day_count INTEGER NOT NULL DEFAULT 0`,
          ],
  },
  {
    version: 3,
    // Days the archive window covered for a month, reading or not — the
    // denominator coverage is measured against. Without it the only available
    // test was `day_count > 0`, which ranked a month resting on a handful of
    // readings identically to a fully covered one.
    //
    // Existing rows are DELETED rather than backfilled. There is no honest
    // value to invent for them: the true denominator depends on the window that
    // was fetched, which was never recorded. climate_months is a cache — the
    // next `trip when` refetches the city in about four seconds and gets real
    // numbers. A fabricated denominator would be indistinguishable from a
    // measured one forever after.
    statements: async (db) =>
      (await hasColumn(db, "climate_months", "expected_days"))
        ? []
        : [
            `ALTER TABLE climate_months
               ADD COLUMN expected_days INTEGER NOT NULL DEFAULT 0`,
            `DELETE FROM climate_months`,
          ],
  },
  {
    version: 4,
    // M2: the segment library and the compiled plan. `days` is deliberately
    // absent — a day's window is fully derived from trip dates, arrival and
    // departure, and the day window, so storing it would be a second copy
    // that can disagree with the first.
    statements: async (db) =>
      (await hasColumn(db, "trips", "day_start"))
        ? []
        : [
            `CREATE TABLE IF NOT EXISTS segments (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               trip_id INTEGER NOT NULL REFERENCES trips(id),
               name TEXT NOT NULL,
               -- NULL means the segment has no coordinates yet, so it cannot
               -- be placed. It is NOT 0,0 (which is in the Gulf of Guinea).
               latitude REAL,
               longitude REAL,
               dwell_minutes INTEGER NOT NULL,
               cost REAL,
               tags TEXT NOT NULL DEFAULT '',
               -- NULL means opening hours are UNKNOWN, never "always open".
               -- The scheduler places these freely and reports them; it must
               -- never read a null as midnight-to-midnight.
               opens_minutes INTEGER,
               closes_minutes INTEGER,
               closed_days TEXT NOT NULL DEFAULT '',
               status TEXT NOT NULL DEFAULT 'confirmed'
             )`,
            `CREATE TABLE IF NOT EXISTS placements (
               segment_id INTEGER PRIMARY KEY REFERENCES segments(id),
               day_number INTEGER NOT NULL,
               ordinal INTEGER NOT NULL,
               -- Nullable on purpose: a day-locked pin (from 'trip move') has
               -- a fixed day and NO fixed time. NOT NULL here would force a
               -- sentinel like 0, which reads as "pinned to midnight".
               start_minutes INTEGER,
               pinned INTEGER NOT NULL DEFAULT 0
             )`,
            `ALTER TABLE trips ADD COLUMN arrival_time INTEGER`,
            `ALTER TABLE trips ADD COLUMN departure_time INTEGER`,
            `ALTER TABLE trips ADD COLUMN day_start INTEGER NOT NULL DEFAULT 540`,
            `ALTER TABLE trips ADD COLUMN day_end INTEGER NOT NULL DEFAULT 1140`,
          ],
  },
];

/** The version a freshly migrated database lands on. Derived, never hand-set. */
export const SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

/** 0 for a database that predates versioning, or an empty one. */
export async function schemaVersion(db: Client): Promise<number> {
  const t = await db.execute(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_version'`,
  );
  if (t.rows.length === 0) return 0;
  const r = await db.execute(`SELECT MAX(version) AS v FROM schema_version`);
  return Number(r.rows[0]?.v ?? 0);
}

export async function migrate(db: Client): Promise<void> {
  await db.execute(VERSION_TABLE);
  const current = await schemaVersion(db);

  // A database written by a NEWER build of trip. Migrating down is not a thing
  // this can do, and running an old build against a new schema would write
  // rows that silently omit whatever the newer version added. Refuse.
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database is at schema version ${current} but this build of trip only ` +
      `knows version ${SCHEMA_VERSION}. Upgrade trip, or point --db elsewhere.`,
    );
  }

  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    const stmts = await m.statements(db);
    // One batch, so the DDL and the version record commit together. A crash
    // mid-migration must not leave a database that claims a version it does
    // not have — that is a silently-wrong schema, the thing being fixed here.
    await db.batch(
      [
        ...stmts,
        {
          sql: `INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`,
          args: [m.version, new Date().toISOString()],
        },
      ],
      "write",
    );
  }
}

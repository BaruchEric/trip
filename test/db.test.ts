import { expect, test, describe } from "bun:test";
import { openDb, migrate, schemaVersion, SCHEMA_VERSION } from "@/db";
import { readMonths } from "@/climate/cache";
import type { Client } from "@libsql/client";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function tmpDb(name: string): string {
  const p = join(tmpdir(), `trip-test-${name}-${process.pid}.db`);
  rmSync(p, { force: true });
  return p;
}

// The schema exactly as commit 4ff869f shipped it, before `day_count` was
// retrofitted into climate_months. This is a historical fact, not a copy of the
// current schema: it must NEVER be updated to match src/db.ts. It stands in for
// every database created by a build of `trip` older than 09f1374.
const V1_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS destinations (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     country TEXT,
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

async function openLegacyDb(name: string): Promise<Client> {
  const db = openDb(tmpDb(name));
  for (const stmt of V1_SCHEMA) await db.execute(stmt);
  return db;
}

async function columnsOf(db: Client, table: string): Promise<string[]> {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.map((row) => row.name as string).sort();
}

describe("db", () => {
  test("migrate creates all M1 tables", async () => {
    const db = openDb(tmpDb("tables"));
    await migrate(db);
    const r = await db.execute(
      "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    );
    const names = r.rows.map((row) => row.name as string);
    expect(names).toContain("trips");
    expect(names).toContain("destinations");
    expect(names).toContain("climate_months");
    expect(names).toContain("app_state");
  });

  test("migrate is idempotent", async () => {
    const db = openDb(tmpDb("idem"));
    await migrate(db);
    await migrate(db);
    const r = await db.execute("SELECT COUNT(*) AS n FROM trips");
    expect(r.rows[0]!.n).toBe(0);
  });

  test("climate_months enforces one row per city-month", async () => {
    const db = openDb(tmpDb("unique"));
    await migrate(db);
    // @libsql/client enforces foreign keys (unlike bare SQLite, which defaults
    // them off), so a destination must exist before months can reference it.
    await db.execute({
      sql: `INSERT INTO destinations
              (name, country, country_code, latitude, longitude, timezone)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["Tokyo", "Japan", "JP", 35.68, 139.69, "Asia/Tokyo"],
    });
    const args = [1, 5, 14.2, 22.1, 4, "2026-07-26"];
    await db.execute({
      sql: `INSERT INTO climate_months
            (destination_id, month, dew_point_mean, temp_max_mean, rain_days, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args,
    });
    await expect(
      db.execute({
        sql: `INSERT INTO climate_months
              (destination_id, month, dew_point_mean, temp_max_mean, rain_days, fetched_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        args,
      }),
    ).rejects.toThrow();
  });
});

describe("schema migrations", () => {
  test("a pre-day_count database is readable after migrate", async () => {
    // The whole reason versioning exists. `migrate()` used to be nothing but
    // CREATE TABLE IF NOT EXISTS, so an additive column was a no-op on an
    // existing database: climate_months kept its 6 columns and readMonths threw
    // SQLITE_ERROR: no such column: day_count. `trip when` was permanently dead
    // for that install, with no error path that hinted at why.
    const db = await openLegacyDb("legacy-read");
    await db.execute({
      sql: `INSERT INTO destinations
              (name, country, country_code, latitude, longitude, timezone)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["Tokyo", "Japan", "JP", 35.68, 139.69, "Asia/Tokyo"],
    });
    await db.execute({
      sql: `INSERT INTO climate_months
              (destination_id, month, dew_point_mean, temp_max_mean, rain_days, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: [1, 5, 14.2, 22.1, 4, "2026-07-26"],
    });

    await migrate(db);

    // The assertion is that this RESOLVES. Before versioning it threw
    // SQLITE_ERROR mid-query and there was no way back short of deleting the
    // file. It returns null because migration 3 clears the cache (below), which
    // is a different thing from the query being impossible to run.
    expect(await readMonths(db, 1)).toBeNull();
    expect(await columnsOf(db, "climate_months")).toContain("day_count");
  });

  test("adding a coverage denominator clears the cache instead of inventing one", async () => {
    // expected_days has no honest value for rows fetched before it existed —
    // the window they used was never recorded. climate_months is a cache, so
    // the next `trip when` refetches in seconds and gets measured numbers. A
    // fabricated denominator would be indistinguishable from a real one forever.
    const db = await openLegacyDb("cache-clear");
    await db.execute(
      `ALTER TABLE climate_months ADD COLUMN day_count INTEGER NOT NULL DEFAULT 0`,
    );
    await db.execute({
      sql: `INSERT INTO destinations
              (name, country, country_code, latitude, longitude, timezone)
            VALUES (?, ?, ?, ?, ?, ?)`,
      args: ["Tokyo", "Japan", "JP", 35.68, 139.69, "Asia/Tokyo"],
    });
    await db.execute({
      sql: `INSERT INTO climate_months
              (destination_id, month, dew_point_mean, temp_max_mean, rain_days,
               day_count, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [1, 5, 14.2, 22.1, 4, 300, "2026-07-26"],
    });

    await migrate(db);

    const left = await db.execute("SELECT COUNT(*) AS n FROM climate_months");
    expect(Number(left.rows[0]!.n)).toBe(0);
    // The destination itself survives — only the derived cache is dropped.
    const dests = await db.execute("SELECT COUNT(*) AS n FROM destinations");
    expect(Number(dests.rows[0]!.n)).toBe(1);
  });

  test("an upgraded database has the same table shapes as a fresh one", async () => {
    // The guard against this class of bug recurring. Any column added to SCHEMA
    // without a matching numbered migration lands in the fresh database and not
    // the upgraded one, and this comparison fails naming the table.
    const legacy = await openLegacyDb("legacy-shape");
    await migrate(legacy);

    const fresh = openDb(tmpDb("fresh-shape"));
    await migrate(fresh);

    for (const table of ["destinations", "trips", "climate_months", "app_state"]) {
      expect(await columnsOf(legacy, table)).toEqual(await columnsOf(fresh, table));
    }
  });

  test("migrate records the schema version it reached", async () => {
    const db = openDb(tmpDb("version"));
    expect(await schemaVersion(db)).toBe(0);
    await migrate(db);
    expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  test("a second migrate applies nothing and records nothing", async () => {
    // Re-applying a migration must be impossible, not merely harmless: the
    // day_count ALTER throws "duplicate column name" if it ever runs twice.
    const db = openDb(tmpDb("reapply"));
    await migrate(db);
    const first = await db.execute("SELECT COUNT(*) AS n FROM schema_version");
    await migrate(db);
    const second = await db.execute("SELECT COUNT(*) AS n FROM schema_version");
    expect(Number(second.rows[0]!.n)).toBe(Number(first.rows[0]!.n));
    expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  test("an unversioned database that already has day_count migrates cleanly", async () => {
    // This is the live ~/.trip/trip.db: created after day_count was retrofitted
    // into the schema but before versioning existed, so it reports version 0
    // while already carrying the column. An unguarded ALTER throws "duplicate
    // column name" here and takes out the only real database in existence.
    const db = await openLegacyDb("retrofit");
    await db.execute(
      `ALTER TABLE climate_months ADD COLUMN day_count INTEGER NOT NULL DEFAULT 0`,
    );
    expect(await schemaVersion(db)).toBe(0);

    await migrate(db);

    expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(await columnsOf(db, "climate_months")).toContain("day_count");
  });

  test("refuses a database written by a newer build of trip", async () => {
    // Migrating down is not a thing this can do. Running an old build against a
    // newer schema would write rows silently missing whatever the newer version
    // added, so the failure has to be loud and name both versions.
    const db = openDb(tmpDb("future"));
    await migrate(db);
    await db.execute({
      sql: `INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`,
      args: [SCHEMA_VERSION + 1, "2027-01-01T00:00:00.000Z"],
    });
    await expect(migrate(db)).rejects.toThrow(
      new RegExp(`version ${SCHEMA_VERSION + 1}`),
    );
  });

  test("a legacy database is versioned to current after upgrade", async () => {
    // A pre-versioning database reports version 0 and must be carried all the
    // way forward, not merely stamped as current while skipping the steps.
    const db = await openLegacyDb("legacy-version");
    expect(await schemaVersion(db)).toBe(0);
    await migrate(db);
    expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
    expect(await columnsOf(db, "climate_months")).toContain("day_count");
  });
});

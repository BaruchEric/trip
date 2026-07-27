import { expect, test, describe } from "bun:test";
import { openDb, migrate, migrateTo, schemaVersion, SCHEMA_VERSION } from "@/db";
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

// The `segments`/`placements` shape exactly as migration 4 created it, before
// migration 5 split `start_minutes` into an assertion column and a compiled
// column. Frozen for the same reason V1_SCHEMA is: it stands in for every
// database that has run migration 4 but not migration 5, and must NEVER be
// updated to match src/db.ts.
const V4_M2_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS segments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     trip_id INTEGER NOT NULL REFERENCES trips(id),
     name TEXT NOT NULL,
     latitude REAL,
     longitude REAL,
     dwell_minutes INTEGER NOT NULL,
     cost REAL,
     tags TEXT NOT NULL DEFAULT '',
     opens_minutes INTEGER,
     closes_minutes INTEGER,
     closed_days TEXT NOT NULL DEFAULT '',
     status TEXT NOT NULL DEFAULT 'confirmed'
   )`,
  `CREATE TABLE IF NOT EXISTS placements (
     segment_id INTEGER PRIMARY KEY REFERENCES segments(id),
     day_number INTEGER NOT NULL,
     ordinal INTEGER NOT NULL,
     start_minutes INTEGER,
     pinned INTEGER NOT NULL DEFAULT 0
   )`,
];

/** A database that has physically run migration 4 (segments/placements exist,
 *  no pin_start_minutes) but is unversioned, same shape as the "unversioned
 *  database that already has day_count" case below — it exercises the
 *  `hasColumn` guard rather than a hand-set schema_version row. */
async function openV4Db(name: string): Promise<Client> {
  const db = await openLegacyDb(name);
  for (const stmt of V4_M2_SCHEMA) await db.execute(stmt);
  return db;
}

async function columnsOf(db: Client, table: string): Promise<string[]> {
  const r = await db.execute(`PRAGMA table_info(${table})`);
  return r.rows.map((row) => row.name as string).sort();
}

/** A database at exactly v5, recorded as such in `schema_version` rather than
 *  inferred via `hasColumn` -- the shape of the live ~/.trip/trip.db before
 *  migration 6. Every other migration-6 test below starts from an empty
 *  database; this fixture lets one test prove the migration lands correctly
 *  on a database that already has real data in it. */
async function openV5Db(name: string): Promise<Client> {
  const db = await openV4Db(name);
  await db.execute(
    `ALTER TABLE climate_months ADD COLUMN day_count INTEGER NOT NULL DEFAULT 0`,
  );
  await db.execute(
    `ALTER TABLE climate_months ADD COLUMN expected_days INTEGER NOT NULL DEFAULT 0`,
  );
  await db.execute(`ALTER TABLE placements ADD COLUMN pin_start_minutes INTEGER`);
  await db.execute(
    `CREATE TABLE IF NOT EXISTS schema_version (
       version INTEGER PRIMARY KEY,
       applied_at TEXT NOT NULL
     )`,
  );
  for (let v = 1; v <= 5; v++) {
    await db.execute({
      sql: `INSERT INTO schema_version (version, applied_at) VALUES (?, ?)`,
      args: [v, "2026-01-01T00:00:00.000Z"],
    });
  }
  return db;
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

    for (const table of [
      "destinations", "trips", "climate_months", "app_state",
      // M2's tables (migration 4) weren't covered here before migration 5
      // touched one of them — closing that gap now rather than leaving it
      // for the next person to add a column to `placements` blind.
      "segments", "placements",
    ]) {
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

  test("migration 4 adds the M2 tables without disturbing M1 data", async () => {
    const db = await openLegacyDb("m2-tables");
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["lisbon", "2026-07-26"],
    });

    await migrate(db);

    const t = await db.execute(
      `SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`,
    );
    const names = t.rows.map((r) => r.name as string);
    expect(names).toContain("segments");
    expect(names).toContain("placements");
    expect(await columnsOf(db, "trips")).toEqual(
      expect.arrayContaining(["arrival_time", "departure_time", "day_start", "day_end"]),
    );
    // The trip predates the migration and must still be there.
    const trips = await db.execute("SELECT COUNT(*) AS n FROM trips");
    expect(Number(trips.rows[0]!.n)).toBe(1);
  });

  test("migration 5 adds pin_start_minutes without disturbing existing placement rows", async () => {
    // The bug this migration exists to fix: a day-locked pin and the
    // compiler's result shared one column, so a replan after `trip move`
    // threw SQLITE_CONSTRAINT. Migration 5 splits them — this test proves
    // the split lands on a database that already has real placement rows.
    const db = await openV4Db("m5-placements");
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["lisbon", "2026-07-26"],
    });
    await db.execute({
      sql: `INSERT INTO segments (trip_id, name, latitude, longitude, dwell_minutes)
            VALUES (?, ?, ?, ?, ?)`,
      args: [1, "Torre", 38.69, -9.21, 60],
    });
    await db.execute({
      sql: `INSERT INTO placements (segment_id, day_number, ordinal, start_minutes, pinned)
            VALUES (?, ?, ?, ?, ?)`,
      args: [1, 2, 0, 600, 1],
    });

    await migrate(db);

    expect(await columnsOf(db, "placements")).toContain("pin_start_minutes");
    const row = await db.execute("SELECT * FROM placements WHERE segment_id = 1");
    expect(row.rows).toHaveLength(1);
    expect(Number(row.rows[0]!.day_number)).toBe(2);
    expect(Number(row.rows[0]!.start_minutes)).toBe(600);
    expect(Number(row.rows[0]!.pinned)).toBe(1);
    // A pre-existing row predates the assertion/compiled split, so there is
    // no honest value to invent for the new column.
    expect(row.rows[0]!.pin_start_minutes).toBeNull();
  });

  test("migration 6 creates the video-source tables", async () => {
    const db = openDb(tmpDb("m6-tables"));
    await migrate(db);
    for (const table of ["sources", "mentions", "mention_candidates"]) {
      const r = await db.execute({
        sql: `SELECT name FROM sqlite_master WHERE type='table' AND name=?`,
        args: [table],
      });
      expect(r.rows.length).toBe(1);
    }
  });

  test("migration 6 adds provenance columns to segments", async () => {
    const db = openDb(tmpDb("m6-cols"));
    await migrate(db);
    const r = await db.execute(`PRAGMA table_info(segments)`);
    const names = r.rows.map((row) => String(row.name));
    expect(names).toContain("local_name");
    expect(names).toContain("source_id");
    expect(names).toContain("source_at_seconds");
    expect(names).toContain("dwell_is_default");
  });

  test("one video cannot be watched twice into the same trip", async () => {
    const db = openDb(tmpDb("m6-unique"));
    await migrate(db);
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["lisbon", "2026-07-27"],
    });
    const ins = {
      sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
      args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
    };
    await db.execute(ins);
    await expect(db.execute(ins)).rejects.toThrow();
  });

  test("schema version is 8", async () => {
    // Deliberately a hardcoded number, not SCHEMA_VERSION — against
    // SCHEMA_VERSION this would be a tautology. It is a speed bump: adding a
    // migration must be a conscious act that also updates this line.
    const db = openDb(tmpDb("m8-version"));
    await migrate(db);
    expect(await schemaVersion(db)).toBe(8);
  });

  test("migration 6 backfills an existing segments row instead of erasing it", async () => {
    // The live ~/.trip/trip.db is exactly this shape: recorded at version 5
    // with real segments already in it. This is migration 6's analogue of
    // the migration 5 test above ("...without disturbing existing placement
    // rows") -- proving the ALTERs land on populated data, not just an
    // empty database.
    const db = await openV5Db("m6-backfill");
    expect(await schemaVersion(db)).toBe(5);
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["lisbon", "2026-07-27"],
    });
    await db.execute({
      sql: `INSERT INTO segments (trip_id, name, latitude, longitude, dwell_minutes)
            VALUES (?, ?, ?, ?, ?)`,
      args: [1, "Torre", 38.69, -9.21, 60],
    });

    await migrate(db);

    // SCHEMA_VERSION, not a literal: this test is about the backfill, and
    // asserting migrate() reached the latest version is the point. Pinning
    // the number here would make every future migration edit this test for
    // no reason — the pin lives in "schema version is 7" above.
    expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
    const row = await db.execute("SELECT * FROM segments WHERE id = 1");
    expect(row.rows).toHaveLength(1);
    const r = row.rows[0]!;
    // The row predates M3 entirely, so it genuinely was never a defaulted
    // dwell -- 0 is the true claim here, not a placeholder.
    expect(Number(r.dwell_is_default)).toBe(0);
    // Unknown provenance is NULL, never a value -- absence is loud.
    expect(r.local_name).toBeNull();
    expect(r.source_id).toBeNull();
    expect(r.source_at_seconds).toBeNull();
    // Untouched by the backfill.
    expect(r.name).toBe("Torre");
    expect(Number(r.dwell_minutes)).toBe(60);
  });

  test("migration 7 adds mentions.kind, and re-running is a no-op", async () => {
    const db = openDb(tmpDb("m7"));
    await migrate(db);

    const cols = (await db.execute("PRAGMA table_info(mentions)"))
      .rows.map((r) => String(r.name));
    expect(cols).toContain("kind");

    // Every migration is guarded by a hasColumn/hasTable check, so a second
    // run must not throw and must not change the version.
    await migrate(db);
    expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
  });

  // -------------------------------------------------------------------------
  // Migration 8 — M5. These stand at v7 first, via migrateTo, because the
  // whole job of migration 8 is moving data out of a column that only a v7
  // database has. Migrating a fresh database straight to 8 would exercise the
  // guard and none of the work.
  // -------------------------------------------------------------------------

  async function atV7(name: string): Promise<Client> {
    const db = openDb(tmpDb(name));
    await migrateTo(db, 7);
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["t", "2026-07-27"],
    });
    return db;
  }

  test("migration 8 retires segments.cost into price_rules", async () => {
    const db = await atV7("m8-cost");
    await db.execute(
      `INSERT INTO segments (trip_id, name, dwell_minutes, cost)
       VALUES (1, 'Museum', 60, 25)`,
    );

    await migrate(db);

    const cols = await db.execute(`PRAGMA table_info(segments)`);
    expect(cols.rows.map((r) => String(r.name))).not.toContain("cost");

    const rules = await db.execute(
      `SELECT owner_kind, owner_id, min_age, max_age, price FROM price_rules`,
    );
    expect(rules.rows.length).toBe(1);
    expect(String(rules.rows[0]!.owner_kind)).toBe("segment");
    expect(Number(rules.rows[0]!.owner_id)).toBe(1);
    expect(Number(rules.rows[0]!.price)).toBe(25);
    // Both NULL: the migrated cost is the UNBOUNDED base rule, applying to
    // every age, which is exactly what a single un-banded price meant.
    expect(rules.rows[0]!.min_age).toBeNull();
    expect(rules.rows[0]!.max_age).toBeNull();
  });

  test("a NULL cost migrates to no rule at all, not to a zero rule", async () => {
    // Absence is loud. An unpriced segment must stay unpriced; a 0 rule here
    // would silently declare every old segment free, and nothing downstream
    // could tell that apart from a place that really costs nothing.
    const db = await atV7("m8-null");
    await db.execute(
      `INSERT INTO segments (trip_id, name, dwell_minutes) VALUES (1, 'Free-ish', 60)`,
    );
    await migrate(db);
    const rules = await db.execute(`SELECT COUNT(*) AS n FROM price_rules`);
    expect(Number(rules.rows[0]!.n)).toBe(0);
  });

  test("migration 8 is a no-op on a second run", async () => {
    const db = openDb(tmpDb("m8-idempotent"));
    await migrate(db);
    await migrate(db);
    expect(await schemaVersion(db)).toBe(SCHEMA_VERSION);
    const rules = await db.execute(`SELECT COUNT(*) AS n FROM price_rules`);
    expect(Number(rules.rows[0]!.n)).toBe(0);
  });

  test("migration 8 leaves existing segment rows otherwise untouched", async () => {
    // A DROP COLUMN is a table rewrite under the hood. Everything else on the
    // row has to survive it, including the columns migration 6 bolted on.
    const db = await atV7("m8-intact");
    await db.execute(
      `INSERT INTO segments (trip_id, name, local_name, latitude, longitude,
                             dwell_minutes, dwell_is_default, cost, tags,
                             opens_minutes, closes_minutes, closed_days)
       VALUES (1, 'Hongya Cave', '洪崖洞', 29.56, 106.57, 90, 0, 30,
               'sight', 600, 1320, 'mon')`,
    );
    await migrate(db);
    const r = await db.execute(`SELECT * FROM segments WHERE id = 1`);
    const row = r.rows[0]!;
    expect(String(row.name)).toBe("Hongya Cave");
    expect(String(row.local_name)).toBe("洪崖洞");
    expect(Number(row.latitude)).toBeCloseTo(29.56);
    expect(Number(row.dwell_minutes)).toBe(90);
    expect(String(row.tags)).toBe("sight");
    expect(Number(row.opens_minutes)).toBe(600);
    expect(String(row.closed_days)).toBe("mon");
    // The new column defaults to '', which splitList reads as [] — no free
    // day is KNOWN, which is not the same as "never free".
    expect(String(row.free_days)).toBe("");
  });

  test("migrateTo refuses to go backwards", async () => {
    const db = openDb(tmpDb("m8-backwards"));
    await migrate(db);
    await expect(migrateTo(db, 7)).rejects.toThrow(/cannot migrate down/);
  });
});

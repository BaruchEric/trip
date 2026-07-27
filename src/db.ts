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
  {
    version: 5,
    // M2: migration 4's `placements` gave the user's assertion and the
    // compiler's result the SAME column (`start_minutes`). That works for a
    // timed pin, where the two coincide, but a day-locked pin (`trip move`,
    // startMin null) has no time to assert while the compiler still owes it
    // one — so `savePlacements`'s insert collided with `setPinned`'s row on
    // the very next replan (SQLITE_CONSTRAINT on segment_id). Splitting them
    // fixes it: `pin_start_minutes` is the user's assertion (only `setPinned`
    // writes it, NULL = day-locked), `start_minutes` becomes purely the
    // compiler's output (only `savePlacements` writes it, NULL until the
    // first plan).
    statements: async (db) =>
      (await hasColumn(db, "placements", "pin_start_minutes"))
        ? []
        : [`ALTER TABLE placements ADD COLUMN pin_start_minutes INTEGER`],
  },
  {
    version: 6,
    // M3: video sources and the review queue.
    //
    // A mention deliberately lives OUTSIDE `segments`. The alternative --
    // segments.status = 'review' -- makes "an unresolved guess reached the
    // itinerary" a filter every reader must remember, and `segments.status`
    // is currently written by its schema default and read by NOTHING, so that
    // reading would have silently planned review items from day one. Keeping
    // mentions in their own table makes it structurally impossible instead:
    // the compiler reads `segments`, and a pending mention has no segment row.
    //
    // `segments.status` stays (migration 4 is frozen) and is hereby confirmed
    // dead rather than left looking meaningful.
    statements: async (db) =>
      (await hasColumn(db, "segments", "local_name"))
        ? []
        : [
            `CREATE TABLE IF NOT EXISTS sources (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               trip_id INTEGER NOT NULL REFERENCES trips(id),
               url TEXT NOT NULL,
               -- NULL means yt-dlp did not report it. Never "".
               title TEXT,
               uploader TEXT,
               duration_seconds INTEGER,
               -- NULL means NO transcript was obtained. An empty transcript and
               -- an absent one are different facts and ingest treats them
               -- differently, so this must never be defaulted to ''.
               transcript TEXT,
               transcript_source TEXT,
               fetched_at TEXT NOT NULL,
               -- Re-watching a URL reuses the cached row; only --refresh
               -- re-downloads. Without this, every re-run re-fetched the video.
               UNIQUE (trip_id, url)
             )`,
            `CREATE TABLE IF NOT EXISTS mentions (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               trip_id INTEGER NOT NULL REFERENCES trips(id),
               source_id INTEGER NOT NULL REFERENCES sources(id),
               -- What the video called it. Written once, never updated: a
               -- segment must trace back to what was said at its minute mark.
               text TEXT NOT NULL,
               -- NULL until someone renames. --rename must NOT overwrite
               -- text, because a mention gets renamed precisely when text
               -- was useless ("that ramen spot"). Segment name is
               -- COALESCE(resolved_name, text) -- both facts kept.
               resolved_name TEXT,
               -- NULL means the extractor gave no timestamp. Not 0, which is
               -- the first frame of the video.
               at_seconds INTEGER,
               -- NULL means the extractor proposed no dwell. The 60-minute
               -- default is applied at segment creation and flagged THERE.
               -- Storing 60 here would erase the fact that nobody said so.
               dwell_minutes INTEGER,
               tags TEXT NOT NULL DEFAULT '',
               -- Why it is queued. NULL once resolved.
               reason TEXT,
               segment_id INTEGER REFERENCES segments(id),
               rejected_at TEXT
             )`,
            `CREATE TABLE IF NOT EXISTS mention_candidates (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               mention_id INTEGER NOT NULL REFERENCES mentions(id),
               -- 1-based, exactly as review resolve --pick=N takes it.
               rank INTEGER NOT NULL,
               display_name TEXT NOT NULL,
               local_name TEXT,
               latitude REAL NOT NULL,
               longitude REAL NOT NULL,
               category TEXT,
               type TEXT,
               importance REAL,
               osm_type TEXT,
               osm_id INTEGER,
               km_from_centre REAL NOT NULL
             )`,
            `ALTER TABLE segments ADD COLUMN local_name TEXT`,
            `ALTER TABLE segments ADD COLUMN source_id INTEGER REFERENCES sources(id)`,
            `ALTER TABLE segments ADD COLUMN source_at_seconds INTEGER`,
            `ALTER TABLE segments ADD COLUMN dwell_is_default INTEGER NOT NULL DEFAULT 0`,
          ],
  },
  {
    version: 7,
    // What the extractor said this place IS, so a unique-but-wrong geocode
    // result can be caught (M4). NULL means none was declared — never '' —
    // and NULL is what routes a mention to the denylist rather than to the
    // kind comparison. The two cases are only distinguishable if this stays
    // NULL, so no DEFAULT is given.
    statements: async (db) =>
      (await hasColumn(db, "mentions", "kind"))
        ? []
        : [`ALTER TABLE mentions ADD COLUMN kind TEXT`],
  },
  {
    version: 8,
    // M5: the traveller profile and concession pricing.
    //
    // `segments.cost` is DROPPED rather than kept alongside price_rules. Two
    // sources of truth for one number is how they come to disagree, and the
    // whole milestone exists because `cost` was write-only anyway -- stored
    // since M2, rendered by NOTHING. A user could type --cost=25 and no
    // command would ever show it back except --json.
    //
    // ALTER TABLE ... DROP COLUMN was verified against this project's
    // installed @libsql/client before this migration was written; SQLite only
    // gained it in 3.35. If a downgrade ever breaks it, the fallback is the
    // twelve-step table rebuild, which is a materially larger change.
    statements: async (db) => {
      if (await hasColumn(db, "trips", "currency")) return [];
      const stmts = [
        `CREATE TABLE IF NOT EXISTS travellers (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           trip_id    INTEGER NOT NULL REFERENCES trips(id),
           label      TEXT NOT NULL,
           -- YYYY-MM-DD. NOT NULL: a nullable birth date would have to mean
           -- "adult" at match time, and that is a guess wearing the costume
           -- of a fact -- the same shape as the zero-filled climate month.
           birth_date TEXT NOT NULL,
           UNIQUE (trip_id, label)
         )`,
        `CREATE TABLE IF NOT EXISTS passes (
           id       INTEGER PRIMARY KEY AUTOINCREMENT,
           trip_id  INTEGER NOT NULL REFERENCES trips(id),
           name     TEXT NOT NULL,
           -- 1-based day numbers, matching DayWindow.day and pin --day=.
           from_day INTEGER NOT NULL,
           to_day   INTEGER NOT NULL
         )`,
        `CREATE TABLE IF NOT EXISTS price_rules (
           id         INTEGER PRIMARY KEY AUTOINCREMENT,
           -- One table, two owners: a pass is a priced thing with age rules
           -- and a validity window, differing from a segment in what owns it
           -- and when it is counted, not in how it is priced.
           owner_kind TEXT NOT NULL CHECK (owner_kind IN ('segment','pass')),
           owner_id   INTEGER NOT NULL,
           -- NULL is unbounded on that side; both NULL is the base rule,
           -- which is a FALLBACK rather than a peer.
           min_age    INTEGER,
           max_age    INTEGER,
           -- NOT NULL. 0 is a real price meaning free. UNKNOWN is the ABSENCE
           -- OF A ROW; there is deliberately no NULL price, because a NULL
           -- price would be a row asserting a price exists while refusing to
           -- say what it is.
           price      REAL NOT NULL
         )`,
        `CREATE INDEX IF NOT EXISTS price_rules_owner
           ON price_rules (owner_kind, owner_id)`,
        `ALTER TABLE trips ADD COLUMN currency TEXT`,
      ];
      if (!(await hasColumn(db, "segments", "free_days"))) {
        stmts.push(
          `ALTER TABLE segments ADD COLUMN free_days TEXT NOT NULL DEFAULT ''`,
        );
      }
      if (await hasColumn(db, "segments", "cost")) {
        stmts.push(
          // A NULL cost migrates to NO ROW, not to a zero rule: an unpriced
          // segment must stay unpriced rather than quietly become free.
          `INSERT INTO price_rules (owner_kind, owner_id, min_age, max_age, price)
             SELECT 'segment', id, NULL, NULL, cost
             FROM segments WHERE cost IS NOT NULL`,
          `ALTER TABLE segments DROP COLUMN cost`,
        );
      }
      return stmts;
    },
  },
  {
    version: 9,
    // M5: the agent contract gains `price`.
    //
    // Stored on the MENTION as the raw rule strings, comma-joined like `tags`,
    // rather than as price_rules rows. A mention is a record of what the VIDEO
    // said; its rules have no owner until the mention resolves to a segment,
    // and price_rules.owner_id is NOT NULL. A queued mention has no segment to
    // own them.
    //
    // Separate from migration 8 because Task 9 lands after 8 is committed, and
    // editing an applied migration is precisely what this file's header
    // comment forbids.
    statements: async (db) =>
      (await hasColumn(db, "mentions", "price"))
        ? []
        : [`ALTER TABLE mentions ADD COLUMN price TEXT NOT NULL DEFAULT ''`],
  },
  {
    version: 10,
    // M6: what a SOURCE said a trip cost.
    //
    // NOT cost_bands. This records observations with their provenance;
    // cost_bands would be reference data estimating what a city costs, and
    // building that from one video is the thin-evidence trap M5 warned about.
    //
    // The first row this table ever holds was read off a video FRAME -- the
    // Chongqing budget card, which the transcript announces and never states.
    statements: async (db) =>
      (await hasColumn(db, "cost_observations", "label"))
        ? []
        : [
            `CREATE TABLE IF NOT EXISTS cost_observations (
               id            INTEGER PRIMARY KEY AUTOINCREMENT,
               trip_id       INTEGER NOT NULL REFERENCES trips(id),
               -- NULL for a hand-entered figure. NOT NULL would force a fake
               -- source row for anything the user simply knows.
               source_id     INTEGER REFERENCES sources(id),
               -- Where in the video it was stated. NULL means it did not say.
               at_seconds    INTEGER,
               label         TEXT NOT NULL,
               amount        REAL NOT NULL,
               -- NOT NULL: an amount with no unit cannot be compared to
               -- anything, which M5 established for trips.currency.
               currency      TEXT NOT NULL,
               -- NULL is UNKNOWN on either axis. BOTH are needed to
               -- normalise to a per-person-per-day rate, and an unknown
               -- either side makes that UNAVAILABLE rather than approximate.
               covers_days   INTEGER,
               covers_people INTEGER
             )`,
            `CREATE INDEX IF NOT EXISTS cost_observations_trip
               ON cost_observations (trip_id)`,
          ],
  },
  {
    version: 11,
    // M7: the string to look a place up BY, when it differs from what you
    // call it. 龙门浩老街 geocodes where "Longmenhao Old Street" returns
    // nothing -- and renaming to the Chinese to make the lookup work used to
    // destroy the name the traveller can read, because `name` and
    // `local_name` then held the same string and displayName only shows the
    // local one when it DIFFERS.
    //
    // NULL means "search by the name", which is what every existing row
    // means. No DEFAULT '': an empty query would search for the empty string
    // and return whatever the viewbox happens to contain, so that is a value
    // this column must never be able to hold.
    statements: async (db) =>
      (await hasColumn(db, "mentions", "query"))
        ? []
        : [`ALTER TABLE mentions ADD COLUMN query TEXT`],
  },
  {
    version: 12,
    // M8: a MEASURED walking leg between two points.
    //
    // No trip_id: a leg is a fact about two points in a city, shared by every
    // trip that visits them. Keyed on COORDINATES rather than segment ids, so
    // a segment moved by M7's --query or --rename MISSES and falls back to the
    // model, instead of silently answering with a leg measured from where it
    // used to be.
    //
    // DIRECTED. The recon measured Valhalla pedestrian at 23.4 min one way and
    // 32.1 the other over the same 360 m -- it models grade, OSRM foot does
    // not. One row per unordered pair would have made every uphill return leg
    // wrong with nothing anywhere to notice it.
    //
    // One row PER SOURCE, never merged: the two routers disagree by a median
    // 4.7 and a maximum 25.1 minutes, and that spread is a finding about the
    // city. Storing a midpoint would erase it permanently.
    statements: async (db) =>
      (await hasColumn(db, "route_legs", "minutes"))
        ? []
        : [
            `CREATE TABLE IF NOT EXISTS route_legs (
               id         INTEGER PRIMARY KEY AUTOINCREMENT,
               from_lat   REAL NOT NULL,
               from_lon   REAL NOT NULL,
               to_lat     REAL NOT NULL,
               to_lon     REAL NOT NULL,
               mode       TEXT NOT NULL,
               -- Free TEXT, not a CHECK: a third router should be an INSERT,
               -- not a migration.
               source     TEXT NOT NULL,
               -- REAL, not INTEGER. The routers return seconds and metres, and
               -- rounding at write time would discard the very spread this
               -- table exists to preserve. Rounding happens at the point of
               -- use, where whole-minute travel times are still the rule.
               minutes    REAL NOT NULL,
               meters     REAL NOT NULL,
               fetched_at TEXT NOT NULL
             )`,
            `CREATE UNIQUE INDEX IF NOT EXISTS route_legs_key
               ON route_legs (from_lat, from_lon, to_lat, to_lon, mode, source)`,
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

/** Apply migrations up to and including `target`, and no further.
 *
 *  Exists so a test can build a database as some OLDER build of trip left it
 *  and then migrate it forward for real — which is the only way to exercise a
 *  migration against the shape it will actually meet in the wild. Migration 8
 *  needs this: its whole job is moving data out of a column that a v7 database
 *  has and a fresh one would too, so there is no way to test it without first
 *  standing at v7. */
export async function migrateTo(db: Client, target: number): Promise<void> {
  await db.execute(VERSION_TABLE);
  const current = await schemaVersion(db);
  if (current > target) {
    throw new Error(
      `database is at schema version ${current}, cannot migrate down to ${target}`,
    );
  }

  for (const m of MIGRATIONS) {
    if (m.version <= current || m.version > target) continue;
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

export async function migrate(db: Client): Promise<void> {
  await db.execute(VERSION_TABLE);
  const current = await schemaVersion(db);

  // A database written by a NEWER build of trip. Migrating down is not a thing
  // this can do, and running an old build against a new schema would write
  // rows that silently omit whatever the newer version added. Refuse.
  //
  // Checked HERE rather than in migrateTo, whose contract is "stop at target"
  // — a caller asking for 7 on a v8 database is making a different mistake and
  // gets a different message.
  if (current > SCHEMA_VERSION) {
    throw new Error(
      `database is at schema version ${current} but this build of trip only ` +
      `knows version ${SCHEMA_VERSION}. Upgrade trip, or point --db elsewhere.`,
    );
  }

  await migrateTo(db, SCHEMA_VERSION);
}

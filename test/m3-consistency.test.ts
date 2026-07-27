import { expect, test, describe } from "bun:test";
import type { Client } from "@libsql/client";
import { openDb, migrate } from "@/db";
import { run } from "@/cli";
import { listMentions, getMention } from "@/mentions";
import { listSegments } from "@/segments";
import { latestSource } from "@/sources";
import { MODES, PACES } from "@/plan/types";
import type { PoiCandidate } from "@/geo/poi";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** These drive the CLI through `run(argv, { dbPath })`, never the modules
 *  directly — a per-command test can already prove `seg ls`, `review ls` and
 *  `plan` each work in isolation; only running them back to back against the
 *  SAME database can catch two of them describing that database differently.
 *  M2's three worst bugs were exactly that shape. */

const URL = "https://www.youtube.com/watch?v=KHHlcCUTwZA";
const URL_B = "https://www.youtube.com/watch?v=zzzzzzzzzzz";

const REPORT = {
  title: "4 Days in Chongqing",
  uploader: "Some Traveller",
  durationSeconds: 1694,
  transcriptSource: "captions",
  transcript: "[00:42] welcome to Chongqing\n[04:32] this hot pot place",
  lines: [
    { atSeconds: 42, text: "welcome to Chongqing" },
    { atSeconds: 272, text: "this hot pot place" },
  ],
};

let seq = 0;

function scratchDbPath(tag: string): string {
  const p = join(tmpdir(), `trip-m3-consistency-${tag}-${process.pid}-${seq++}.db`);
  rmSync(p, { force: true });
  return p;
}

function mentionsFile(tag: string, entries: unknown[]): string {
  const p = join(tmpdir(), `trip-m3-mentions-${tag}-${process.pid}-${seq++}.json`);
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

/** Trip + destination fixture. The destination link has no CLI path that
 *  avoids a real geocoding call (`trip when <city>` hits Open-Meteo/Nominatim
 *  for real), so it is set directly, the same way test/commands-watch.test.ts's
 *  db1() helper does. Everything the CLI itself owns — creating the trip,
 *  setting dates — goes through `run()`. */
async function tripFixture(
  tag: string,
): Promise<{ dbPath: string; tripId: number; db: Client }> {
  const dbPath = scratchDbPath(tag);
  const created = await run(["new", tag], { dbPath });
  expect(created.code).toBe(0);

  const db = openDb(dbPath);
  await migrate(db);
  const destRow = await db.execute({
    sql: `INSERT INTO destinations (name, country_code, latitude, longitude)
          VALUES (?, ?, ?, ?) RETURNING id`,
    args: ["Chongqing", "cn", 29.563, 106.5516],
  });
  const destId = Number(destRow.rows[0]!.id);
  const tripRow = await db.execute({
    sql: `SELECT id FROM trips WHERE name = ?`, args: [tag],
  });
  const tripId = Number(tripRow.rows[0]!.id);
  await db.execute({
    sql: `UPDATE trips SET destination_id = ? WHERE id = ?`,
    args: [destId, tripId],
  });

  const dated = await run(["dates", "set", "2027-04-10..04-13"], { dbPath });
  expect(dated.code).toBe(0);

  return { dbPath, tripId, db };
}

/** Watches the fixture video through the injected `watchFn`, never the
 *  network, and returns the new source id. */
async function watchVideo(dbPath: string): Promise<number> {
  const out = await run(["watch", URL, "--json"], {
    dbPath,
    deps: { watch: { watchFn: async () => REPORT, now: () => "2027-04-10T09:00:00Z" } },
  });
  expect(out.code).toBe(0);
  return JSON.parse(out.stdout).sourceId;
}

/** Same as watchVideo, but for an arbitrary url/fetchedAt - needed to build
 *  a two-source timeline for the failed-refresh seam test below. */
async function watchVideoAt(dbPath: string, url: string, now: string): Promise<number> {
  const out = await run(["watch", url, "--json"], {
    dbPath,
    deps: { watch: { watchFn: async () => REPORT, now: () => now } },
  });
  expect(out.code).toBe(0);
  return JSON.parse(out.stdout).sourceId;
}

function candidate(over: Partial<PoiCandidate> = {}): PoiCandidate {
  return {
    displayName: "洪崖洞, 渝中区, 重庆市, 中国",
    localName: "洪崖洞",
    latitude: 29.565, longitude: 106.575,
    category: "building", type: "yes", importance: 0.3408,
    osmType: "way", osmId: 1, kmFromCentre: 2.3,
    ...over,
  };
}

const CONFIDENT_TEXT = "Hongya Cave";
const AMBIGUOUS_TEXT = "Ciqikou Ancient Town";
const NO_MATCH_TEXT = "Ghost Noodle Stall";
const RENAME_TARGET = "Eling Park";

/** Dispatches on the mention's text, so one geocode fixture can produce a
 *  unique hit, an ambiguous one and a total miss from a single ingest —
 *  exactly what assertion 1 needs. */
const GEO_TABLE: Record<string, PoiCandidate[]> = {
  [CONFIDENT_TEXT]: [candidate()],
  [AMBIGUOUS_TEXT]: [
    candidate({
      displayName: "磁器口古镇正门, 沙坪坝区, 重庆市, 中国",
      localName: "磁器口古镇正门", osmId: 2, kmFromCentre: 5.1,
    }),
    candidate({
      displayName: "磁器口古镇后门, 沙坪坝区, 重庆市, 中国",
      localName: "磁器口古镇后门", osmId: 3, kmFromCentre: 5.4,
    }),
  ],
  [NO_MATCH_TEXT]: [],
  [RENAME_TARGET]: [
    candidate({
      displayName: "鹅岭公园, 渝中区, 重庆市, 中国",
      localName: "鹅岭公园", osmId: 4, kmFromCentre: 1.2,
    }),
  ],
};

function geocodeFixture(overrides: Record<string, PoiCandidate[]> = {}) {
  const table = { ...GEO_TABLE, ...overrides };
  return async (query: string) => table[query] ?? [];
}

async function ingest(
  dbPath: string,
  file: string,
  opts: { replace?: boolean; overrides?: Record<string, PoiCandidate[]> } = {},
) {
  const flags = [`--mentions=${file}`, "--json"];
  if (opts.replace) flags.push("--replace");
  return run(["watch", "ingest", ...flags], {
    dbPath,
    deps: {
      watch: {
        ingestDeps: { geocode: geocodeFixture(opts.overrides), sleepFn: async () => {} },
      },
    },
  });
}

const THREE_MENTIONS = [
  { text: CONFIDENT_TEXT, at: "04:32", dwell: "90m" },
  { text: AMBIGUOUS_TEXT, at: "10:00" },
  { text: NO_MATCH_TEXT, at: "20:00" },
];

/** Every mention must be accounted for by exactly one of the three surfaces,
 *  and no mention may hold two contradictory facts at once. */
async function assertAccounted(db: Client, tripId: number) {
  const all = await listMentions(db, tripId);
  for (const m of all) {
    const contradictions = [
      m.segmentId !== null && m.reason !== null,
      m.segmentId !== null && m.rejectedAt !== null,
    ].filter(Boolean);
    expect(contradictions).toEqual([]);
  }
  const byState = {
    pending: all.filter((m) => m.state === "pending").length,
    resolved: all.filter((m) => m.state === "resolved").length,
    rejected: all.filter((m) => m.state === "rejected").length,
  };
  // The name's own promise: `seg ls` (segments) + `review ls` (pending) +
  // rejected must equal the mention count. None of the fixtures in this file
  // ever add a segment outside the ingest/resolve pipeline, so every segment
  // in the trip is attributed to exactly one resolved mention - a duplicate
  // or a silently-missing segment would drift this count without ever
  // touching `byState.resolved`, which only reads the mentions table.
  const segments = await listSegments(db, tripId);
  expect(segments.length).toBe(byState.resolved);
  return byState;
}

describe("m3 consistency: the mention lifecycle", () => {
  test("1. nothing vanishes: seg ls, review ls and assertAccounted all agree", async () => {
    const { dbPath, tripId, db } = await tripFixture("vanish");
    const sourceId = await watchVideo(dbPath);
    const file = mentionsFile("vanish", THREE_MENTIONS);
    const out = await ingest(dbPath, file);
    expect(out.code).toBe(0);
    expect(JSON.parse(out.stdout)).toMatchObject({ total: 3, geocoded: 1, queued: 2, failed: 0 });

    const segLs = JSON.parse((await run(["seg", "ls", `--from=${sourceId}`, "--json"], { dbPath })).stdout);
    expect(segLs.segments.length).toBe(1);

    const reviewLs = JSON.parse((await run(["review", "ls", "--json"], { dbPath })).stdout);
    expect(reviewLs.pending.length).toBe(2);

    const byState = await assertAccounted(db, tripId);
    expect(byState).toEqual({ pending: 2, resolved: 1, rejected: 0 });
  });

  test("2. a pending mention is never planned, at any pace or mode", async () => {
    const { dbPath } = await tripFixture("neverplanned");
    await watchVideo(dbPath);
    const file = mentionsFile("neverplanned", THREE_MENTIONS);
    await ingest(dbPath, file);

    let sawConfident = false;
    for (const pace of PACES) {
      for (const mode of MODES) {
        const planned = await run(["plan", `--pace=${pace}`, `--mode=${mode}`], { dbPath });
        expect(planned.code).toBe(0);
        expect(planned.stdout).not.toContain(AMBIGUOUS_TEXT);
        expect(planned.stdout).not.toContain(NO_MATCH_TEXT);
        if (planned.stdout.includes(CONFIDENT_TEXT)) sawConfident = true;

        const day1 = await run(["day", "1"], { dbPath });
        expect(day1.code).toBe(0);
        expect(day1.stdout).not.toContain(AMBIGUOUS_TEXT);
        expect(day1.stdout).not.toContain(NO_MATCH_TEXT);
      }
    }
    // Not a vacuous check: the resolved segment really is placeable, so its
    // ABSENCE from every combination above is meaningful.
    expect(sawConfident).toBe(true);
  });

  test("3. seg rm returns a resolved mention to the queue, reason 'segment deleted'", async () => {
    const { dbPath, db, tripId } = await tripFixture("segrm");
    await watchVideo(dbPath);
    const file = mentionsFile("segrm", [{ text: AMBIGUOUS_TEXT, at: "10:00" }]);
    await ingest(dbPath, file);

    const before = JSON.parse((await run(["review", "ls", "--json"], { dbPath })).stdout);
    expect(before.pending.length).toBe(1);
    const mentionId = before.pending[0].id;

    const resolved = await run(
      ["review", "resolve", String(mentionId), "--pick=1", "--json"], { dbPath },
    );
    expect(resolved.code).toBe(0);
    const segmentId = JSON.parse(resolved.stdout).segmentId;

    const afterResolve = JSON.parse((await run(["review", "ls", "--json"], { dbPath })).stdout);
    expect(afterResolve.pending.map((m: { id: number }) => m.id)).not.toContain(mentionId);

    const removed = await run(["seg", "rm", String(segmentId)], { dbPath });
    expect(removed.code).toBe(0);

    const afterRm = JSON.parse((await run(["review", "ls", "--json"], { dbPath })).stdout);
    const back = afterRm.pending.find((m: { id: number }) => m.id === mentionId);
    expect(back).toBeDefined();
    expect(back.reason).toBe("segment deleted");

    const segLs = JSON.parse((await run(["seg", "ls", "--json"], { dbPath })).stdout);
    expect(segLs.segments.find((s: { id: number }) => s.id === segmentId)).toBeUndefined();

    await assertAccounted(db, tripId);
  });

  test("4. review resolve --pick twice errors on the second call, leaves one segment", async () => {
    const { dbPath, db, tripId } = await tripFixture("doubleresolve");
    await watchVideo(dbPath);
    const file = mentionsFile("doubleresolve", [{ text: AMBIGUOUS_TEXT, at: "10:00" }]);
    await ingest(dbPath, file);
    const pending = JSON.parse((await run(["review", "ls", "--json"], { dbPath })).stdout).pending;
    const mentionId = pending[0].id;

    const first = await run(
      ["review", "resolve", String(mentionId), "--pick=1", "--json"], { dbPath },
    );
    expect(first.code).toBe(0);

    const second = await run(
      ["review", "resolve", String(mentionId), "--pick=2", "--json"], { dbPath },
    );
    expect(second.code).toBe(1);
    expect(JSON.parse(second.stdout).error).toContain("already resolved");

    const segLs = JSON.parse((await run(["seg", "ls", "--json"], { dbPath })).stdout);
    expect(segLs.segments.length).toBe(1);

    await assertAccounted(db, tripId);
  });

  // 4b: only the already-RESOLVED half of the generic `state !== "pending"`
  // guard was ever exercised anywhere in the suite. A mention with >= 2
  // candidates is used deliberately: if the guard were removed, --pick=1
  // would still succeed (never hitting the unrelated "no candidates" error),
  // so this is the only way a missing guard would actually show up red.
  test("4b. review resolve on an already-rejected mention also errors", async () => {
    const { dbPath, db, tripId } = await tripFixture("rejectedtwice");
    await watchVideo(dbPath);
    const file = mentionsFile("rejectedtwice", [{ text: AMBIGUOUS_TEXT, at: "10:00" }]);
    await ingest(dbPath, file);
    const pending = JSON.parse((await run(["review", "ls", "--json"], { dbPath })).stdout).pending;
    const mentionId = pending[0].id;
    expect(pending[0].candidates.length).toBeGreaterThanOrEqual(2);

    const rejected = await run(
      ["review", "resolve", String(mentionId), "--reject", "--json"], { dbPath },
    );
    expect(rejected.code).toBe(0);

    const secondAttempt = await run(
      ["review", "resolve", String(mentionId), "--pick=1", "--json"], { dbPath },
    );
    expect(secondAttempt.code).toBe(1);
    expect(JSON.parse(secondAttempt.stdout).error).toContain("already rejected");

    const segLs = JSON.parse((await run(["seg", "ls", "--json"], { dbPath })).stdout);
    expect(segLs.segments.length).toBe(0);

    const byState = await assertAccounted(db, tripId);
    expect(byState).toEqual({ pending: 0, resolved: 0, rejected: 1 });
  });

  test("5. --rename keeps the video's words as text; the segment gets the new name", async () => {
    const { dbPath, db, tripId } = await tripFixture("rename");
    await watchVideo(dbPath);
    const file = mentionsFile("rename", [{ text: NO_MATCH_TEXT, at: "15:00" }]);
    await ingest(dbPath, file);

    const before = JSON.parse((await run(["review", "ls", "--json"], { dbPath })).stdout).pending;
    expect(before.length).toBe(1);
    expect(before[0].text).toBe(NO_MATCH_TEXT);
    const mentionId = before[0].id;

    const renamed = await run(
      ["review", "resolve", String(mentionId), `--rename=${RENAME_TARGET}`, "--json"],
      { dbPath, deps: { review: { geocode: geocodeFixture() } } },
    );
    expect(renamed.code).toBe(0);
    const segmentId = JSON.parse(renamed.stdout).segmentId;

    // Not visible through `review ls` any more (it only lists pending) — the
    // provenance check has to read the mention directly, same as the brief's
    // own snippet importing listMentions for assertAccounted.
    const mention = await getMention(db, tripId, mentionId);
    expect(mention!.text).toBe(NO_MATCH_TEXT);
    expect(mention!.name).toBe(RENAME_TARGET);

    const segLs = JSON.parse((await run(["seg", "ls", "--json"], { dbPath })).stdout);
    const seg = segLs.segments.find((s: { id: number }) => s.id === segmentId);
    expect(seg.name).toBe(RENAME_TARGET);

    await assertAccounted(db, tripId);
  });

  test("6. ingest --replace refuses once a mention is resolved, and nothing changes", async () => {
    const { dbPath, db, tripId } = await tripFixture("replaceresolved");
    await watchVideo(dbPath);
    const file = mentionsFile("replaceresolved", THREE_MENTIONS);
    await ingest(dbPath, file);

    const before = await assertAccounted(db, tripId);

    const again = await ingest(dbPath, file, { replace: true });
    expect(again.code).toBe(1);
    expect(JSON.parse(again.stdout).error).toContain("resolved");

    const after = await assertAccounted(db, tripId);
    expect(after).toEqual(before);
  });

  test("7. a defaulted dwell shows [default] in both seg ls and day 1, never '60m?'", async () => {
    const { dbPath } = await tripFixture("defaultdwell");
    await watchVideo(dbPath);
    // No `dwell` key: the extractor proposed none, so DEFAULT_DWELL_MINUTES
    // applies and dwellIsDefault is set.
    const file = mentionsFile("defaultdwell", [{ text: CONFIDENT_TEXT, at: "04:32" }]);
    const ing = await ingest(dbPath, file);
    expect(JSON.parse(ing.stdout).geocoded).toBe(1);

    const segLs = await run(["seg", "ls"], { dbPath });
    expect(segLs.stdout).toContain("[default]");
    expect(segLs.stdout).not.toContain("60m?");

    const planned = await run(["plan"], { dbPath });
    expect(planned.code).toBe(0);
    const day1 = await run(["day", "1"], { dbPath });
    expect(day1.stdout).toContain("[default]");
    expect(day1.stdout).not.toContain("60m?");
  });

  test("8. a failed --refresh of an OLDER source does not re-point ingest's default", async () => {
    const { dbPath, tripId } = await tripFixture("refreshsource");
    const sourceA = await watchVideoAt(dbPath, URL, "2027-04-10T09:00:00Z");
    const sourceB = await watchVideoAt(dbPath, URL_B, "2027-04-10T10:00:00Z");
    expect(sourceA).not.toBe(sourceB);

    // A --refresh of A that comes back with no transcript must fail loudly
    // and must NOT touch which source is "latest" - if it did, an `ingest`
    // with no --source would attach B's mentions to A's row.
    const empty = { ...REPORT, transcript: null, transcriptSource: null, lines: [] };
    const failedRefresh = await run(["watch", URL, "--refresh"], {
      dbPath,
      deps: { watch: { watchFn: async () => empty, now: () => "2027-04-10T11:00:00Z" } },
    });
    expect(failedRefresh.code).toBe(1);

    const db = openDb(dbPath);
    await migrate(db);
    const latest = await latestSource(db, tripId);
    expect(latest!.id).toBe(sourceB);
  });
});

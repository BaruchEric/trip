import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runWatchCommand } from "@/commands/watch";
import { getSourceByUrl } from "@/sources";
import { listMentions } from "@/mentions";
import { listSegments } from "@/segments";
import { SEARCH_RADIUS_KM } from "@/geo/poi";
import type { WatchReport } from "@/watch/parse-report";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPORT: WatchReport = {
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

const URL = "https://www.youtube.com/watch?v=KHHlcCUTwZA";

async function db1(tag: string, withDestination = true) {
  const p = join(tmpdir(), `trip-cmdwatch-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  if (withDestination) {
    await db.execute({
      sql: `INSERT INTO destinations (name, country_code, latitude, longitude)
            VALUES (?, ?, ?, ?)`,
      args: ["Chongqing", "cn", 29.5630, 106.5516],
    });
  }
  await db.execute({
    sql: `INSERT INTO trips (name, destination_id, created_at) VALUES (?, ?, ?)`,
    args: ["chongqing", withDestination ? 1 : null, "2026-07-27"],
  });
  // active_trip stores the trip's NAME (see trips.ts getActiveTrip), not its id.
  // The brief's own snippet inserted '1' here, which getTripByName would never
  // match against a trip named "chongqing" — every test would fail on "no
  // active trip" before ever reaching the code under test.
  await db.execute({
    sql: `INSERT INTO app_state (key, value) VALUES ('active_trip', 'chongqing')`,
  });
  return db;
}

const deps = { watchFn: async () => REPORT, now: () => "2026-07-27T10:00:00Z" };

describe("trip watch", () => {
  test("caches the transcript and reports what it got", async () => {
    const db = await db1("cache");
    const out = await runWatchCommand(db, [URL], false, deps);
    expect(out).toContain("4 Days in Chongqing");
    expect(out).toContain("2 lines");
    expect(out).toContain("welcome to Chongqing");

    const s = await getSourceByUrl(db, 1, URL);
    expect(s!.transcript).toContain("welcome to Chongqing");
    expect(s!.transcriptSource).toBe("captions");
    expect(s!.durationSeconds).toBe(1694);
  });

  test("json output carries the lines an agent needs", async () => {
    const db = await db1("json");
    const out = JSON.parse(await runWatchCommand(db, [URL], true, deps));
    expect(out.sourceId).toBe(1);
    expect(out.title).toBe("4 Days in Chongqing");
    expect(out.lines.length).toBe(2);
    expect(out.lines[1]).toEqual({ at: "04:32", text: "this hot pot place" });
  });

  test("a second watch of the same url serves the cache without re-downloading", async () => {
    const db = await db1("cached");
    await runWatchCommand(db, [URL], false, deps);
    let calls = 0;
    const out = await runWatchCommand(db, [URL], false, {
      ...deps,
      watchFn: async () => { calls += 1; return REPORT; },
    });
    expect(calls).toBe(0);
    expect(out).toContain("cached");
  });

  test("--refresh re-downloads and keeps the same source id", async () => {
    const db = await db1("refresh");
    await runWatchCommand(db, [URL], false, deps);
    let calls = 0;
    const out = JSON.parse(await runWatchCommand(db, [URL, "--refresh"], true, {
      ...deps,
      watchFn: async () => { calls += 1; return REPORT; },
    }));
    expect(calls).toBe(1);
    expect(out.sourceId).toBe(1);
  });

  test("a video with no transcript is saved, reported, and fails", async () => {
    const db = await db1("no-transcript");
    const empty: WatchReport = {
      ...REPORT, transcript: null, transcriptSource: null, lines: [],
    };
    await expect(
      runWatchCommand(db, [URL], false, { ...deps, watchFn: async () => empty }),
    ).rejects.toThrow(/no transcript/i);
    // Saved anyway: the download happened, and re-running should not repeat it
    // just to learn the same thing.
    const s = await getSourceByUrl(db, 1, URL);
    expect(s).not.toBeNull();
    expect(s!.transcript).toBeNull();
  });

  test("a failed --refresh keeps the transcript it already had", async () => {
    const db = await db1("refresh-no-transcript");
    await runWatchCommand(db, [URL], false, deps);
    const empty: WatchReport = {
      ...REPORT, transcript: null, transcriptSource: null, lines: [],
    };
    // The refresh fails loudly...
    await expect(
      runWatchCommand(db, [URL, "--refresh"], false, {
        ...deps, watchFn: async () => empty,
      }),
    ).rejects.toThrow(/kept/i);
    // ...but the cached transcript survives, rather than being overwritten with
    // NULL because the second fetch happened to come back empty.
    const s = await getSourceByUrl(db, 1, URL);
    expect(s!.transcript).toContain("welcome to Chongqing");
    expect(s!.transcriptSource).toBe("captions");
  });

  test("a second plain watch of a no-transcript video does not re-download", async () => {
    const db = await db1("no-transcript-cached");
    const empty: WatchReport = {
      ...REPORT, transcript: null, transcriptSource: null, lines: [],
    };
    let calls = 0;
    const counting = { ...deps, watchFn: async () => { calls += 1; return empty; } };

    await expect(runWatchCommand(db, [URL], false, counting)).rejects.toThrow(/no transcript/i);
    expect(calls).toBe(1);

    // Second plain run: still fails, but from cache — the download is the
    // expensive thing and it must not happen twice.
    await expect(runWatchCommand(db, [URL], false, counting)).rejects.toThrow(/no transcript/i);
    expect(calls).toBe(1);
  });

  test("a trip with no destination is refused before anything is downloaded", async () => {
    const db = await db1("no-dest", false);
    let calls = 0;
    await expect(
      runWatchCommand(db, [URL], false, {
        ...deps, watchFn: async () => { calls += 1; return REPORT; },
      }),
    ).rejects.toThrow(/destination/i);
    expect(calls).toBe(0);
  });

  test("a missing url is a usage error", async () => {
    const db = await db1("no-url");
    await expect(runWatchCommand(db, [], false, deps)).rejects.toThrow(/usage/i);
  });

  // Every other command test file that requires an active trip (dates, trips)
  // has this test; a mutation sweep on this file found the guard was otherwise
  // unverified here.
  test("no active trip fails loudly", async () => {
    const p = join(tmpdir(), `trip-cmdwatch-notrip-${process.pid}.db`);
    rmSync(p, { force: true });
    const db = openDb(p);
    await migrate(db);
    await expect(runWatchCommand(db, [URL], false, deps))
      .rejects.toThrow(/active trip/i);
  });
});

const URL2 = "https://www.youtube.com/watch?v=AAAAAAAAAAA";

function mentionsFile(tag: string, entries: unknown[]): string {
  const p = join(tmpdir(), `trip-mentions-${tag}-${process.pid}.json`);
  writeFileSync(p, JSON.stringify(entries));
  return p;
}

const ONE_HIT = {
  ingestDeps: {
    geocode: async () => [{
      displayName: "洪崖洞, 渝中区, 重庆市, 中国", localName: "洪崖洞",
      latitude: 29.565, longitude: 106.575,
      category: "building", type: "yes", importance: 0.3408,
      osmType: "way", osmId: 1, kmFromCentre: 2.3,
    }],
    sleepFn: async () => {},
  },
};

async function watched(tag: string) {
  const db = await db1(tag);
  await runWatchCommand(db, [URL], false, deps);
  return db;
}

describe("trip watch ingest", () => {
  test("reports counts and creates the segments", async () => {
    const db = await watched("ingest-basic");
    const file = mentionsFile("basic", [
      { text: "Hongya Cave", at: "04:32", dwell: "90m" },
    ]);
    const out = await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, ONE_HIT);
    expect(out).toContain("1 mention");
    expect(out).toContain("1 geocoded");
    expect((await listSegments(db, 1)).length).toBe(1);
  });

  test("json output is the same counts an agent can branch on", async () => {
    const db = await watched("ingest-json");
    const file = mentionsFile("json", [{ text: "Hongya Cave" }]);
    const out = JSON.parse(
      await runWatchCommand(db, ["ingest", `--mentions=${file}`], true, ONE_HIT),
    );
    expect(out).toMatchObject({ sourceId: 1, total: 1, geocoded: 1, queued: 0, failed: 0 });
  });

  test("without --source it attaches to the trip's most recent video", async () => {
    const db = await watched("ingest-latest");
    const file = mentionsFile("latest", [{ text: "Hongya Cave" }]);
    await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, ONE_HIT);
    expect((await listMentions(db, 1))[0]!.sourceId).toBe(1);
  });

  // A single-source trip cannot tell "latest" from "first" apart - both name
  // the same row. Watching two videos is the only way a mutation from
  // latestSource to "first source" would show up as a failing test.
  test("with two videos watched, it attaches to the one fetched most recently, not the first", async () => {
    const db = await db1("ingest-latest-vs-first");
    await runWatchCommand(db, [URL], false, deps);
    await runWatchCommand(db, [URL2], false, deps);
    const file = mentionsFile("latestvsfirst", [{ text: "Hongya Cave" }]);
    await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, ONE_HIT);
    expect((await listMentions(db, 1))[0]!.sourceId).toBe(2);
  });

  test("a trip with no source at all says so plainly", async () => {
    const db = await db1("ingest-nosource");
    const file = mentionsFile("nosource", [{ text: "x" }]);
    await expect(
      runWatchCommand(db, ["ingest", `--mentions=${file}`], false, ONE_HIT),
    ).rejects.toThrow(/no video/i);
  });

  test("an unknown --source is named, not a generic crash", async () => {
    const db = await watched("ingest-badsource");
    const file = mentionsFile("badsource", [{ text: "Hongya Cave" }]);
    await expect(
      runWatchCommand(db, ["ingest", `--mentions=${file}`, "--source=999"], false, ONE_HIT),
    ).rejects.toThrow(/source #999/);
  });

  test("malformed entries are reported and the good ones still land", async () => {
    const db = await watched("ingest-partial");
    const file = mentionsFile("partial", [
      { text: "Hongya Cave" },
      { text: "bad", at: "banana" },
    ]);
    const out = await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, ONE_HIT);
    expect(out).toContain("1 entry skipped");
    expect(out).toContain("[1]");
    expect((await listMentions(db, 1)).length).toBe(1);
  });

  test("a second ingest refuses and names --replace", async () => {
    const db = await watched("ingest-twice");
    const file = mentionsFile("twice", [{ text: "Hongya Cave" }]);
    await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, ONE_HIT);
    await expect(
      runWatchCommand(db, ["ingest", `--mentions=${file}`], false, ONE_HIT),
    ).rejects.toThrow(/--replace/);
    expect((await listMentions(db, 1)).length).toBe(1);
  });

  // Same guard as above, but isolated from the "resolved" guard: the prior
  // test's first ingest fully resolves (ONE_HIT), so its rejection message
  // happens to come from the *resolved* branch, which also happens to mention
  // "--replace" - a mutation that no-ops the plain "already has mentions"
  // check would slip through THAT test undetected. Using NO_HIT here means
  // the existing mention is pending, not resolved, so only the plain refusal
  // guard can be what throws.
  test("a second ingest refuses even when nothing is resolved yet", async () => {
    const db = await watched("ingest-twice-pending");
    const file = mentionsFile("twice-pending", [{ text: "hot pot" }]);
    const NO_HIT = { ingestDeps: { geocode: async () => [], sleepFn: async () => {} } };
    await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, NO_HIT);
    expect((await listMentions(db, 1))[0]!.state).toBe("pending");
    await expect(
      runWatchCommand(db, ["ingest", `--mentions=${file}`], false, NO_HIT),
    ).rejects.toThrow(/--replace/);
    expect((await listMentions(db, 1)).length).toBe(1);
  });

  test("--replace refuses while a mention is resolved, naming it", async () => {
    const db = await watched("ingest-replace-resolved");
    const file = mentionsFile("rr", [{ text: "Hongya Cave" }]);
    await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, ONE_HIT);
    await expect(
      runWatchCommand(db, ["ingest", `--mentions=${file}`, "--replace"], false, ONE_HIT),
    ).rejects.toThrow(/resolved/i);
  });

  test("--replace clears pending mentions and ingests fresh", async () => {
    const db = await watched("ingest-replace-pending");
    const file = mentionsFile("rp", [{ text: "hot pot" }]);
    const NO_HIT = { ingestDeps: { geocode: async () => [], sleepFn: async () => {} } };
    await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, NO_HIT);
    expect((await listMentions(db, 1)).length).toBe(1);

    const file2 = mentionsFile("rp2", [{ text: "hot pot" }, { text: "noodles" }]);
    await runWatchCommand(db, ["ingest", `--mentions=${file2}`, "--replace"], false, NO_HIT);
    expect((await listMentions(db, 1)).length).toBe(2);
  });

  test("--mentions is required", async () => {
    const db = await watched("ingest-nofile");
    await expect(runWatchCommand(db, ["ingest"], false, ONE_HIT)).rejects.toThrow(/--mentions/);
  });

  test("a missing mentions file names the path", async () => {
    const db = await watched("ingest-missing");
    await expect(
      runWatchCommand(db, ["ingest", "--mentions=/nope/nope.json"], false, ONE_HIT),
    ).rejects.toThrow(/\/nope\/nope\.json/);
  });

  // A network outage must not read as "a video full of vague places" - `failed`
  // (the lookup itself broke) has to stay visibly apart from `queued`
  // (the lookup answered, just not confidently). Every other test here uses
  // ONE_HIT or a no-match NO_HIT, so failed is 0 everywhere else and a mutation
  // merging the two counts would pass unnoticed without this test.
  const FAILING = {
    ingestDeps: {
      geocode: async () => { throw new Error("network down"); },
      sleepFn: async () => {},
    },
  };

  test("a lookup failure is counted apart from queued, and the search box is named", async () => {
    const db = await watched("ingest-failed-text");
    const file = mentionsFile("failed-text", [{ text: "Hongya Cave" }]);
    const out = await runWatchCommand(db, ["ingest", `--mentions=${file}`], false, FAILING);
    expect(out).toContain("1 lookup failure");
    expect(out).toContain("0 geocoded");
    expect(out).toContain("0 queued");
    expect(out).toContain(`${SEARCH_RADIUS_KM} km`);
  });

  test("json separates failed lookups from queued", async () => {
    const db = await watched("ingest-failed-json");
    const file = mentionsFile("failed-json", [{ text: "Hongya Cave" }]);
    const out = JSON.parse(
      await runWatchCommand(db, ["ingest", `--mentions=${file}`], true, FAILING),
    );
    expect(out).toMatchObject({ geocoded: 0, queued: 0, failed: 1 });
    expect(out.searchRadiusKm).toBe(SEARCH_RADIUS_KM);
  });
});

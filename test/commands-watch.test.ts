import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runWatchCommand } from "@/commands/watch";
import { getSourceByUrl } from "@/sources";
import { listMentions } from "@/mentions";
import { listSegments } from "@/segments";
import { SEARCH_RADIUS_KM } from "@/geo/poi";
import type { WatchReport } from "@/watch/parse-report";
import { rmSync, writeFileSync, mkdtempSync, mkdirSync } from "node:fs";
import { runFrames } from "@/watch/run";
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
    const original = await getSourceByUrl(db, 1, URL);
    const empty: WatchReport = {
      ...REPORT, transcript: null, transcriptSource: null, lines: [],
    };
    // The refresh fails loudly...
    await expect(
      runWatchCommand(db, [URL, "--refresh"], false, {
        ...deps, watchFn: async () => empty, now: () => "2026-07-27T12:00:00Z",
      }),
    ).rejects.toThrow(/kept/i);
    // ...but the cached transcript survives, rather than being overwritten with
    // NULL because the second fetch happened to come back empty.
    const s = await getSourceByUrl(db, 1, URL);
    expect(s!.transcript).toContain("welcome to Chongqing");
    expect(s!.transcriptSource).toBe("captions");
    // fetched_at must not advance either. A fetch that yielded nothing is not
    // a fetch, and `latestSource` orders by fetched_at DESC — advancing it
    // here is what let a failed refresh silently re-point which source
    // `ingest` attaches to.
    expect(s!.fetchedAt).toBe(original!.fetchedAt);
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

  test("--replace reports how many mentions it discarded", async () => {
    // Regression (M3 final review): deleteUnresolvedMentions already returns
    // the count; runWatchCommand threw it away, so a --replace that
    // destroyed twelve mentions looked identical in the output to a first
    // ingest of one. Check both output shapes.
    const db = await watched("ingest-replace-count");
    const NO_HIT = { ingestDeps: { geocode: async () => [], sleepFn: async () => {} } };
    const file1 = mentionsFile("rc1", [{ text: "a" }, { text: "b" }, { text: "c" }]);
    await runWatchCommand(db, ["ingest", `--mentions=${file1}`], false, NO_HIT);
    expect((await listMentions(db, 1)).length).toBe(3);

    const file2 = mentionsFile("rc2", [{ text: "d" }]);
    const jsonOut = JSON.parse(
      await runWatchCommand(db, ["ingest", `--mentions=${file2}`, "--replace"], true, NO_HIT),
    );
    expect(jsonOut.replaced).toBe(3);

    const db2 = await watched("ingest-replace-count-text");
    await runWatchCommand(db2, ["ingest", `--mentions=${file1}`], false, NO_HIT);
    const textOut = await runWatchCommand(
      db2, ["ingest", `--mentions=${file2}`, "--replace"], false, NO_HIT,
    );
    expect(textOut).toContain("--replace discarded 3 unresolved mentions");
  });

  test("a first ingest (nothing to replace) reports 0, distinguishing it from --replace", async () => {
    const db = await watched("ingest-first-replaced-zero");
    const NO_HIT = { ingestDeps: { geocode: async () => [], sleepFn: async () => {} } };
    const file = mentionsFile("first", [{ text: "a" }]);
    const jsonOut = JSON.parse(
      await runWatchCommand(db, ["ingest", `--mentions=${file}`], true, NO_HIT),
    );
    expect(jsonOut.replaced).toBe(0);
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

describe("trip watch frames", () => {
  /** db1 + a source row, which only exists once a watch has run. */
  async function withSource(tag: string) {
    const db = await db1(tag);
    await runWatchCommand(db, [URL], false, deps);
    return db;
  }

  function tmpRoot(tag: string): string {
    return mkdtempSync(join(tmpdir(), `trip-framesroot-${tag}-`));
  }

  test("extracts a window and prints the directory and files", async () => {
    const db = await withSource("frames-ok");
    const root = tmpRoot("ok");
    const out = await runWatchCommand(
      db, ["frames", "1", "--from=19:25", "--to=20:20"], false,
      {
        framesRoot: root,
        framesFn: async () => ({
          dir: `${root}/1/19-25_20-20/frames`,
          files: [`${root}/1/19-25_20-20/frames/frame_0001.jpg`],
        }),
      },
    );
    expect(out).toContain("1 frame");
    expect(out).toContain("frame_0001.jpg");
    // The agent has to be told what to do next, or the command is a dead end
    // that produced files nobody knows how to feed back.
    expect(out).toMatch(/read them/i);
    rmSync(root, { recursive: true, force: true });
  });

  test("--from and --to are BOTH required", async () => {
    // Without a window this is the blanket pass the design rejected, and the
    // cost stops being a deliberate choice.
    const db = await withSource("frames-nowindow");
    await expect(runWatchCommand(db, ["frames", "1"], false, {}))
      .rejects.toThrow(/--from/);
    await expect(runWatchCommand(db, ["frames", "1", "--from=1:00"], false, {}))
      .rejects.toThrow(/--to/);
  });

  test("a source the trip does not have is refused BEFORE any extraction", async () => {
    const db = await withSource("frames-nosource");
    let called = false;
    await expect(runWatchCommand(
      db, ["frames", "9", "--from=0:00", "--to=1:00"], false,
      { framesFn: async () => { called = true; throw new Error("should not run"); } },
    )).rejects.toThrow(/9/);
    expect(called).toBe(false);
  });

  test("a malformed window is rejected, naming the value", async () => {
    const db = await withSource("frames-badwindow");
    await expect(runWatchCommand(
      db, ["frames", "1", "--from=banana", "--to=1:00"], false, {},
    )).rejects.toThrow(/banana/);
  });

  test("a non-numeric --max is rejected", async () => {
    const db = await withSource("frames-badmax");
    await expect(runWatchCommand(
      db, ["frames", "1", "--from=0:00", "--to=1:00", "--max=lots"], false, {},
    )).rejects.toThrow(/--max/);
  });

  test("--refresh re-extracts over a cached window", async () => {
    const db = await withSource("frames-refresh");
    const root = tmpRoot("refresh");
    let calls = 0;
    const framesFn = async (_u: string, dir: string) => {
      calls++;
      mkdirSync(join(dir, "frames"), { recursive: true });
      writeFileSync(join(dir, "frames", "frame_0001.jpg"), "jpeg");
      return { dir: join(dir, "frames"), files: [join(dir, "frames", "frame_0001.jpg")] };
    };
    await runWatchCommand(db, ["frames", "1", "--from=0:00", "--to=1:00"], false,
      { framesRoot: root, framesFn });
    await runWatchCommand(db, ["frames", "1", "--from=0:00", "--to=1:00", "--refresh"], false,
      { framesRoot: root, framesFn });
    expect(calls).toBe(2);
    rmSync(root, { recursive: true, force: true });
  });

  test("json returns the paths, not prose", async () => {
    const db = await withSource("frames-json");
    const root = tmpRoot("json");
    const out = await runWatchCommand(
      db, ["frames", "1", "--from=0:00", "--to=1:00"], true,
      {
        framesRoot: root,
        framesFn: async () => ({ dir: "/d/frames", files: ["/d/frames/frame_0001.jpg"] }),
      },
    );
    expect(JSON.parse(out).files).toEqual(["/d/frames/frame_0001.jpg"]);
    rmSync(root, { recursive: true, force: true });
  });

  test("the cache hits against the REAL runFrames and a stub script", async () => {
    // The fakes above cannot check this: they write where the cache looks
    // because the same person wrote both halves. This drives the real
    // runFrames, so the write location and the read location have to agree
    // for real -- and if they ever disagreed, the cache would silently never
    // hit and every call would re-extract at full cost, looking like it
    // worked.
    const root = tmpRoot("realcache");
    const script = join(root, "stub.py");
    writeFileSync(script, [
      "import sys, os",
      "out = sys.argv[sys.argv.index('--out-dir') + 1]",
      "os.makedirs(os.path.join(out, 'frames'), exist_ok=True)",
      "open(os.path.join(out, 'frames', 'frame_0001.jpg'), 'w').write('jpeg')",
      "print('ok')",
    ].join("\n"));

    const db = await withSource("frames-realcache");
    const first = await runWatchCommand(
      db, ["frames", "1", "--from=0:00", "--to=1:00"], false,
      {
        framesRoot: root,
        framesFn: (url, dir, f, t, o) =>
          runFrames(url, dir, f, t, { ...o, scriptPath: script }),
      },
    );
    expect(first).toContain("frame_0001.jpg");

    // A cache hit must never reach the extractor. This one throws if called.
    const second = await runWatchCommand(
      db, ["frames", "1", "--from=0:00", "--to=1:00"], false,
      {
        framesRoot: root,
        framesFn: async () => { throw new Error("re-extracted"); },
      },
    );
    expect(second).toMatch(/already/i);
    expect(second).toContain("frame_0001.jpg");
    rmSync(root, { recursive: true, force: true });
  });
});

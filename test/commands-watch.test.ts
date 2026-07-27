import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runWatchCommand } from "@/commands/watch";
import { getSourceByUrl } from "@/sources";
import type { WatchReport } from "@/watch/parse-report";
import { rmSync } from "node:fs";
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

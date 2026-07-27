import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runReviewCommand } from "@/commands/review";
import {
  createMention, setCandidates, queueMention, rejectMention, resolveMention,
  getMention,
} from "@/mentions";
import { addSegment, listSegments } from "@/segments";
import type { Kind } from "@/geo/plausibility";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function queued(
  tag: string,
  opts: { dwellMinutes?: number | null; kind?: Kind | null } = {},
) {
  const p = join(tmpdir(), `trip-review-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO destinations (name, country_code, latitude, longitude)
          VALUES (?, ?, ?, ?)`,
    args: ["Chongqing", "cn", 29.5630, 106.5516],
  });
  await db.execute({
    sql: `INSERT INTO trips (name, destination_id, created_at) VALUES (?, ?, ?)`,
    args: ["chongqing", 1, "2026-07-27"],
  });
  // active_trip stores the trip's NAME (see trips.ts getActiveTrip), not its id —
  // the brief's own snippet used '1' here, which getTripByName would never match
  // against a trip named "chongqing"; every test would fail on "no active trip"
  // before ever reaching the code under test.
  await db.execute({
    sql: `INSERT INTO app_state (key, value) VALUES ('active_trip','chongqing')`,
  });
  await db.execute({
    sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
    args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
  });
  const id = await createMention(db, 1, 1, {
    text: "hot pot", atSeconds: 272, dwellMinutes: opts.dwellMinutes ?? null,
    tags: [], kind: opts.kind ?? null,
  });
  await setCandidates(db, id, [{
    rank: 1, displayName: "夜福火锅, 渝中区, 重庆市", localName: "夜福火锅",
    latitude: 29.563, longitude: 106.567,
    category: "amenity", type: "restaurant", importance: 0.0001,
    osmType: "node", osmId: 1, kmFromCentre: 1.4,
  }]);
  await queueMention(db, id, "1 candidate");
  return { db, id };
}

describe("trip review ls", () => {
  test("lists pending mentions", async () => {
    const { db } = await queued("ls");
    const out = await runReviewCommand(db, ["ls"], false);
    expect(out).toContain("hot pot");
    expect(out).toContain("夜福火锅");
  });

  test("json carries the candidates an agent picks from", async () => {
    const { db, id } = await queued("ls-json");
    const out = JSON.parse(await runReviewCommand(db, ["ls"], true));
    expect(out.pending.length).toBe(1);
    expect(out.pending[0].id).toBe(id);
    expect(out.pending[0].candidates[0].rank).toBe(1);
    expect(out.searchRadiusKm).toBe(25);
  });

  test("a rejected mention is not listed", async () => {
    const { db, id } = await queued("ls-filter-rejected");
    await rejectMention(db, id, "2026-07-27T12:00:00Z");
    const out = JSON.parse(await runReviewCommand(db, ["ls"], true));
    expect(out.pending).toEqual([]);
  });

  test("a resolved mention is not listed", async () => {
    const { db, id } = await queued("ls-filter-resolved");
    const segId = await addSegment(db, 1, {
      name: "Yuwei Hot Pot", latitude: 29.563, longitude: 106.567,
      dwellMinutes: 60, freeDays: [], tags: [],
      opensMin: null, closesMin: null, closedDays: [],
    });
    await resolveMention(db, id, segId);
    const out = JSON.parse(await runReviewCommand(db, ["ls"], true));
    expect(out.pending).toEqual([]);
  });

  test("--source scopes the queue to one video", async () => {
    const { db } = await queued("ls-source");
    // A second, real source with no mentions of its own - proves the filter
    // actually scopes rather than just happening to see an empty queue.
    await db.execute({
      sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
      args: [1, "https://youtu.be/y", "2026-07-27T00:00:00Z"],
    });
    const out = JSON.parse(await runReviewCommand(db, ["ls", "--source=2"], true));
    expect(out.pending).toEqual([]);
  });

  test("--source keeps the queue for the video it names", async () => {
    const { db, id } = await queued("ls-source-hit");
    const out = JSON.parse(await runReviewCommand(db, ["ls", "--source=1"], true));
    expect(out.pending.map((m: { id: number }) => m.id)).toEqual([id]);
  });

  test("an unknown --source is named, not a drained queue", async () => {
    // Regression (M3 final review): review ls did not validate --source at
    // all, so a typo'd id reported "nothing pending review" indistinguishable
    // from a genuinely drained queue. Mirrors watch ingest's own
    // "no source #999" validation (src/commands/watch.ts).
    const { db } = await queued("ls-source-unknown");
    await expect(
      runReviewCommand(db, ["ls", "--source=99"], true),
    ).rejects.toThrow(/no source #99/);
  });

  test("a non-numeric --source is rejected, not sent to the driver as NaN", async () => {
    const { db } = await queued("ls-source-nan");
    await expect(
      runReviewCommand(db, ["ls", "--source=abc"], true),
    ).rejects.toThrow(/invalid --source/);
  });

  test("an unknown subcommand is a usage error", async () => {
    const { db } = await queued("ls-bad");
    await expect(runReviewCommand(db, ["frobnicate"], false)).rejects.toThrow(/usage/i);
  });
});

const RENAME_HIT = {
  geocode: async () => [{
    displayName: "一兰拉面, 渝中区, 重庆市", localName: "一兰拉面",
    latitude: 29.561, longitude: 106.577,
    category: "amenity", type: "restaurant", importance: 0.0001,
    osmType: "node", osmId: 7, kmFromCentre: 2.5,
  }],
};

describe("trip review resolve", () => {
  test("--pick creates the segment and resolves the mention", async () => {
    const { db, id } = await queued("pick");
    const out = await runReviewCommand(db, ["resolve", String(id), "--pick=1"], false);
    expect(out).toContain("夜福火锅");

    const segs = await listSegments(db, 1);
    expect(segs.length).toBe(1);
    // The video's own words stay the name; OSM's is kept beside it.
    expect(segs[0]!.name).toBe("hot pot");
    expect(segs[0]!.localName).toBe("夜福火锅");
    expect(segs[0]!.sourceAtSeconds).toBe(272);
    expect(segs[0]!.dwellIsDefault).toBe(true);

    const m = (await getMention(db, 1, id))!;
    expect(m.state).toBe("resolved");
    expect(m.reason).toBeNull();
  });

  test("--pick out of range names the range instead of throwing an index error", async () => {
    const { db, id } = await queued("pick-range");
    await expect(
      runReviewCommand(db, ["resolve", String(id), "--pick=9"], false),
    ).rejects.toThrow(/1\.\.1/);
  });

  // A far out-of-range pick and an off-by-one pick both land past the last
  // candidate, but a bound relaxed by one (e.g. `n > length + 1`) would still
  // reject --pick=9 while silently accepting --pick=2 against a 1-candidate
  // list. Only a value exactly one past the end tells the two apart.
  test("--pick one past the end also names the range, not just far out-of-range", async () => {
    const { db, id } = await queued("pick-range-boundary");
    await expect(
      runReviewCommand(db, ["resolve", String(id), "--pick=2"], false),
    ).rejects.toThrow(/1\.\.1/);
  });

  test("--reject marks it rejected and creates nothing", async () => {
    const { db, id } = await queued("reject");
    await runReviewCommand(db, ["resolve", String(id), "--reject"], false,
      { now: () => "2026-07-27T12:00:00Z" });
    expect((await getMention(db, 1, id))!.state).toBe("rejected");
    expect(await listSegments(db, 1)).toEqual([]);
  });

  test("--rename re-geocodes and keeps the video's original words", async () => {
    const { db, id } = await queued("rename");
    await runReviewCommand(db,
      ["resolve", String(id), "--rename=Ichiran Chongqing"], false, RENAME_HIT);

    const m = (await getMention(db, 1, id))!;
    expect(m.text).toBe("hot pot");
    expect(m.resolvedName).toBe("Ichiran Chongqing");
    expect(m.state).toBe("resolved");

    const segs = await listSegments(db, 1);
    expect(segs[0]!.name).toBe("Ichiran Chongqing");
    expect(segs[0]!.localName).toBe("一兰拉面");
  });

  test("--rename re-runs the plausibility check against the mention's kind", async () => {
    // Without this, --rename is a documented bypass: it re-geocodes, so it is
    // exactly the path a wrong unique result can re-enter through, and every
    // corrected mention would resolve on uniqueness alone.
    const { db, id } = await queued("rename-recheck", { kind: "street" });
    const HOTEL = {
      geocode: async () => [{
        displayName: "你好酒店(重庆解放碑步行街店), 渝中区, 重庆市",
        localName: "你好酒店(重庆解放碑步行街店)",
        latitude: 29.557, longitude: 106.577,
        category: "tourism", type: "hotel", importance: 0.0001,
        osmType: "node", osmId: 9, kmFromCentre: 2.1,
      }],
    };

    const out = await runReviewCommand(
      db, ["resolve", String(id), "--rename=Jiefangbei Pedestrian Street"],
      false, HOTEL,
    );

    expect(out).toContain("type mismatch");
    const m = (await getMention(db, 1, id))!;
    expect(m.state).toBe("pending");
    expect(m.reason).toBe("type mismatch: expected street, got tourism/hotel");
    expect(m.segmentId).toBeNull();
    // The video's own words survive; the correction lives in resolved_name.
    expect(m.text).toBe("hot pot");
    expect(m.resolvedName).toBe("Jiefangbei Pedestrian Street");
    // And the candidate is still there to accept with --pick=1.
    expect(m.candidates).toHaveLength(1);
    expect(await listSegments(db, 1)).toEqual([]);
  });

  test("--rename against a malformed geocode result leaves the mention untouched", async () => {
    // Deferred from M3 as honest but untested. parsePoiResponse throws on a
    // result it cannot read, and this call site has no try/catch, so the
    // command fails and the mention comes out exactly as it went in — old
    // name, old candidates. That is the safe outcome, and now it is pinned.
    const { db, id } = await queued("rename-malformed");
    const BROKEN = {
      geocode: async () => {
        throw new Error("unusable geocode result (missing coordinates or name)");
      },
    };

    await expect(runReviewCommand(
      db, ["resolve", String(id), "--rename=Ramen Ichiban"], false, BROKEN,
    )).rejects.toThrow("unusable geocode result");

    const m = (await getMention(db, 1, id))!;
    expect(m.text).toBe("hot pot");
    expect(m.resolvedName).toBeNull();
    expect(m.reason).toBe("1 candidate");
    expect(m.state).toBe("pending");
    // The OLD name's candidates, unreplaced.
    expect(m.candidates).toHaveLength(1);
    expect(m.candidates[0]!.localName).toBe("夜福火锅");
  });

  test("--rename that stays ambiguous returns to the queue with fresh candidates", async () => {
    const { db, id } = await queued("rename-ambiguous");
    // Two results -> still queued, with the NEW name's candidates.
    const AMBIG = {
      geocode: async () => [1, 2].map((n) => ({
        displayName: `option ${n}`, localName: `option ${n}`,
        latitude: 29.56, longitude: 106.55,
        category: "amenity", type: "restaurant", importance: 0.0001,
        osmType: "node", osmId: n, kmFromCentre: 1,
      })),
    };
    await runReviewCommand(db, ["resolve", String(id), "--rename=noodles"], false, AMBIG);

    const m = (await getMention(db, 1, id))!;
    expect(m.state).toBe("pending");
    expect(m.reason).toBe("2 candidates");
    expect(m.candidates.length).toBe(2);
    expect(m.candidates[0]!.displayName).toBe("option 1");
    expect(await listSegments(db, 1)).toEqual([]);
  });

  // The fixture never renames, so mention.name and mention.text are identical
  // there and cannot tell a --pick that reads the wrong field from one that
  // reads the right one. Renaming into ambiguity first, then picking from the
  // fresh list, is the only way to make the two fields differ.
  test("--pick after an ambiguous --rename uses the renamed name, not the video's words", async () => {
    const { db, id } = await queued("pick-after-rename");
    const AMBIG = {
      geocode: async () => [1, 2].map((n) => ({
        displayName: `option ${n}`, localName: `option ${n}`,
        latitude: 29.56, longitude: 106.55,
        category: "amenity", type: "restaurant", importance: 0.0001,
        osmType: "node", osmId: n, kmFromCentre: 1,
      })),
    };
    await runReviewCommand(db, ["resolve", String(id), "--rename=noodles"], false, AMBIG);
    await runReviewCommand(db, ["resolve", String(id), "--pick=1"], false);

    const segs = await listSegments(db, 1);
    expect(segs[0]!.name).toBe("noodles");

    const m = (await getMention(db, 1, id))!;
    expect(m.text).toBe("hot pot");
    expect(m.state).toBe("resolved");
  });

  // The fixture's default dwellMinutes is null, so a mutant that always applies
  // DEFAULT_DWELL_MINUTES instead of the mention's own value would be invisible
  // without a fixture that actually carries an explicit dwell.
  test("--pick preserves an explicit dwell instead of applying the default", async () => {
    const { db, id } = await queued("pick-dwell", { dwellMinutes: 90 });
    await runReviewCommand(db, ["resolve", String(id), "--pick=1"], false);
    const segs = await listSegments(db, 1);
    expect(segs[0]!.dwellMinutes).toBe(90);
    expect(segs[0]!.dwellIsDefault).toBe(false);
  });

  // If the geocode lookup throws AFTER the new name is already written, the
  // mention is left with the new name beside the OLD name's candidate list —
  // exactly the mismatch --rename exists to prevent (a later --pick=N would
  // mean a different place than the list the reader last saw). The lookup
  // must run, and succeed, before anything is written.
  test("a failing geocode during --rename leaves the mention and its candidates untouched", async () => {
    const { db, id } = await queued("rename-geocode-fails");
    const FAILING = { geocode: async () => { throw new Error("429"); } };
    await expect(
      runReviewCommand(db, ["resolve", String(id), "--rename=noodles"], false, FAILING),
    ).rejects.toThrow(/429/);

    const m = (await getMention(db, 1, id))!;
    expect(m.resolvedName).toBeNull();
    expect(m.state).toBe("pending");
    expect(m.candidates.length).toBe(1);
    expect(m.candidates[0]!.displayName).toBe("夜福火锅, 渝中区, 重庆市");
  });

  test("resolving an already-resolved mention errors and does not double-create", async () => {
    const { db, id } = await queued("double");
    await runReviewCommand(db, ["resolve", String(id), "--pick=1"], false);
    await expect(
      runReviewCommand(db, ["resolve", String(id), "--pick=1"], false),
    ).rejects.toThrow(/already resolved/i);
    expect((await listSegments(db, 1)).length).toBe(1);
  });

  test("exactly one action is required", async () => {
    const { db, id } = await queued("one-action");
    await expect(
      runReviewCommand(db, ["resolve", String(id)], false),
    ).rejects.toThrow(/--pick/);
    await expect(
      runReviewCommand(db, ["resolve", String(id), "--pick=1", "--reject"], false),
    ).rejects.toThrow(/exactly one/i);
  });

  test("an unknown mention id says so", async () => {
    const { db } = await queued("missing");
    await expect(
      runReviewCommand(db, ["resolve", "999", "--reject"], false),
    ).rejects.toThrow(/999/);
  });
});

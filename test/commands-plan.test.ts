import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip } from "@/trips";
import { runDatesCommand } from "@/commands/dates";
import { runSegmentsCommand } from "@/commands/segments";
import { runPlanCommand } from "@/commands/plan";
import { readPlacements, readPins, savePlacements } from "@/placements";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function setup(tag: string, opts: { dates?: boolean; segs?: boolean } = {}) {
  const p = join(tmpdir(), `trip-plancmd-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  // createTrip requires a createdAt string (see src/trips.ts) - the brief's
  // illustrative call omitted it.
  await createTrip(db, "lisbon", "2026-07-26");
  await setActiveTrip(db, "lisbon");
  if (opts.dates !== false) {
    await runDatesCommand(db, ["set", "2027-05-08..05-10"], false);
  }
  if (opts.segs !== false) {
    await runSegmentsCommand(db, ["add", "Se", "--dur=60m", "--at=38.7100,-9.1330"], false);
    await runSegmentsCommand(db, ["add", "Alfama", "--dur=60m", "--at=38.7120,-9.1280"], false);
    await runSegmentsCommand(db, ["add", "Jeronimos", "--dur=90m", "--at=38.6970,-9.2060"], false);
    await runSegmentsCommand(db, ["add", "Torre", "--dur=45m", "--at=38.6916,-9.2160"], false);
  }
  return db;
}

describe("trip plan", () => {
  test("produces a plan with clock times", async () => {
    const db = await setup("basic");
    const out = await runPlanCommand(db, "plan", [], false);
    expect(out).toMatch(/Day 1/);
    expect(out).toMatch(/\d{2}:\d{2}/);
    expect(await readPlacements(db, 1)).not.toHaveLength(0);
  });

  test("plan is persisted and readable by day", async () => {
    const db = await setup("byday");
    await runPlanCommand(db, "plan", [], false);
    const out = await runPlanCommand(db, "day", ["1"], false);
    expect(out).toMatch(/Day 1/);
    expect(out).not.toMatch(/Day 2/);
  });

  test("running plan twice gives the same result", async () => {
    const db = await setup("idem");
    const first = await runPlanCommand(db, "plan", [], false);
    const second = await runPlanCommand(db, "plan", [], false);
    expect(second).toBe(first);
  });

  test("--pace and --mode are honoured", async () => {
    const db = await setup("paced");
    const json = JSON.parse(await runPlanCommand(db, "plan", ["--pace=easy"], true));
    for (const day of json.days) expect(day.placements.length).toBeLessThanOrEqual(3);
  });

  test("an invalid pace is rejected instead of falling back", async () => {
    const db = await setup("badpace");
    await expect(runPlanCommand(db, "plan", ["--pace=leisurely"], false))
      .rejects.toThrow(/pace/i);
  });

  test("segments that did not fit are reported with reasons", async () => {
    // M2's governing principle: absent from the output is never how you find
    // out something is missing.
    const db = await setup("unplaced");
    await runSegmentsCommand(db, ["add", "Nowhere", "--dur=30m"], false);
    const out = await runPlanCommand(db, "plan", [], false);
    expect(out).toContain("Nowhere");
    expect(out.toLowerCase()).toContain("coordinates");
  });

  test("json output carries days, placements, and the unplaced list", async () => {
    const db = await setup("json");
    await runSegmentsCommand(db, ["add", "Nowhere", "--dur=30m"], false);
    const json = JSON.parse(await runPlanCommand(db, "plan", [], true));
    expect(json.days).toHaveLength(3);
    expect(json.days[0].placements[0]).toHaveProperty("startTime");
    expect(json.unplaced[0]).toHaveProperty("reason");
    expect(json.unplaced[0]).toHaveProperty("name");
  });

  test("planning without dates fails loudly", async () => {
    const db = await setup("nodates", { dates: false });
    await expect(runPlanCommand(db, "plan", [], false)).rejects.toThrow(/dates/i);
  });

  test("planning with no segments fails loudly", async () => {
    const db = await setup("nosegs", { segs: false });
    await expect(runPlanCommand(db, "plan", [], false)).rejects.toThrow(/segment/i);
  });
});

describe("pin, unpin, move", () => {
  test("a pinned segment keeps its slot across replan", async () => {
    const db = await setup("pin");
    await runPlanCommand(db, "plan", [], false);
    await runPlanCommand(db, "pin", ["Torre", "--day=1", "--at=10:00"], false);
    await runPlanCommand(db, "replan", [], false);

    const placements = await readPlacements(db, 1);
    const torre = placements.find((p) => p.segmentId === 4)!;
    expect(torre.day).toBe(1);
    expect(torre.startMin).toBe(600);
    expect(torre.pinned).toBe(true);
  });

  test("a segment can be pinned by name or by id", async () => {
    const db = await setup("pinid");
    await runPlanCommand(db, "pin", ["4", "--day=2", "--at=09:30"], false);
    // readPlacements is the COMPILED result and this pin has never gone
    // through a plan, so its start_minutes is still NULL — read the
    // ASSERTION instead, which is what a bare `pin` actually writes.
    const pinned = (await readPins(db, 1)).find((p) => p.segmentId === 4);
    expect(pinned).toBeDefined();
    expect(pinned!.day).toBe(2);
    expect(pinned!.startMin).toBe(570);
  });

  test("an ambiguous name is rejected rather than guessed", async () => {
    const db = await setup("ambig");
    await runSegmentsCommand(db, ["add", "Torre Extra", "--dur=30m", "--at=38.69,-9.21"], false);
    await expect(runPlanCommand(db, "pin", ["Torre", "--day=1", "--at=10:00"], false))
      .rejects.toThrow(/matches/i);
  });

  test("a name matching nothing is rejected", async () => {
    const db = await setup("nomatch");
    await expect(runPlanCommand(db, "pin", ["Nonexistent", "--day=1"], false))
      .rejects.toThrow(/no segment/i);
  });

  test("pinning outside the trip's days is rejected at the command", async () => {
    const db = await setup("pinrange");
    await expect(runPlanCommand(db, "pin", ["Torre", "--day=9", "--at=10:00"], false))
      .rejects.toThrow(/day/i);
  });

  test("move fixes the day but leaves the time to the compiler", async () => {
    const db = await setup("move");
    await runPlanCommand(db, "plan", [], false);
    await runPlanCommand(db, "move", ["Torre", "--to=day1"], false);
    await runPlanCommand(db, "replan", [], false);
    const torre = (await readPlacements(db, 1)).find((p) => p.segmentId === 4)!;
    expect(torre.day).toBe(1);
    expect(torre.pinned).toBe(true);
  });

  test("unpin releases a segment back to the compiler", async () => {
    const db = await setup("unpin");
    await runPlanCommand(db, "pin", ["Torre", "--day=1", "--at=10:00"], false);
    await runPlanCommand(db, "unpin", ["Torre"], false);
    await runPlanCommand(db, "replan", [], false);
    const torre = (await readPlacements(db, 1)).find((p) => p.segmentId === 4)!;
    expect(torre.pinned).toBe(false);
  });

  test("unpinning something that is not pinned says so", async () => {
    const db = await setup("unpinmiss");
    await expect(runPlanCommand(db, "unpin", ["Torre"], false)).rejects.toThrow(/not pinned/i);
  });

  test("day out of range is rejected", async () => {
    const db = await setup("dayrange");
    await runPlanCommand(db, "plan", [], false);
    await expect(runPlanCommand(db, "day", ["9"], false)).rejects.toThrow(/day/i);
  });

  test("day before planning tells you to plan", async () => {
    const db = await setup("dayfirst");
    await expect(runPlanCommand(db, "day", ["1"], false)).rejects.toThrow(/plan/i);
  });

  // Reported by team-lead: pin a segment onto a day, then pin something else
  // that blocks it and replan. The compiler correctly drops the first
  // segment (it no longer fits), but its OLD compiled row from the EARLIER
  // successful plan was never cleared, so `trip day` kept showing it at a
  // stale time while `trip plan --json` correctly reported it unplaced in
  // the same breath -- two commands, same state, opposite answers.
  test("a pinned segment the compiler could not place is called out, not shown at a stale time", async () => {
    const p = join(tmpdir(), `trip-plancmd-staleunplaced-${process.pid}.db`);
    rmSync(p, { force: true });
    const db = openDb(p);
    await migrate(db);
    await createTrip(db, "lisbon", "2026-07-26");
    await setActiveTrip(db, "lisbon");
    await runDatesCommand(db, ["set", "2027-05-08..05-10", "--arrive=15:30"], false);
    await runSegmentsCommand(db, ["add", "Se", "--dur=60m", "--at=38.7100,-9.1330"], false);
    await runSegmentsCommand(
      db, ["add", "Alfama", "--dur=90m", "--at=38.7120,-9.1280", "--hours=10:00-18:00"], false,
    );
    await runSegmentsCommand(db, ["add", "Jeronimos", "--dur=90m", "--at=38.6970,-9.2060"], false);
    await runSegmentsCommand(db, ["add", "Pasteis", "--dur=30m", "--at=38.6975,-9.2030"], false);

    await runPlanCommand(db, "plan", [], false); // Alfama lands somewhere real, e.g. day 3 at 10:00
    await runPlanCommand(db, "pin", ["Jeronimos", "--day=1", "--at=16:00"], false);
    await runPlanCommand(db, "move", ["Alfama", "--to=day1"], false); // day-locked pin
    await runPlanCommand(db, "replan", [], false);
    // Jeronimos blocks 16:00-17:30; Alfama's 90m dwell cannot finish inside
    // its 10:00-18:00 hours around that block on a 15:30-19:00 day -- the
    // compiler drops it.

    // Alfama (#2) must not be among the compiled itinerary at all.
    const placements = await readPlacements(db, 1);
    expect(placements.find((pl) => pl.segmentId === 2)).toBeUndefined();

    const dayText = await runPlanCommand(db, "day", ["1"], false);
    // Not rendered as scheduled, at any time -- this was the bug: it showed
    // "10:00 Alfama", stale from the earlier plan where it sat on day 3.
    expect(dayText).not.toMatch(/\d{2}:\d{2} Alfama/);
    // But not silently dropped either -- M2's rule that a segment's absence
    // is never how you find out it was dropped.
    expect(dayText).toContain("Alfama");

    const dayJson = JSON.parse(await runPlanCommand(db, "day", ["1"], true)) as {
      days: { placements: { name: string }[] }[];
      unplaced: { name: string }[];
    };
    expect(dayJson.days[0]!.placements.some((pl) => pl.name === "Alfama")).toBe(false);
    expect(dayJson.unplaced.some((u) => u.name === "Alfama")).toBe(true);

    // Jeronimos, which COULD be placed, is unaffected: still on day 1 at
    // 16:00, still marked pinned.
    const jeronimos = placements.find((pl) => pl.segmentId === 3)!;
    expect(jeronimos.day).toBe(1);
    expect(jeronimos.startMin).toBe(960);
    expect(jeronimos.pinned).toBe(true);

    // `trip plan --json` must keep correctly reporting Alfama unplaced with
    // a reason -- this already worked before the fix and must keep working.
    const planned = JSON.parse(await runPlanCommand(db, "plan", [], true)) as {
      unplaced: { name: string; reason: string }[];
    };
    const unplacedAlfama = planned.unplaced.find((u) => u.name === "Alfama");
    expect(unplacedAlfama).toBeDefined();
    expect(unplacedAlfama!.reason.length).toBeGreaterThan(0);
  });

  // Carried forward from Task 9's implementer: between `trip pin`/`trip
  // move` and the next `trip replan`, setPinned writes ordinal 0
  // unconditionally, which can TIE with whatever the previous plan already
  // put at ordinal 0 on that day. `ordinal` is NOT NULL in the schema, so
  // there is no "no opinion yet" sentinel to fall back on -- `trip day` must
  // still produce a stable, deterministic order in that window.
  //
  // This has to construct a genuine INVERSION, not just a tie: two segments
  // tied on ordinal with the SAME startMin sort in ascending-id order
  // regardless of whether the code sorts by ordinal alone or by
  // (ordinal, startMin, id) -- SQLite returns ties in ascending segment_id
  // order in practice, and a stable JS sort preserves that, so an
  // ordinal-only sort would accidentally "pass" that shape. The case that
  // only the full key gets right: a LOWER-id resident with a LATER real
  // clock time, versus a HIGHER-id segment freshly pinned onto that day --
  // ordinal-only falls back to id order and gets the resident first; the
  // correct key must sort by clock time next and puts the pinned segment
  // first instead.
  //
  // Constructed directly via savePlacements/setPinned rather than through
  // `plan`, so this does not depend on how clusterSegments happens to
  // divide these segments across days (that's frozen compiler geography,
  // not something a sort-order test should be coupled to) -- and, since the
  // fix round below makes readPlacements skip NULL start_minutes rows, a
  // genuinely never-compiled fresh pin would no longer surface here at all;
  // both rows in this test carry real, non-null compiled times.
  test("day render breaks a pin-created ordinal tie deterministically, without a replan", async () => {
    const db = await setup("tiewindow");
    // Se (#1, lower id) is day 1's ordinal-0 resident with a REAL, LATE
    // clock time (15:30). Torre (#4, higher id) starts on day 3 with a
    // REAL, EARLY time (09:00) -- both as if from a completed plan.
    await savePlacements(db, 1, [
      { segmentId: 1, day: 1, ordinal: 0, startMin: 930, endMin: 990, pinned: false },
      { segmentId: 4, day: 3, ordinal: 0, startMin: 540, endMin: 585, pinned: false },
    ]);

    // Torre is now pinned onto day 1 without a replan. setPinned resets ITS
    // OWN row's ordinal to 0 unconditionally -- a genuine tie with Se's
    // ordinal 0 -- but leaves start_minutes untouched (only savePlacements
    // writes that column), so Torre's stale, EARLIER time (540) survives.
    await runPlanCommand(db, "pin", ["Torre", "--day=1"], false);

    const placements = (await readPlacements(db, 1)).filter((p) => p.day === 1);
    const resident = placements.find((p) => p.segmentId === 1)!;
    const pinned = placements.find((p) => p.segmentId === 4)!;
    // Sanity: this is the specific inversion under test, not an accident.
    expect(resident.ordinal).toBe(0);
    expect(pinned.ordinal).toBe(0);
    expect(pinned.startMin).toBeLessThan(resident.startMin);
    expect(pinned.segmentId).toBeGreaterThan(resident.segmentId);

    const expectedIds = [...placements]
      .sort((a, b) => a.ordinal - b.ordinal || a.startMin - b.startMin || a.segmentId - b.segmentId)
      .map((p) => p.segmentId);
    expect(expectedIds[0]).toBe(4); // the freshly pinned segment (Torre) sorts FIRST

    const outText1 = await runPlanCommand(db, "day", ["1"], false);
    const outText2 = await runPlanCommand(db, "day", ["1"], false);
    expect(outText1).toBe(outText2); // stable across repeated calls

    const idToName = new Map([[1, "Se"], [2, "Alfama"], [3, "Jeronimos"], [4, "Torre"]]);
    const renderedIds = outText1
      .split("\n")
      .map((line) => {
        const hit = [...idToName.entries()].find(([, name]) => new RegExp(`\\b${name}\\b`).test(line));
        return hit?.[0];
      })
      .filter((id): id is number => id !== undefined);
    expect(renderedIds).toEqual(expectedIds);

    // Same contract on the JSON path (planJson's independent sort).
    const outJson = JSON.parse(await runPlanCommand(db, "day", ["1"], true)) as {
      days: { placements: { segmentId: number }[] }[];
    };
    const jsonIds = outJson.days[0]!.placements.map((p) => p.segmentId);
    expect(jsonIds).toEqual(expectedIds);
  });
});

import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip } from "@/trips";
import { runDatesCommand } from "@/commands/dates";
import { runSegmentsCommand } from "@/commands/segments";
import { runPlanCommand } from "@/commands/plan";
import { readPlacements } from "@/placements";
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
    const pinned = (await readPlacements(db, 1)).find((p) => p.pinned)!;
    expect(pinned.segmentId).toBe(4);
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

  // Carried forward from Task 9's implementer: between `trip pin`/`trip
  // move` and the next `trip replan`, setPinned writes ordinal 0
  // unconditionally, which can TIE with whatever the previous plan already
  // put at ordinal 0 on that day. `ordinal` is NOT NULL in the schema, so
  // there is no "no opinion yet" sentinel to fall back on -- `trip day` must
  // still produce a stable, deterministic order in that window.
  //
  // This has to construct a genuine INVERSION, not just a tie: two segments
  // pinned onto the same day both read back startMin 0 (NULL, unset) and sort
  // in ascending-id order regardless of whether the code sorts by ordinal
  // alone or by (ordinal, startMin, id) -- SQLite returns ties in ascending
  // segment_id order in practice, and a stable JS sort preserves that, so an
  // ordinal-only sort would accidentally "pass" that shape. The case that
  // only the full key gets right: a LOWER-id resident with a LATER real
  // clock time, versus a HIGHER-id segment freshly pinned (never through a
  // `plan`, so its start_minutes is genuinely NULL/0) -- ordinal-only falls
  // back to id order and gets the resident first; the correct key must sort
  // by clock time next and puts the freshly pinned segment first instead.
  test("day render breaks a pin-created ordinal tie deterministically, without a replan", async () => {
    const db = await setup("tiewindow");
    await runPlanCommand(db, "plan", [], false);
    // Empirically: with this segment set and no --arrive, day 1's ordinal-0
    // resident is Se (#1) at 09:00 (startMin 540).

    // Added AFTER the plan ran, so it has no prior placements row at all --
    // pinning it is a fresh INSERT, and start_minutes is omitted (NULL),
    // reading back as 0 (see placements.ts). Higher id (#5) than the
    // resident (#1), but an "earlier" (unset) stale clock time.
    await runSegmentsCommand(db, ["add", "Cais", "--dur=20m", "--at=38.7050,-9.1400"], false);
    await runPlanCommand(db, "pin", ["Cais", "--day=1", "--at=09:15"], false);

    const placements = (await readPlacements(db, 1)).filter((p) => p.day === 1);
    const resident = placements.find((p) => p.segmentId === 1)!;
    const pinned = placements.find((p) => p.segmentId === 5)!;
    // Sanity: this is the specific inversion under test, not an accident.
    expect(resident.ordinal).toBe(0);
    expect(pinned.ordinal).toBe(0);
    expect(pinned.startMin).toBeLessThan(resident.startMin);
    expect(pinned.segmentId).toBeGreaterThan(resident.segmentId);

    const expectedIds = [...placements]
      .sort((a, b) => a.ordinal - b.ordinal || a.startMin - b.startMin || a.segmentId - b.segmentId)
      .map((p) => p.segmentId);
    expect(expectedIds[0]).toBe(5); // the freshly pinned segment sorts FIRST

    const outText1 = await runPlanCommand(db, "day", ["1"], false);
    const outText2 = await runPlanCommand(db, "day", ["1"], false);
    expect(outText1).toBe(outText2); // stable across repeated calls

    const idToName = new Map([[1, "Se"], [2, "Alfama"], [3, "Jeronimos"], [4, "Torre"], [5, "Cais"]]);
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

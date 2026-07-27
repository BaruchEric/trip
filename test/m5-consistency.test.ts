import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runTripsCommand } from "@/commands/trips";
import { runDatesCommand } from "@/commands/dates";
import { runWhoCommand } from "@/commands/who";
import { runSegmentsCommand } from "@/commands/segments";
import { runPassCommand } from "@/commands/passes";
import { runPlanCommand } from "@/commands/plan";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Cross-command consistency. Every one of M2's and M3's worst defects was
 *  found by two commands describing the same state and disagreeing, never by
 *  a unit test — and this milestone gives them money to disagree about. */

async function fresh(tag: string) {
  const p = join(tmpdir(), `trip-m5c-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  return db;
}

/** A trip whose party spans all three concession cases, with one segment
 *  deliberately unpriced so unknowns are always in play. Segments are PINNED
 *  rather than left to the compiler, so which day a price lands on is a fact
 *  of the fixture rather than of the clustering heuristic. */
async function fixture(tag: string) {
  const db = await fresh(tag);
  await runTripsCommand(db, ["new", "chongqing"], false);
  await runDatesCommand(db, ["set", "2026-10-02..2026-10-06"], false);
  await runTripsCommand(db, ["set", "--currency=CNY"], false);

  await runWhoCommand(db, ["add", "Eric", "--born=1971-06-02"], false);
  await runWhoCommand(db, ["add", "Mom", "--born=1949-03-14"], false);
  await runWhoCommand(db, ["add", "Kid", "--born=2015-11-20"], false);

  // Luohan:  10 base, seniors and children free      -> party 10
  // Hongya:  20 base, seniors free, children 10      -> party 30
  // Jiefangbei: no rules at all                      -> UNKNOWN
  await runSegmentsCommand(db, ["add", "Luohan", "--dur=90m", "--at=29.5615,106.5810",
    "--price=10", "--price=65+:0", "--price=0-11:0"], false);
  await runSegmentsCommand(db, ["add", "Hongya", "--dur=90m", "--at=29.5620,106.5770",
    "--price=20", "--price=65+:0", "--price=0-11:10"], false);
  await runSegmentsCommand(db, ["add", "Jiefangbei", "--dur=60m", "--at=29.5570,106.5770"], false);

  await runPassCommand(db, ["add", "Metro", "--days=1-3",
    "--price=45", "--price=65+:0"], false);

  await runPlanCommand(db, "plan", [], false);
  // All three onto day 1, so one day carries both priced segments and the
  // unpriced one — the exact shape the breakdown rule is about.
  for (const id of ["1", "2", "3"]) {
    await runPlanCommand(db, "pin", [id, "--day=1"], false);
  }
  await runPlanCommand(db, "replan", [], false);
  return db;
}

/** `Day 1 total          CNY 40 + 1 unknown` -> { total: 40, unknown: 1 } */
function readTotal(line: string): { total: number | null; unknown: number } {
  const unknown = Number(/\+ (\d+) unknown/.exec(line)?.[1] ?? 0);
  const head = line.replace(/\+ \d+ unknown/, "");
  const m = /(?:CNY )(\d+)/.exec(head);
  return { total: m ? Number(m[1]) : null, unknown };
}

function lineWith(out: string, needle: string): string {
  const hit = out.split("\n").find((l) => l.includes(needle));
  if (hit === undefined) {
    throw new Error(`no line containing "${needle}" in:\n${out}`);
  }
  return hit;
}

describe("M5 cross-command consistency", () => {
  test("trip day N's breakdown sums to trip plan's day-N total", async () => {
    // THE headline invariant. Two commands, two code paths, one number.
    const db = await fixture("breakdown");
    const plan = await runPlanCommand(db, "plan", [], false);
    const { total } = readTotal(lineWith(plan, "Day 1 total"));

    const day = await runPlanCommand(db, "day", ["1"], false);
    const rows = [...day.matchAll(/age \d+\s+(?:CNY )?(\d+|free)\s*$/gm)]
      .map((m) => (m[1] === "free" ? 0 : Number(m[1])));

    expect(rows.length).toBe(3);
    // Asserted non-null first on purpose: `toBe(total)` alone would also pass
    // if BOTH sides were null, which is the failure mode where the renderer
    // silently stops producing a number at all.
    expect(total).not.toBeNull();
    expect(rows.reduce((a, b) => a + b, 0)).toBe(total!);
  });

  test("trip day and trip plan report the same day total and unknown count", async () => {
    const db = await fixture("daymatch");
    const plan = readTotal(
      lineWith(await runPlanCommand(db, "plan", [], false), "Day 1 total"));
    const day = readTotal(
      lineWith(await runPlanCommand(db, "day", ["1"], false), "Day 1 total"));
    expect(day).toEqual(plan);
  });

  test("the trip total equals the day totals plus the passes", async () => {
    const db = await fixture("triptotal");
    const out = await runPlanCommand(db, "plan", [], false);
    const dayTotals = out.split("\n")
      .filter((l) => /Day \d+ total/.test(l))
      .map(readTotal);
    const admission = readTotal(lineWith(out, "Admission"));
    const passes = readTotal(lineWith(out, "Passes  "));
    const trip = readTotal(lineWith(out, "Trip total"));

    const daySum = dayTotals.reduce((a, d) => a + (d.total ?? 0), 0);
    const dayUnknown = dayTotals.reduce((a, d) => a + d.unknown, 0);

    expect(admission.total).toBe(daySum);
    expect(admission.unknown).toBe(dayUnknown);
    expect(trip.total).toBe((admission.total ?? 0) + (passes.total ?? 0));
    expect(trip.unknown).toBe(admission.unknown + passes.unknown);
  });

  test("the footer's unknown count equals the number of unpriced placed segments", async () => {
    const db = await fixture("unknowncount");
    // One unpriced segment in the fixture.
    let out = await runPlanCommand(db, "plan", [], false);
    expect(readTotal(lineWith(out, "Admission")).unknown).toBe(1);

    // Pricing it must take the count to zero. Asserting only the 1 would pass
    // against a hardcoded constant.
    await runSegmentsCommand(db, ["price", "3", "--price=5"], false);
    out = await runPlanCommand(db, "plan", [], false);
    expect(readTotal(lineWith(out, "Admission")).unknown).toBe(0);

    // And clearing it must bring the count back -- UNKNOWN, not free.
    await runSegmentsCommand(db, ["price", "3", "--clear"], false);
    out = await runPlanCommand(db, "plan", [], false);
    expect(readTotal(lineWith(out, "Admission")).unknown).toBe(1);
  });

  test("a birthday inside the trip window prices differently within ONE plan", async () => {
    // End-to-end version of the pure test in pricing-party: this one catches
    // an age cached anywhere in the command layer, which the pure test cannot
    // see. Nearly turns 65 on 2026-10-04, which is day 3.
    const db = await fresh("birthday");
    await runTripsCommand(db, ["new", "cq"], false);
    await runDatesCommand(db, ["set", "2026-10-02..2026-10-06"], false);
    await runTripsCommand(db, ["set", "--currency=CNY"], false);
    await runWhoCommand(db, ["add", "Nearly", "--born=1961-10-04"], false);

    await runSegmentsCommand(db, ["add", "Before", "--dur=60m", "--at=29.56,106.58",
      "--price=30", "--price=65+:0"], false);
    await runSegmentsCommand(db, ["add", "After", "--dur=60m", "--at=29.56,106.58",
      "--price=30", "--price=65+:0"], false);
    await runPlanCommand(db, "plan", [], false);
    await runPlanCommand(db, "pin", ["1", "--day=1"], false);
    await runPlanCommand(db, "pin", ["2", "--day=5"], false);
    await runPlanCommand(db, "replan", [], false);

    const out = await runPlanCommand(db, "plan", [], false);
    // Day 1 is 2026-10-02, age 64 -> pays. Day 5 is 2026-10-06, age 65 -> free.
    expect(readTotal(lineWith(out, "Day 1 total")).total).toBe(30);
    expect(readTotal(lineWith(out, "Day 5 total")).total).toBe(0);
  });

  test("removing a traveller changes every total, with no replan", async () => {
    // Decision 10: nothing is persisted, so nothing can go stale. The
    // placements must be identical while the money moves.
    const db = await fixture("removewho");
    const before = await runPlanCommand(db, "plan", [], false);
    const beforeTotal = readTotal(lineWith(before, "Trip total")).total;

    await runWhoCommand(db, ["rm", "Eric"], false);

    // Deliberately NOT replanning.
    const after = await runPlanCommand(db, "day", ["1"], false);
    const afterPlan = await runPlanCommand(db, "plan", [], false);
    expect(readTotal(lineWith(afterPlan, "Trip total")).total).not.toBe(beforeTotal);
    expect(after).not.toContain("Eric");

    const placedBefore = before.split("\n").filter((l) => /^  \d\d:\d\d /.test(l))
      .map((l) => l.slice(0, 40));
    const placedAfter = afterPlan.split("\n").filter((l) => /^  \d\d:\d\d /.test(l))
      .map((l) => l.slice(0, 40));
    expect(placedAfter).toEqual(placedBefore);
  });

  test("seg ls and trip day never disagree about whether a segment is priced", async () => {
    // The two commands read different tables to answer the same question:
    // seg ls reads price_rules directly, trip day reads a resolved party
    // price. Every segment with rules must resolve to a number, and every
    // segment without must resolve to "?".
    const db = await fixture("agree");
    const ls = await runSegmentsCommand(db, ["ls"], true);
    const segments = JSON.parse(ls).segments as
      { id: number; name: string; priceRules: unknown[] }[];
    const day = await runPlanCommand(db, "day", ["1"], false);

    for (const s of segments) {
      const line = lineWith(day, s.name);
      if (s.priceRules.length > 0) {
        expect(line).toMatch(/CNY \d+|free/);
      } else {
        expect(line).toContain("?");
      }
    }
  });

  test("a free day zeroes a segment on that weekday only", async () => {
    const db = await fresh("freeday");
    await runTripsCommand(db, ["new", "cq"], false);
    await runDatesCommand(db, ["set", "2026-10-02..2026-10-06"], false);
    await runTripsCommand(db, ["set", "--currency=CNY"], false);
    await runWhoCommand(db, ["add", "Eric", "--born=1971-06-02"], false);

    // 2026-10-02 is a Friday; 2026-10-03 a Saturday.
    await runSegmentsCommand(db, ["add", "Museum", "--dur=60m", "--at=29.56,106.58",
      "--price=30", "--free-days=fri"], false);
    await runSegmentsCommand(db, ["add", "Other", "--dur=60m", "--at=29.56,106.58",
      "--price=30", "--free-days=fri"], false);
    await runPlanCommand(db, "plan", [], false);
    await runPlanCommand(db, "pin", ["1", "--day=1"], false);
    await runPlanCommand(db, "pin", ["2", "--day=2"], false);
    await runPlanCommand(db, "replan", [], false);

    const out = await runPlanCommand(db, "plan", [], false);
    expect(readTotal(lineWith(out, "Day 1 total")).total).toBe(0);
    expect(readTotal(lineWith(out, "Day 2 total")).total).toBe(30);
  });

  test("an unpriced segment is never counted as free anywhere", async () => {
    // Asserted across all three surfaces at once, because the failure is a
    // 0 appearing where a ? belongs and it can appear at any one of them.
    const db = await fixture("neverfree");
    const plan = await runPlanCommand(db, "plan", [], false);
    const day = await runPlanCommand(db, "day", ["1"], false);
    const ls = await runSegmentsCommand(db, ["ls"], false);

    expect(lineWith(plan, "Jiefangbei")).toContain("?");
    expect(lineWith(plan, "Jiefangbei")).not.toContain("free");
    expect(lineWith(day, "Jiefangbei")).toContain("?");
    expect(lineWith(ls, "Jiefangbei")).not.toContain("free");
  });

  test("a segment priced for only SOME travellers keeps the breakdown honest", async () => {
    // THE SUBTLE CASE, and the one the mutation sweep found unguarded.
    //
    // At a child-only-priced segment the Kid's fare is perfectly KNOWN while
    // the party total is not. If that segment stayed in the Kid's row but
    // dropped out of the day total, the two would disagree by exactly the
    // Kid's fare -- and every assertion about unknown COUNTS would still
    // pass, because the counts are unchanged. Only the sums diverge.
    const db = await fresh("partialparty");
    await runTripsCommand(db, ["new", "cq"], false);
    await runDatesCommand(db, ["set", "2026-10-02..2026-10-06"], false);
    await runTripsCommand(db, ["set", "--currency=CNY"], false);
    await runWhoCommand(db, ["add", "Eric", "--born=1971-06-02"], false);
    await runWhoCommand(db, ["add", "Kid", "--born=2015-11-20"], false);

    // Everyone matches: party 40.
    await runSegmentsCommand(db, ["add", "Both", "--dur=60m", "--at=29.56,106.58",
      "--price=20"], false);
    // ONLY children are priced: the Kid's 10 is known, Eric matches nothing,
    // so the party total is unknown and the whole segment must drop out.
    await runSegmentsCommand(db, ["add", "KidOnly", "--dur=60m", "--at=29.56,106.58",
      "--price=0-11:10"], false);
    await runPlanCommand(db, "plan", [], false);
    await runPlanCommand(db, "pin", ["1", "--day=1"], false);
    await runPlanCommand(db, "pin", ["2", "--day=1"], false);
    await runPlanCommand(db, "replan", [], false);

    const day = await runPlanCommand(db, "day", ["1"], false);
    const { total, unknown } = readTotal(lineWith(day, "Day 1 total"));
    expect(total).toBe(40);
    expect(unknown).toBe(1);

    const rows = [...day.matchAll(/age \d+\s+(?:CNY )?(\d+|free)\s*$/gm)]
      .map((m) => (m[1] === "free" ? 0 : Number(m[1])));
    expect(rows.length).toBe(2);
    // 20 + 20. NOT 20 + 30: the Kid's known 10 at KidOnly must not appear in
    // a breakdown whose day total excluded that segment.
    expect(rows.reduce((a, b) => a + b, 0)).toBe(40);
  });

  test("a trip with no travellers computes nothing and names the fix", async () => {
    const db = await fresh("noparty");
    await runTripsCommand(db, ["new", "cq"], false);
    await runDatesCommand(db, ["set", "2026-10-02..2026-10-06"], false);
    await runSegmentsCommand(db, ["add", "Museum", "--dur=60m", "--at=29.56,106.58",
      "--price=30"], false);
    const out = await runPlanCommand(db, "plan", [], false);
    expect(out).toContain("No travellers set");
    expect(out).toContain("trip who add");
    expect(out).not.toContain("Trip total");
  });
});

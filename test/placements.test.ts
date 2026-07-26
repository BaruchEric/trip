import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import {
  createTrip, getTripByName, setTripSchedule, setTripDestination,
} from "@/trips";
import { addSegment, listSegments } from "@/segments";
import {
  savePlacements, readPlacements, readPins, setPinned, clearPin,
} from "@/placements";
import { compile } from "@/plan/compile";
import { deriveDays } from "@/days";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-pl-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await createTrip(db, "lisbon", "2026-07-26");
  return db;
}

async function addTwo(db: Awaited<ReturnType<typeof freshDb>>, tripId = 1) {
  const base = {
    latitude: 38.71, longitude: -9.13, dwellMinutes: 60, cost: null,
    tags: [], opensMin: null, closesMin: null, closedDays: [],
  };
  return [
    await addSegment(db, tripId, { ...base, name: "a" }),
    await addSegment(db, tripId, { ...base, name: "b" }),
  ];
}

const place = (segmentId: number, day: number, ordinal: number, startMin: number,
                pinned = false) => ({
  segmentId, day, ordinal, startMin, endMin: startMin + 60, pinned,
});

describe("placements", () => {
  test("placements round-trip", async () => {
    const db = await freshDb("round");
    const [a, b] = await addTwo(db);
    await savePlacements(db, 1, [place(a!, 1, 0, 540), place(b!, 1, 1, 660)]);
    const back = await readPlacements(db, 1);
    expect(back).toHaveLength(2);
    expect(back[0]!.startMin).toBe(540);
    // dwellMinutes is 60 (addTwo's `base`) — endMin must be start + dwell,
    // not start - dwell or a stored/stale copy.
    expect(back[0]!.endMin).toBe(600);
    expect(back[1]!.endMin).toBe(720);
    expect(back[1]!.ordinal).toBe(1);
    expect(back[0]!.pinned).toBe(false);
  });

  test("readPlacements orders by day and ordinal, not insertion order", async () => {
    // The fixture deliberately inserts the day-2 row BEFORE the day-1 row,
    // so a missing ORDER BY can't hide behind "insertion order happened to
    // match" — the same trap M1's readMonths test caught.
    const db = await freshDb("order");
    const [a, b] = await addTwo(db);
    await savePlacements(db, 1, [place(a!, 2, 0, 600), place(b!, 1, 0, 540)]);
    const back = await readPlacements(db, 1);
    expect(back.map((p) => p.segmentId)).toEqual([b!, a!]);
  });

  test("savePlacements writing a pinned element does not clobber the pin", async () => {
    // compile() legitimately includes pinned segments in its output (that is
    // what gives a day-locked pin a real time — see the migration-5 tests
    // below). This is the property that actually matters once savePlacements
    // stopped filtering pinned rows out: it may overwrite the compiled
    // columns, but must never touch the user's assertion.
    const db = await freshDb("pinned-in-batch");
    const [a] = await addTwo(db);
    await setPinned(db, a!, 2, 780);
    await savePlacements(db, 1, [place(a!, 2, 0, 800, true)]);

    const placed = await readPlacements(db, 1);
    const row = placed.find((p) => p.segmentId === a!)!;
    expect(row.startMin).toBe(800);
    expect(row.pinned).toBe(true);
    expect(await readPins(db, 1)).toEqual([{ segmentId: a!, day: 2, startMin: 780 }]);
  });

  test("saving replaces the previous plan rather than appending", async () => {
    const db = await freshDb("replace");
    const [a] = await addTwo(db);
    await savePlacements(db, 1, [place(a!, 1, 0, 540)]);
    await savePlacements(db, 1, [place(a!, 2, 0, 600)]);
    const back = await readPlacements(db, 1);
    expect(back).toHaveLength(1);
    expect(back[0]!.day).toBe(2);
  });

  test("a pin survives a save that does not mention it", async () => {
    // replan discards placements and rebuilds. If that wiped pins, the one
    // guarantee `pin` makes would be worthless.
    const db = await freshDb("pins");
    const [a, b] = await addTwo(db);
    await setPinned(db, a!, 3, 780);
    await savePlacements(db, 1, [place(b!, 1, 0, 540)]);

    const pins = await readPins(db, 1);
    expect(pins).toEqual([{ segmentId: a!, day: 3, startMin: 780 }]);
  });

  test("a day-locked pin round-trips with a null time", async () => {
    const db = await freshDb("daylock");
    const [a] = await addTwo(db);
    await setPinned(db, a!, 2, null);
    expect(await readPins(db, 1)).toEqual([{ segmentId: a!, day: 2, startMin: null }]);
  });

  test("re-pinning a segment resets its stale ordinal from a prior plan", async () => {
    // `a` gets ordinal 1 from an ordinary plan, before it is ever pinned.
    // Pinning it afterward must not leave that ordinal sitting there —
    // ordinal belongs to savePlacements/compile(), and a fresh pin has no
    // opinion on it until the next plan assigns a real one.
    const db = await freshDb("repin-ordinal");
    const [a, b] = await addTwo(db);
    await savePlacements(db, 1, [place(b!, 1, 0, 540), place(a!, 1, 1, 600)]);
    await setPinned(db, a!, 2, 700);

    const placed = await readPlacements(db, 1);
    const row = placed.find((p) => p.segmentId === a!)!;
    expect(row.ordinal).toBe(0);
  });

  test("clearPin reports whether it removed anything", async () => {
    const db = await freshDb("unpin");
    const [a] = await addTwo(db);
    await setPinned(db, a!, 2, 600);
    expect(await clearPin(db, a!)).toBe(true);
    expect(await clearPin(db, a!)).toBe(false);
    expect(await readPins(db, 1)).toEqual([]);
  });

  test("placements are scoped to their trip on read", async () => {
    const db = await freshDb("scope");
    const [a] = await addTwo(db);
    await createTrip(db, "tokyo", "2026-07-26");
    await savePlacements(db, 1, [place(a!, 1, 0, 540)]);
    expect(await readPlacements(db, 2)).toHaveLength(0);
  });

  test("saving one trip's placements does not touch another trip's", async () => {
    // The delete in savePlacements has no trip_id column to filter on — it
    // must reach the right rows only through the segments join. A missing
    // scope here would silently wipe another trip's unpinned plan, same bug
    // class Task 2 found in removeSegment.
    const db = await freshDb("cross");
    const [a] = await addTwo(db, 1);
    await createTrip(db, "tokyo", "2026-07-26");
    const [c] = await addTwo(db, 2);

    await savePlacements(db, 1, [place(a!, 1, 0, 540)]);
    await savePlacements(db, 2, [place(c!, 1, 0, 600)]);
    // Re-saving trip 2's plan must not disturb trip 1's rows.
    await savePlacements(db, 2, [place(c!, 1, 0, 660)]);

    const tripOne = await readPlacements(db, 1);
    expect(tripOne).toHaveLength(1);
    expect(tripOne[0]!.segmentId).toBe(a!);
  });
});

describe("day-locked pins across replan (migration 5)", () => {
  // Reported crash: `trip plan` -> `trip move <seg> --to=day1` (a day-locked
  // pin, startMin null) -> `trip replan` threw SQLITE_CONSTRAINT. compile()
  // only marks a *timed* pin `pinned: true` at Stage 1; a day-locked segment
  // runs through orderDay like any free segment and comes back
  // `pinned: false`. The old savePlacements filtered `!p.pinned` and did a
  // plain INSERT, which collided with setPinned's still-pinned row on the
  // segment_id primary key. Migration 5 splits the assertion
  // (pin_start_minutes) from the compiled result (start_minutes) and
  // savePlacements upserts every compiled placement, so this must be a
  // no-op even when compile()'s `pinned` flag disagrees with the DB's.
  const SCHEDULE = {
    startDate: "2027-05-08", endDate: "2027-05-10",
    arrivalMin: null, departureMin: null, dayStartMin: 540, dayEndMin: 1140,
  };

  async function replan(db: Awaited<ReturnType<typeof freshDb>>, tripId: number) {
    const days = deriveDays(SCHEDULE);
    const segments = await listSegments(db, tripId);
    const pins = await readPins(db, tripId);
    const result = compile(segments, days, { mode: "walking", pace: "normal", pins });
    await savePlacements(db, tripId, result.placements);
    return result;
  }

  test("move (day-lock) then replan succeeds and gives the segment a real time", async () => {
    const db = await freshDb("daylock-replan");
    await setTripSchedule(db, 1, SCHEDULE);
    const [a] = await addTwo(db);
    await replan(db, 1);              // trip plan
    await setPinned(db, a!, 1, null); // trip move a --to=day1
    await replan(db, 1);              // trip replan: must not throw

    const placed = await readPlacements(db, 1);
    const row = placed.find((p) => p.segmentId === a!)!;
    expect(row.day).toBe(1);
    expect(row.startMin).toBeGreaterThan(0);
    expect(row.pinned).toBe(true);
  });

  test("a day-lock made before any plan exists still gets a real compiled time", async () => {
    // Same defect as above, tightened so the assertion cannot pass on a
    // stale value by coincidence. `setPinned` alone creates the placements
    // row (pinned = 1, start_minutes NULL — no plan has run yet), so if
    // `savePlacements` ever fails to write the compiled time on conflict,
    // `start_minutes` stays NULL and reads back as 0. A prior successful
    // plan for this same segment could leave a stale non-zero value that
    // happens to match the fresh one (deterministic layouts can repeat),
    // which is exactly the gap this variant closes.
    const db = await freshDb("daylock-fresh");
    await setTripSchedule(db, 1, SCHEDULE);
    const [a] = await addTwo(db);
    await setPinned(db, a!, 1, null); // trip move a --to=day1, before any plan
    await replan(db, 1);

    const placed = await readPlacements(db, 1);
    const row = placed.find((p) => p.segmentId === a!)!;
    expect(row.day).toBe(1);
    expect(row.startMin).not.toBe(0);
    expect(row.pinned).toBe(true);
  });

  test("a day-locked pin stays day-locked across two consecutive replans", async () => {
    // If savePlacements ever wrote the compiled time into pin_start_minutes,
    // the second replan would silently promote a day-lock into a time-lock.
    const db = await freshDb("daylock-twice");
    await setTripSchedule(db, 1, SCHEDULE);
    const [a] = await addTwo(db);
    await replan(db, 1);
    await setPinned(db, a!, 2, null);
    await replan(db, 1);
    await replan(db, 1);

    expect(await readPins(db, 1)).toEqual([{ segmentId: a!, day: 2, startMin: null }]);
  });

  test("a timed pin still lands at exactly its asserted time after replan", async () => {
    const db = await freshDb("timed-replan");
    await setTripSchedule(db, 1, SCHEDULE);
    const [a] = await addTwo(db);
    await setPinned(db, a!, 1, 600);
    await replan(db, 1);

    const placed = await readPlacements(db, 1);
    const row = placed.find((p) => p.segmentId === a!)!;
    expect(row.day).toBe(1);
    expect(row.startMin).toBe(600);
    expect(row.pinned).toBe(true);
    expect(await readPins(db, 1)).toEqual([{ segmentId: a!, day: 1, startMin: 600 }]);
  });
});

describe("trip schedule fields", () => {
  test("schedule round-trips with defaults for the day window", async () => {
    const db = await freshDb("sched");
    const before = await getTripByName(db, "lisbon");
    expect(before!.dayStartMin).toBe(540);
    expect(before!.dayEndMin).toBe(1140);
    expect(before!.arrivalMin).toBeNull();

    await setTripSchedule(db, 1, {
      startDate: "2027-05-08", endDate: "2027-05-16",
      arrivalMin: 930, departureMin: 660,
      dayStartMin: 540, dayEndMin: 1140,
    });
    const after = await getTripByName(db, "lisbon");
    expect(after!.startDate).toBe("2027-05-08");
    expect(after!.arrivalMin).toBe(930);
    expect(after!.departureMin).toBe(660);
  });

  test("a null arrival stays null rather than becoming midnight", async () => {
    // M2-3: no arrival means "assume a full day", not "landed at 00:00".
    const db = await freshDb("nullarr");
    await setTripSchedule(db, 1, {
      startDate: "2027-05-08", endDate: "2027-05-16",
      arrivalMin: null, departureMin: null,
      dayStartMin: 540, dayEndMin: 1140,
    });
    const t = await getTripByName(db, "lisbon");
    expect(t!.arrivalMin).toBeNull();
    expect(t!.departureMin).toBeNull();
  });

  test("setTripDestination round-trips the destination id", async () => {
    const db = await freshDb("dest");
    await db.execute({
      sql: `INSERT INTO destinations (name, country_code, latitude, longitude)
            VALUES (?, ?, ?, ?)`,
      args: ["Lisbon", "PT", 38.71, -9.13],
    });
    await setTripDestination(db, 1, 1);
    const t = await getTripByName(db, "lisbon");
    expect(t!.destinationId).toBe(1);
  });
});

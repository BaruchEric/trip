import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import {
  createTrip, getTripByName, setTripSchedule, setTripDestination,
} from "@/trips";
import { addSegment } from "@/segments";
import {
  savePlacements, readPlacements, readPins, setPinned, clearPin,
} from "@/placements";
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
    expect(back[1]!.ordinal).toBe(1);
    expect(back[0]!.pinned).toBe(false);
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

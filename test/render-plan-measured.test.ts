import { test, expect, describe } from "bun:test";
import { run } from "@/cli";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip, setTripSchedule } from "@/trips";
import { addSegment } from "@/segments";
import { saveLeg } from "@/legs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const TESTBED = { lat: 29.5537638, lon: 106.5368476 };
const LIZIBA = { lat: 29.5556826, lon: 106.5338753 };

async function tripDb(tag: string) {
  const path = join(tmpdir(), `trip-m8-render-${tag}-${process.pid}.db`);
  rmSync(path, { force: true });
  const db = openDb(path);
  await migrate(db);
  const trip = await createTrip(db, "chongqing", "2026-07-27");
  await setActiveTrip(db, "chongqing");
  await setTripSchedule(db, trip.id, {
    startDate: "2026-09-01", endDate: "2026-09-01",
    arrivalMin: null, departureMin: null,
    dayStartMin: 9 * 60, dayEndMin: 20 * 60,
  });
  for (const [name, p] of [["Testbed 2", TESTBED], ["Liziba", LIZIBA]] as const) {
    await addSegment(db, trip.id, {
      name, latitude: p.lat, longitude: p.lon, dwellMinutes: 60, tags: [],
      opensMin: null, closesMin: null, closedDays: [], freeDays: [],
    });
  }
  return { db, path };
}

const OSRM_LEG = {
  fromLat: TESTBED.lat, fromLon: TESTBED.lon,
  toLat: LIZIBA.lat, toLon: LIZIBA.lon,
  mode: "walking", source: "osrm-foot",
  minutes: 22.2, meters: 1670, fetchedAt: "2026-07-27T12:00:00Z",
};

/** BOTH directions, which is what `trip route` stores. Saving only one and
 *  asserting on the plan bakes in whichever order the compiler happens to
 *  choose -- and it chose the other one, which is how this helper came to
 *  exist. Directedness is asserted deliberately in its own test below. */
const BOTH_WAYS = [
  OSRM_LEG,
  {
    ...OSRM_LEG,
    fromLat: LIZIBA.lat, fromLon: LIZIBA.lon,
    toLat: TESTBED.lat, toLon: TESTBED.lon,
  },
];

describe("the plan distinguishes measured hops from estimated ones", () => {
  test("with no legs, the hop reads estimated", async () => {
    const { path } = await tripDb("none");
    const r = await run(["plan"], { dbPath: path });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("(estimated)");
    expect(r.stdout).not.toContain("(measured)");
    // The model's own number for 360 m.
    expect(r.stdout).toContain("6 min walk");
  });

  test("with a leg, that hop reads measured AND uses its number", async () => {
    const { db, path } = await tripDb("some");
    for (const l of BOTH_WAYS) await saveLeg(db, l);
    const r = await run(["plan"], { dbPath: path });
    expect(r.stdout).toContain("(measured)");
    expect(r.stdout).toContain("22 min walk");
    expect(r.stdout).not.toContain("6 min walk");
  });

  test("the FIRST stop of a day has no hop line -- there is nothing to describe", async () => {
    const { path } = await tripDb("first");
    const r = await run(["plan"], { dbPath: path });
    // Two segments, so exactly one hop between them.
    expect(r.stdout.split("min walk").length - 1).toBe(1);
  });

  test("--json carries measured as a BOOLEAN, never a string", async () => {
    const { db, path } = await tripDb("json");
    for (const l of BOTH_WAYS) await saveLeg(db, l);
    const r = await run(["plan", "--json"], { dbPath: path });
    const raw = r.stdout;
    expect(raw).toContain('"measured":true');
    expect(raw).not.toContain('"measured":"true"');
    const j = JSON.parse(raw);
    const stops = j.days[0].placements;
    expect(stops[0].arriveBy).toBeNull();
    expect(stops[1].arriveBy.minutes).toBe(22);
    expect(stops[1].arriveBy.measured).toBe(true);
  });

  test("--json without any leg says measured false rather than omitting it", async () => {
    // An absent field would make the agent infer from silence, which is the
    // thing M2-2 exists to prevent.
    const { path } = await tripDb("jsonnone");
    const r = await run(["plan", "--json"], { dbPath: path });
    const j = JSON.parse(r.stdout);
    expect(j.days[0].placements[1].arriveBy.measured).toBe(false);
  });

  test("transit finds no legs and every hop stays estimated", async () => {
    const { db, path } = await tripDb("transit");
    for (const l of BOTH_WAYS) await saveLeg(db, l);
    const r = await run(["plan", "--mode=transit"], { dbPath: path });
    expect(r.stdout).not.toContain("(measured)");
    expect(r.stdout).toContain("(estimated)");
    expect(r.stdout).toContain("min transit");
  });

  test("the reverse leg alone does not make the forward hop measured", async () => {
    const { db, path } = await tripDb("reverse");
    await saveLeg(db, {
      ...OSRM_LEG,
      fromLat: LIZIBA.lat, fromLon: LIZIBA.lon,
      toLat: TESTBED.lat, toLon: TESTBED.lon,
      minutes: 32.1,
    });
    const r = await run(["plan"], { dbPath: path });
    // Two things happen here, and the second is the more interesting one.
    //
    // 1. Only Liziba -> Testbed 2 was measured, at 32 minutes.
    // 2. So the ORDERING search prices that direction at 32 and the other at
    //    the model's 6, and picks Testbed 2 -> Liziba. The hop the plan
    //    actually takes is therefore the unmeasured one, and says so.
    //
    // Under an unordered-pair design step 1 would have answered both
    // directions with 32, and this would read "32 min walk (measured)".
    expect(r.stdout).toContain("Testbed 2");
    expect(r.stdout).toContain("(estimated)");
    expect(r.stdout).not.toContain("32 min");
    expect(r.stdout).not.toContain("(measured)");
  });
});

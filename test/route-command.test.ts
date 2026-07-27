import { test, expect, describe } from "bun:test";
import { runRouteCommand } from "@/commands/route";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip } from "@/trips";
import { addSegment } from "@/segments";
import { listLegs, countLegs } from "@/legs";
import { run } from "@/cli";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const PTS: [string, number, number][] = [
  ["Testbed 2", 29.5537638, 106.5368476],
  ["Liziba", 29.5556826, 106.5338753],
];

async function tripWith(tag: string, pts: [string, number, number][]) {
  const path = join(tmpdir(), `trip-m8-route-${tag}-${process.pid}.db`);
  rmSync(path, { force: true });
  const db = openDb(path);
  await migrate(db);
  const trip = await createTrip(db, "chongqing", "2026-07-27");
  await setActiveTrip(db, "chongqing");
  for (const [name, latitude, longitude] of pts) {
    await addSegment(db, trip.id, {
      name, latitude, longitude, dwellMinutes: 60, tags: [],
      opensMin: null, closesMin: null, closedDays: [], freeDays: [],
    });
  }
  return { db, path, id: trip.id };
}

const DEPS = {
  osrm: async () => ({ minutes: 22.2, meters: 1670 }),
  valhalla: async () => ({ minutes: 23.4, meters: 1783 }),
  sleepFn: async () => {},
  now: () => "2026-07-27T12:00:00Z",
};

describe("trip route", () => {
  test("stores both directions and both sources", async () => {
    const { db } = await tripWith("both", PTS);
    await runRouteCommand(db, [], false, DEPS);
    // 2 segments -> 2 DIRECTED pairs -> x2 sources = 4 rows. Under an
    // unordered-pair design this would be 2, and the uphill leg would be a
    // guess wearing a measurement's clothes.
    expect(await countLegs(db)).toBe(4);
  });

  test("a second run refetches nothing", async () => {
    const { db } = await tripWith("cache", PTS);
    let calls = 0;
    const counting = {
      ...DEPS,
      osrm: async () => { calls++; return { minutes: 22.2, meters: 1670 }; },
    };
    await runRouteCommand(db, [], false, counting);
    const first = calls;
    const out = await runRouteCommand(db, [], false, counting);
    expect(calls).toBe(first);
    expect(out).toMatch(/cached/i);
  });

  test("--refresh refetches", async () => {
    const { db } = await tripWith("refresh", PTS);
    let calls = 0;
    const counting = {
      ...DEPS,
      osrm: async () => { calls++; return { minutes: 22.2, meters: 1670 }; },
    };
    await runRouteCommand(db, [], false, counting);
    const first = calls;
    await runRouteCommand(db, ["--refresh"], false, counting);
    expect(calls).toBeGreaterThan(first);
  });

  test("a failed source stores NOTHING and does not block the other", async () => {
    // Absence is loud: a timed-out router must not contribute a zero, a
    // fallback, or a partial row.
    const { db } = await tripWith("fail", PTS);
    const out = await runRouteCommand(db, [], false, {
      ...DEPS,
      valhalla: async () => { throw new Error("Valhalla timed out after 15000ms"); },
    });
    const legs = await listLegs(db);
    expect(legs).toHaveLength(2);
    expect(legs.every((l) => l.source === "osrm-foot")).toBe(true);
    expect(out).toMatch(/valhalla/i);
    expect(out).toMatch(/timed out/i);
  });

  test("reports the size of the job before doing it", async () => {
    const { db } = await tripWith("size", PTS);
    const out = await runRouteCommand(db, [], false, DEPS);
    expect(out).toMatch(/4 requests/);
  });

  test("names the widest disagreement", async () => {
    const { db } = await tripWith("spread", PTS);
    const out = await runRouteCommand(db, [], false, {
      ...DEPS, valhalla: async () => ({ minutes: 47.3, meters: 1783 }),
    });
    expect(out).toMatch(/disagree/i);
    expect(out).toContain("25");
    // Both are kept. The report is a reading of the data, not a replacement.
    expect(await countLegs(db)).toBe(4);
  });

  test("a segment with no coordinates is skipped, and says so", async () => {
    const { db, id } = await tripWith("nocoord", PTS);
    await addSegment(db, id, {
      name: "Wulong Karst", latitude: null, longitude: null, dwellMinutes: 60,
      tags: [], opensMin: null, closesMin: null, closedDays: [], freeDays: [],
    });
    const out = await runRouteCommand(db, [], false, DEPS);
    expect(out).toMatch(/Wulong Karst/);
    expect(out).toMatch(/no coordinates/i);
    // Still 4: the unplaced segment contributes no pairs at all.
    expect(await countLegs(db)).toBe(4);
  });

  test("fewer than two placed segments is an error naming the fix", async () => {
    const { db } = await tripWith("one", [PTS[0]!]);
    await expect(runRouteCommand(db, [], false, DEPS)).rejects.toThrow(/two/i);
  });

  test("--json carries BOTH sources per directed pair", async () => {
    const { db } = await tripWith("json", PTS);
    const out = await runRouteCommand(db, [], true, DEPS);
    const j = JSON.parse(out);
    expect(j.legs).toHaveLength(4);
    expect(new Set(j.legs.map((l: { source: string }) => l.source)))
      .toEqual(new Set(["osrm-foot", "valhalla-pedestrian"]));
    // The disagreement survives export -- a midpoint here would erase it.
    expect(j.legs.some((l: { minutes: number }) => l.minutes === 22.2)).toBe(true);
    expect(j.legs.some((l: { minutes: number }) => l.minutes === 23.4)).toBe(true);
  });

  test("stores what the router actually said, unrounded", async () => {
    const { db } = await tripWith("unrounded", PTS);
    await runRouteCommand(db, [], false, DEPS);
    expect((await listLegs(db)).some((l) => l.minutes === 23.4)).toBe(true);
  });
});

describe("trip route flag validation", () => {
  const dbFor = (tag: string) => {
    const p = join(tmpdir(), `trip-m8-flags-${tag}-${process.pid}.db`);
    rmSync(p, { force: true });
    return p;
  };

  test("rejects a flag belonging to another command", async () => {
    const r = await run(["route", "--pick=1"], { dbPath: dbFor("pick") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag for `trip route`");
  });

  test("rejects --refresh given as a value flag", async () => {
    const r = await run(["route", "--refresh=yes"], { dbPath: dbFor("val") });
    expect(r.code).toBe(1);
  });

  test("--help describes the command, not the whole CLI", async () => {
    const r = await run(["route", "--help"], { dbPath: dbFor("help") });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("trip route");
    expect(r.stdout).toMatch(/network/i);
    expect(r.stdout).toMatch(/directed/i);
  });
});

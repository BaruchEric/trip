import { test, expect, describe } from "bun:test";
import { run } from "@/cli";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip } from "@/trips";
import { saveLeg } from "@/legs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const TESTBED = { lat: 29.5537638, lon: 106.5368476 };
const LIZIBA = { lat: 29.5556826, lon: 106.5338753 };

async function tripDb(tag: string) {
  const path = join(tmpdir(), `trip-m9-cal-${tag}-${process.pid}.db`);
  rmSync(path, { force: true });
  const db = openDb(path);
  await migrate(db);
  await createTrip(db, "chongqing", "2026-07-27");
  await setActiveTrip(db, "chongqing");
  return { db, path };
}

const legFor = (minutes: number, source: string) => ({
  fromLat: TESTBED.lat, fromLon: TESTBED.lon,
  toLat: LIZIBA.lat, toLon: LIZIBA.lon,
  mode: "walking", source, minutes, meters: 1670,
  fetchedAt: "2026-07-27T12:00:00Z",
});

describe("trip calibrate", () => {
  test("with no legs it says UNKNOWN and names the fix", async () => {
    const { path } = await tripDb("empty");
    const r = await run(["calibrate"], { dbPath: path });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/unknown/i);
    expect(r.stdout).toContain("trip route");
    // The failure this guards: an empty table reading 100% would say the
    // model agrees perfectly here.
    expect(r.stdout).not.toContain("100%");
  });

  test("a stored leg produces a percentage and the worst line", async () => {
    const { db, path } = await tripDb("one");
    await saveLeg(db, legFor(22.2, "osrm-foot"));
    const r = await run(["calibrate"], { dbPath: path });
    // Model says 6 for 360 m; 6/22.2 = 27%.
    expect(r.stdout).toContain("27%");
    expect(r.stdout).toMatch(/worst/i);
    expect(r.stdout).toContain("6 min");
  });

  test("an empty band renders a dash, not a percentage", async () => {
    const { db, path } = await tripDb("band");
    await saveLeg(db, legFor(22.2, "osrm-foot"));
    const r = await run(["calibrate"], { dbPath: path });
    const long = r.stdout.split("\n").find((l) => l.includes("2 km and over"))!;
    expect(long).toContain("-");
    expect(long).not.toMatch(/\d%/);
  });

  test("with both routers it reconciles itself against the schedule", async () => {
    // A user comparing this against a plan and finding a mismatch must not
    // conclude one of the two is broken.
    const { db, path } = await tripDb("both");
    await saveLeg(db, legFor(20, "osrm-foot"));
    await saveLeg(db, legFor(30, "valhalla-pedestrian"));
    const r = await run(["calibrate"], { dbPath: path });
    expect(r.stdout).toMatch(/midpoint/i);
    expect(r.stdout).toMatch(/slower/i);
    // 6/25 = 24%, the midpoint -- not 6/30 = 20%, which the schedule implies.
    expect(r.stdout).toContain("24%");
    expect(r.stdout).not.toContain("20%");
  });

  test("--json carries medianRatio as a NUMBER or null, never a string", async () => {
    const { db, path } = await tripDb("json");
    await saveLeg(db, legFor(22.2, "osrm-foot"));
    const r = await run(["calibrate", "--json"], { dbPath: path });
    const j = JSON.parse(r.stdout);
    expect(typeof j.bands[0].medianRatio).toBe("number");
    expect(j.bands[1].medianRatio).toBeNull();
    expect(r.stdout).not.toMatch(/"medianRatio":"/);
    // The two questions, stated as data rather than left in prose.
    expect(j.comparedAgainst).toBe("router-midpoint");
    expect(j.scheduleReads).toBe("router-maximum");
  });

  test("--json with no legs still reports the mode and a zero count", async () => {
    const { path } = await tripDb("jsonempty");
    const j = JSON.parse((await run(["calibrate", "--json"], { dbPath: path })).stdout);
    expect(j.legCount).toBe(0);
    expect(j.worst).toBeNull();
    expect(j.mode).toBe("walking");
  });

  test("a transit trip finds no walking legs and says so", async () => {
    const { db, path } = await tripDb("transit");
    await saveLeg(db, legFor(22.2, "osrm-foot"));
    await run(["set", "--mode=transit"], { dbPath: path });
    const r = await run(["calibrate"], { dbPath: path });
    expect(r.stdout).toMatch(/unknown/i);
    expect(r.stdout).toContain("transit");
  });
});

describe("trip calibrate flag validation", () => {
  const dbFor = (tag: string) => {
    const p = join(tmpdir(), `trip-m9-calflag-${tag}-${process.pid}.db`);
    rmSync(p, { force: true });
    return p;
  };

  test("rejects a flag belonging to another command", async () => {
    const r = await run(["calibrate", "--refresh"], { dbPath: dbFor("refresh") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag for `trip calibrate`");
  });

  test("rejects --mode, which belongs to plan", async () => {
    // Deliberately not accepted: calibrate reports on the mode the plan is
    // actually compiled with, so asking about another one would answer a
    // question about a plan that does not exist.
    const r = await run(["calibrate", "--mode=transit"], { dbPath: dbFor("mode") });
    expect(r.code).toBe(1);
  });

  test("--help describes this command", async () => {
    const r = await run(["calibrate", "--help"], { dbPath: dbFor("help") });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("trip calibrate");
    expect(r.stdout).toMatch(/offline/i);
    expect(r.stdout).toMatch(/midpoint/i);
  });
});

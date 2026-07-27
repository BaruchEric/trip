import { test, expect, describe } from "bun:test";
import { openDb, migrate, schemaVersion } from "@/db";
import { saveLeg, listLegs, countLegs, clearLegs, roundCoord, legKey } from "@/legs";
import type { MeasuredLeg } from "@/legs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-m8-legs-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  return db;
}

const LEG: MeasuredLeg = {
  fromLat: 29.5537638, fromLon: 106.5368476,
  toLat: 29.5556826, toLon: 106.5338753,
  mode: "walking", source: "osrm-foot",
  minutes: 22.2, meters: 1670, fetchedAt: "2026-07-27T12:00:00Z",
};

describe("route_legs", () => {
  test("migration 12 creates the table", async () => {
    const db = await freshDb("mig");
    expect(await schemaVersion(db)).toBeGreaterThanOrEqual(12);
    expect(await countLegs(db)).toBe(0);
  });

  test("a saved leg round-trips with its coordinates rounded to 5dp", async () => {
    const db = await freshDb("round");
    await saveLeg(db, LEG);
    const [got] = await listLegs(db);
    // Stored ROUNDED so the key is stable against float formatting; 5dp is
    // ~1.1 m, far below the distance between two distinct POIs.
    expect(got!.fromLat).toBe(29.55376);
    expect(got!.toLon).toBe(106.53388);
    expect(got!.minutes).toBe(22.2);
    expect(got!.source).toBe("osrm-foot");
  });

  test("legs are DIRECTED -- the reverse is a different row", async () => {
    // The recon measured Valhalla at 23.4 min one way and 32.1 the other for
    // exactly this pair. One row per unordered pair would lose the uphill leg.
    const db = await freshDb("directed");
    await saveLeg(db, { ...LEG, source: "valhalla-pedestrian", minutes: 23.4 });
    await saveLeg(db, {
      ...LEG, source: "valhalla-pedestrian", minutes: 32.1,
      fromLat: LEG.toLat, fromLon: LEG.toLon, toLat: LEG.fromLat, toLon: LEG.fromLon,
    });
    expect(await countLegs(db)).toBe(2);
  });

  test("the two sources coexist -- one is never merged into the other", async () => {
    const db = await freshDb("sources");
    await saveLeg(db, LEG);
    await saveLeg(db, { ...LEG, source: "valhalla-pedestrian", minutes: 23.4 });
    expect(await countLegs(db)).toBe(2);
    expect((await listLegs(db)).map((l) => l.minutes).sort()).toEqual([22.2, 23.4]);
  });

  test("re-saving the same key REPLACES rather than duplicating", async () => {
    const db = await freshDb("replace");
    await saveLeg(db, LEG);
    await saveLeg(db, { ...LEG, minutes: 25.0, fetchedAt: "2026-07-28T00:00:00Z" });
    expect(await countLegs(db)).toBe(1);
    expect((await listLegs(db))[0]!.minutes).toBe(25);
  });

  test("clearLegs empties the table", async () => {
    const db = await freshDb("clear");
    await saveLeg(db, LEG);
    await clearLegs(db);
    expect(await countLegs(db)).toBe(0);
  });

  test("roundCoord keeps a real zero rather than dropping it", () => {
    // 0 is a real coordinate -- the Gulf of Guinea is not "no longitude".
    expect(roundCoord(0)).toBe(0);
    expect(roundCoord(106.5368476)).toBe(106.53685);
    expect(roundCoord(-29.5537638)).toBe(-29.55376);
  });

  test("legKey is DIRECTED and mode-scoped", () => {
    const there = legKey(1, 2, 3, 4, "walking");
    expect(legKey(3, 4, 1, 2, "walking")).not.toBe(there);
    expect(legKey(1, 2, 3, 4, "transit")).not.toBe(there);
  });
});

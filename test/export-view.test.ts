import { test, expect, describe } from "bun:test";
import { buildExportView } from "@/export/view";
import { run } from "@/cli";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip, setTripSchedule } from "@/trips";
import { addSegment } from "@/segments";
import { addTraveller } from "@/travellers";
import { saveLeg } from "@/legs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const HONGYA = { lat: 29.5650738, lon: 106.5753425 };
const LUOHAN = { lat: 29.5625664, lon: 106.5778425 };
const TESTBED = { lat: 29.5537638, lon: 106.5368476 };

async function tripDb(tag: string, endDate = "2026-09-02") {
  const path = join(tmpdir(), `trip-m10-view-${tag}-${process.pid}.db`);
  rmSync(path, { force: true });
  const db = openDb(path);
  await migrate(db);
  const trip = await createTrip(db, "chongqing", "2026-07-27");
  await setActiveTrip(db, "chongqing");
  await setTripSchedule(db, trip.id, {
    startDate: "2026-09-01", endDate,
    arrivalMin: null, departureMin: null,
    dayStartMin: 9 * 60, dayEndMin: 19 * 60,
  });
  return { db, path, tripId: trip.id };
}

const base = {
  dwellMinutes: 60, tags: [], opensMin: null, closesMin: null,
  closedDays: [], freeDays: [],
};

describe("buildExportView", () => {
  test("with nothing planned it errors and names trip plan", async () => {
    const { db, tripId } = await tripDb("empty");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await expect(buildExportView(db)).rejects.toThrow(/trip plan/);
  });

  test("reads STORED placements and does NOT re-plan", async () => {
    // An export that silently re-plans hands the user an itinerary they never
    // approved. Plan once, then add a segment WITHOUT replanning: the view
    // must still show the stored two, and the newcomer must appear as
    // unplaced rather than being quietly scheduled.
    const { db, path, tripId } = await tripDb("stored");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await addSegment(db, tripId, { ...base, name: "Luohan Temple",
      latitude: LUOHAN.lat, longitude: LUOHAN.lon });
    await run(["plan"], { dbPath: path });

    await addSegment(db, tripId, { ...base, name: "Testbed 2",
      latitude: TESTBED.lat, longitude: TESTBED.lon });

    const v = await buildExportView(db);
    const names = v.days.flatMap((d) => d.stops.map((s) => s.name));
    expect(names).not.toContain("Testbed 2");
    expect(v.unplaced.map((u) => u.name)).toContain("Testbed 2");
  });

  test("a segment with no coordinates is unplaced, with the reason", async () => {
    const { db, path, tripId } = await tripDb("nocoord");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await addSegment(db, tripId, { ...base, name: "Wulong Karst",
      latitude: null, longitude: null });
    await run(["plan"], { dbPath: path });
    const v = await buildExportView(db);
    expect(v.unplaced).toHaveLength(1);
    expect(v.unplaced[0]!.name).toBe("Wulong Karst");
    expect(v.unplaced[0]!.reason).toMatch(/no coordinates/);
  });

  test("hoursKnown is false for a segment whose hours are unknown", async () => {
    const { db, path, tripId } = await tripDb("hours");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await addSegment(db, tripId, { ...base, name: "Luohan Temple",
      latitude: LUOHAN.lat, longitude: LUOHAN.lon,
      opensMin: 8 * 60, closesMin: 18 * 60 });
    await run(["plan"], { dbPath: path });
    const v = await buildExportView(db);
    const stops = v.days.flatMap((d) => d.stops);
    expect(stops.find((s) => s.name === "Hongya Cave")!.hoursKnown).toBe(false);
    expect(stops.find((s) => s.name === "Luohan Temple")!.hoursKnown).toBe(true);
  });

  test("price null is UNKNOWN and price 0 is free", async () => {
    // The M5 distinction, carried into every export format.
    const { db, path, tripId } = await tripDb("price");
    await addTraveller(db, tripId, "eric", "1985-04-12");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await addSegment(db, tripId, { ...base, name: "Luohan Temple",
      latitude: LUOHAN.lat, longitude: LUOHAN.lon });
    await run(["seg", "price", "2", "--price=0"], { dbPath: path });
    await run(["plan"], { dbPath: path });
    const v = await buildExportView(db);
    const stops = v.days.flatMap((d) => d.stops);
    expect(stops.find((s) => s.name === "Hongya Cave")!.price).toBeNull();
    expect(stops.find((s) => s.name === "Luohan Temple")!.price).toBe(0);
  });

  test("arriveBy is null for the first stop of each day", async () => {
    const { db, path, tripId } = await tripDb("first", "2026-09-01");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await addSegment(db, tripId, { ...base, name: "Luohan Temple",
      latitude: LUOHAN.lat, longitude: LUOHAN.lon });
    await run(["plan"], { dbPath: path });
    const v = await buildExportView(db);
    for (const d of v.days) {
      if (d.stops.length === 0) continue;
      expect(d.stops[0]!.arriveBy).toBeNull();
      for (const s of d.stops.slice(1)) expect(s.arriveBy).not.toBeNull();
    }
  });

  test("arriveBy says measured only once a leg exists for that direction", async () => {
    // ONE day, so the two segments share it and there is a hop between them.
    const { db, path, tripId } = await tripDb("measured", "2026-09-01");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await addSegment(db, tripId, { ...base, name: "Luohan Temple",
      latitude: LUOHAN.lat, longitude: LUOHAN.lon });
    await run(["plan"], { dbPath: path });

    const before = await buildExportView(db);
    const hopBefore = before.days.flatMap((d) => d.stops).find((s) => s.arriveBy)!;
    expect(hopBefore.arriveBy!.basis).not.toBe("measured");

    for (const [f, t] of [[HONGYA, LUOHAN], [LUOHAN, HONGYA]] as const) {
      await saveLeg(db, {
        fromLat: f.lat, fromLon: f.lon, toLat: t.lat, toLon: t.lon,
        mode: "walking", source: "osrm-foot", minutes: 9, meters: 620,
        fetchedAt: "2026-07-27T12:00:00Z",
      });
    }
    const after = await buildExportView(db);
    const hopAfter = after.days.flatMap((d) => d.stops).find((s) => s.arriveBy)!;
    expect(hopAfter.arriveBy!.basis).toBe("measured");
    expect(hopAfter.arriveBy!.minutes).toBe(9);
  });

  test("calibration is null with no legs, and present with them", async () => {
    // null is UNKNOWN, not "the model agrees here".
    const { db, path, tripId } = await tripDb("cal");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await addSegment(db, tripId, { ...base, name: "Luohan Temple",
      latitude: LUOHAN.lat, longitude: LUOHAN.lon });
    await run(["plan"], { dbPath: path });
    expect((await buildExportView(db)).calibration).toBeNull();

    await saveLeg(db, {
      fromLat: HONGYA.lat, fromLon: HONGYA.lon,
      toLat: LUOHAN.lat, toLon: LUOHAN.lon,
      mode: "walking", source: "osrm-foot", minutes: 9, meters: 620,
      fetchedAt: "2026-07-27T12:00:00Z",
    });
    expect((await buildExportView(db)).calibration).not.toBeNull();
  });

  test("the trip total carries its unknown COUNT, not just a number", async () => {
    const { db, path, tripId } = await tripDb("total");
    await addTraveller(db, tripId, "eric", "1985-04-12");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon });
    await addSegment(db, tripId, { ...base, name: "Luohan Temple",
      latitude: LUOHAN.lat, longitude: LUOHAN.lon });
    await run(["seg", "price", "2", "--price=10"], { dbPath: path });
    await run(["plan"], { dbPath: path });
    const v = await buildExportView(db);
    expect(v.tripTotal.total).toBe(10);
    expect(v.tripTotal.unknown).toBe(1);
  });

  test("localName is carried only where it DIFFERS from the name", async () => {
    const { db, path, tripId } = await tripDb("local");
    await addSegment(db, tripId, { ...base, name: "Hongya Cave",
      latitude: HONGYA.lat, longitude: HONGYA.lon, localName: "洪崖洞" });
    await addSegment(db, tripId, { ...base, name: "Luohan Temple",
      latitude: LUOHAN.lat, longitude: LUOHAN.lon, localName: "Luohan Temple" });
    await run(["plan"], { dbPath: path });
    const stops = (await buildExportView(db)).days.flatMap((d) => d.stops);
    expect(stops.find((s) => s.name === "Hongya Cave")!.localName).toBe("洪崖洞");
    expect(stops.find((s) => s.name === "Luohan Temple")!.localName).toBeNull();
  });
});

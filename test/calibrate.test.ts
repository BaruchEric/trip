import { test, expect, describe } from "bun:test";
import { calibrate } from "@/calibrate";
import type { MeasuredLeg } from "@/legs";

const TESTBED = { lat: 29.5537638, lon: 106.5368476 };
const LIZIBA = { lat: 29.5556826, lon: 106.5338753 };
const HONGYA = { lat: 29.5650738, lon: 106.5753425 };

function leg(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  minutes: number,
  source = "osrm-foot",
  mode = "walking",
): MeasuredLeg {
  return {
    fromLat: from.lat, fromLon: from.lon, toLat: to.lat, toLon: to.lon,
    mode, source, minutes, meters: 1000, fetchedAt: "2026-07-27T12:00:00Z",
  };
}

describe("calibrate", () => {
  test("no legs is UNKNOWN, never agreement", () => {
    // Absence is loud: no measurement is not "the model is perfect here".
    const c = calibrate([], "walking");
    expect(c.legCount).toBe(0);
    expect(c.bands.every((b) => b.medianRatio === null)).toBe(true);
    expect(c.worst).toBeNull();
  });

  test("compares against the MIDPOINT of the two routers, not the slower", () => {
    // The schedule reads the max because that is a SCHEDULING POLICY buying
    // safety margin. Calibration asks what the routers measured, which is the
    // midpoint. Folding the policy in would report the model as more wrong
    // than it is.
    const c = calibrate([
      leg(TESTBED, LIZIBA, 20, "osrm-foot"),
      leg(TESTBED, LIZIBA, 30, "valhalla-pedestrian"),
    ], "walking");
    expect(c.legCount).toBe(1);
    expect(c.bands[0]!.medianRatio).toBeCloseTo(6 / 25, 4);
    // Not 6/30, which is what the schedule would imply.
    expect(c.bands[0]!.medianRatio).not.toBeCloseTo(6 / 30, 4);
  });

  test("a single source is used alone", () => {
    const c = calibrate([leg(TESTBED, LIZIBA, 22, "osrm-foot")], "walking");
    expect(c.bands[0]!.medianRatio).toBeCloseTo(6 / 22, 4);
  });

  test("bands split on STRAIGHT-LINE distance at 2 km", () => {
    // Not on measured time -- that would band by the quantity under
    // measurement, which is circular.
    const c = calibrate([
      leg(TESTBED, LIZIBA, 22),   // 0.36 km straight
      leg(TESTBED, HONGYA, 71),   // 3.93 km straight
    ], "walking");
    expect(c.bands[0]!.label).toContain("2 km");
    expect(c.bands[0]!.legCount).toBe(1);
    expect(c.bands[1]!.legCount).toBe(1);
  });

  test("a long leg with a short measured time still bands as long", () => {
    // The circular version of the banding would put this in the short band.
    const c = calibrate([leg(TESTBED, HONGYA, 3)], "walking");
    expect(c.bands[0]!.legCount).toBe(0);
    expect(c.bands[1]!.legCount).toBe(1);
  });

  test("an empty band is null, never 100%", () => {
    const c = calibrate([leg(TESTBED, LIZIBA, 22)], "walking");
    expect(c.bands[1]!.legCount).toBe(0);
    expect(c.bands[1]!.medianRatio).toBeNull();
  });

  test("uses the MEDIAN, so one outlier cannot move it", () => {
    // Three distinct short legs, one of them absurd. A mean would be dragged
    // by roughly a third of the absurdity; a median ignores it.
    const c = calibrate([
      leg(TESTBED, LIZIBA, 22),
      leg(LIZIBA, TESTBED, 24),
      leg({ lat: 29.5537638, lon: 106.5368476 }, { lat: 29.5540000, lon: 106.5370000 }, 6000),
    ], "walking");
    expect(c.legCount).toBe(3);
    // Median of {6/22, 6/24, ~0} is 6/24 -- the outlier is at an end, not the
    // middle. A mean would land near 0.09.
    expect(c.bands[0]!.medianRatio!).toBeGreaterThan(0.2);
  });

  test("names the single worst leg by ratio", () => {
    const c = calibrate([
      leg(TESTBED, LIZIBA, 22),
      leg(TESTBED, HONGYA, 71),
    ], "walking");
    expect(c.worst!.modelMinutes).toBe(6);
    expect(c.worst!.measuredMinutes).toBe(22);
  });

  test("worst prefers the OPTIMISTIC extreme, because that is what runs late", () => {
    // One leg the model badly under-estimates, one it mildly over-estimates.
    // A plan runs late on the first and merely early on the second.
    const c = calibrate([
      leg(TESTBED, LIZIBA, 22),        // model 6, optimistic
      leg(TESTBED, HONGYA, 40),        // model 68, pessimistic and further from 1
    ], "walking");
    expect(c.worst!.ratio).toBeLessThan(1);
  });

  test("legs of another mode are ignored", () => {
    expect(
      calibrate([leg(TESTBED, LIZIBA, 22, "osrm-foot", "transit")], "walking").legCount,
    ).toBe(0);
  });

  test("a ratio ABOVE 1 means the model is pessimistic", () => {
    // Amsterdam's case -- and the one a Chongqing-only project would never
    // have produced.
    const c = calibrate([leg(TESTBED, LIZIBA, 3)], "walking");
    expect(c.bands[0]!.medianRatio!).toBeGreaterThan(1);
  });

  test("a zero-minute measurement is dropped rather than dividing by zero", () => {
    expect(calibrate([leg(TESTBED, LIZIBA, 0)], "walking").legCount).toBe(0);
  });

  test("the reverse leg is counted separately", () => {
    const c = calibrate([
      leg(TESTBED, LIZIBA, 22),
      leg(LIZIBA, TESTBED, 32),
    ], "walking");
    expect(c.legCount).toBe(2);
  });
});

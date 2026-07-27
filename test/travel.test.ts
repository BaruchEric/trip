import { test, expect, describe } from "bun:test";
import { modelOnly, withLegs } from "@/plan/travel";
import { travelMinutes } from "@/plan/geo";
import type { MeasuredLeg } from "@/legs";

const TESTBED = { latitude: 29.5537638, longitude: 106.5368476 };
const LIZIBA = { latitude: 29.5556826, longitude: 106.5338753 };

function leg(o: Partial<MeasuredLeg> = {}): MeasuredLeg {
  return {
    fromLat: TESTBED.latitude, fromLon: TESTBED.longitude,
    toLat: LIZIBA.latitude, toLon: LIZIBA.longitude,
    mode: "walking", source: "osrm-foot",
    minutes: 22.2, meters: 1670, fetchedAt: "2026-07-27T12:00:00Z", ...o,
  };
}

describe("modelOnly", () => {
  test("is exactly the M2 model, unchanged", () => {
    const t = modelOnly();
    for (const mode of ["walking", "transit"] as const) {
      expect(t.minutes(TESTBED, LIZIBA, mode)).toBe(travelMinutes(TESTBED, LIZIBA, mode));
      expect(t.estimate(TESTBED, LIZIBA, mode).basis).not.toBe("measured");
    }
  });
});

describe("withLegs", () => {
  test("THE MILESTONE: a measured leg replaces the straight line", () => {
    // 360 m apart in a straight line, and no direct pedestrian path between
    // them. The model calls them neighbours.
    expect(modelOnly().minutes(TESTBED, LIZIBA, "walking")).toBe(6);
    expect(withLegs([leg()]).minutes(TESTBED, LIZIBA, "walking")).toBe(22);
  });

  test("with both sources the SLOWER wins", () => {
    // A plan that runs early is a good day; a plan that runs late cascades
    // through every segment after it.
    const t = withLegs([
      leg({ minutes: 22.2 }),
      leg({ source: "valhalla-pedestrian", minutes: 23.4 }),
    ]);
    expect(t.minutes(TESTBED, LIZIBA, "walking")).toBe(23);
    expect(t.estimate(TESTBED, LIZIBA, "walking").basis).toBe("measured");
  });

  test("the slower wins whichever ORDER the legs arrive in", () => {
    // A max written as a last-write-wins would pass the test above and fail
    // this one.
    const t = withLegs([
      leg({ source: "valhalla-pedestrian", minutes: 23.4 }),
      leg({ minutes: 22.2 }),
    ]);
    expect(t.minutes(TESTBED, LIZIBA, "walking")).toBe(23);
  });

  test("the REVERSE leg is looked up separately", () => {
    // The recon: Valhalla gives 23.4 min one way and 32.1 uphill over the same
    // 360 m. A test that only checks one direction passes under the
    // unordered-pair design this replaces.
    const t = withLegs([
      leg({ source: "valhalla-pedestrian", minutes: 23.4 }),
      leg({
        source: "valhalla-pedestrian", minutes: 32.1,
        fromLat: LIZIBA.latitude, fromLon: LIZIBA.longitude,
        toLat: TESTBED.latitude, toLon: TESTBED.longitude,
      }),
    ]);
    expect(t.minutes(TESTBED, LIZIBA, "walking")).toBe(23);
    expect(t.minutes(LIZIBA, TESTBED, "walking")).toBe(32);
  });

  test("a leg for one direction does NOT answer the other", () => {
    const t = withLegs([leg()]);
    expect(t.estimate(TESTBED, LIZIBA, "walking").basis).toBe("measured");
    expect(t.estimate(LIZIBA, TESTBED, "walking").basis).not.toBe("measured");
  });

  test("a moved segment falls back to the model rather than reusing its leg", () => {
    // M7's --query and --rename can re-resolve a segment onto different
    // coordinates. Keying on coordinates makes that a MISS. Keying on segment
    // ids would have silently answered with a leg measured somewhere else.
    const moved = { latitude: 29.56, longitude: 106.54 };
    const t = withLegs([leg()]);
    expect(t.estimate(TESTBED, moved, "walking").basis).not.toBe("measured");
    expect(t.minutes(TESTBED, moved, "walking"))
      .toBe(travelMinutes(TESTBED, moved, "walking"));
  });

  test("transit finds nothing and uses the model", () => {
    // Nothing in M8 measured transit, and `trip route` stores mode='walking'
    // only. A transit plan is exactly as unevidenced after M8 as before it.
    const t = withLegs([leg()]);
    expect(t.estimate(TESTBED, LIZIBA, "transit").basis).not.toBe("measured");
    expect(t.minutes(TESTBED, LIZIBA, "transit"))
      .toBe(travelMinutes(TESTBED, LIZIBA, "transit"));
  });

  test("a coordinate differing below 5dp still hits", () => {
    const t = withLegs([leg()]);
    const nudged = { latitude: TESTBED.latitude + 0.000001, longitude: TESTBED.longitude };
    expect(t.estimate(nudged, LIZIBA, "walking").basis).toBe("measured");
  });

  test("a coordinate differing ABOVE 5dp misses", () => {
    const t = withLegs([leg()]);
    const moved = { latitude: TESTBED.latitude + 0.01, longitude: TESTBED.longitude };
    expect(t.estimate(moved, LIZIBA, "walking").basis).not.toBe("measured");
  });

  test("minutes are whole, because clock arithmetic must not drift", () => {
    const t = withLegs([leg({ minutes: 22.6 })]);
    expect(Number.isInteger(t.minutes(TESTBED, LIZIBA, "walking"))).toBe(true);
    expect(t.minutes(TESTBED, LIZIBA, "walking")).toBe(23);
  });

  test("an empty leg set is exactly modelOnly", () => {
    expect(withLegs([]).minutes(TESTBED, LIZIBA, "walking"))
      .toBe(modelOnly().minutes(TESTBED, LIZIBA, "walking"));
    expect(withLegs([]).estimate(TESTBED, LIZIBA, "walking").basis).not.toBe("measured");
  });

  test("a zero-minute measured leg is still MEASURED, not absent", () => {
    // 0 is a real number here and must not be read as "no leg". The routers
    // never return it, but the distinction is the project's oldest rule.
    const t = withLegs([leg({ minutes: 0 })]);
    expect(t.estimate(TESTBED, LIZIBA, "walking").basis).toBe("measured");
    expect(t.minutes(TESTBED, LIZIBA, "walking")).toBe(0);
  });
});

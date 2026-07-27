import { test, expect, describe } from "bun:test";
import { buildGraph } from "@/transit/graph";
import { modelOnly, withLegs, withLegsAndTransit } from "@/plan/travel";
import { travelMinutes } from "@/plan/geo";
import type { MeasuredLeg } from "@/legs";
import type { TransitStation, TransitEdge } from "@/transit/store";

/** Line A is a long east-west line: A1 - A2 - A3, ~9.7 km per hop.
 *  Line B meets it at A2.
 *  Line D is two stations 300 m apart — the case where riding cannot win. */
const STATIONS: TransitStation[] = [
  { name: "A1", latitude: 29.56, longitude: 106.50 },
  { name: "A2", latitude: 29.56, longitude: 106.60 },
  { name: "A3", latitude: 29.56, longitude: 106.70 },
  { name: "B1", latitude: 29.66, longitude: 106.60 },
  { name: "D1", latitude: 29.40, longitude: 106.50 },
  { name: "D2", latitude: 29.40, longitude: 106.5031 },
];
const EDGES: TransitEdge[] = [
  { fromName: "A1", toName: "A2", line: "A", km: 9.69 },
  { fromName: "A2", toName: "A3", line: "A", km: 9.69 },
  { fromName: "A2", toName: "B1", line: "B", km: 11.1 },
  { fromName: "D1", toName: "D2", line: "D", km: 0.3 },
];
const graph = buildGraph(STATIONS, EDGES);
const at = (latitude: number, longitude: number) => ({ latitude, longitude });

const NEAR_A1 = at(29.5601, 106.5001);
const NEAR_A3 = at(29.5601, 106.7001);
const NEAR_D1 = at(29.4001, 106.5001);
const NEAR_D2 = at(29.4001, 106.5030);

describe("the transit model built on the station graph", () => {
  test("a long ride reports the graph as its basis, with stops and changes", async () => {
    const m = withLegsAndTransit([], graph);
    const e = m.estimate(NEAR_A1, NEAR_A3, "transit");
    expect(e.basis).toBe("osm-graph");
    expect(e.transit!.fromStation).toBe("A1");
    expect(e.transit!.toStation).toBe("A3");
    expect(e.transit!.stops).toBe(2);
    expect(e.transit!.transfers).toBe(0);
    expect(e.transit!.walkWins).toBe(false);
    expect(e.minutes).toBeGreaterThan(0);
  });

  test("A TRANSIT ESTIMATE NEVER EXCEEDS THE WALK FOR THE SAME PAIR", async () => {
    // The defect fix, stated as one rule. The old constant recommended riding
    // in 36-42 of every 42 pairs the recon measured, and measured walking
    // actually won 4 to 11 of them, by up to 70 minutes.
    const m = withLegsAndTransit([], graph);
    for (const [a, b] of [
      [NEAR_A1, NEAR_A3], [NEAR_A1, NEAR_D1], [NEAR_D1, NEAR_D2],
      [NEAR_A3, NEAR_A1], [NEAR_D2, NEAR_D1],
    ] as const) {
      const transit = m.estimate(a, b, "transit").minutes;
      const walk = m.estimate(a, b, "walking").minutes;
      expect(transit).toBeLessThanOrEqual(walk);
    }
  });

  test("when walking is faster the estimate IS the walk, and says so", async () => {
    // D1 and D2 are 300 m apart. Boarding alone costs more than the walk.
    const m = withLegsAndTransit([], graph);
    const e = m.estimate(NEAR_D1, NEAR_D2, "transit");
    expect(e.transit!.walkWins).toBe(true);
    expect(e.minutes).toBe(m.estimate(NEAR_D1, NEAR_D2, "walking").minutes);
  });

  test("both ends at the same station is a walk, not a zero-minute ride", async () => {
    // 4/42 pairs in Chongqing, 6/42 in Bangkok. A ride of zero stops must not
    // come back as "0 min by transit".
    const m = withLegsAndTransit([], graph);
    const e = m.estimate(at(29.5605, 106.5005), at(29.5595, 106.4995), "transit");
    expect(e.transit!.stops).toBe(0);
    expect(e.transit!.walkWins).toBe(true);
    expect(e.minutes).toBeGreaterThan(0);
  });

  test("no station within reach means walking, and names no station", async () => {
    const m = withLegsAndTransit([], graph);
    const e = m.estimate(at(20.0, 100.0), at(20.01, 100.01), "transit");
    expect(e.transit!.fromStation).toBeNull();
    expect(e.transit!.toStation).toBeNull();
    expect(e.transit!.walkWins).toBe(true);
    expect(e.minutes).toBe(m.estimate(at(20.0, 100.0), at(20.01, 100.01), "walking").minutes);
  });

  test("no graph at all falls back to the old constant, and says THAT", async () => {
    // Distinct from every case above: nobody has run `trip transit`. The
    // number is the unevidenced 18 km/h constant, and a plan compiled on it
    // must not look like one compiled on the graph.
    const m = withLegsAndTransit([], null);
    const e = m.estimate(NEAR_A1, NEAR_A3, "transit");
    expect(e.basis).toBe("model");
    expect(e.transit).toBeUndefined();
    expect(e.minutes).toBe(travelMinutes(NEAR_A1, NEAR_A3, "transit"));
  });

  test("a transfer is charged and counted", async () => {
    const m = withLegsAndTransit([], graph);
    const e = m.estimate(NEAR_A1, at(29.6601, 106.6001), "transit");
    expect(e.transit!.transfers).toBe(1);
  });
});

describe("walking is unaffected, and basis replaced measured", () => {
  const LEG: MeasuredLeg = {
    fromLat: 29.5601, fromLon: 106.5001, toLat: 29.5601, toLon: 106.7001,
    mode: "walking", source: "osrm-foot",
    minutes: 300, meters: 19400, fetchedAt: "2026-07-27T12:00:00Z",
  };

  test("a measured walking leg still wins, and reports measured", async () => {
    const m = withLegsAndTransit([LEG], graph);
    const e = m.estimate(NEAR_A1, NEAR_A3, "walking");
    expect(e.basis).toBe("measured");
    expect(e.minutes).toBe(300);
  });

  test("walking with no leg reports model", async () => {
    const e = withLegsAndTransit([], graph).estimate(NEAR_A1, NEAR_A3, "walking");
    expect(e.basis).toBe("model");
  });

  test("modelOnly and withLegs still answer, on the basis scale", async () => {
    expect(modelOnly().estimate(NEAR_A1, NEAR_A3, "walking").basis).toBe("model");
    expect(withLegs([LEG]).estimate(NEAR_A1, NEAR_A3, "walking").basis).toBe("measured");
    // withLegs knows no graph, so transit is still the constant.
    expect(withLegs([]).estimate(NEAR_A1, NEAR_A3, "transit").basis).toBe("model");
  });

  test("a measured walking leg is what transit is compared AGAINST", async () => {
    // The comparison improves wherever `trip route` has measured real walking.
    // Here the measured walk is 300 min, so the ride wins; with an absurdly
    // fast measured walk, the walk must win instead.
    const fast: MeasuredLeg = { ...LEG, minutes: 3 };
    const m = withLegsAndTransit([fast], graph);
    const e = m.estimate(NEAR_A1, NEAR_A3, "transit");
    expect(e.transit!.walkWins).toBe(true);
    expect(e.minutes).toBe(3);
    expect(e.basis).toBe("measured");
  });
});

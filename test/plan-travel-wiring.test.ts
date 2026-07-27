import { test, expect, describe } from "bun:test";
import { compile } from "@/plan/compile";
import { withLegs, modelOnly } from "@/plan/travel";
import type { Segment } from "@/segments";
import type { MeasuredLeg } from "@/legs";
import type { DayWindow } from "@/days";

function seg(id: number, name: string, latitude: number, longitude: number): Segment {
  return {
    id, tripId: 1, name, localName: null, latitude, longitude,
    dwellMinutes: 60, dwellIsDefault: false, tags: [],
    opensMin: null, closesMin: null, closedDays: [], freeDays: [],
    status: "confirmed", sourceId: null, sourceAtSeconds: null,
  };
}

const TESTBED = seg(1, "Testbed 2", 29.5537638, 106.5368476);
const LIZIBA = seg(2, "Liziba", 29.5556826, 106.5338753);
const HONGYA = seg(3, "Hongya Cave", 29.5650738, 106.5753425);

const DAY: DayWindow[] = [
  { day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1200 },
];

function leg(
  from: Segment, to: Segment, minutes: number, source = "osrm-foot",
): MeasuredLeg {
  return {
    fromLat: from.latitude!, fromLon: from.longitude!,
    toLat: to.latitude!, toLon: to.longitude!,
    mode: "walking", source, minutes, meters: 1670,
    fetchedAt: "2026-07-27T12:00:00Z",
  };
}

const start = (r: { placements: { segmentId: number; startMin: number }[] }, id: number) =>
  r.placements.find((p) => p.segmentId === id)!.startMin;

describe("compile threads the travel model", () => {
  test("defaults to the model when no travel is supplied", () => {
    // Every caller predating M8 keeps compiling, and keeps its behaviour.
    const r = compile([TESTBED, LIZIBA], DAY, { mode: "walking", pace: "normal", pins: [] });
    expect(r.placements).toHaveLength(2);
    const explicit = compile([TESTBED, LIZIBA], DAY,
      { mode: "walking", pace: "normal", pins: [], travel: modelOnly() });
    expect(JSON.stringify(r)).toBe(JSON.stringify(explicit));
  });

  test("a measured leg moves the CLOCK", () => {
    const modelled = compile([TESTBED, LIZIBA], DAY,
      { mode: "walking", pace: "normal", pins: [], travel: modelOnly() });
    const measured = compile([TESTBED, LIZIBA], DAY,
      { mode: "walking", pace: "normal", pins: [],
        travel: withLegs([leg(TESTBED, LIZIBA, 22.2), leg(LIZIBA, TESTBED, 22.2)]) });

    // Testbed 2 first in both. Liziba starts 16 minutes later once the real
    // leg is known -- 22 measured against 6 modelled.
    expect(start(measured, 2) - start(modelled, 2)).toBe(16);
  });

  test("a measured leg changes the ORDER, not only the clock", () => {
    // The model puts Testbed 2 and Liziba 6 minutes apart, so a route that
    // visits them consecutively looks cheap. Measured, they are 90 minutes
    // apart and Hongya Cave belongs between them. The ordering SEARCH has to
    // be able to see that -- a display-only marker could not.
    const legs = [
      leg(TESTBED, LIZIBA, 90), leg(LIZIBA, TESTBED, 90),
      leg(TESTBED, HONGYA, 5), leg(HONGYA, TESTBED, 5),
      leg(LIZIBA, HONGYA, 5), leg(HONGYA, LIZIBA, 5),
    ];
    const seq = (r: { placements: { segmentId: number; ordinal: number }[] }) =>
      [...r.placements].sort((a, b) => a.ordinal - b.ordinal)
        .map((p) => p.segmentId).join(",");

    const modelled = compile([TESTBED, LIZIBA, HONGYA], DAY,
      { mode: "walking", pace: "normal", pins: [], travel: modelOnly() });
    const measured = compile([TESTBED, LIZIBA, HONGYA], DAY,
      { mode: "walking", pace: "normal", pins: [], travel: withLegs(legs) });

    expect(seq(measured)).not.toBe(seq(modelled));
    // Hongya Cave in the middle: the only order that avoids the 90-minute hop.
    expect(seq(measured)).toBe("1,3,2");
  });

  test("compile stays PURE -- same inputs, same output, twice", () => {
    const opts = {
      mode: "walking" as const, pace: "normal" as const, pins: [],
      travel: withLegs([leg(TESTBED, LIZIBA, 22.2)]),
    };
    expect(JSON.stringify(compile([TESTBED, LIZIBA, HONGYA], DAY, opts)))
      .toBe(JSON.stringify(compile([TESTBED, LIZIBA, HONGYA], DAY, opts)));
  });

  test("transit ignores every walking leg", () => {
    const legs = [leg(TESTBED, LIZIBA, 90), leg(LIZIBA, TESTBED, 90)];
    const withL = compile([TESTBED, LIZIBA], DAY,
      { mode: "transit", pace: "normal", pins: [], travel: withLegs(legs) });
    const without = compile([TESTBED, LIZIBA], DAY,
      { mode: "transit", pace: "normal", pins: [], travel: modelOnly() });
    expect(JSON.stringify(withL)).toBe(JSON.stringify(without));
  });
});

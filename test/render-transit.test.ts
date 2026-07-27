import { test, expect, describe } from "bun:test";
import { renderDay, renderPlan, transitCaveat } from "@/render-plan";
import { withLegsAndTransit } from "@/plan/travel";
import { buildGraph } from "@/transit/graph";
import type { TransitStation, TransitEdge } from "@/transit/store";
import type { Segment } from "@/segments";
import type { DayWindow } from "@/days";
import type { Placement } from "@/plan/types";

/** Line A: A1 - A2 - A3, ~9.7 km per hop, so riding beats walking.
 *  Line D: D1 - D2, 300 m apart, so walking beats riding. */
const STATIONS: TransitStation[] = [
  { name: "A1", latitude: 29.56, longitude: 106.50 },
  { name: "A2", latitude: 29.56, longitude: 106.60 },
  { name: "A3", latitude: 29.56, longitude: 106.70 },
  { name: "D1", latitude: 29.40, longitude: 106.50 },
  { name: "D2", latitude: 29.40, longitude: 106.5031 },
];
const EDGES: TransitEdge[] = [
  { fromName: "A1", toName: "A2", line: "A", km: 9.69 },
  { fromName: "A2", toName: "A3", line: "A", km: 9.69 },
  { fromName: "D1", toName: "D2", line: "D", km: 0.3 },
];
const graph = buildGraph(STATIONS, EDGES);

const seg = (id: number, name: string, latitude: number, longitude: number): Segment => ({
  id, name, localName: null, latitude, longitude,
  dwellMinutes: 60, tags: [], opensMin: null, closesMin: null,
  closedDays: [], freeDays: [], dwellIsDefault: false,
  sourceId: null, sourceAtSeconds: null,
} as unknown as Segment);

const DAY: DayWindow = {
  day: 1, date: "2026-09-01", weekday: "tue", startMin: 540, endMin: 1140,
} as DayWindow;

const place = (segmentId: number, ordinal: number, startMin: number): Placement => ({
  segmentId, day: 1, ordinal, startMin, endMin: startMin + 60, pinned: false,
});

function dayText(segments: Segment[], mode: "walking" | "transit" = "transit"): string {
  const map = new Map(segments.map((s) => [s.id, s]));
  const placements = segments.map((s, i) => place(s.id, i, 540 + i * 120));
  return renderDay(DAY, placements, map, [], undefined, false, {
    model: withLegsAndTransit([], graph), mode,
  });
}

describe("the hop line describes a modelled ride", () => {
  const FAR = [seg(1, "West End", 29.5601, 106.5001), seg(2, "East End", 29.5601, 106.7001)];

  test("it names the stations, the stops and the changes", async () => {
    const out = dayText(FAR);
    expect(out).toContain("min transit (modelled)");
    expect(out).toContain("A1 -> A3");
    expect(out).toContain("2 stops");
    expect(out).toContain("0 changes");
  });

  test("modelled is a DIFFERENT word from estimated", async () => {
    // "estimated" has meant "a straight line times a constant" since M8, and
    // for transit that constant is one M12 measured wrong in four cities. A
    // station-graph number must not borrow its label.
    const out = dayText(FAR);
    expect(out).toContain("(modelled)");
    expect(out).not.toContain("(estimated)");
  });

  test("with no graph at all the hop is estimated, not modelled", async () => {
    // Nobody has run `trip transit`. The number is the old constant and must
    // say so: a plan compiled on it must not look like one compiled on data.
    const map = new Map(FAR.map((s) => [s.id, s]));
    const out = renderDay(DAY, [place(1, 0, 540), place(2, 1, 660)], map, [],
      undefined, false, { model: withLegsAndTransit([], null), mode: "transit" });
    expect(out).toContain("(estimated)");
    expect(out).not.toContain("(modelled)");
    expect(out).not.toContain("stops");
  });
});

describe("the hop line says WALK when the railway does not help", () => {
  test("two stops 300 m apart get told to walk, with the reason", async () => {
    const out = dayText([
      seg(1, "Corner Shop", 29.4001, 106.5001),
      seg(2, "Next Corner", 29.4001, 106.5030),
    ]);
    expect(out).toContain("WALK instead");
    expect(out).toContain("the railway does not help here");
    expect(out).not.toContain("min transit");
  });

  test("both ends nearest one station says so by name", async () => {
    const out = dayText([
      seg(1, "North Side", 29.5605, 106.5005),
      seg(2, "South Side", 29.5595, 106.4995),
    ]);
    expect(out).toContain("WALK instead");
    expect(out).toContain("both stops are nearest A1");
  });

  test("no station within reach says THAT, not that the railway is unhelpful", async () => {
    // Two different facts. One means the metro exists and loses; the other
    // means there is no metro here at all.
    const out = dayText([
      seg(1, "Far Field", 20.0, 100.0),
      seg(2, "Farther Field", 20.02, 100.02),
    ]);
    expect(out).toContain("WALK instead");
    expect(out).toContain("no station within reach");
  });
});

describe("the timetable caveat", () => {
  test("it names what OSM does not have", async () => {
    const lines = transitCaveat(true).join("\n");
    expect(lines).toContain("NO TIMETABLE");
    expect(lines).toContain("assumed");
    expect(lines.toLowerCase()).toContain("waiting");
  });

  test("it is silent when no hop used the graph", async () => {
    expect(transitCaveat(false)).toEqual([]);
  });

  test("trip plan prints it when a transit hop was modelled", async () => {
    const segs = [seg(1, "West End", 29.5601, 106.5001), seg(2, "East End", 29.5601, 106.7001)];
    const out = renderPlan(
      [DAY], [place(1, 0, 540), place(2, 1, 660)], segs, [], undefined,
      { model: withLegsAndTransit([], graph), mode: "transit" },
    );
    expect(out).toContain("NO TIMETABLE");
  });

  test("trip plan stays silent on a walking trip", async () => {
    const segs = [seg(1, "West End", 29.5601, 106.5001), seg(2, "East End", 29.5601, 106.7001)];
    const out = renderPlan(
      [DAY], [place(1, 0, 540), place(2, 1, 660)], segs, [], undefined,
      { model: withLegsAndTransit([], graph), mode: "walking" },
    );
    expect(out).not.toContain("NO TIMETABLE");
  });
});

describe("both renderers agree, which is the M8 defect M10 caught", () => {
  test("trip plan and trip day render the SAME hop line", async () => {
    // M8 shipped `trip day` with no hop lines while `trip plan` had them, for
    // the same stored placements, and it took until M10 to notice. Every
    // output change since must land in both.
    const segs = [seg(1, "West End", 29.5601, 106.5001), seg(2, "East End", 29.5601, 106.7001)];
    const travel = { model: withLegsAndTransit([], graph), mode: "transit" as const };
    const placements = [place(1, 0, 540), place(2, 1, 660)];

    const day = renderDay(DAY, placements, new Map(segs.map((s) => [s.id, s])),
      [], undefined, false, travel);
    const plan = renderPlan([DAY], placements, segs, [], undefined, travel);

    const hopOf = (text: string) =>
      text.split("\n").filter((l) => l.includes("->")).map((l) => l.trim());
    expect(hopOf(day).length).toBeGreaterThan(0);
    expect(hopOf(plan)).toEqual(hopOf(day));
  });

  test("they agree on a walk-instead hop too", async () => {
    const segs = [seg(1, "Corner Shop", 29.4001, 106.5001), seg(2, "Next Corner", 29.4001, 106.5030)];
    const travel = { model: withLegsAndTransit([], graph), mode: "transit" as const };
    const placements = [place(1, 0, 540), place(2, 1, 660)];
    const day = renderDay(DAY, placements, new Map(segs.map((s) => [s.id, s])),
      [], undefined, false, travel);
    const plan = renderPlan([DAY], placements, segs, [], undefined, travel);
    expect(day).toContain("WALK instead");
    expect(plan).toContain("WALK instead");
  });
});

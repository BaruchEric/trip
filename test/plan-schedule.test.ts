import { expect, test, describe } from "bun:test";
import { layoutDay } from "@/plan/schedule";
import type { PlannableSegment } from "@/plan/types";
import type { DayWindow } from "@/days";

function seg(
  id: number,
  o: Partial<PlannableSegment> = {},
): PlannableSegment {
  return {
    id, tripId: 1, name: `s${id}`, localName: null,
    latitude: 38.71, longitude: -9.13,
    dwellMinutes: 60, dwellIsDefault: false, cost: null, tags: [],
    opensMin: null, closesMin: null, closedDays: [],
    status: "confirmed", sourceId: null, sourceAtSeconds: null, ...o,
  };
}

const DAY: DayWindow = {
  day: 1, date: "2027-05-08", weekday: "sat", startMin: 540, endMin: 1140,
};

describe("layoutDay", () => {
  test("places segments back to back from the day's start", () => {
    const r = layoutDay([seg(1), seg(2)], DAY, "walking", []);
    expect(r.unplaced).toHaveLength(0);
    expect(r.placements[0]!.startMin).toBe(540);
    expect(r.placements[0]!.endMin).toBe(600);
    expect(r.placements[0]!.ordinal).toBe(0);
    // Same coordinates, so walking travel is zero.
    expect(r.placements[1]!.startMin).toBe(600);
    expect(r.placements[1]!.ordinal).toBe(1);
  });

  test("travel time between distant segments pushes the clock", () => {
    const near = seg(1);
    const far = seg(2, { latitude: 38.6916, longitude: -9.216 });
    const r = layoutDay([near, far], DAY, "walking", []);
    expect(r.transitMinutes).toBeGreaterThan(100);
    expect(r.placements[1]!.startMin).toBe(600 + r.transitMinutes);
  });

  test("a segment that opens later makes the schedule wait", () => {
    // Not an error: arriving early at a museum means waiting, not skipping.
    const r = layoutDay([seg(1, { opensMin: 660 })], DAY, "walking", []);
    expect(r.placements[0]!.startMin).toBe(660);
  });

  test("unknown hours never block placement", () => {
    // M2-2. A null must never be read as a closed door.
    const r = layoutDay([seg(1, { opensMin: null, closesMin: null })], DAY, "walking", []);
    expect(r.placements).toHaveLength(1);
    expect(r.unplaced).toHaveLength(0);
  });

  test("a segment closed on this weekday is unplaced with a reason naming the day", () => {
    const r = layoutDay([seg(1, { closedDays: ["sat"] })], DAY, "walking", []);
    expect(r.placements).toHaveLength(0);
    expect(r.unplaced[0]!.segmentId).toBe(1);
    expect(r.unplaced[0]!.reason).toMatch(/closed on sat/i);
  });

  test("a segment that cannot finish before closing is unplaced", () => {
    const r = layoutDay([seg(1, { dwellMinutes: 120, closesMin: 600 })], DAY, "walking", []);
    expect(r.unplaced[0]!.reason).toMatch(/clos/i);
  });

  test("a segment that cannot finish before the day ends is unplaced", () => {
    const r = layoutDay(
      [seg(1, { dwellMinutes: 400 }), seg(2, { dwellMinutes: 400 })],
      DAY, "walking", [],
    );
    expect(r.placements).toHaveLength(1);
    expect(r.unplaced[0]!.segmentId).toBe(2);
    expect(r.unplaced[0]!.reason).toMatch(/room/i);
  });

  test("one unplaceable segment does not abort the rest of the day", () => {
    // A closed museum in the middle must not cost you the afternoon.
    const r = layoutDay(
      [seg(1), seg(2, { closedDays: ["sat"] }), seg(3)],
      DAY, "walking", [],
    );
    expect(r.placements.map((p) => p.segmentId)).toEqual([1, 3]);
    expect(r.unplaced.map((u) => u.segmentId)).toEqual([2]);
    // Ordinals stay contiguous after the gap.
    expect(r.placements.map((p) => p.ordinal)).toEqual([0, 1]);
  });

  test("a skipped segment charges no travel and does not move the clock", () => {
    // The three-segment test above is coordinate-degenerate: every segment
    // sits at the same point, so it can't tell whether a skip advances
    // `previous`. This one puts the skipped segment far away — if `previous`
    // (or the cursor) were updated on skip, seg 3 would inherit a phantom
    // travel leg it never took, and Task 7's score would be wrong.
    const far = seg(2, { latitude: 38.6916, longitude: -9.216, closedDays: ["sat"] });
    const r = layoutDay([seg(1), far, seg(3)], DAY, "walking", []);
    expect(r.placements.map((p) => p.segmentId)).toEqual([1, 3]);
    expect(r.transitMinutes).toBe(0);
    expect(r.placements[1]!.startMin).toBe(600);
  });

  test("a segment skipped via closesMin mid-day charges no phantom travel", () => {
    // Same shape as the closedDays skip above, but for the closesMin path:
    // a distant, expensive-to-reach segment that closes before it could
    // finish. If `previous`/cursor were updated on this skip too, segment 3
    // would inherit a phantom leg from the skipped segment's coordinates
    // (and Task 7's score would be corrupted by it).
    const far = seg(2, {
      latitude: 38.6916, longitude: -9.216, closesMin: 601, dwellMinutes: 5,
    });
    const r = layoutDay([seg(1), far, seg(3)], DAY, "walking", []);
    expect(r.placements.map((p) => p.segmentId)).toEqual([1, 3]);
    expect(r.unplaced[0]!.segmentId).toBe(2);
    expect(r.unplaced[0]!.reason).toMatch(/clos/i);
    expect(r.transitMinutes).toBe(0);
    expect(r.placements[1]!.startMin).toBe(600);
  });

  test("a segment skipped for lack of room mid-day charges no phantom travel", () => {
    const shortDay: DayWindow = { ...DAY, endMin: 700 };
    const far = seg(2, { latitude: 38.6916, longitude: -9.216, dwellMinutes: 200 });
    const r = layoutDay([seg(1), far, seg(3)], shortDay, "walking", []);
    expect(r.placements.map((p) => p.segmentId)).toEqual([1, 3]);
    expect(r.unplaced[0]!.segmentId).toBe(2);
    expect(r.unplaced[0]!.reason).toMatch(/room/i);
    expect(r.transitMinutes).toBe(0);
    expect(r.placements[1]!.startMin).toBe(600);
  });

  test("blocked intervals are stepped over, not scheduled through", () => {
    // This is how a pinned segment reserves its time.
    const r = layoutDay([seg(1)], DAY, "walking", [{ startMin: 540, endMin: 660 }]);
    expect(r.placements[0]!.startMin).toBe(660);
  });

  test("mealDeviation measures food segments against the nearest meal window", () => {
    // A food segment centred exactly on 12:30 deviates by zero.
    const lunch = seg(1, { tags: ["food"], dwellMinutes: 60, opensMin: 720 });
    const r = layoutDay([lunch], DAY, "walking", []);
    expect(r.placements[0]!.startMin).toBe(720);
    expect(r.mealDeviation).toBe(0);
  });

  test("a non-food segment contributes nothing to mealDeviation", () => {
    const r = layoutDay([seg(1)], DAY, "walking", []);
    expect(r.mealDeviation).toBe(0);
  });

  test("an empty order is a valid empty day", () => {
    const r = layoutDay([], DAY, "walking", []);
    expect(r).toEqual({ placements: [], unplaced: [], transitMinutes: 0, mealDeviation: 0 });
  });

  test("a zero-length day places nothing and blames room, not hours", () => {
    const empty: DayWindow = { ...DAY, startMin: 1140, endMin: 1140 };
    const r = layoutDay([seg(1)], empty, "walking", []);
    expect(r.placements).toHaveLength(0);
    expect(r.unplaced[0]!.reason).toMatch(/room/i);
  });
});

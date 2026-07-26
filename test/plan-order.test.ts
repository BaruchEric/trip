import { expect, test, describe } from "bun:test";
import { orderDay, EXACT_LIMIT } from "@/plan/order";
import { travelMinutes } from "@/plan/geo";
import type { PlannableSegment } from "@/plan/types";
import type { DayWindow } from "@/days";

function seg(
  id: number, latitude: number, longitude: number,
  o: Partial<PlannableSegment> = {},
): PlannableSegment {
  return {
    id, tripId: 1, name: `s${id}`, latitude, longitude,
    dwellMinutes: 30, cost: null, tags: [], opensMin: null,
    closesMin: null, closedDays: [], status: "confirmed", ...o,
  };
}

const DAY: DayWindow = {
  day: 1, date: "2027-05-08", weekday: "sat", startMin: 540, endMin: 1260,
};

describe("orderDay", () => {
  test("orders a line of segments end to end rather than zig-zagging", () => {
    // Given in worst-case order, the best route is the straight sweep.
    const a = seg(1, 38.70, -9.10);
    const b = seg(2, 38.71, -9.10);
    const c = seg(3, 38.72, -9.10);
    const zigzag = orderDay([a, c, b], DAY, "walking", []);
    const ids = zigzag.placements.map((p) => p.segmentId);
    expect(ids === undefined).toBe(false);
    // Either sweep direction is optimal; both are monotone.
    expect([[1, 2, 3], [3, 2, 1]]).toContainEqual(ids);
  });

  test("beats the naive input order on total transit", () => {
    const a = seg(1, 38.70, -9.10);
    const b = seg(2, 38.71, -9.10);
    const c = seg(3, 38.72, -9.10);
    const ordered = orderDay([a, c, b], DAY, "walking", []);
    // Input order a -> c -> b (39 + 19 = 58 min under the current geo model)
    // detours twice; the sweep (19 + 19 = 38 min) walks the span once. Bound
    // it against the naive route's own cost rather than a fixed number: the
    // travel-time model in geo.ts is a placeholder due for replacement in
    // M4, and a magic-number threshold would break on that swap even though
    // "beats naive" would still be true.
    expect(ordered.transitMinutes).toBeLessThan(
      travelMinutes(a, c, "walking") + travelMinutes(c, b, "walking"),
    );
  });

  test("is deterministic under input reordering", () => {
    const pts = [
      seg(1, 38.700, -9.100), seg(2, 38.705, -9.110), seg(3, 38.710, -9.120),
      seg(4, 38.715, -9.130), seg(5, 38.720, -9.140),
    ];
    const forward = orderDay(pts, DAY, "walking", []);
    const backward = orderDay([...pts].reverse(), DAY, "walking", []);
    expect(backward.placements.map((p) => p.segmentId))
      .toEqual(forward.placements.map((p) => p.segmentId));
  });

  test("prefers placing more segments over saving transit", () => {
    // A closed-early segment can only be placed first. Losing it to save a
    // few minutes of walking would be the wrong trade every time.
    const early = seg(1, 38.75, -9.20, { closesMin: 600, dwellMinutes: 30 });
    const anytime1 = seg(2, 38.70, -9.10);
    const anytime2 = seg(3, 38.70, -9.10);
    const r = orderDay([anytime1, anytime2, early], DAY, "walking", []);
    expect(r.unplaced).toHaveLength(0);
    expect(r.placements[0]!.segmentId).toBe(1);
  });

  test("dominance: placing a food segment badly beats dropping it", () => {
    // Task 6's review risk: mealDeviation only accrues for PLACED food
    // segments, so a skipped one looks free on that axis alone. This pins
    // that the combined score still refuses the drop. `food` can only be
    // placed FIRST (closesMin 600); anywhere else it is unplaceable, so an
    // ordering that puts the fillers first "cleanly" avoids mealDeviation
    // but must lose to UNPLACED_PENALTY.
    const food = seg(1, 38.71, -9.13, {
      tags: ["food"], closesMin: 600, dwellMinutes: 30,
    });
    const filler1 = seg(2, 38.71, -9.13, { dwellMinutes: 300 });
    const filler2 = seg(3, 38.71, -9.13, { dwellMinutes: 300 });
    const r = orderDay([filler1, filler2, food], DAY, "walking", []);
    expect(r.unplaced).toHaveLength(0);
    expect(r.placements[0]!.segmentId).toBe(1);
    // Placed first (09:00-09:30) is nowhere near either meal window, so this
    // is a genuinely bad placement — and it still wins over dropping it.
    expect(r.mealDeviation).toBeGreaterThan(0);
  });

  test("pulls a food segment toward a meal window", () => {
    // Same coordinates so transit cannot decide it — only the meal pull can.
    const morning = seg(1, 38.71, -9.13, { dwellMinutes: 180 });
    const food = seg(2, 38.71, -9.13, { dwellMinutes: 60, tags: ["food"] });
    const r = orderDay([food, morning], DAY, "walking", []);
    // Placing the 3h segment first lands lunch at 12:00-13:00, centred on
    // 12:30. Food first would put it at 09:00.
    expect(r.placements.map((p) => p.segmentId)).toEqual([1, 2]);
  });

  test("the meal pull decides the winner, not the tie-break", () => {
    // The earlier "pulls a food segment" test above is a false positive for
    // MEAL_WEIGHT: both candidate orderings sit at identical coordinates, so
    // transit ties at 0 either way, and the score is then a genuine tie —
    // the winner comes from strictly-less-than tie-breaking on the FIRST
    // candidate tried (ascending id order), not from mealDeviation at all.
    // Set MEAL_WEIGHT to 0 and that test still passes.
    //
    // Here the meal-optimal ordering is [block, food] (food lands on lunch,
    // deviation 0), but permutations() tries [food, block] FIRST (pool is
    // sorted ascending by id, and food has the lower id). So with the meal
    // term zeroed out, tie-break alone would hand the win to [food, block]
    // — a different, worse-timed result. Only an actually-weighted
    // mealDeviation can make [block, food] win.
    const food = seg(1, 38.71, -9.13, { tags: ["food"], dwellMinutes: 60 });
    const block = seg(2, 38.71, -9.13, { dwellMinutes: 180 });
    const r = orderDay([food, block], DAY, "walking", []);
    expect(r.placements.map((p) => p.segmentId)).toEqual([2, 1]);
    expect(r.mealDeviation).toBe(0);
  });

  test("no food segments means no meal influence", () => {
    const r = orderDay([seg(1, 38.71, -9.13), seg(2, 38.71, -9.13)], DAY, "walking", []);
    expect(r.mealDeviation).toBe(0);
    expect(r.placements).toHaveLength(2);
  });

  test("solves exactly at the EXACT_LIMIT boundary (8! = 40320 layouts)", () => {
    // The worst case the exact path ever takes on. Timed rather than merely
    // asserted correct: this is the number that has to stay "a few
    // milliseconds" for the whole suite to stay fast.
    const eight = Array.from({ length: EXACT_LIMIT }, (_, i) =>
      seg(i + 1, 38.70 + i * 0.002, -9.10));
    const started = performance.now();
    const r = orderDay(eight, DAY, "walking", []);
    const elapsedMs = performance.now() - started;
    expect(r.placements).toHaveLength(EXACT_LIMIT);
    expect(elapsedMs).toBeLessThan(2000);
  });

  test("finds the true optimum at n=5 that nearest-neighbour + 2-opt misses", () => {
    // Nothing pins the exact/heuristic boundary itself: EXACT_LIMIT could be
    // set far too low and every test above would still pass, because
    // nearest-neighbour + 2-opt (restarted from every point) usually finds
    // the same tour the exhaustive search does anyway. This is a specific,
    // empirically-found n=5 layout where it doesn't: exhaustive search
    // (used because 5 <= EXACT_LIMIT) reaches 495 minutes of transit;
    // nearest-neighbour + 2-opt, run in isolation on the same points, gets
    // stuck at 515. Bounding at 505 sits strictly between the two, so this
    // fails if EXACT_LIMIT ever drops below 5.
    const coords: [number, number][] = [
      [38.7359, -8.9049],
      [38.8582, -9.0265],
      [38.8928, -8.9475],
      [38.8195, -9.0019],
      [38.8430, -8.9660],
    ];
    const segs = coords.map(([lat, lon], i) => seg(i + 1, lat!, lon!));
    const r = orderDay(segs, DAY, "walking", []);
    expect(r.placements).toHaveLength(5);
    expect(r.transitMinutes).toBeLessThan(505);
  });

  test("handles more segments than the exact search allows", () => {
    // Above EXACT_LIMIT the heuristic takes over; it must still return a
    // complete, valid day rather than degrading into a partial one.
    const many = Array.from({ length: EXACT_LIMIT + 4 }, (_, i) =>
      seg(i + 1, 38.70 + i * 0.002, -9.10));
    const r = orderDay(many, DAY, "walking", []);
    expect(r.placements).toHaveLength(many.length);
    expect(new Set(r.placements.map((p) => p.segmentId)).size).toBe(many.length);
  });

  test("the heuristic path beats a bad construction, not just any tour", () => {
    // The existing "handles more segments" tests above only check that
    // everything gets placed and that the result is stable under input
    // reversal — a heuristic that built a poor route deterministically
    // would pass both. This is a specific, empirically-found n=9 layout
    // (not colinear, unlike the other heuristic-path tests, where 2-opt
    // alone can repair almost any construction) where nearest-neighbour
    // construction genuinely matters: the real heuristic reaches 646
    // minutes; a construction that just walks the points in their given
    // order (what you get if nearest-neighbour selection is broken) gets
    // stuck at 678 even after the same 2-opt cleanup, both with everything
    // placed. Bounding at 660 sits strictly between the two. Uses a
    // full-length day (rather than the shared DAY) purely so room is never
    // the deciding factor — this test is about route quality, not fit.
    const fullDay: DayWindow = { ...DAY, startMin: 0, endMin: 1440 };
    const coords: [number, number][] = [
      [38.8621, -8.9009], [38.8552, -9.0348], [38.7898, -9.0199],
      [38.7994, -9.0009], [38.8249, -8.9570], [38.7790, -8.9467],
      [38.8006, -9.0452], [38.7300, -9.0039], [38.8172, -9.0387],
    ];
    const segs = coords.map(([lat, lon], i) =>
      seg(i + 1, lat!, lon!, { dwellMinutes: 10 }));
    const r = orderDay(segs, fullDay, "walking", []);
    expect(r.unplaced).toHaveLength(0);
    expect(r.transitMinutes).toBeLessThan(660);
  });

  test("the heuristic path is deterministic too", () => {
    const many = Array.from({ length: EXACT_LIMIT + 4 }, (_, i) =>
      seg(i + 1, 38.70 + i * 0.002, -9.10));
    const a = orderDay(many, DAY, "walking", []);
    const b = orderDay([...many].reverse(), DAY, "walking", []);
    expect(b.placements.map((p) => p.segmentId))
      .toEqual(a.placements.map((p) => p.segmentId));
  });

  test("ties break to the first candidate tried, not the last", () => {
    // All three segments share coordinates (transit ties at 0 for every
    // permutation) and carry no food tag or time constraint (mealDeviation
    // and unplaced both tie at 0 too), so every one of the 3! = 6 candidate
    // orders scores identically. permutations() emits the pool's own
    // ascending-id order first and the fully-reversed order last, so
    // strictly-less-than tie-break must return [1, 2, 3] — a `<=` compare
    // would keep overwriting through every tie and return [3, 2, 1] instead.
    const segs = [seg(1, 38.71, -9.13), seg(2, 38.71, -9.13), seg(3, 38.71, -9.13)];
    const r = orderDay(segs, DAY, "walking", []);
    expect(r.placements.map((p) => p.segmentId)).toEqual([1, 2, 3]);
  });

  test("empty and single-segment days are valid", () => {
    expect(orderDay([], DAY, "walking", []).placements).toHaveLength(0);
    expect(orderDay([seg(1, 38.7, -9.1)], DAY, "walking", []).placements).toHaveLength(1);
  });
});

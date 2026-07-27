import { expect, test, describe } from "bun:test";
import { compile } from "@/plan/compile";
import type { Segment } from "@/segments";
import type { DayWindow } from "@/days";

function seg(
  id: number, latitude: number | null, longitude: number | null,
  o: Partial<Segment> = {},
): Segment {
  return {
    id, tripId: 1, name: `s${id}`, latitude, longitude,
    dwellMinutes: 60, cost: null, tags: [], opensMin: null,
    closesMin: null, closedDays: [], status: "confirmed", ...o,
  };
}

function days(n: number): DayWindow[] {
  const weekdays = ["sat", "sun", "mon", "tue", "wed", "thu", "fri"];
  return Array.from({ length: n }, (_, i) => ({
    day: i + 1,
    date: `2027-05-${String(8 + i).padStart(2, "0")}`,
    weekday: weekdays[i % 7]!,
    startMin: 540, endMin: 1140,
  }));
}

const OPTS = { mode: "walking" as const, pace: "normal" as const, pins: [] };

const ALFAMA = [seg(1, 38.712, -9.128), seg(2, 38.714, -9.130)];
const BELEM = [seg(3, 38.6916, -9.216), seg(4, 38.6970, -9.206)];

describe("compile", () => {
  test("every segment is either placed once or unplaced with a reason", () => {
    // THE property. Never both, never neither. This is the same shape as the
    // vanishing-month trap in M1, and it is the single test most likely to
    // catch a real compiler bug.
    const all = [...ALFAMA, ...BELEM, seg(5, null, null), seg(6, 38.79, -9.39)];
    const r = compile(all, days(2), OPTS);

    const placed = r.placements.map((p) => p.segmentId);
    const missed = r.unplaced.map((u) => u.segmentId);
    expect([...placed, ...missed].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(new Set(placed).size).toBe(placed.length);
    expect(placed.filter((id) => missed.includes(id))).toEqual([]);
    for (const u of r.unplaced) expect(u.reason.length).toBeGreaterThan(0);
  });

  test("is deterministic", () => {
    // A plan that changes between two identical runs is not reviewable.
    const all = [...ALFAMA, ...BELEM];
    expect(compile(all, days(2), OPTS)).toEqual(compile(all, days(2), OPTS));
  });

  test("input order does not change the plan", () => {
    const forward = compile([...ALFAMA, ...BELEM], days(2), OPTS);
    const reversed = compile([...BELEM, ...ALFAMA].reverse(), days(2), OPTS);
    expect(reversed).toEqual(forward);
  });

  test("a segment with no coordinates is unplaced, naming coordinates", () => {
    const r = compile([seg(1, null, null)], days(1), OPTS);
    expect(r.placements).toHaveLength(0);
    expect(r.unplaced[0]!.reason).toMatch(/coordinates/i);
  });

  test("geographic groups land on separate days", () => {
    const r = compile([...ALFAMA, ...BELEM], days(2), OPTS);
    const dayOf = (id: number) => r.placements.find((p) => p.segmentId === id)!.day;
    expect(dayOf(1)).toBe(dayOf(2));
    expect(dayOf(3)).toBe(dayOf(4));
    expect(dayOf(1)).not.toBe(dayOf(3));
  });

  test("the pace ceiling caps a day", () => {
    const many = Array.from({ length: 8 }, (_, i) => seg(i + 1, 38.71 + i * 0.001, -9.13));
    const r = compile(many, days(1), { ...OPTS, pace: "easy" });
    expect(r.placements).toHaveLength(3);
    expect(r.unplaced).toHaveLength(5);
    for (const u of r.unplaced) expect(u.reason).toMatch(/room/i);
  });

  test("the time budget caps a day independently of the count", () => {
    // Three 4-hour segments cannot fit a 10-hour day even at normal pace.
    const long = Array.from({ length: 3 }, (_, i) =>
      seg(i + 1, 38.71, -9.13, { dwellMinutes: 240 }));
    const r = compile(long, days(1), OPTS);
    expect(r.placements).toHaveLength(2);
    expect(r.unplaced).toHaveLength(1);
  });

  test("a short arrival day gets the small cluster", () => {
    // Stage 3. Without it, the 3h30 arrival day receives the Sintra day trip.
    const d = days(2);
    d[0]!.startMin = 930;  // 15:30 arrival
    const big = [seg(1, 38.712, -9.128), seg(2, 38.713, -9.129), seg(3, 38.714, -9.130)];
    const small = [seg(4, 38.79, -9.39)];
    const r = compile([...big, ...small], d, OPTS);
    expect(r.placements.find((p) => p.segmentId === 4)!.day).toBe(1);
    expect(r.placements.find((p) => p.segmentId === 1)!.day).toBe(2);
  });

  test("a pinned segment keeps its exact day and time", () => {
    const r = compile([...ALFAMA, ...BELEM], days(2), {
      ...OPTS, pins: [{ segmentId: 4, day: 1, startMin: 780 }],
    });
    const p = r.placements.find((x) => x.segmentId === 4)!;
    expect(p.day).toBe(1);
    expect(p.startMin).toBe(780);
    expect(p.pinned).toBe(true);
  });

  test("a pin survives a change of pace and mode", () => {
    const pins = [{ segmentId: 4, day: 1, startMin: 780 }];
    for (const pace of ["easy", "normal", "packed"] as const) {
      for (const mode of ["walking", "transit"] as const) {
        const r = compile([...ALFAMA, ...BELEM], days(2), { mode, pace, pins });
        const p = r.placements.find((x) => x.segmentId === 4)!;
        expect(p.day).toBe(1);
        expect(p.startMin).toBe(780);
      }
    }
  });

  test("nothing is scheduled through a pinned segment's time", () => {
    const r = compile([...ALFAMA, ...BELEM], days(2), {
      ...OPTS, pins: [{ segmentId: 4, day: 1, startMin: 600 }],
    });
    const pin = r.placements.find((x) => x.segmentId === 4)!;
    for (const p of r.placements) {
      if (p.segmentId === 4 || p.day !== pin.day) continue;
      expect(p.startMin >= pin.endMin || p.endMin <= pin.startMin).toBe(true);
    }
  });

  test("a pinned segment's ordinal reflects its true position, not its -1 placeholder", () => {
    // Stage 5 inserts a timed pin with a placeholder ordinal of -1, then
    // `finish` is supposed to renumber by sorted startMin. This is the
    // sibling of the vanishing-month bug: nothing here would fail if `finish`
    // forgot to renumber, UNLESS this test checks ordinal directly — every
    // other pin test above only asserts day/startMin/pinned.
    const r = compile([...ALFAMA, ...BELEM], days(2), {
      ...OPTS, pins: [{ segmentId: 4, day: 1, startMin: 600 }],
    });
    const dayOne = r.placements
      .filter((p) => p.day === 1)
      .sort((a, b) => a.startMin - b.startMin);
    dayOne.forEach((p, i) => expect(p.ordinal).toBe(i));
    for (const p of r.placements) expect(p.ordinal).toBeGreaterThanOrEqual(0);
  });

  test("a day-locked pin without a time stays on its day", () => {
    // This is what `trip move` produces: day fixed, time still the compiler's.
    const r = compile([...ALFAMA, ...BELEM], days(2), {
      ...OPTS, pins: [{ segmentId: 4, day: 2, startMin: null }],
    });
    expect(r.placements.find((x) => x.segmentId === 4)!.day).toBe(2);
  });

  test("day-locked pins count fully against the pace ceiling, not just as one slot", () => {
    // Regression: `room = ceiling - pinnedCount - locked.length` must subtract
    // the FULL count of day-locked segments, not fold them into `pinnedCount`
    // (which only counts already-placed timed pins) or drop the term
    // entirely. Three day-locked pins on an easy-pace (ceiling 3) day must
    // leave zero room for anything else — that day is already full.
    const locked = [
      seg(1, 38.712, -9.128), seg(2, 38.713, -9.129), seg(3, 38.714, -9.130),
    ];
    // A tight free cluster plus a distant outlier: farthest-point seeding
    // reliably puts the cluster and the outlier in separate clusters, so
    // whichever cluster lands on day 1 has at least one member — enough to
    // break the ceiling if `locked.length` is dropped from `room`.
    const freeCluster = [
      seg(4, 38.6916, -9.216), seg(5, 38.692, -9.2155), seg(6, 38.691, -9.2165),
    ];
    const outlier = [seg(7, 38.79, -9.39)];
    const pins = [1, 2, 3].map((segmentId) => ({ segmentId, day: 1, startMin: null }));

    const r = compile([...locked, ...freeCluster, ...outlier], days(2), {
      mode: "walking", pace: "easy", pins,
    });

    const byDay = new Map<number, number>();
    for (const p of r.placements) byDay.set(p.day, (byDay.get(p.day) ?? 0) + 1);
    for (const [, count] of byDay) expect(count).toBeLessThanOrEqual(3);

    // The day lock itself must still be honoured.
    for (const id of [1, 2, 3]) {
      expect(r.placements.find((p) => p.segmentId === id)!.day).toBe(1);
    }
  });

  // F8: the "pace ceiling caps a day" test above hits stage 2's overflow
  // (clusterSegments itself has nowhere else to put the excess, with only
  // one day/cluster in play) -- that message is already accurate, every
  // other cluster genuinely was tried. This constructs the OTHER site: a
  // cluster that fits clusterSegments' own capacity gets committed whole to
  // a day by stage 3, and only THEN does the per-day ceiling trim it because
  // a day-locked pin sharing that day already ate into the room. That
  // segment was never offered to any other day.
  test("a segment trimmed by the per-day ceiling names the day and says it was not tried elsewhere", () => {
    const locked = [seg(1, 38.712, -9.128)]; // day-locked pin, eats 1 of 3 easy-pace slots
    const freeCluster = [seg(2, 38.6916, -9.216), seg(3, 38.692, -9.2155), seg(4, 38.691, -9.2165)];
    const pins = [{ segmentId: 1, day: 1, startMin: null }];
    const r = compile([...locked, ...freeCluster], days(1), { mode: "walking", pace: "easy", pins });

    expect(r.unplaced).toHaveLength(1);
    expect(r.unplaced[0]!.reason).toMatch(/room/i);
    expect(r.unplaced[0]!.reason).toContain("day 1");
    expect(r.unplaced[0]!.reason.toLowerCase()).toContain("not tried on another day");
  });

  test("a pin to a day outside the trip is unplaced, not clamped", () => {
    // Silently moving it to the last day would be a lie about what was asked.
    const r = compile(ALFAMA, days(2), {
      ...OPTS, pins: [{ segmentId: 1, day: 9, startMin: 600 }],
    });
    expect(r.unplaced.find((u) => u.segmentId === 1)!.reason).toMatch(/outside the trip/i);
  });

  test("zero days places nothing and blames the dates", () => {
    const r = compile(ALFAMA, [], OPTS);
    expect(r.placements).toHaveLength(0);
    expect(r.unplaced).toHaveLength(2);
  });

  test("no segments yields an empty plan without throwing", () => {
    expect(compile([], days(3), OPTS)).toEqual({ placements: [], unplaced: [] });
  });

  test("placements are sorted by day then ordinal", () => {
    const r = compile([...ALFAMA, ...BELEM], days(2), OPTS);
    for (let i = 1; i < r.placements.length; i++) {
      const prev = r.placements[i - 1]!;
      const cur = r.placements[i]!;
      expect(cur.day > prev.day || (cur.day === prev.day && cur.ordinal > prev.ordinal))
        .toBe(true);
    }
  });
});

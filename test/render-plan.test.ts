import { expect, test, describe } from "bun:test";
import { renderDay, renderPlan, renderSegmentList } from "@/render-plan";
import type { Segment } from "@/segments";
import type { DayWindow } from "@/days";
import type { Placement } from "@/plan/types";

function seg(id: number, o: Partial<Segment> = {}): Segment {
  return {
    id, tripId: 1, name: `s${id}`, localName: null, latitude: 38.7, longitude: -9.1,
    dwellMinutes: 60, dwellIsDefault: false, cost: null, tags: [], opensMin: null,
    closesMin: null, closedDays: [], status: "confirmed",
    sourceId: null, sourceAtSeconds: null, ...o,
  };
}

const DAY: DayWindow = {
  day: 1, date: "2027-05-08", weekday: "sat", startMin: 540, endMin: 1140,
};

function place(segmentId: number, startMin: number, endMin: number, pinned = false): Placement {
  return { segmentId, day: 1, ordinal: 0, startMin, endMin, pinned };
}

// These placements reference a segmentId that is deliberately absent from
// the segments map passed in — the shape the compiler and readPlacements can
// both legitimately produce if a segment was removed after a plan compiled,
// or (in renderPlan's case) if the caller's segment list and placement list
// simply disagree. F6, three findings, all in the same "unreachable via the
// CLI today, but the failure direction matters" category the review flagged.
describe("renderDay: a placement whose segment cannot be found (F6)", () => {
  test("is rendered, not silently dropped", () => {
    // Before the fix this was `if (!s) continue`, which vanished the line
    // entirely — the day looked shorter than it really was, no sign anything
    // was omitted.
    const out = renderDay(DAY, [place(99, 600, 660)], new Map());
    expect(out).toContain("#99");
    expect(out).not.toContain("(nothing planned)");
  });

  test("still reports the real dwell time, computed from the placement itself", () => {
    const out = renderDay(DAY, [place(99, 600, 690)], new Map());
    expect(out).toContain("90m");
  });

  test("does not fabricate the '?' unknown-hours mark for a segment it cannot look up", () => {
    // Whether hours are known is itself unknowable here — no mark either way,
    // not a guess.
    const out = renderDay(DAY, [place(99, 600, 660)], new Map());
    const line = out.split("\n").find((l) => l.includes("#99"))!;
    expect(line).not.toContain("?");
  });

  test("a known segment on the same day is unaffected", () => {
    const out = renderDay(
      DAY,
      [place(1, 600, 660), place(99, 700, 760)],
      new Map([[1, seg(1, { name: "Alfama" })]]),
    );
    expect(out).toContain("Alfama");
    expect(out).toContain("#99");
  });
});

describe("renderPlan: blind-placement count (F6)", () => {
  test("counts a placement whose segment cannot be found as blind, not zero", () => {
    // Before the fix, `byId.get(...)?.opensMin === null` is FALSE when the
    // segment is missing (undefined?.opensMin is undefined, not null), which
    // undercounts the exact thing this warning exists to catch.
    const out = renderPlan([DAY], [place(99, 600, 660)], [], []);
    expect(out).toContain("1 segment placed without opening hours");
  });

  test("a segment with known hours is not counted as blind", () => {
    const out = renderPlan(
      [DAY], [place(1, 600, 660)], [seg(1, { opensMin: 540, closesMin: 1200 })], [],
    );
    expect(out).not.toContain("placed without opening hours");
  });
});

describe("renderSegmentList: known open time with unknown close time (F7)", () => {
  test("marks the close side unknown rather than fabricating 23:59", () => {
    // --hours requires both ends today, so this shape is only reachable by
    // constructing the Segment directly (M3's partial-hours ingestion will
    // make it CLI-reachable) — closesMin is independently nullable in the
    // schema regardless of what the current CLI enforces.
    const out = renderSegmentList([seg(1, { name: "Cafe", opensMin: 540, closesMin: null })]);
    expect(out).not.toContain("23:59");
    expect(out).toContain("09:00-?");
  });

  test("both known still renders the real window", () => {
    const out = renderSegmentList([seg(1, { name: "Cafe", opensMin: 540, closesMin: 1080 })]);
    expect(out).toContain("09:00-18:00");
  });
});

describe("renderSegmentList: local name and defaulted dwell", () => {
  test("a local name is shown beside the video's words, not instead of them", () => {
    const out = renderSegmentList([
      seg(1, { name: "Hongya Cave", localName: "洪崖洞" }),
    ]);
    expect(out).toContain("Hongya Cave (洪崖洞)");
  });

  test("a segment with no local name renders unchanged", () => {
    const out = renderSegmentList([seg(1, { name: "Time Out Market" })]);
    expect(out).toContain("Time Out Market");
    expect(out).not.toContain("(");
  });

  test("a defaulted dwell is marked, and not with the unknown-hours question mark", () => {
    const out = renderSegmentList([seg(1, { dwellMinutes: 60, dwellIsDefault: true })]);
    expect(out).toContain("[default]");
  });

  test("a supplied dwell carries no marker", () => {
    expect(renderSegmentList([seg(1, { dwellMinutes: 90 })])).not.toContain("[default]");
  });

  test("the day view marks a defaulted dwell too", () => {
    const out = renderDay(
      DAY,
      [place(1, 600, 660)],
      new Map([[1, seg(1, {
        name: "Hongya Cave", localName: "洪崖洞",
        dwellMinutes: 60, dwellIsDefault: true,
      })]]),
    );
    expect(out).toContain("[default]");
    expect(out).toContain("(洪崖洞)");
  });
});

import { expect, test, describe } from "bun:test";
import { renderDay, renderPlan, renderSegmentList } from "@/render-plan";
import type { Segment } from "@/segments";
import type { DayWindow } from "@/days";
import type { Placement } from "@/plan/types";

function seg(id: number, o: Partial<Segment> = {}): Segment {
  return {
    id, tripId: 1, name: `s${id}`, localName: null, latitude: 38.7, longitude: -9.1,
    dwellMinutes: 60, dwellIsDefault: false, freeDays: [], tags: [], opensMin: null,
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

// ---------------------------------------------------------------------------
// M5 — prices, totals and the per-traveller breakdown.
// ---------------------------------------------------------------------------

import { resolveParty } from "@/pricing/party";
import { parsePriceRule } from "@/pricing/rules";
import type { PlanPricing } from "@/render-plan";

const PARTY = [
  { id: 1, label: "Eric", birthDate: "1971-06-02" },
  { id: 2, label: "Mom", birthDate: "1949-03-14" },
  { id: 3, label: "Kid", birthDate: "2015-11-20" },
];

/** Luohan-shaped: 10 base, seniors and children free -> party 10.
 *  Hongya-shaped: 20 base, seniors free, children 10 -> party 30.
 *  Segment 3 carries no rules at all -> unknown. */
function pricing(o: Partial<PlanPricing> = {}): PlanPricing {
  const on = DAY.date;
  return {
    currency: "CNY",
    bySegment: new Map([
      [1, resolveParty(
        [parsePriceRule("10"), parsePriceRule("65+:0"), parsePriceRule("0-11:0")],
        PARTY, on)],
      [2, resolveParty(
        [parsePriceRule("20"), parsePriceRule("65+:0"), parsePriceRule("0-11:10")],
        PARTY, on)],
      [3, resolveParty([], PARTY, on)],
    ]),
    passes: [],
    travellers: PARTY,
    ...o,
  };
}

const SEGS = new Map([[1, seg(1)], [2, seg(2)], [3, seg(3)]]);
const PLACED = [place(1, 540, 600), place(2, 660, 720), place(3, 780, 840)];

describe("renderDay with pricing", () => {
  test("a day total sums the party prices and counts unknowns separately", () => {
    const out = renderDay(DAY, PLACED, SEGS, [], pricing());
    expect(out).toMatch(/Day 1 total\s+CNY 40 \+ 1 unknown/);
  });

  test("the per-traveller breakdown sums to the day total", () => {
    // THE headline invariant. Asserted on the rendered strings so a renderer
    // that computes its own total cannot pass.
    const out = renderDay(DAY, PLACED, SEGS, [], pricing(), true);
    const total = Number(/Day 1 total\s+CNY (\d+)/.exec(out)![1]);
    const rows = [...out.matchAll(/age \d+\s+(?:CNY )?(\d+|free)\s*$/gm)]
      .map((m) => (m[1] === "free" ? 0 : Number(m[1])));
    expect(rows.length).toBe(3);
    expect(rows.reduce((a, b) => a + b, 0)).toBe(total);
  });

  test("an unpriced segment drops from EVERY traveller's row, not just the total", () => {
    // Propagating unknown per traveller would render three "?" rows under a
    // numeric day total, and the invariant above would fail. The two sums
    // agree only if both drop the same segments.
    const out = renderDay(DAY, PLACED, SEGS, [], pricing(), true);
    expect(out).toMatch(/Eric.*CNY 30/);
    expect(out).toMatch(/Mom.*free/);
    expect(out).toMatch(/Kid.*CNY 10/);
    expect(out).toMatch(/\+ 1 unknown/);
  });

  test("a segment priced for SOME travellers is unknown for all of them", () => {
    // 65+:0 alone says seniors are free and says nothing about anyone else,
    // so the party total is unknown and the segment leaves Mom's row too --
    // even though her free admission there is perfectly well known.
    const seniorOnly = pricing({
      bySegment: new Map([[1, resolveParty([parsePriceRule("65+:0")], PARTY, DAY.date)]]),
    });
    const out = renderDay(DAY, [place(1, 540, 600)], SEGS, [], seniorOnly, true);
    expect(out).toMatch(/Day 1 total\s+\? \+ 1 unknown/);
    expect(out).toMatch(/Mom.*free\s*$/m);
    // Mom's row is her sum over PRICED segments, of which there are none.
    expect(out).not.toMatch(/Mom.*CNY/);
  });

  test("an unknown price renders ? and never 0", () => {
    const none = pricing({
      bySegment: new Map([[1, resolveParty([], PARTY, DAY.date)]]),
    });
    const out = renderDay(DAY, [place(1, 540, 600)], SEGS, [], none);
    expect(out).toContain("?");
    expect(out).not.toMatch(/CNY 0\b/);
  });

  test("a real zero renders 'free' as a line item", () => {
    const free = pricing({
      bySegment: new Map([[1, resolveParty([parsePriceRule("0")], PARTY, DAY.date)]]),
    });
    expect(renderDay(DAY, [place(1, 540, 600)], SEGS, [], free)).toContain("free");
  });

  test("a TOTAL of zero renders the numeral, never the word free", () => {
    // "Day 1 total free + 2 unknown" reads as a contradiction, and a total is
    // an arithmetic result rather than a statement about a venue.
    const free = pricing({
      bySegment: new Map([[1, resolveParty([parsePriceRule("0")], PARTY, DAY.date)]]),
    });
    const out = renderDay(DAY, [place(1, 540, 600)], SEGS, [], free);
    expect(out).toMatch(/Day 1 total\s+CNY 0/);
    expect(out).not.toMatch(/Day 1 total\s+free/);
  });

  test("a day with nothing planned costs 0, not unknown", () => {
    // Nothing to price is not the same as not knowing the price: there is no
    // unpriced thing for the number to be hiding.
    const out = renderDay(DAY, [], SEGS, [], pricing());
    expect(out).toMatch(/Day 1 total\s+CNY 0/);
    expect(out).not.toMatch(/Day 1 total\s+\?/);
  });

  test("a null currency renders bare numbers, as before M5", () => {
    const out = renderDay(DAY, PLACED, SEGS, [], pricing({ currency: null }));
    expect(out).toMatch(/Day 1 total\s+40 \+ 1 unknown/);
    expect(out).not.toContain("CNY");
  });

  test("trip plan omits the breakdown that trip day shows", () => {
    const overview = renderDay(DAY, PLACED, SEGS, [], pricing());
    const detail = renderDay(DAY, PLACED, SEGS, [], pricing(), true);
    expect(overview).not.toContain("b.1949-03-14");
    expect(detail).toContain("b.1949-03-14");
  });

  test("with no pricing supplied the output is unchanged from before M5", () => {
    const out = renderDay(DAY, PLACED, SEGS);
    expect(out).not.toContain("total");
    expect(out).not.toContain("CNY");
  });

  test("a known price and unknown hours are both shown, unambiguously", () => {
    const segs = new Map([[1, seg(1, { opensMin: null })]]);
    const out = renderDay(DAY, [place(1, 540, 600)], segs, [], pricing());
    expect(out).toMatch(/CNY 10\s+\?/);
  });
});

describe("renderPlan with pricing", () => {
  const DAYS = [DAY];

  test("the footer separates admission from passes and combines them", () => {
    const withPass = pricing({
      passes: [{
        pass: { id: 1, tripId: 1, name: "Metro", fromDay: 1, toDay: 3 },
        price: resolveParty([parsePriceRule("45"), parsePriceRule("65+:0")], PARTY, DAY.date),
      }],
    });
    const out = renderPlan(DAYS, PLACED, [seg(1), seg(2), seg(3)], [], withPass);
    expect(out).toMatch(/Admission\s+CNY 40 \+ 1 unknown/);
    expect(out).toMatch(/Passes\s+CNY 90/);
    expect(out).toMatch(/Trip total\s+CNY 130 \+ 1 unknown/);
  });

  test("a pass names its day range and is NOT spread across those days", () => {
    // No single day costs a third of a three-day pass, and an average is not
    // a fact. The pass appears once, on its own line.
    const withPass = pricing({
      passes: [{
        pass: { id: 1, tripId: 1, name: "Metro", fromDay: 1, toDay: 3 },
        price: resolveParty([parsePriceRule("45"), parsePriceRule("65+:0")], PARTY, DAY.date),
      }],
    });
    const out = renderPlan(DAYS, PLACED, [seg(1), seg(2), seg(3)], [], withPass);
    expect(out).toMatch(/Metro\s+days 1-3\s+CNY 90/);
    // The day total is admission only -- 40, not 40 + any slice of the pass.
    expect(out).toMatch(/Day 1 total\s+CNY 40 \+ 1 unknown/);
  });

  test("a pass with an unmatched traveller is unknown, not a partial sum", () => {
    const withPass = pricing({
      passes: [{
        pass: { id: 1, tripId: 1, name: "Metro", fromDay: 1, toDay: 3 },
        price: resolveParty([parsePriceRule("65+:0")], PARTY, DAY.date),
      }],
    });
    const out = renderPlan(DAYS, PLACED, [seg(1), seg(2), seg(3)], [], withPass);
    expect(out).toMatch(/Metro\s+days 1-3\s+\?/);
    expect(out).toMatch(/Passes\s+\? \+ 1 unknown/);
  });

  test("no travellers means no prices, and it names the fix", () => {
    const empty = pricing({ travellers: [], bySegment: new Map() });
    const out = renderPlan(DAYS, PLACED, [seg(1)], [], empty);
    expect(out).toContain("No travellers set");
    expect(out).toContain("trip who add");
    expect(out).not.toMatch(/Trip total/);
  });

  test("with no pricing supplied renderPlan is unchanged from before M5", () => {
    const out = renderPlan(DAYS, PLACED, [seg(1), seg(2), seg(3)], []);
    expect(out).not.toContain("Trip total");
    expect(out).not.toContain("Admission");
  });
});

describe("renderSegmentList with rules", () => {
  test("shows a segment's RULES, never a resolved price", () => {
    // An unplaced segment has no date, so no age, so no price (M5-8).
    const rules = new Map([[1, [parsePriceRule("30"), parsePriceRule("65+:0")]]]);
    const out = renderSegmentList([seg(1)], rules);
    expect(out).toContain("all ages:30");
    expect(out).toContain("65+:0");
    expect(out).not.toContain("CNY");
  });

  test("a segment with no rules gets no price mark at all", () => {
    // NOT "?" -- that character already means unknown HOURS on this line, and
    // two meanings for one mark is how a reader learns to ignore it.
    const out = renderSegmentList([seg(1, { opensMin: 600, closesMin: 1080 })]);
    expect(out).not.toContain("?");
  });

  test("free days are shown", () => {
    const out = renderSegmentList([seg(1, { freeDays: ["tue"] })]);
    expect(out).toContain("free tue");
  });
});

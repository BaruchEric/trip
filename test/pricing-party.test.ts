import { test, expect, describe } from "bun:test";
import { ageOn, resolveParty, type PartyMember } from "@/pricing/party";
import { parsePriceRule } from "@/pricing/rules";

const ERIC: PartyMember = { id: 1, label: "Eric", birthDate: "1971-06-02" };
const MOM: PartyMember  = { id: 2, label: "Mom",  birthDate: "1949-03-14" };
const KID: PartyMember  = { id: 3, label: "Kid",  birthDate: "2015-11-20" };

describe("ageOn", () => {
  test("counts completed years", () => {
    expect(ageOn("1971-06-02", "2026-10-03")).toBe(55);
  });

  test("the day before a birthday is still the younger age", () => {
    expect(ageOn("1961-10-04", "2026-10-03")).toBe(64);
  });

  test("the birthday itself counts", () => {
    expect(ageOn("1961-10-04", "2026-10-04")).toBe(65);
  });

  test("uses UTC, so it does not shift across a DST boundary", () => {
    // days.ts derives dates in UTC for exactly this reason; ageOn must agree
    // with it or a segment could price against a different day than it is
    // scheduled on.
    expect(ageOn("2000-03-29", "2026-03-29")).toBe(26);
  });

  test("a malformed birth date is named, not silently NaN", () => {
    expect(() => ageOn("not-a-date", "2026-10-03")).toThrow(/invalid birth date/);
  });

  test("a malformed target date is named", () => {
    expect(() => ageOn("1971-06-02", "nonsense")).toThrow(/invalid date/);
  });

  test("a birth date after the visit is an error, not a negative age", () => {
    // A negative age would silently match an unbounded base rule and bill a
    // not-yet-born traveller full price.
    expect(() => ageOn("2030-01-01", "2026-10-03")).toThrow(/after/);
  });

  test("born on the visit date is age 0, not an error", () => {
    expect(ageOn("2026-10-03", "2026-10-03")).toBe(0);
  });
});

describe("resolveParty", () => {
  const rules = [parsePriceRule("20"), parsePriceRule("65+:0"), parsePriceRule("0-11:10")];

  test("prices each traveller by their age on the day", () => {
    const p = resolveParty(rules, [ERIC, MOM, KID], "2026-10-03");
    expect(p.perTraveller.map((t) => [t.label, t.age, t.price])).toEqual([
      ["Eric", 55, 20],
      ["Mom", 77, 0],
      ["Kid", 10, 10],
    ]);
    expect(p.total).toBe(30);
  });

  test("ONE unmatched traveller makes the whole party total unknown", () => {
    // Decision 3. The tempting implementation -- sum the matches, drop the
    // rest -- yields 0 here and reads as a free segment.
    const seniorOnly = [parsePriceRule("65+:0")];
    const p = resolveParty(seniorOnly, [ERIC, MOM], "2026-10-03");
    expect(p.total).toBeNull();
    expect(p.perTraveller.find((t) => t.label === "Eric")!.price).toBeNull();
    expect(p.perTraveller.find((t) => t.label === "Mom")!.price).toBe(0);
  });

  test("no rules at all is unknown, never free", () => {
    const p = resolveParty([], [ERIC], "2026-10-03");
    expect(p.total).toBeNull();
    expect(p.perTraveller[0]!.price).toBeNull();
  });

  test("an empty party is unknown, not zero", () => {
    const p = resolveParty(rules, [], "2026-10-03");
    expect(p.perTraveller).toEqual([]);
    expect(p.total).toBeNull();
  });

  test("a free day zeroes everyone, overriding every age rule", () => {
    const p = resolveParty(rules, [ERIC, MOM, KID], "2026-10-03", true);
    expect(p.perTraveller.map((t) => t.price)).toEqual([0, 0, 0]);
    expect(p.total).toBe(0);
  });

  test("a free day makes a segment with NO rules free, not unknown", () => {
    // The free day is itself the statement of price, so it stands alone.
    const p = resolveParty([], [ERIC], "2026-10-03", true);
    expect(p.total).toBe(0);
  });

  test("a total of 0 is a real total, distinguishable from unknown", () => {
    const allFree = [parsePriceRule("0")];
    const p = resolveParty(allFree, [ERIC], "2026-10-03");
    expect(p.total).toBe(0);
    expect(p.total).not.toBeNull();
  });

  test("a birthday inside the trip window changes the price mid-trip", () => {
    // The single most important test in the milestone: it fails the instant
    // anyone caches an age anywhere in the pipeline.
    const turns65 = { id: 9, label: "Nearly", birthDate: "1961-10-04" };
    const banded = [parsePriceRule("30"), parsePriceRule("65+:0")];
    expect(resolveParty(banded, [turns65], "2026-10-03").total).toBe(30);
    expect(resolveParty(banded, [turns65], "2026-10-04").total).toBe(0);
  });

  test("the per-traveller ages are reported, so a renderer need not recompute", () => {
    const p = resolveParty(rules, [MOM], "2026-10-03");
    expect(p.perTraveller[0]!.age).toBe(77);
    expect(p.perTraveller[0]!.id).toBe(2);
  });
});

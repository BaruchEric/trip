import { test, expect, describe } from "bun:test";
import {
  parsePriceRule, formatRule, validateRuleSet, matchRule,
} from "@/pricing/rules";

describe("parsePriceRule", () => {
  test("a bare number is the unbounded base rule", () => {
    expect(parsePriceRule("30")).toEqual({ minAge: null, maxAge: null, price: 30 });
  });

  test("N-M is bounded both ways", () => {
    expect(parsePriceRule("60-64:15")).toEqual({ minAge: 60, maxAge: 64, price: 15 });
  });

  test("N+ is bounded below only", () => {
    expect(parsePriceRule("65+:0")).toEqual({ minAge: 65, maxAge: null, price: 0 });
  });

  test("under-six-free needs no new syntax", () => {
    expect(parsePriceRule("0-5:0")).toEqual({ minAge: 0, maxAge: 5, price: 0 });
  });

  test("an empty price is rejected, not read as 0", () => {
    // Number("") is 0, not NaN -- the same trap `--cost=` hit in M2 (F5).
    // Silently storing a real 0 here would say a place is FREE.
    expect(() => parsePriceRule("65+:")).toThrow(/invalid price/);
  });

  test("a range with no price names the problem", () => {
    expect(() => parsePriceRule("65+")).toThrow(/no price/);
  });

  test("a non-numeric price is rejected", () => {
    expect(() => parsePriceRule("abc")).toThrow(/invalid price/);
  });

  test("a negative price is rejected", () => {
    expect(() => parsePriceRule("60-64:-5")).toThrow(/negative price/);
  });

  test("a backwards range is rejected, naming it", () => {
    expect(() => parsePriceRule("64-60:5")).toThrow(/ends before it starts/);
  });

  test("a malformed range names the expected forms", () => {
    expect(() => parsePriceRule("sixty+:5")).toThrow(/expected N-M, N\+/);
  });

  test("an empty string is rejected", () => {
    expect(() => parsePriceRule("   ")).toThrow(/empty/);
  });

  test("a non-finite price is rejected", () => {
    expect(() => parsePriceRule("Infinity")).toThrow(/invalid price/);
  });
});

describe("validateRuleSet", () => {
  test("a base rule alongside a bounded rule is fine", () => {
    // THE case the whole grammar exists for. An unbounded rule overlaps every
    // age by definition, so a uniform overlap check would reject this.
    const rules = [parsePriceRule("30"), parsePriceRule("65+:0")];
    expect(() => validateRuleSet(rules)).not.toThrow();
  });

  test("two bounded rules that overlap are rejected, naming both", () => {
    const rules = [parsePriceRule("60-70:15"), parsePriceRule("65+:0")];
    expect(() => validateRuleSet(rules)).toThrow(/60-70:15/);
    expect(() => validateRuleSet(rules)).toThrow(/65\+:0/);
  });

  test("adjacent bounded rules do not overlap", () => {
    const rules = [parsePriceRule("0-5:0"), parsePriceRule("6-64:30"), parsePriceRule("65+:0")];
    expect(() => validateRuleSet(rules)).not.toThrow();
  });

  test("two unbounded rules are rejected", () => {
    expect(() => validateRuleSet([parsePriceRule("30"), parsePriceRule("40")]))
      .toThrow(/one base price/);
  });

  test("a non-finite price is rejected at the set level too", () => {
    // parsePriceRule guards the CLI path; this guards every OTHER writer.
    expect(() => validateRuleSet([{ minAge: null, maxAge: null, price: Infinity }]))
      .toThrow(/invalid price/);
  });

  test("a negative price is rejected at the set level too", () => {
    expect(() => validateRuleSet([{ minAge: null, maxAge: null, price: -1 }]))
      .toThrow(/negative price/);
  });

  test("a fractional age bound is rejected", () => {
    expect(() => validateRuleSet([{ minAge: 6.5, maxAge: null, price: 1 }]))
      .toThrow(/invalid age/);
  });

  test("a negative age bound is rejected", () => {
    expect(() => validateRuleSet([{ minAge: -1, maxAge: null, price: 1 }]))
      .toThrow(/invalid age/);
  });

  test("a backwards range is rejected at the set level too", () => {
    expect(() => validateRuleSet([{ minAge: 64, maxAge: 60, price: 1 }]))
      .toThrow(/ends before it starts/);
  });

  test("an empty rule set is valid -- it just means unknown", () => {
    expect(() => validateRuleSet([])).not.toThrow();
  });
});

describe("matchRule", () => {
  const rules = [parsePriceRule("30"), parsePriceRule("0-5:0"), parsePriceRule("65+:10")];

  test("a bounded rule beats the unbounded base", () => {
    expect(matchRule(rules, 70)?.price).toBe(10);
    expect(matchRule(rules, 3)?.price).toBe(0);
  });

  test("the base applies where no bounded rule matches", () => {
    expect(matchRule(rules, 40)?.price).toBe(30);
  });

  test("no base and no bounded match is null, NOT a fallback price", () => {
    // Decision 3: a segment carrying only `65+:0` says seniors are free and
    // says NOTHING about anyone else.
    const seniorOnly = [parsePriceRule("65+:0")];
    expect(matchRule(seniorOnly, 40)).toBeNull();
    expect(matchRule(seniorOnly, 70)?.price).toBe(0);
  });

  test("boundaries are inclusive on both ends", () => {
    const banded = [parsePriceRule("60-64:15")];
    expect(matchRule(banded, 59)).toBeNull();
    expect(matchRule(banded, 60)?.price).toBe(15);
    expect(matchRule(banded, 64)?.price).toBe(15);
    expect(matchRule(banded, 65)).toBeNull();
  });

  test("an empty rule set matches nothing", () => {
    expect(matchRule([], 40)).toBeNull();
  });
});

describe("formatRule", () => {
  test("round-trips the three grammar forms", () => {
    expect(formatRule(parsePriceRule("30"))).toBe("all ages:30");
    expect(formatRule(parsePriceRule("60-64:15"))).toBe("60-64:15");
    expect(formatRule(parsePriceRule("65+:0"))).toBe("65+:0");
  });

  test("renders a max-only rule the database can hold but the grammar cannot write", () => {
    expect(formatRule({ minAge: null, maxAge: 17, price: 0 })).toBe("0-17:0");
  });
});

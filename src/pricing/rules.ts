/** The price-rule grammar and its resolution.
 *
 *  Pure by design: no database, no clock, no I/O. Everything here is a
 *  function of its arguments, which is what makes the age-boundary and
 *  unknown-propagation tests cheap enough to write exhaustively. */

export interface PriceRule {
  /** null is unbounded on that side. Both null is the BASE rule, which is a
   *  fallback rather than a peer -- see `matchRule` and `validateRuleSet`. */
  minAge: number | null;
  maxAge: number | null;
  /** Never null, and never negative. 0 means free. UNKNOWN is the ABSENCE of
   *  a rule, never a null price -- a null price would be a row asserting that
   *  a price exists while refusing to say what it is. */
  price: number;
}

const RANGE = /^(\d+)(?:-(\d+)|\+)$/;

/** `30` | `60-64:15` | `65+:0`. Under-six-free is `0-5:0`: ages are
 *  non-negative so `N-M` already says it, and a `<6` spelling would need
 *  shell quoting because `<` is a zsh metacharacter anywhere in a word. */
export function parsePriceRule(raw: string): PriceRule {
  const s = raw.trim();
  if (s === "") throw new Error("invalid price rule: empty");

  const colon = s.lastIndexOf(":");
  const rangeRaw = colon === -1 ? "" : s.slice(0, colon);
  const priceRaw = colon === -1 ? s : s.slice(colon + 1);

  // A bare range with no price is a common typo and deserves its own message
  // rather than "invalid price 65+", which points at the wrong half.
  if (colon === -1 && RANGE.test(s)) {
    throw new Error(`age range "${s}" has no price (expected "${s}:<price>")`);
  }

  // Number("") is 0, not NaN. Storing that would say the place is FREE --
  // the same trap `--cost=` hit in M2, recorded as F5 in commands/segments.ts.
  if (priceRaw.trim() === "") {
    throw new Error(`invalid price in "${raw}" (empty)`);
  }
  const price = Number(priceRaw);
  if (!Number.isFinite(price)) {
    throw new Error(`invalid price "${priceRaw}" in "${raw}"`);
  }
  if (price < 0) {
    throw new Error(`negative price "${priceRaw}" in "${raw}"`);
  }

  if (rangeRaw === "") return { minAge: null, maxAge: null, price };

  const m = RANGE.exec(rangeRaw);
  if (!m) {
    throw new Error(
      `invalid age range "${rangeRaw}" in "${raw}" ` +
      `(expected N-M, N+, or no range at all)`,
    );
  }
  const minAge = Number(m[1]);
  const maxAge = m[2] === undefined ? null : Number(m[2]);
  if (maxAge !== null && maxAge < minAge) {
    throw new Error(`age range "${rangeRaw}" ends before it starts`);
  }
  return { minAge, maxAge, price };
}

export function formatRule(r: PriceRule): string {
  const range =
    r.minAge === null && r.maxAge === null ? "all ages"
    : r.maxAge === null ? `${r.minAge}+`
    // A max-only rule is unreachable through the grammar but perfectly
    // storable, so it is rendered rather than crashing a reader.
    : r.minAge === null ? `0-${r.maxAge}`
    : `${r.minAge}-${r.maxAge}`;
  return `${range}:${r.price}`;
}

function isBounded(r: PriceRule): boolean {
  return r.minAge !== null || r.maxAge !== null;
}

/** Every check that must hold no matter which caller wrote the rules. The
 *  CLI parser enforces most of these, which is exactly why they would be
 *  unreachable defects the moment `ingest` starts writing prices -- the same
 *  shape as the M3 bugs that put `validate()` into segments.ts. */
export function validateRuleSet(rules: PriceRule[]): void {
  for (const r of rules) {
    if (!Number.isFinite(r.price)) {
      throw new Error(`invalid price ${r.price} (expected a finite number)`);
    }
    if (r.price < 0) {
      throw new Error(`negative price ${r.price}`);
    }
    for (const [side, v] of [["min", r.minAge], ["max", r.maxAge]] as const) {
      if (v === null) continue;
      if (!Number.isInteger(v) || v < 0) {
        throw new Error(
          `invalid age ${v} for ${side} bound (expected a whole number >= 0)`,
        );
      }
    }
    if (r.minAge !== null && r.maxAge !== null && r.maxAge < r.minAge) {
      throw new Error(`age range ${r.minAge}-${r.maxAge} ends before it starts`);
    }
  }

  const base = rules.filter((r) => !isBounded(r));
  if (base.length > 1) {
    throw new Error(
      `${base.length} unbounded price rules (${base.map(formatRule).join(", ")}); ` +
      `only one base price is allowed`,
    );
  }

  // Bounded rules ONLY. The base rule overlaps every possible age by
  // definition, so including it here would reject `--price=30 --price=65+:0`
  // -- the most common rule set the grammar has. Decision 2 of the spec.
  const bounded = rules.filter(isBounded);
  for (let i = 0; i < bounded.length; i++) {
    for (let j = i + 1; j < bounded.length; j++) {
      const a = bounded[i]!;
      const b = bounded[j]!;
      const aMin = a.minAge ?? 0;
      const aMax = a.maxAge ?? Infinity;
      const bMin = b.minAge ?? 0;
      const bMax = b.maxAge ?? Infinity;
      if (aMin <= bMax && bMin <= aMax) {
        throw new Error(
          `overlapping price rules: ${formatRule(a)} and ${formatRule(b)}`,
        );
      }
    }
  }
}

/** The rule that applies at `age`, or null when none does.
 *
 *  A bounded rule wins over the base; the base applies only where no bounded
 *  rule matches. Returning null is a real answer -- it means UNKNOWN, and the
 *  caller must not substitute a nearby price for it. */
export function matchRule(rules: PriceRule[], age: number): PriceRule | null {
  const hit = rules.filter(isBounded).find(
    (r) =>
      (r.minAge === null || age >= r.minAge) &&
      (r.maxAge === null || age <= r.maxAge),
  );
  if (hit) return hit;
  return rules.find((r) => !isBounded(r)) ?? null;
}

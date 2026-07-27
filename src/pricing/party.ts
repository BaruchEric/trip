/** Age derivation and party pricing. Pure: the caller supplies the date, so
 *  nothing here reads a clock.
 *
 *  Ages are DERIVED here and stored nowhere. A stored age is a claim about a
 *  date nobody recorded -- a 64 written while planning is a 65 by the trip,
 *  and the row cannot tell you which. */

import { matchRule, type PriceRule } from "@/pricing/rules";

/** Structural, deliberately not the `Traveller` storage row: this module must
 *  not depend on the database layer. */
export interface PartyMember {
  id: number;
  label: string;
  birthDate: string;
}

export interface TravellerPrice {
  id: number;
  label: string;
  age: number;
  /** null means UNKNOWN -- no rule covered this traveller. Never 0 for that
   *  case; 0 is a real price meaning free. */
  price: number | null;
}

export interface PartyPrice {
  perTraveller: TravellerPrice[];
  /** null when ANY traveller is unmatched, and when the party is empty.
   *
   *  Summing the travellers who did match and dropping the one who did not
   *  produces a total more confident than its inputs, which is the one thing
   *  the governing principle forbids. It is also what falls out of
   *  `.filter(Boolean).reduce(sum)` if nobody decides otherwise. */
  total: number | null;
}

/** Completed years between two `YYYY-MM-DD` dates.
 *
 *  UTC throughout, matching `days.ts`: these are calendar dates, not instants,
 *  and local-midnight arithmetic would shift one across a DST boundary. If
 *  this disagreed with `deriveDays`, a segment could be priced against a
 *  different day than the one it is scheduled on. */
export function ageOn(birthDate: string, onDate: string): number {
  const b = new Date(`${birthDate}T00:00:00Z`);
  const d = new Date(`${onDate}T00:00:00Z`);
  if (Number.isNaN(b.getTime())) {
    throw new Error(`invalid birth date "${birthDate}"`);
  }
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid date "${onDate}"`);
  }
  if (b > d) {
    // A negative age silently matches an unbounded base rule, which would bill
    // a not-yet-born traveller the adult fare. Loud beats plausible.
    throw new Error(`birth date ${birthDate} is after ${onDate}`);
  }
  let age = d.getUTCFullYear() - b.getUTCFullYear();
  const monthDiff = d.getUTCMonth() - b.getUTCMonth();
  if (monthDiff < 0 || (monthDiff === 0 && d.getUTCDate() < b.getUTCDate())) {
    age--;
  }
  return age;
}

/** What a party pays at one priced thing on one date.
 *
 *  `isFreeToday` is the free-day override, resolved by the caller so this
 *  module stays free of weekday vocabulary (which lives in `@/validate`). It
 *  beats every age rule, and it stands alone: a segment with no rules at all
 *  is FREE on its free day rather than unknown, because the free day is
 *  itself the statement of price. */
export function resolveParty(
  rules: PriceRule[],
  party: PartyMember[],
  onDate: string,
  isFreeToday = false,
): PartyPrice {
  const perTraveller: TravellerPrice[] = party.map((m) => {
    const age = ageOn(m.birthDate, onDate);
    const price = isFreeToday ? 0 : (matchRule(rules, age)?.price ?? null);
    return { id: m.id, label: m.label, age, price };
  });

  // An empty party is an unknown party, not a free one. `trip plan` catches
  // this earlier and names the fix; this is the backstop.
  if (perTraveller.length === 0) return { perTraveller, total: null };

  const anyUnknown = perTraveller.some((t) => t.price === null);
  const total = anyUnknown
    ? null
    : perTraveller.reduce((sum, t) => sum + (t.price ?? 0), 0);
  return { perTraveller, total };
}

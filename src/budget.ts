import { perPersonPerDay, type CostObservation } from "@/observations";

/** What the trip costs, from what is actually known.
 *
 *  Almost every rule here is a refusal, and each one has a reason:
 *
 *  - Currencies are never added and never converted. No exchange rate is a
 *    fact this tool has, and a stale rate is worse than none.
 *  - Observations are never summed. The Chongqing card states three
 *    components AND their total; adding them double-counts by exactly the
 *    total. Which row is the daily cost is the USER's call, via --daily.
 *  - A projection is one source's claim about a DIFFERENT trip, never a rate.
 *
 *  And one rule that is not a refusal, and matters just as much: **the report
 *  answers every part it can**. Refusing wholesale when admissions are
 *  perfectly well known is the same error as guessing -- both replace a
 *  precise statement with a vague one. */

export interface DailyChoice {
  observation: CostObservation;
  /** Never null: `selectDaily` rejects an observation whose coverage is
   *  unknown rather than projecting from nothing. */
  perPersonPerDay: number;
  projected: number;
  days: number;
  travellers: number;
}

export interface BudgetReport {
  tripName: string;
  currency: string | null;
  days: number;
  travellers: number;
  admissions: { total: number | null; unknown: number };
  passes: { total: number | null; unknown: number };
  observations: CostObservation[];
  /** null when --daily was not given. */
  daily: DailyChoice | null;
  limit: number | null;
  /** Every reason the report cannot give one combined number. Empty means it
   *  can. Each entry names a specific missing input, because "cannot compute"
   *  is a shrug rather than an answer. */
  blockers: string[];
}

export interface BudgetInput {
  tripName: string;
  currency: string | null;
  days: number;
  travellers: number;
  admissions: { total: number | null; unknown: number };
  passes: { total: number | null; unknown: number };
  observations: CostObservation[];
  dailyId: number | null;
  limit: number | null;
}

/** Throws rather than returning null: a --daily that cannot be projected from
 *  is a user error with a fix, not an absence to render. */
export function selectDaily(
  observations: CostObservation[],
  id: number,
  days: number,
  travellers: number,
): DailyChoice {
  const o = observations.find((x) => x.id === id);
  if (!o) {
    throw new Error(
      `no cost observation with id ${id} (list them with \`trip costs ls\`)`,
    );
  }
  const rate = perPersonPerDay(o);
  if (rate === null) {
    // perPersonPerDay is null when either axis is unknown. Projecting from
    // that would produce a number out of a fact nobody has.
    throw new Error(
      `observation ${id} "${o.label}" does not say how many days or people it ` +
      `covers, so it cannot be projected. Record them with ` +
      `\`trip costs add ... --days=<n> --people=<n>\`.`,
    );
  }
  return {
    observation: o,
    perPersonPerDay: rate,
    // Assumes every traveller costs the same per day. The observation covered
    // however many people it covered and says nothing about a second one.
    // The renderer states this on the same line as the number.
    projected: rate * days * travellers,
    days,
    travellers,
  };
}

export function buildBudget(input: BudgetInput): BudgetReport {
  const daily = input.dailyId === null
    ? null
    : selectDaily(input.observations, input.dailyId, input.days, input.travellers);

  const blockers: string[] = [];

  if (input.admissions.unknown > 0) {
    blockers.push(
      `${input.admissions.unknown} segment${input.admissions.unknown === 1 ? "" : "s"} ` +
      "in your plan have no price recorded, so the admissions figure is a " +
      "floor rather than a total",
    );
  }

  if (daily === null) {
    blockers.push(
      input.observations.length === 0
        ? "no daily costs are recorded at all, so lodging, food and local " +
          "transport are entirely unaccounted for"
        : "no daily cost is selected, so lodging, food and local transport " +
          "are unaccounted for (choose one with --daily=<id>)",
    );
  } else if (daily.observation.currency !== input.currency) {
    // The refusal that cannot be worked around: no rate, no conversion.
    blockers.push(
      `the daily cost is in ${daily.observation.currency} and this trip is in ` +
      `${input.currency ?? "an unstated currency"}, and no exchange rate is a ` +
      "fact this tool has, so the two are never added",
    );
  }

  return {
    tripName: input.tripName,
    currency: input.currency,
    days: input.days,
    travellers: input.travellers,
    admissions: input.admissions,
    passes: input.passes,
    observations: input.observations,
    daily,
    limit: input.limit,
    blockers,
  };
}

/** The one combined figure, or null when it cannot be had.
 *
 *  Separate from `buildBudget` so that a caller must ask for it explicitly and
 *  handle the null, rather than finding a number on the report and assuming it
 *  is safe to print. */
export function combinedTotal(r: BudgetReport): number | null {
  if (r.blockers.length > 0) return null;
  if (r.admissions.total === null) return null;
  const passes = r.passes.total ?? 0;
  return r.admissions.total + passes + (r.daily?.projected ?? 0);
}

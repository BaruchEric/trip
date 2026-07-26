import { layoutDay, type Blocked, type LayoutResult } from "@/plan/schedule";
import { travelMinutes } from "@/plan/geo";
import type { Mode, PlannableSegment } from "@/plan/types";
import type { DayWindow } from "@/days";

/** Search orderings for a single day.
 *
 *  The objective is ELAPSED TRANSIT TIME (decision 3), never distance. Walking
 *  is nearly free by decision 2 — clustering and ordering survive because
 *  back-tracking wastes clock, not because distance hurts. */

/** At --pace packed a day holds 7 segments, so 8! = 40320 layouts is a few
 *  milliseconds. Every real day is therefore solved EXACTLY; the heuristic
 *  below exists only for a day stuffed by pins. */
export const EXACT_LIMIT = 8;

/** Dropping a segment must always cost more than any routing gain. A whole
 *  day is 1440 minutes, so this cannot be outbid. */
const UNPLACED_PENALTY = 100_000;

/** Meal timing is a preference, not a constraint (M2-5): half a minute of
 *  score per minute away from the nearest meal window. */
const MEAL_WEIGHT = 0.5;

function scoreOf(r: LayoutResult): number {
  return (
    r.unplaced.length * UNPLACED_PENALTY +
    r.transitMinutes +
    r.mealDeviation * MEAL_WEIGHT
  );
}

export function orderDay(
  segments: PlannableSegment[],
  day: DayWindow,
  mode: Mode,
  blocked: Blocked[],
): LayoutResult {
  // Canonical input order: the search must depend on the SET, not the order
  // it arrived in.
  const pool = [...segments].sort((a, b) => a.id - b.id);
  if (pool.length === 0) return layoutDay([], day, mode, blocked);

  const candidates =
    pool.length <= EXACT_LIMIT ? permutations(pool) : heuristicOrders(pool, mode);

  let best: LayoutResult | null = null;
  let bestScore = Infinity;
  for (const order of candidates) {
    const result = layoutDay(order, day, mode, blocked);
    const score = scoreOf(result);
    // Strictly less-than: the first candidate wins ties, and candidates are
    // generated in a deterministic order, so the result is reproducible.
    if (score < bestScore) {
      bestScore = score;
      best = result;
    }
  }
  return best!;
}

function* permutations(items: PlannableSegment[]): Generator<PlannableSegment[]> {
  if (items.length <= 1) {
    yield [...items];
    return;
  }
  for (let i = 0; i < items.length; i++) {
    const rest = [...items.slice(0, i), ...items.slice(i + 1)];
    for (const tail of permutations(rest)) yield [items[i]!, ...tail];
  }
}

/** Nearest-neighbour from every possible start, each improved by 2-opt. Only
 *  reached when pins stuff a day past EXACT_LIMIT. */
function heuristicOrders(
  pool: PlannableSegment[],
  mode: Mode,
): PlannableSegment[][] {
  return pool.map((start) => twoOpt(nearestNeighbour(pool, start, mode), mode));
}

function nearestNeighbour(
  pool: PlannableSegment[],
  start: PlannableSegment,
  mode: Mode,
): PlannableSegment[] {
  const remaining = pool.filter((s) => s.id !== start.id);
  const route = [start];
  let current = start;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestCost = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const cost = travelMinutes(current, remaining[i]!, mode);
      if (cost < bestCost) {
        bestCost = cost;
        bestIdx = i;
      }
    }
    current = remaining.splice(bestIdx, 1)[0]!;
    route.push(current);
  }
  return route;
}

function routeCost(route: PlannableSegment[], mode: Mode): number {
  let total = 0;
  for (let i = 1; i < route.length; i++) {
    total += travelMinutes(route[i - 1]!, route[i]!, mode);
  }
  return total;
}

function twoOpt(route: PlannableSegment[], mode: Mode): PlannableSegment[] {
  let best = [...route];
  let bestCost = routeCost(best, mode);
  let improved = true;

  while (improved) {
    improved = false;
    for (let i = 1; i < best.length - 1; i++) {
      for (let j = i + 1; j < best.length; j++) {
        const candidate = [
          ...best.slice(0, i),
          ...best.slice(i, j + 1).reverse(),
          ...best.slice(j + 1),
        ];
        const cost = routeCost(candidate, mode);
        if (cost < bestCost) {
          best = candidate;
          bestCost = cost;
          improved = true;
        }
      }
    }
  }
  return best;
}

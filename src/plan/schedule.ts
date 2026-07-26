import { travelMinutes } from "@/plan/geo";
import { MEAL_WINDOWS } from "@/plan/types";
import type { Mode, Placement, PlannableSegment, Unplaced } from "@/plan/types";
import type { DayWindow } from "@/days";

/** Lay a FIXED order onto the clock. Ordering is Task 7's job; this file only
 *  answers "given this sequence, when does each thing happen, and what does
 *  not fit". */

export interface Blocked {
  startMin: number;
  endMin: number;
}

export interface LayoutResult {
  placements: Placement[];
  unplaced: Unplaced[];
  transitMinutes: number;
  mealDeviation: number;
}

export function layoutDay(
  order: PlannableSegment[],
  day: DayWindow,
  mode: Mode,
  blocked: Blocked[],
): LayoutResult {
  const placements: Placement[] = [];
  const unplaced: Unplaced[] = [];
  let cursor = day.startMin;
  let previous: PlannableSegment | null = null;
  let transitMinutes = 0;
  let mealDeviation = 0;

  for (const s of order) {
    if (s.closedDays.includes(day.weekday)) {
      unplaced.push({ segmentId: s.id, reason: `closed on ${day.weekday}` });
      continue;
    }

    const travel = previous === null ? 0 : travelMinutes(previous, s, mode);
    let start = cursor + travel;

    // Arriving before opening means waiting, not skipping. A NULL opensMin is
    // unknown hours and imposes nothing (M2-2).
    if (s.opensMin !== null && start < s.opensMin) start = s.opensMin;
    start = clearBlocked(start, s.dwellMinutes, blocked);

    if (start + s.dwellMinutes > day.endMin) {
      unplaced.push({ segmentId: s.id, reason: "no room left in the day" });
      continue;
    }
    if (s.closesMin !== null && start + s.dwellMinutes > s.closesMin) {
      unplaced.push({
        segmentId: s.id,
        reason: "closed during every available window",
      });
      continue;
    }

    // Only charge transit for a hop that actually happened. A skipped segment
    // must not leave phantom travel time in the score.
    transitMinutes += travel;
    const end = start + s.dwellMinutes;
    placements.push({
      segmentId: s.id,
      day: day.day,
      ordinal: placements.length,
      startMin: start,
      endMin: end,
      pinned: false,
    });
    if (s.tags.includes("food")) {
      mealDeviation += mealMiss(Math.round((start + end) / 2));
    }
    cursor = end;
    previous = s;
  }

  return { placements, unplaced, transitMinutes, mealDeviation };
}

/** Push `start` past any blocked interval it would collide with. Loops because
 *  clearing one reservation can land inside the next.
 *
 *  Termination: a match requires `s < b.endMin`, and the match sets
 *  `s = b.endMin`, so `s` strictly increases on every iteration and can only
 *  ever take one of the finitely many `endMin` values in `blocked`. That
 *  holds even for a degenerate interval (`endMin <= startMin`) or overlapping
 *  intervals, so the loop always terminates within `blocked.length`
 *  iterations. */
function clearBlocked(start: number, dwell: number, blocked: Blocked[]): number {
  let s = start;
  for (;;) {
    const hit = blocked.find((b) => s < b.endMin && s + dwell > b.startMin);
    if (!hit) return s;
    s = hit.endMin;
  }
}

/** Minutes from the midpoint of a meal to the nearest meal window. Feeds a
 *  SOFT penalty in ordering — it never prevents a placement (M2-5). */
function mealMiss(midpoint: number): number {
  return Math.min(...MEAL_WINDOWS.map((w) => Math.abs(midpoint - w)));
}

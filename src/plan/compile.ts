import { clusterSegments } from "@/plan/cluster";
import { orderDay } from "@/plan/order";
import { PACE_CEILING, isPlannable } from "@/plan/types";
import type {
  CompileResult, Mode, Pace, Pin, Placement, PlannableSegment, Unplaced,
} from "@/plan/types";
import type { Blocked } from "@/plan/schedule";
import type { Segment } from "@/segments";
import type { DayWindow } from "@/days";

export interface CompileOpts {
  mode: Mode;
  pace: Pace;
  pins: Pin[];
}

/** The day compiler. A pure function: no DB, no network, no clock, no RNG.
 *
 *  Five stages, in order:
 *    1. anchor pins        2. cluster geographically
 *    3. assign clusters to days                   4. order within each day
 *    5. lay down clock times (in Task 6, via Task 7)
 *
 *  The invariant every test leans on: each input segment ends up in exactly
 *  one of `placements` or `unplaced`. Never both, never neither. */
export function compile(
  segments: Segment[],
  days: DayWindow[],
  opts: CompileOpts,
): CompileResult {
  const placements: Placement[] = [];
  const unplaced: Unplaced[] = [];
  const ceiling = PACE_CEILING[opts.pace];

  // Canonical order so the result depends on the input SET alone.
  const pool = [...segments].sort((a, b) => a.id - b.id);

  const plannable: PlannableSegment[] = [];
  for (const s of pool) {
    if (isPlannable(s)) plannable.push(s);
    else unplaced.push({ segmentId: s.id, reason: "no coordinates" });
  }

  if (days.length === 0) {
    for (const s of plannable) {
      unplaced.push({ segmentId: s.id, reason: "the trip has no days; set dates first" });
    }
    return finish(placements, unplaced);
  }

  // ---- Stage 1: anchor pins -----------------------------------------------
  const pinBySegment = new Map(opts.pins.map((p) => [p.segmentId, p]));
  const validDays = new Set(days.map((d) => d.day));
  const blockedByDay = new Map<number, Blocked[]>();
  const lockedToDay = new Map<number, PlannableSegment[]>();
  const free: PlannableSegment[] = [];

  for (const s of plannable) {
    const pin = pinBySegment.get(s.id);
    if (!pin) {
      free.push(s);
      continue;
    }
    if (!validDays.has(pin.day)) {
      // Clamping to the nearest day would silently answer a question the user
      // did not ask.
      unplaced.push({
        segmentId: s.id,
        reason: `pinned to day ${pin.day}, outside the trip`,
      });
      continue;
    }
    if (pin.startMin === null) {
      push(lockedToDay, pin.day, s);
      continue;
    }
    // A timed pin is absolute: the user asserted it, so it is placed as asked
    // and everything else routes around it.
    placements.push({
      segmentId: s.id, day: pin.day, ordinal: -1,
      startMin: pin.startMin, endMin: pin.startMin + s.dwellMinutes,
      pinned: true,
    });
    push(blockedByDay, pin.day, {
      startMin: pin.startMin, endMin: pin.startMin + s.dwellMinutes,
    });
  }

  // ---- Stage 2: cluster ---------------------------------------------------
  const { clusters, overflow } = clusterSegments(free, days.length, ceiling);
  for (const s of overflow) {
    unplaced.push({ segmentId: s.id, reason: "no day had room" });
  }

  // ---- Stage 3: assign clusters to days -----------------------------------
  // Biggest cluster to roomiest day. This is what stops a 3h30 arrival day
  // from receiving the Sintra day trip.
  const byLoad = clusters
    .map((segs, i) => ({ segs, i, load: segs.reduce((n, s) => n + s.dwellMinutes, 0) }))
    .sort((a, b) => b.load - a.load || a.i - b.i);
  const byRoom = days
    .map((d) => ({ d, room: d.endMin - d.startMin }))
    .sort((a, b) => b.room - a.room || a.d.day - b.d.day);

  const assigned = new Map<number, PlannableSegment[]>();
  for (let i = 0; i < byLoad.length; i++) {
    const day = byRoom[i]?.d;
    if (day === undefined) {
      for (const s of byLoad[i]!.segs) {
        unplaced.push({ segmentId: s.id, reason: "no day had room" });
      }
      continue;
    }
    assigned.set(day.day, byLoad[i]!.segs);
  }

  // ---- Stages 4 and 5: order and lay down the clock -----------------------
  for (const day of days) {
    const locked = lockedToDay.get(day.day) ?? [];
    const fromCluster = assigned.get(day.day) ?? [];
    const pinnedCount = placements.filter((p) => p.day === day.day).length;

    // Pinned and day-locked segments count against the ceiling (M2 spec).
    const room = Math.max(0, ceiling - pinnedCount - locked.length);
    const taken = fromCluster.slice(0, room);
    for (const s of fromCluster.slice(room)) {
      unplaced.push({ segmentId: s.id, reason: "no day had room" });
    }

    const result = orderDay(
      [...locked, ...taken].sort((a, b) => a.id - b.id),
      day, opts.mode, blockedByDay.get(day.day) ?? [],
    );
    placements.push(...result.placements);
    unplaced.push(...result.unplaced);
  }

  return finish(placements, unplaced);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** Sort by day then clock, and renumber ordinals so a pinned segment lands in
 *  its true position rather than keeping the -1 placeholder. */
function finish(placements: Placement[], unplaced: Unplaced[]): CompileResult {
  const sorted = [...placements].sort(
    (a, b) => a.day - b.day || a.startMin - b.startMin || a.segmentId - b.segmentId,
  );
  let day = -1;
  let ordinal = 0;
  for (const p of sorted) {
    if (p.day !== day) {
      day = p.day;
      ordinal = 0;
    }
    p.ordinal = ordinal++;
  }
  return {
    placements: sorted,
    unplaced: [...unplaced].sort((a, b) => a.segmentId - b.segmentId),
  };
}

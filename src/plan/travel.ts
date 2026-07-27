import { travelMinutes } from "@/plan/geo";
import { legKey, type MeasuredLeg } from "@/legs";
import type { Mode, Point } from "@/plan/types";

/** Measured leg, or the model. This file owns that decision and nothing else.
 *
 *  It exists so that `geo.ts` never learns about the database, the leg store
 *  never learns about planning, and the ONE place where a measurement beats an
 *  assumption is somewhere a mutation test can point at. */

export interface TravelEstimate {
  minutes: number;
  /** False means NO LEG EXISTS for this directed pair in this mode. It is not
   *  a confidence score attached to a measured number — it is the loud
   *  absence, and the renderer prints it as such. */
  measured: boolean;
}

export interface TravelModel {
  minutes(a: Point, b: Point, mode: Mode): number;
  estimate(a: Point, b: Point, mode: Mode): TravelEstimate;
}

/** The M2 model alone: what every caller had before M8, bit for bit. */
export function modelOnly(): TravelModel {
  return {
    minutes: (a, b, mode) => travelMinutes(a, b, mode),
    estimate: (a, b, mode) => ({ minutes: travelMinutes(a, b, mode), measured: false }),
  };
}

export function withLegs(legs: MeasuredLeg[]): TravelModel {
  // Max per directed key, across sources: the schedule reads the SLOWER of the
  // two routers. A plan that runs early is a good day; one that runs late
  // cascades through every segment after it. Both rows stay on disk — this
  // decides only what the clock reads.
  const slowest = new Map<string, number>();
  for (const l of legs) {
    const k = legKey(l.fromLat, l.fromLon, l.toLat, l.toLon, l.mode);
    const prior = slowest.get(k);
    // `prior === undefined`, not `!prior`: a stored 0 is a measurement.
    if (prior === undefined || l.minutes > prior) slowest.set(k, l.minutes);
  }

  const estimate = (a: Point, b: Point, mode: Mode): TravelEstimate => {
    const hit = slowest.get(legKey(a.latitude, a.longitude, b.latitude, b.longitude, mode));
    return hit === undefined
      ? { minutes: travelMinutes(a, b, mode), measured: false }
      // Whole minutes, matching geo.ts: fractional travel times let clock
      // arithmetic drift across a day and make placements irreproducible.
      : { minutes: Math.round(hit), measured: true };
  };

  return { minutes: (a, b, mode) => estimate(a, b, mode).minutes, estimate };
}

import { travelMinutes, walkMinutesForKm } from "@/plan/geo";
import { legKey, type MeasuredLeg } from "@/legs";
import type { Mode, Point } from "@/plan/types";
import { BOARDING_MINUTES, type TransitGraph } from "@/transit/graph";

/** Measured leg, station graph, or the constant. This file owns that decision
 *  and nothing else.
 *
 *  It exists so that `geo.ts` never learns about the database, the leg store
 *  never learns about planning, the graph never learns about walking, and the
 *  ONE place where better evidence beats worse is somewhere a mutation test
 *  can point at. */

/** Where a number CAME FROM. Three values because there are now three
 *  genuinely different provenances, and the renderer must never print the
 *  third as though it were the second.
 *
 *  This REPLACED a boolean `measured`. Keeping both would have put `measured`
 *  and `basis === "measured"` in one object — two facts that are always equal,
 *  which M7 established is still two facts, and one of them eventually goes
 *  wrong. */
export type TravelBasis =
  /** A router measured this leg. */
  | "measured"
  /** Real OSM station geometry, plus the constants OSM cannot supply. */
  | "osm-graph"
  /** The straight-line constant. Unevidenced for transit, and M12 measured it
   *  wrong in four cities. */
  | "model";

export interface TransitDetail {
  /** null means NO STATION within reach of that endpoint — not a station
   *  whose name is unknown. */
  fromStation: string | null;
  toStation: string | null;
  stops: number;
  transfers: number;
  /** True when walking beat riding, so `minutes` IS the walk. The single
   *  thing the old constant could never say. */
  walkWins: boolean;
}

export interface TravelEstimate {
  minutes: number;
  basis: TravelBasis;
  /** Present only when a station graph was consulted. Absent means nobody has
   *  run `trip transit` for this city, which is a different fact from "the
   *  graph looked and found nothing". */
  transit?: TransitDetail;
}

export interface TravelModel {
  minutes(a: Point, b: Point, mode: Mode): number;
  estimate(a: Point, b: Point, mode: Mode): TravelEstimate;
}

/** The M2 model alone: what every caller had before M8, bit for bit. */
export function modelOnly(): TravelModel {
  return {
    minutes: (a, b, mode) => travelMinutes(a, b, mode),
    estimate: (a, b, mode) => ({ minutes: travelMinutes(a, b, mode), basis: "model" }),
  };
}

export function withLegs(legs: MeasuredLeg[]): TravelModel {
  return withLegsAndTransit(legs, null);
}

export function withLegsAndTransit(
  legs: MeasuredLeg[],
  graph: TransitGraph | null,
): TravelModel {
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

  /** Walking, from the best evidence there is for it. */
  const walk = (a: Point, b: Point): { minutes: number; basis: TravelBasis } => {
    const hit = slowest.get(legKey(a.latitude, a.longitude, b.latitude, b.longitude, "walking"));
    return hit === undefined
      ? { minutes: travelMinutes(a, b, "walking"), basis: "model" }
      // Whole minutes, matching geo.ts: fractional travel times let clock
      // arithmetic drift across a day and make placements irreproducible.
      : { minutes: Math.round(hit), basis: "measured" };
  };

  const transit = (a: Point, b: Point): TravelEstimate => {
    // No graph stored at all. The old constant, labelled as the old constant.
    if (graph === null) {
      return { minutes: travelMinutes(a, b, "transit"), basis: "model" };
    }

    const w = walk(a, b);
    const r = graph.route(a, b);

    // No station within reach of one end, or no edges connect the two. There
    // is no transit answer here, so the honest number is the walk.
    if (r === null) {
      return {
        minutes: w.minutes,
        basis: w.basis,
        transit: {
          fromStation: null, toStation: null,
          stops: 0, transfers: 0, walkWins: true,
        },
      };
    }

    // Door to door: walk in, wait, ride, walk out. BOARDING_MINUTES is
    // included rather than omitted — see `@/transit/graph`. The access walks
    // use the walking MODEL because no router has ever been asked for a leg
    // between a segment and a station.
    const ride = walkMinutesForKm(r.accessKm)
      + BOARDING_MINUTES
      + r.rideMinutes
      + walkMinutesForKm(r.egressKm);

    // THE RULE THIS MILESTONE EXISTS FOR: a transit estimate never exceeds the
    // walk for the same pair. Where riding loses, the answer IS the walk.
    //
    // `<=` rather than `<`: on an exact tie, walking wins. A traveller who
    // walks is not standing on a platform for a train that saves them nothing.
    // It also makes the same-station case fall out here rather than needing a
    // branch of its own — a zero-stop ride still costs boarding.
    const detail: TransitDetail = {
      fromStation: r.fromStation, toStation: r.toStation,
      stops: r.stops, transfers: r.transfers,
      walkWins: w.minutes <= ride,
    };
    return detail.walkWins
      ? { minutes: w.minutes, basis: w.basis, transit: detail }
      : { minutes: Math.round(ride), basis: "osm-graph", transit: detail };
  };

  const estimate = (a: Point, b: Point, mode: Mode): TravelEstimate =>
    mode === "transit" ? transit(a, b) : walk(a, b);

  return { minutes: (a, b, mode) => estimate(a, b, mode).minutes, estimate };
}

/** The one word every renderer uses for a basis.
 *
 *  Here rather than in each format, for the reason this file exists: M8
 *  shipped `trip day` with no hop lines while `trip plan` had them, because a
 *  second call site was missed. Three formats each spelling "modelled"
 *  slightly differently is the same defect, quieter. */
export function basisWord(basis: TravelBasis): string {
  // "estimated" keeps its M8 meaning exactly: a straight line times a
  // constant, and for transit a constant M12 measured wrong in four cities.
  // "modelled" is the new middle: real station geometry, assumed timings.
  if (basis === "measured") return "measured";
  return basis === "osm-graph" ? "modelled" : "estimated";
}

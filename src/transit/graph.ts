import { haversineKm } from "@/plan/geo";
import type { Point } from "@/plan/types";
import type { TransitStation, TransitEdge } from "@/transit/store";

/** Earliest arrival across a city's rail network, from OSM's own geometry.
 *
 *  WHAT IS EVIDENCE HERE AND WHAT IS NOT.
 *
 *  Evidence: station positions, the order stops appear in a route relation,
 *  which line each edge belongs to, and therefore how many stops and how many
 *  changes a trip takes. All of that is in the data, and M12's recon measured
 *  it in four cities.
 *
 *  NOT evidence: every constant below. OSM carries no timetable for any of
 *  those four cities — zero `interval`, `headway` or `duration` tags across
 *  126 route relations, checked at the tag level, not inferred from a count.
 *  So line-haul speed, transfer cost, boarding wait and station dwell are
 *  ASSUMPTIONS, and this file is where they are visible rather than spread
 *  through the compiler.
 *
 *  WHAT THE RECON ACTUALLY LICENSES. Swept across 25-40 km/h and 2-6 minutes
 *  per transfer, the finding that the old straight-line constant UNDER-STATES
 *  door-to-door time held in every one of twelve combinations, in all four
 *  cities. The finding that it under-states it by a particular number did
 *  not — Chongqing moves between 22/42 and 38/42 of pairs across that range.
 *
 *  So this graph is evidence about DIRECTION AND ORDERING, not about
 *  duration. Nothing downstream may present its minutes as measured, and
 *  `@/plan/travel` tags them `osm-graph` precisely so the renderer cannot.
 *
 *  See docs/superpowers/specs/2026-07-27-trip-m12-recon.md. */

/** Line-haul speed. Unevidenced; swept 25-40 in the recon. */
export const RAIL_KMH = 30;
/** Per change of line. Unevidenced; swept 2-6 in the recon. */
export const TRANSFER_MINUTES = 4;
/** Initial wait plus reaching the platform.
 *
 *  INCLUDED IN THE TOTAL rather than omitted, which is a deliberate choice
 *  against the smaller-looking number. A traveller does not teleport onto a
 *  train, and leaving this out would make the model optimistic in exactly the
 *  direction M12 exists to fix. Real waiting depends on frequency, which OSM
 *  does not carry at all — so this is an assumed allowance, and every renderer
 *  that shows a total built on it says so. */
export const BOARDING_MINUTES = 4;
/** Dwell at each intermediate station. */
export const STOP_MINUTES = 0.5;
/** Past this, an endpoint has no usable station.
 *
 *  A guard against absurd access walks and against a neighbouring city's
 *  network, NOT a modelling claim. The worst real access walk the recon
 *  measured was 1431 m, in Bangkok. */
export const MAX_ACCESS_KM = 3.0;

export interface TransitRoute {
  fromStation: string;
  toStation: string;
  /** Straight-line km from the origin to its boarding station, and from the
   *  alighting station to the destination. Reported SEPARATELY rather than
   *  folded into the ride: the caller prices them with the walking model, or
   *  with a measured walking leg, neither of which this file knows about. */
  accessKm: number;
  egressKm: number;
  /** Station-to-station hops. 0 means both ends board at the same station,
   *  which is a real answer meaning the railway does not help here. */
  stops: number;
  transfers: number;
  /** Riding only: no access walk, no egress walk, no boarding allowance. */
  rideMinutes: number;
}

export interface TransitGraph {
  stationCount: number;
  /** null when either endpoint has no station within MAX_ACCESS_KM, or when
   *  no sequence of edges connects the two. Never a fallback number: an
   *  invented connection is worse than no answer. */
  route(a: Point, b: Point): TransitRoute | null;
}

interface Adj { to: string; line: string; km: number }

export function buildGraph(
  stations: TransitStation[],
  edges: TransitEdge[],
): TransitGraph {
  const byName = new Map(stations.map((s) => [s.name, s]));
  const adj = new Map<string, Adj[]>();
  for (const e of edges) {
    // An edge naming a station this network does not have would route through
    // a node with no position. Dropped rather than defaulted to 0,0.
    if (!byName.has(e.fromName) || !byName.has(e.toName)) continue;
    const at = adj.get(e.fromName);
    const entry = { to: e.toName, line: e.line, km: e.km };
    if (at) at.push(entry);
    else adj.set(e.fromName, [entry]);
  }

  const nearest = (p: Point): { name: string; km: number } | null => {
    let best: { name: string; km: number } | null = null;
    for (const s of stations) {
      const km = haversineKm(p, { latitude: s.latitude, longitude: s.longitude });
      if (best === null || km < best.km) best = { name: s.name, km };
    }
    return best !== null && best.km <= MAX_ACCESS_KM ? best : null;
  };

  const route = (a: Point, b: Point): TransitRoute | null => {
    const from = nearest(a);
    const to = nearest(b);
    if (from === null || to === null) return null;

    if (from.name === to.name) {
      return {
        fromStation: from.name, toStation: to.name,
        accessKm: from.km, egressKm: to.km,
        stops: 0, transfers: 0, rideMinutes: 0,
      };
    }

    // Dijkstra over station names, cost in minutes. The state carries the line
    // arrived on, because a transfer is a change of line and is therefore a
    // property of the PATH rather than of the node.
    interface State { minutes: number; at: string; line: string | null; stops: number; transfers: number }
    const seen = new Map<string, number>();
    const queue: State[] = [{ minutes: 0, at: from.name, line: null, stops: 0, transfers: 0 }];

    while (queue.length > 0) {
      // Linear scan rather than a heap: a city's rail network is hundreds of
      // stations, and a heap here would be complexity nothing measured a need
      // for.
      let bestAt = 0;
      for (let i = 1; i < queue.length; i++) {
        if (queue[i]!.minutes < queue[bestAt]!.minutes) bestAt = i;
      }
      const cur = queue.splice(bestAt, 1)[0]!;

      // Keyed on station AND line: arriving at an interchange on a different
      // line is a different state, and collapsing them would let a cheap
      // arrival on the wrong line block a slightly slower one that continues
      // without a transfer.
      const key = `${cur.at}|${cur.line ?? ""}`;
      const prior = seen.get(key);
      if (prior !== undefined && prior <= cur.minutes) continue;
      seen.set(key, cur.minutes);

      if (cur.at === to.name) {
        return {
          fromStation: from.name, toStation: to.name,
          accessKm: from.km, egressKm: to.km,
          stops: cur.stops, transfers: cur.transfers,
          rideMinutes: cur.minutes,
        };
      }

      for (const e of adj.get(cur.at) ?? []) {
        const changed = cur.line !== null && e.line !== cur.line;
        queue.push({
          minutes: cur.minutes + (e.km / RAIL_KMH) * 60 + STOP_MINUTES
                 + (changed ? TRANSFER_MINUTES : 0),
          at: e.to,
          line: e.line,
          stops: cur.stops + 1,
          transfers: cur.transfers + (changed ? 1 : 0),
        });
      }
    }
    return null;
  };

  return { stationCount: stations.length, route };
}

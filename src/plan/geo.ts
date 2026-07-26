import type { Mode, Point } from "@/plan/types";

/** Straight-line distance and a per-mode fudge factor.
 *
 *  These constants are PLACEHOLDERS. M4 replaces this whole file with OSRM
 *  walking routes and GTFS-Transitland transit legs. Nothing else in the
 *  compiler should encode a speed or a detour assumption — when the real
 *  router lands, this file is the only thing that changes. */

const EARTH_RADIUS_KM = 6371;

interface ModeModel {
  kmh: number;
  /** Streets are not straight lines. */
  detour: number;
  /** Fixed cost per hop: waiting, walking to the stop, buying a ticket. This
   *  is what correctly makes transit lose to walking over short distances. */
  perHopMinutes: number;
}

const MODEL: Record<Mode, ModeModel> = {
  walking: { kmh: 4.5, detour: 1.3, perHopMinutes: 0 },
  transit: { kmh: 18, detour: 1.2, perHopMinutes: 6 },
};

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineKm(a: Point, b: Point): number {
  const dLat = toRad(b.latitude - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const lat1 = toRad(a.latitude);
  const lat2 = toRad(b.latitude);

  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  // asin form rather than atan2(sqrt(h), sqrt(1-h)): both are fine, and this
  // keeps the antimeridian case (dLon near 360) correct because sin(dLon/2)
  // is periodic.
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Whole minutes. Fractional travel times would let clock arithmetic drift
 *  across a day and make placements irreproducible at the second. */
export function travelMinutes(a: Point, b: Point, mode: Mode): number {
  const m = MODEL[mode];
  const km = haversineKm(a, b) * m.detour;
  return Math.round((km / m.kmh) * 60 + m.perHopMinutes);
}

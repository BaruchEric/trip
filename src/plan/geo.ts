import type { Mode, Point } from "@/plan/types";

/** Straight-line distance and a per-mode fudge factor: the answer when NOTHING
 *  HAS BEEN MEASURED.
 *
 *  This header used to read "These constants are PLACEHOLDERS. M4 replaces this
 *  whole file with OSRM walking routes and GTFS-Transitland transit legs." M4
 *  shipped the plausibility check instead, and that sentence stayed false for
 *  four milestones while every arrival time this project printed was derived
 *  from the constants below, to the minute. A placeholder that is never
 *  replaced is an assertion; the label decays and the number ships.
 *
 *  M8 measured them. Against two pedestrian routers over the seven places this
 *  project has actually resolved to a segment, the WALKING model came in below
 *  both routers in 18 of 21 pairs and above both in none — 27% optimistic
 *  under 2 km, which is exactly where day-planning happens.
 *  See docs/superpowers/specs/2026-07-27-trip-m8-recon.md.
 *
 *  The constants are deliberately NOT recalibrated to that measurement: one
 *  city, and a famously vertical one, so a global constant tuned on Chongqing
 *  would be overfitting — the same error M7 rejected in "always query in local
 *  script". Real legs live in `route_legs` and are preferred over this by
 *  `@/plan/travel`. What remains here is the honest fallback.
 *
 *  The TRANSIT constants are no longer merely unevidenced. M12 measured them,
 *  and they are WRONG, in a known direction, in every city tried.
 *
 *  Against a station graph built from OSM's own rail relations in Chongqing,
 *  Lisbon, Bangkok and Amsterdam, 18 km/h + 1.20 + 6 min UNDER-STATES
 *  door-to-door transit time by a median of 8 to 24 minutes. Unlike the
 *  walking result, which M9 found reverses sign between cities, this one does
 *  not reverse — it held in all four cities across all twelve swept
 *  combinations of the two constants OSM cannot supply. Under-stating is the
 *  dangerous direction: a plan built on it runs late and cascades.
 *
 *  The worse defect is one no recalibration could fix. Having no idea where a
 *  station is, this model recommends riding over walking in 36 to 42 of every
 *  42 pairs, and measured walking actually wins 4 to 11 of them — by 70
 *  minutes in the worst Bangkok case.
 *
 *  They are NOT recalibrated here, for two reasons. `@/transit/graph` replaces
 *  them wherever a network has been fetched, so tuning the fallback would
 *  improve only the case where nothing is known. And four cities is still four
 *  cities: a global constant fitted to them is the overfitting M8 decision 6
 *  refused and M9 vindicated.
 *
 *  See docs/superpowers/specs/2026-07-27-trip-m12-recon.md. Nothing else in
 *  the compiler should encode a speed or a detour assumption. */

const EARTH_RADIUS_KM = 6371;

interface ModeModel {
  kmh: number;
  /** Streets are not straight lines. */
  detour: number;
  /** Fixed cost per hop: waiting, walking to the stop, buying a ticket.
   *
   *  This comment used to end "this is what correctly makes transit lose to
   *  walking over short distances". M12 measured that claim and it is FALSE.
   *  Six minutes is nowhere near enough: across four cities, transit was
   *  recommended over walking in 36 to 42 of every 42 pairs, and measured
   *  walking really won 4 to 11 of them.
   *
   *  It could not have been true at any value, either. The term is a constant
   *  added to a straight line, so it shifts every hop equally — while whether
   *  the railway helps depends on where the stations happen to be. Only
   *  `@/transit/graph`, which knows that, can make the call. */
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

/** Minutes to walk a straight-line distance, UNROUNDED.
 *
 *  For the transit model's access and egress walks, which arrive as distances
 *  from a station rather than as a pair of points. Unrounded because they are
 *  summed with a ride and a boarding allowance before anything reaches a
 *  clock; rounding each term first would let three half-minutes vanish.
 *
 *  Shares MODEL.walking with `travelMinutes` rather than restating 1.3 and 4.5,
 *  so a change to the walking model cannot reach one caller and miss the other. */
export function walkMinutesForKm(km: number): number {
  const m = MODEL.walking;
  return ((km * m.detour) / m.kmh) * 60 + m.perHopMinutes;
}

/** Whole minutes. Fractional travel times would let clock arithmetic drift
 *  across a day and make placements irreproducible at the second. */
export function travelMinutes(a: Point, b: Point, mode: Mode): number {
  const m = MODEL[mode];
  const km = haversineKm(a, b) * m.detour;
  return Math.round((km / m.kmh) * 60 + m.perHopMinutes);
}

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
 *  The TRANSIT constants remain entirely unevidenced. Nothing in M8 measured
 *  transit, and no free GTFS ground truth for Chongqing was found. Nothing
 *  else in the compiler should encode a speed or a detour assumption. */

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

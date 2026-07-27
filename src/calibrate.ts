import { travelMinutes, haversineKm } from "@/plan/geo";
import { legKey, type MeasuredLeg } from "@/legs";
import type { Mode, Point } from "@/plan/types";

/** How wrong `geo.ts` is, HERE, measured against legs already stored.
 *
 *  A derivation, not a measurement: `trip route` did the measuring. This runs
 *  offline.
 *
 *  It exists because of what M9 found. The model is below both routers in 18
 *  of 21 Chongqing pairs and ABOVE both in the majority of pairs in Bangkok,
 *  Lisbon and Amsterdam — the sign of the error changes by city. So there is
 *  no constant to fix and no global statement to make, and the only honest
 *  thing the tool can do is report what it measured where it is. */

export interface LegComparison {
  from: Point;
  to: Point;
  straightKm: number;
  modelMinutes: number;
  /** The MIDPOINT across sources, not the maximum the schedule reads. */
  measuredMinutes: number;
  sources: number;
  /** model / measured. Below 1 = optimistic, and a plan built on it runs
   *  late. Above 1 = pessimistic. */
  ratio: number;
}

export interface Band {
  label: string;
  legCount: number;
  /** null means NO LEGS IN THIS BAND. Never 1, which would read as "the model
   *  agrees exactly here". */
  medianRatio: number | null;
}

export interface Calibration {
  mode: Mode;
  legCount: number;
  bands: Band[];
  worst: LegComparison | null;
}

/** The band edge, in straight-line km.
 *
 *  Drawn on DISTANCE and not on the measured time being compared against:
 *  banding by the quantity under measurement is circular. 2 km because the
 *  finding is that error concentrates on short hops, and a day is made of
 *  short hops. */
export const BAND_EDGE_KM = 2;

export function calibrate(legs: MeasuredLeg[], mode: Mode): Calibration {
  // Group by directed key so the two routers meet before anything is compared.
  const byLeg = new Map<string, MeasuredLeg[]>();
  for (const l of legs) {
    if (l.mode !== mode) continue;
    const k = legKey(l.fromLat, l.fromLon, l.toLat, l.toLon, l.mode);
    const at = byLeg.get(k);
    if (at) at.push(l);
    else byLeg.set(k, [l]);
  }

  const comparisons: LegComparison[] = [];
  for (const group of byLeg.values()) {
    const first = group[0]!;
    const from = { latitude: first.fromLat, longitude: first.fromLon };
    const to = { latitude: first.toLat, longitude: first.toLon };

    // Midpoint, NOT max. The max is a scheduling policy that buys safety
    // margin; folding it in here would report the model as more wrong than it
    // is, and this report is a measurement rather than a plan.
    const measured = group.reduce((n, l) => n + l.minutes, 0) / group.length;

    // A zero-length measurement would divide to Infinity, which is not a
    // ratio. Such a leg says nothing, so it says nothing.
    if (measured <= 0) continue;

    const model = travelMinutes(from, to, mode);
    comparisons.push({
      from, to,
      straightKm: haversineKm(from, to),
      modelMinutes: model,
      measuredMinutes: measured,
      sources: group.length,
      ratio: model / measured,
    });
  }

  const under = comparisons.filter((c) => c.straightKm < BAND_EDGE_KM);
  const over = comparisons.filter((c) => c.straightKm >= BAND_EDGE_KM);

  return {
    mode,
    legCount: comparisons.length,
    bands: [
      band(`under ${BAND_EDGE_KM} km`, under),
      band(`${BAND_EDGE_KM} km and over`, over),
    ],
    worst: worstOf(comparisons),
  };
}

function band(label: string, cs: LegComparison[]): Band {
  return {
    label,
    legCount: cs.length,
    medianRatio: cs.length === 0 ? null : median(cs.map((c) => c.ratio)),
  };
}

/** Median, never mean: one 4.64-detour outlier would drag a mean and
 *  misdescribe the typical hop. */
function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** The leg furthest from agreement, preferring the OPTIMISTIC side when one
 *  exists: an under-estimate makes the day run late and cascade, where an
 *  over-estimate merely makes it run early. Compared on |log(ratio)| so that
 *  halving and doubling count the same. */
function worstOf(cs: LegComparison[]): LegComparison | null {
  if (cs.length === 0) return null;
  const optimistic = cs.filter((c) => c.ratio < 1);
  const pool = optimistic.length > 0 ? optimistic : cs;
  return pool.reduce((w, c) =>
    Math.abs(Math.log(c.ratio)) > Math.abs(Math.log(w.ratio)) ? c : w);
}

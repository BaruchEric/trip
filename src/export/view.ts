import type { Client } from "@libsql/client";
import { loadContext, buildPricing, reconcilePinned } from "@/commands/plan";
import { readPins, readPlacements } from "@/placements";
import { listLegs } from "@/legs";
import { withLegs, type TravelBasis, type TransitDetail } from "@/plan/travel";
import { calibrate, type Calibration } from "@/calibrate";
import { MODES, type Mode } from "@/plan/types";
import type { Segment } from "@/segments";

/** Everything every export format needs, read ONCE.
 *
 *  Two decisions live here and both are load-bearing.
 *
 *  It reads STORED placements and never re-plans. `trip plan` compiles fresh
 *  and saves; `trip day` reads what was saved; the two can already differ if
 *  pins or segments changed since. Export follows `trip day`, because the user
 *  exports the itinerary they approved rather than a new one computed on the
 *  way out.
 *
 *  And it is ONE view behind all three renderers. M8 shipped `trip day`
 *  rendering no hop lines while `trip plan` rendered them, because a second
 *  call site was missed. Export is the command whose entire job is faithful
 *  reproduction, so the same divergence here would be that defect in the worst
 *  possible place. */

export interface ExportHop {
  minutes: number;
  /** Where the number came from. THREE values, not a boolean, since M12.
   *
   *  A boolean `measured` reported a station-graph result and the bare
   *  straight-line constant identically, as "not measured" -- and those are
   *  not the same claim. The graph knows where the stations are and can say
   *  the railway does not help here; the constant cannot, and M12 measured it
   *  wrong in four cities. Collapsing them would be the M10 error in the
   *  place M10 was written about: a format's confidence must match the plan's. */
  basis: TravelBasis;
  /** Present only when a station graph was consulted. */
  transit?: TransitDetail;
  mode: Mode;
}

export interface ExportStop {
  segmentId: number;
  name: string;
  /** OSM's own name, only where it DIFFERS from `name`. */
  localName: string | null;
  latitude: number | null;
  longitude: number | null;
  startMin: number;
  endMin: number;
  endsNextDay: boolean;
  pinned: boolean;
  /** false means the plan scheduled this WITHOUT knowing when it opens. */
  hoursKnown: boolean;
  /** null is UNKNOWN. 0 is free. Never interchangeable, in any format. */
  price: number | null;
  tags: string[];
  /** The hop that got you here; null for the first stop of a day. */
  arriveBy: ExportHop | null;
}

export interface ExportDay {
  day: number;
  date: string;
  weekday: string;
  startMin: number;
  endMin: number;
  stops: ExportStop[];
  dayTotal: { total: number | null; unknown: number };
}

export interface ExportView {
  tripName: string;
  startDate: string;
  currency: string | null;
  mode: Mode;
  days: ExportDay[];
  unplaced: { segmentId: number; name: string; reason: string }[];
  travellers: { id: number; label: string; birthDate: string }[];
  /** Markdown-only: no home in ICS or GeoJSON, and inventing one would be
   *  worse than pointing at the file that has it. */
  perTraveller: { id: number; label: string; total: number | null }[];
  tripTotal: { total: number | null; unknown: number };
  /** Counted ONCE per pass, never sliced across the days it covers: no single
   *  day costs a third of a three-day pass, and an average is not a fact. */
  passTotal: { total: number | null; unknown: number };
  /** null when no legs are stored -- which is UNKNOWN, not agreement. */
  calibration: Calibration | null;
}

function totalOf(
  prices: ({ total: number | null } | undefined)[],
): { total: number | null; unknown: number } {
  const known = prices.filter((p) => p !== undefined && p.total !== null);
  const unknown = prices.length - known.length;
  // Nothing to price is 0, not unknown -- an empty day costs nothing, which
  // is a different fact from not knowing what it costs.
  if (prices.length === 0) return { total: 0, unknown: 0 };
  return {
    total: known.length === 0 ? null : known.reduce((n, p) => n + (p!.total ?? 0), 0),
    unknown,
  };
}

export async function buildExportView(db: Client): Promise<ExportView> {
  const { trip, days, segments } = await loadContext(db);
  const placements = await readPlacements(db, trip.id);
  if (placements.length === 0) {
    throw new Error("nothing planned yet - run `trip plan`");
  }

  const pins = await readPins(db, trip.id);
  const reconciled = reconcilePinned(placements, pins);
  const pricing = await buildPricing(
    db, trip.id, trip.currency, days, reconciled, segments);

  const mode: Mode = MODES.includes(trip.mode as Mode) ? (trip.mode as Mode) : "walking";
  const travel = withLegs(await listLegs(db));
  const byId = new Map<number, Segment>(segments.map((s) => [s.id, s]));

  const exportDays: ExportDay[] = days.map((d) => {
    const onDay = reconciled
      .filter((p) => p.day === d.day)
      // The same tie-break renderDay uses, and for the same reason: between a
      // pin/move and the next replan, ordinal 0 can be shared.
      .sort((a, b) => a.ordinal - b.ordinal || a.startMin - b.startMin
        || a.segmentId - b.segmentId);

    const stops: ExportStop[] = onDay.map((p, i) => {
      const s = byId.get(p.segmentId);
      const prev = i === 0 ? undefined : byId.get(onDay[i - 1]!.segmentId);
      return {
        segmentId: p.segmentId,
        name: s?.name ?? `#${p.segmentId}`,
        // Only where it DIFFERS: M7's rule, and the reason a rename across
        // scripts used to destroy the readable name.
        localName: s && s.localName && s.localName !== s.name ? s.localName : null,
        latitude: s?.latitude ?? null,
        longitude: s?.longitude ?? null,
        startMin: p.startMin,
        endMin: p.endMin,
        endsNextDay: p.endMin >= 1440,
        pinned: p.pinned,
        // A segment this map cannot find is never hoursKnown -- undefined
        // ?.opensMin is undefined, and undefined !== null reads as TRUE.
        hoursKnown: s !== undefined && s.opensMin !== null,
        price: pricing.bySegment.get(p.segmentId)?.total ?? null,
        tags: s?.tags ?? [],
        arriveBy: hopOf(prev, s, travel, mode),
      };
    });

    return {
      day: d.day, date: d.date, weekday: d.weekday,
      startMin: d.startMin, endMin: d.endMin,
      stops,
      dayTotal: totalOf(onDay.map((p) => pricing.bySegment.get(p.segmentId))),
    };
  });

  // A segment with no placement is not in the itinerary at all, and must
  // still be visible. Absence is loud: dropping it would make a trip look
  // smaller than it is with nothing to say so.
  const placedIds = new Set(reconciled.map((p) => p.segmentId));
  const unplaced = segments
    .filter((s) => !placedIds.has(s.id))
    .map((s) => ({
      segmentId: s.id,
      name: s.name,
      reason: s.latitude === null || s.longitude === null
        ? "no coordinates"
        : "not placed by the last plan - run `trip plan` to see why",
    }));

  const legs = await listLegs(db);

  return {
    tripName: trip.name,
    startDate: trip.startDate!,
    currency: trip.currency,
    mode,
    days: exportDays,
    unplaced,
    travellers: pricing.travellers.map((t) => ({
      id: t.id, label: t.label, birthDate: t.birthDate,
    })),
    perTraveller: pricing.travellers.map((t) => ({
      id: t.id,
      label: t.label,
      total: perTravellerTotal(pricing, reconciled, t.id),
    })),
    tripTotal: totalOf(reconciled.map((p) => pricing.bySegment.get(p.segmentId))),
    passTotal: totalOf(pricing.passes.map((x) => x.price)),
    calibration: legs.length === 0 ? null : calibrate(legs, mode),
  };
}

function hopOf(
  from: Segment | undefined,
  to: Segment | undefined,
  travel: ReturnType<typeof withLegs>,
  mode: Mode,
): ExportHop | null {
  if (!from || !to) return null;
  if (from.latitude === null || from.longitude === null) return null;
  if (to.latitude === null || to.longitude === null) return null;
  const est = travel.estimate(
    { latitude: from.latitude, longitude: from.longitude },
    { latitude: to.latitude, longitude: to.longitude },
    mode,
  );
  return { minutes: est.minutes, basis: est.basis, transit: est.transit, mode };
}

/** The M5 rule, unchanged: a segment whose PARTY total is unknown drops out
 *  wholesale, from the trip total and from every traveller's row alike. The
 *  two sums agree only if both drop the same segments. */
function perTravellerTotal(
  pricing: Awaited<ReturnType<typeof buildPricing>>,
  placements: { segmentId: number }[],
  travellerId: number,
): number | null {
  const priced = placements
    .map((p) => pricing.bySegment.get(p.segmentId))
    .filter((p) => p !== undefined && p.total !== null);
  if (priced.length === 0) return null;
  return priced.reduce((acc, p) => {
    const mine = p!.perTraveller.find((x) => x.id === travellerId);
    return acc + (mine?.price ?? 0);
  }, 0);
}

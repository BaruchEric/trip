import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { listSegments, type Segment } from "@/segments";
import { readPins, readPlacements, savePlacements, setPinned, clearPin } from "@/placements";
import { deriveDays, type DayWindow } from "@/days";
import { compile } from "@/plan/compile";
import { withLegs } from "@/plan/travel";
import { listLegs } from "@/legs";
import {
  MODES, PACES,
  type Mode, type Pace, type Pin, type Unplaced, type Placement,
} from "@/plan/types";
import { formatClock, parseClock } from "@/parse";
import { renderDay, renderPlan, type PlanPricing, type PlanTravel } from "@/render-plan";
import { listTravellers } from "@/travellers";
import { listPasses } from "@/passes";
import { readPriceRules } from "@/prices";
import { resolveParty, type PartyPrice } from "@/pricing/party";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

/** Resolve `<seg>` to an id. A number is an id; anything else is a
 *  case-insensitive substring of the name. An ambiguous match is an ERROR:
 *  silently picking the first would pin the wrong thing and look like it
 *  worked. */
function resolveSegment(segments: Segment[], token: string): Segment {
  if (/^\d+$/.test(token)) {
    const byId = segments.find((s) => s.id === Number(token));
    if (!byId) throw new Error(`no segment #${token} in this trip`);
    return byId;
  }
  const needle = token.toLowerCase();
  const hits = segments.filter((s) => s.name.toLowerCase().includes(needle));
  if (hits.length === 0) throw new Error(`no segment matching "${token}"`);
  if (hits.length > 1) {
    throw new Error(
      `"${token}" matches ${hits.length} segments: ` +
      `${hits.map((s) => `#${s.id} ${s.name}`).join(", ")}`,
    );
  }
  return hits[0]!;
}

async function loadContext(db: Client) {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");
  if (trip.startDate === null || trip.endDate === null) {
    throw new Error("no dates set - run `trip dates set <start>..<end>` first");
  }
  const days = deriveDays({
    startDate: trip.startDate, endDate: trip.endDate,
    arrivalMin: trip.arrivalMin, departureMin: trip.departureMin,
    dayStartMin: trip.dayStartMin, dayEndMin: trip.dayEndMin,
  });
  const segments = await listSegments(db, trip.id);
  return { trip, days, segments };
}

export async function runPlanCommand(
  db: Client,
  command: string,
  argv: string[],
  json: boolean,
): Promise<string> {
  if (command === "plan" || command === "replan") return doPlan(db, argv, json);
  if (command === "day") return doDay(db, argv, json);
  if (command === "pin") return doPin(db, argv, json);
  if (command === "unpin") return doUnpin(db, argv, json);
  if (command === "move") return doMove(db, argv, json);
  throw new Error(`unknown plan command "${command}"`);
}

/** F2: compile() only marks a TIMED pin `pinned: true` at Stage 1 -- a
 *  day-locked pin (`trip move`, or `trip pin` without `--at`) runs through
 *  the ordinary layout path (orderDay -> layoutDay) and comes back
 *  `pinned: false`, same as a free segment, because layoutDay has no idea
 *  which inputs were locked. That is a FALSE field: it tells an agent the
 *  constraint `trip move` exists to create does not exist. The DB's own
 *  `pinned` column is truthful (setPinned/clearPin are its only writers, and
 *  savePlacements's upsert never touches it), which is why `trip day` --
 *  sourced from readPlacements -- was never actually wrong; only `doPlan`,
 *  which hands compile()'s in-memory result straight to the renderers
 *  without ever consulting the DB, was. Re-joining against the pins already
 *  loaded for compile() fixes it without weakening compile()'s purity. Only
 *  ever promotes false -> true: a placement compile() marked pinned (a timed
 *  pin) is never un-marked. */
function reconcilePinned<T extends { segmentId: number; pinned: boolean }>(
  placements: T[],
  pins: Pin[],
): T[] {
  const pinnedIds = new Set(pins.map((p) => p.segmentId));
  return placements.map((p) =>
    p.pinned || !pinnedIds.has(p.segmentId) ? p : { ...p, pinned: true },
  );
}

async function doPlan(db: Client, argv: string[], json: boolean): Promise<string> {
  const { trip, days, segments } = await loadContext(db);
  if (segments.length === 0) {
    throw new Error("no segments yet - run `trip seg add <name> --dur=<90m>` first");
  }

  const modeRaw = flag(argv, "--mode") ?? trip.mode;
  const paceRaw = flag(argv, "--pace") ?? trip.pace;
  // Rejected, never defaulted: a typo that silently falls back to `normal`
  // gives a plan the user did not ask for, with a success exit code.
  if (!MODES.includes(modeRaw as Mode)) {
    throw new Error(`invalid --mode "${modeRaw}" (expected ${MODES.join(" or ")})`);
  }
  if (!PACES.includes(paceRaw as Pace)) {
    throw new Error(`invalid --pace "${paceRaw}" (expected ${PACES.join(", ")})`);
  }

  const pins = await readPins(db, trip.id);
  // The one step that makes measured legs available. `trip route` does the
  // fetching; this only READS what it wrote, so `trip plan` keeps the promise
  // compile() has carried since M2 -- no DB, no network, no clock, no RNG --
  // by receiving the legs as data rather than looking them up mid-compile.
  const travelModel = withLegs(await listLegs(db));
  const travel: PlanTravel = { model: travelModel, mode: modeRaw as Mode };
  const result = compile(segments, days, {
    mode: modeRaw as Mode, pace: paceRaw as Pace, pins, travel: travelModel,
  });
  await savePlacements(db, trip.id, result.placements);
  const placements = reconcilePinned(result.placements, pins);

  const pricing = await buildPricing(
    db, trip.id, trip.currency, days, placements, segments);
  if (json) return planJson(days, placements, segments, result.unplaced, pricing, travel);
  return renderPlan(days, placements, segments, result.unplaced, pricing, travel);
}

/** (ordinal, startMin, segmentId): same tie-break `renderDay` uses, and for
 *  the same reason — between a `pin`/`move` and the next `replan`, ordinal 0
 *  can be shared by more than one placement, and this is agent-facing output
 *  that must not vary across calls. */
function byOrdinalThenClock(
  a: { ordinal: number; startMin: number; segmentId: number },
  b: { ordinal: number; startMin: number; segmentId: number },
): number {
  return a.ordinal - b.ordinal || a.startMin - b.startMin || a.segmentId - b.segmentId;
}

/** Known sum plus a count of the unknowns, as data rather than prose.
 *
 *  Mirrors `totalLine` in render-plan.ts field-for-field and deliberately
 *  follows the SAME rules: a total is null only when something exists and
 *  none of it is known, and nothing-to-price is 0 rather than unknown. The
 *  consistency suite compares the two outputs, so a drift here fails. */
function jsonTotal(
  prices: (PartyPrice | undefined)[],
): { total: number | null; unknown: number } {
  const known = prices.filter(
    (p): p is PartyPrice => p !== undefined && p.total !== null,
  );
  const unknown = prices.length - known.length;
  if (prices.length === 0) return { total: 0, unknown: 0 };
  return {
    total: known.length === 0 ? null : known.reduce((a, p) => a + (p.total ?? 0), 0),
    unknown,
  };
}

// Exported (only) so tests can hand it a placement/segment mismatch that no
// real DB state can produce -- readPlacements INNER JOINs against segments,
// so the two are always consistent through every actual code path -- and
// exercise the F6 defensive check below directly.
/** null when there is no hop to describe. See the note at the call site. */
function hopJson(
  from: Segment | undefined,
  to: Segment | undefined,
  travel: PlanTravel,
): { minutes: number; measured: boolean; mode: string } | null {
  if (!from || !to) return null;
  if (from.latitude === null || from.longitude === null) return null;
  if (to.latitude === null || to.longitude === null) return null;
  const est = travel.model.estimate(
    { latitude: from.latitude, longitude: from.longitude },
    { latitude: to.latitude, longitude: to.longitude },
    travel.mode,
  );
  return { minutes: est.minutes, measured: est.measured, mode: travel.mode };
}

export function planJson(
  days: DayWindow[],
  placements: { segmentId: number; day: number; ordinal: number; startMin: number; endMin: number; pinned: boolean }[],
  segments: Segment[],
  unplaced: { segmentId: number; reason: string }[],
  // Absent means emit exactly what trip emitted before M5. M3's whole premise
  // is that the agent drives this tool through --json, so a pricing milestone
  // that left prices out of it would be write-only for its primary consumer.
  pricing?: PlanPricing,
  // Same terms, for M8. A measurement the agent cannot read is write-only.
  travel?: PlanTravel,
): string {
  const byId = new Map(segments.map((s) => [s.id, s]));
  return JSON.stringify({
    days: days.map((d) => ({
      day: d.day, date: d.date, weekday: d.weekday,
      startTime: formatClock(d.startMin), endTime: formatClock(d.endMin),
      placements: placements
        .filter((p) => p.day === d.day)
        .sort(byOrdinalThenClock)
        .map((p, i, ordered) => {
          const seg = byId.get(p.segmentId);
          const from = i === 0 ? undefined : byId.get(ordered[i - 1]!.segmentId);
          // F9: a TIMED pin (Stage 1 of compile()) is placed at exactly the
          // user's asserted minute with no bound check against the day
          // window — that is correct, the assertion is absolute — but its
          // dwell can run p.endMin past 1440 (23:00 + a 120m segment = 1500).
          // formatClock has no notion of "day", so it used to emit "25:00":
          // not a real clock time, and an agent naively parsing HH:MM (e.g.
          // `new Date("...T25:00")`) gets Invalid Date. Wrapping silently to
          // "01:00" would be worse — a fabricated time that reads as BEFORE
          // startTime, the same class of lie M2-2 exists to prevent. The
          // honest fix states the fact explicitly instead of encoding it in
          // a notation the consumer has to know to decode: a real HH:MM, plus
          // a boolean saying it belongs to the day after.
          const overflowed = p.endMin >= 1440;
          return {
            segmentId: p.segmentId,
            name: seg?.name ?? null,
            startTime: formatClock(p.startMin),
            endTime: formatClock(overflowed ? p.endMin % 1440 : p.endMin),
            endsNextDay: overflowed,
            pinned: p.pinned,
            // Explicit, so an agent never has to infer that a missing field
            // means "we guessed" (M2-2).
            //
            // F6: the old `byId.get(...)?.opensMin !== null` reads TRUE for a
            // segment this map cannot find at all (undefined?.opensMin is
            // undefined, and undefined !== null) — asserting "hours known"
            // for a segment whose hours are not even loadable is the worst
            // direction possible for the field M2-2 introduced to prevent
            // exactly this. A missing segment is never hoursKnown.
            hoursKnown: seg !== undefined && seg.opensMin !== null,
            // null is UNKNOWN, and it is a different fact from 0, which is
            // free. An agent must be able to tell them apart, which is the
            // whole reason there is no NULL price in the schema.
            ...(pricing === undefined ? {} : {
              price: pricing.bySegment.get(p.segmentId)?.total ?? null,
            }),
            // The hop that got you here. null for the first stop of a day and
            // for any hop that cannot be computed -- a segment with no
            // coordinates has no travel time, which is a different fact from
            // zero travel time.
            //
            // `measured` is a BOOLEAN, never a string: false means no leg
            // exists for this directed hop, and an agent must be able to tell
            // that from a measured number without parsing prose.
            ...(travel === undefined ? {} : { arriveBy: hopJson(from, seg, travel) }),
          };
        }),
      ...(pricing === undefined ? {} : {
        total: jsonTotal(
          placements.filter((p) => p.day === d.day)
            .map((p) => pricing.bySegment.get(p.segmentId)),
        ),
      }),
    })),
    unplaced: unplaced.map((u) => ({
      segmentId: u.segmentId,
      name: byId.get(u.segmentId)?.name ?? null,
      reason: u.reason,
    })),
    ...(pricing === undefined ? {} : {
      pricing: {
        currency: pricing.currency,
        // Empty means no prices can be computed at all. Stated as data so an
        // agent does not have to notice the absence of a total.
        travellers: pricing.travellers.map((t) => ({
          id: t.id, label: t.label, birthDate: t.birthDate,
        })),
        admission: jsonTotal(
          placements.map((p) => pricing.bySegment.get(p.segmentId)),
        ),
        passes: pricing.passes.map(({ pass, price }) => ({
          id: pass.id, name: pass.name,
          fromDay: pass.fromDay, toDay: pass.toDay,
          total: price.total,
        })),
        passesTotal: jsonTotal(pricing.passes.map((x) => x.price)),
        tripTotal: jsonTotal([
          ...placements.map((p) => pricing.bySegment.get(p.segmentId)),
          ...pricing.passes.map((x) => x.price),
        ]),
      },
    }),
  });
}

async function doDay(db: Client, argv: string[], json: boolean): Promise<string> {
  const { trip, days, segments } = await loadContext(db);
  const n = Number(argv[0]);
  const day = days.find((d) => d.day === n);
  if (!day) throw new Error(`no day ${argv[0] ?? ""} in this trip (1-${days.length})`);

  const placements = await readPlacements(db, trip.id);
  if (placements.length === 0) throw new Error("nothing planned yet - run `trip plan`");

  // A pin asserted onto THIS day that the last compile could not place has
  // no row in `placements` at all (fix round 1 in placements.ts: its
  // compiled result gets cleared rather than left stale) — cross-reference
  // against the pins themselves so it is called out here, not silently
  // absent. `trip plan`'s own reason string is not persisted (compile()
  // recomputes it fresh each run), so this can only say THAT it was
  // dropped, not why.
  const pins = await readPins(db, trip.id);
  const placedIds = new Set(placements.map((p) => p.segmentId));
  const dayUnplaced: Unplaced[] = pins
    .filter((p) => p.day === day.day && !placedIds.has(p.segmentId))
    .map((p) => ({
      segmentId: p.segmentId,
      reason: "not placed by the last plan - run `trip plan` to see why",
    }));

  // The FULL day list, not just the one being shown: a pass resolves against
  // the first day it covers, which is usually not this one.
  const pricing = await buildPricing(
    db, trip.id, trip.currency, days, placements, segments);
  if (json) return planJson([day], placements, segments, dayUnplaced, pricing);
  // withBreakdown: `trip day` is the detail view, so it earns the
  // per-traveller rows that `trip plan` deliberately omits.
  return renderDay(
    day, placements, new Map(segments.map((s) => [s.id, s])), dayUnplaced,
    pricing, true);
}

async function doPin(db: Client, argv: string[], json: boolean): Promise<string> {
  const { days, segments } = await loadContext(db);
  const token = argv.find((a) => !a.startsWith("--"));
  if (!token) throw new Error("usage: trip pin <seg> --day=<n> [--at=HH:MM]");
  const segment = resolveSegment(segments, token);

  const dayRaw = flag(argv, "--day");
  if (dayRaw === null) throw new Error("--day is required (e.g. --day=2)");
  const day = Number(dayRaw);
  if (!days.some((d) => d.day === day)) {
    throw new Error(`day ${dayRaw} is outside the trip (1-${days.length})`);
  }

  const atRaw = flag(argv, "--at");
  const startMin = atRaw === null ? null : parseClock(atRaw);
  await setPinned(db, segment.id, day, startMin);

  const when = startMin === null ? `day ${day}` : `day ${day} at ${formatClock(startMin)}`;
  return json
    ? JSON.stringify({ pinned: segment.id, day, startTime: atRaw })
    : `pinned ${segment.name} to ${when}. Run \`trip replan\` to rebuild around it.`;
}

async function doUnpin(db: Client, argv: string[], json: boolean): Promise<string> {
  const { segments } = await loadContext(db);
  const token = argv.find((a) => !a.startsWith("--"));
  if (!token) throw new Error("usage: trip unpin <seg>");
  const segment = resolveSegment(segments, token);

  if (!(await clearPin(db, segment.id))) {
    throw new Error(`${segment.name} is not pinned`);
  }
  return json
    ? JSON.stringify({ unpinned: segment.id })
    : `unpinned ${segment.name}. Run \`trip replan\` to let the compiler place it.`;
}

async function doMove(db: Client, argv: string[], json: boolean): Promise<string> {
  const { days, segments } = await loadContext(db);
  const token = argv.find((a) => !a.startsWith("--"));
  if (!token) throw new Error("usage: trip move <seg> --to=day<n>");
  const segment = resolveSegment(segments, token);

  const toRaw = flag(argv, "--to");
  if (toRaw === null) throw new Error("--to is required (e.g. --to=day4)");
  const day = Number(toRaw.replace(/^day/i, ""));
  if (!days.some((d) => d.day === day)) {
    throw new Error(`day ${toRaw} is outside the trip (1-${days.length})`);
  }

  // move PINS (M2 spec). Leaving it unpinned would mean the next replan
  // silently undoes the move.
  await setPinned(db, segment.id, day, null);
  return json
    ? JSON.stringify({ moved: segment.id, day })
    : `moved ${segment.name} to day ${day} (pinned to the day, time is the compiler's). ` +
      "Run `trip replan`.";
}

/** Resolve what the party pays, for every placed segment and every pass.
 *
 *  Lives HERE rather than in the renderer because this is where a segment and
 *  its day are both in hand — the free-day override needs the day's weekday,
 *  and the age rules need the day's date. Renderers stay pure string
 *  formatters that do no arithmetic on ages.
 *
 *  A segment placed on no day cannot be priced and simply is not in the map,
 *  which reads as unknown. That is correct: its price is not knowable until
 *  it is placed (M5-8). */
async function buildPricing(
  db: Client,
  tripId: number,
  currency: string | null,
  days: DayWindow[],
  placements: Placement[],
  segments: Segment[],
): Promise<PlanPricing> {
  const travellers = await listTravellers(db, tripId);
  const party = travellers.map((t) => ({
    id: t.id, label: t.label, birthDate: t.birthDate,
  }));

  const byId = new Map(segments.map((s) => [s.id, s]));
  const dayById = new Map(days.map((d) => [d.day, d]));
  const segRules = await readPriceRules(db, "segment", segments.map((s) => s.id));

  const bySegment = new Map<number, ReturnType<typeof resolveParty>>();
  for (const p of placements) {
    const seg = byId.get(p.segmentId);
    const day = dayById.get(p.day);
    if (!seg || !day) continue;
    bySegment.set(
      p.segmentId,
      resolveParty(
        segRules.get(p.segmentId) ?? [],
        party,
        day.date,
        seg.freeDays.includes(day.weekday),
      ),
    );
  }

  const passList = await listPasses(db, tripId);
  const passRules = await readPriceRules(db, "pass", passList.map((x) => x.id));
  // A pass is counted once, not per day, so it resolves against the FIRST day
  // it covers. Ages could differ across a long pass's window; the first day is
  // the day you buy it, which is the day the fare is actually assessed.
  const passes = passList.map((pass) => {
    const start = dayById.get(pass.fromDay);
    // `pass add` validates the range against the trip's length, but only AT
    // ENTRY. A later `trip dates set` to a shorter range strands the pass
    // pointing at days that no longer exist.
    //
    // Substituting day 1's date here would price the pass against the wrong
    // day — a senior who crosses a threshold between day 1 and the pass's
    // real start gets the wrong fare, while `pass ls` and the footer still
    // show the old range, with nothing saying anything is amiss. A silent
    // wrong number is exactly what the governing principle forbids, so the
    // pass is UNKNOWN instead: a check that cannot be sure says nothing.
    if (start === undefined) {
      return { pass, price: { perTraveller: [], total: null } };
    }
    return {
      pass,
      price: resolveParty(passRules.get(pass.id) ?? [], party, start.date),
    };
  });

  return { currency, bySegment, passes, travellers: party };
}

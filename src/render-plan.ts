import { formatClock } from "@/parse";
import type { Segment } from "@/segments";
import type { DayWindow } from "@/days";
import type { Placement, Unplaced } from "@/plan/types";
import type { PartyPrice } from "@/pricing/party";
import { formatRule, type PriceRule } from "@/pricing/rules";
import type { Pass } from "@/passes";
import type { Mode } from "@/plan/types";
import type { TravelModel } from "@/plan/travel";

/** How to get between two consecutive stops, and whether anyone measured it.
 *
 *  Optional everywhere below, on the same terms as `PlanPricing`: absent means
 *  render exactly as trip did before M8, byte for byte. */
export interface PlanTravel {
  model: TravelModel;
  mode: Mode;
}

/** Everything the renderers need to talk about money, resolved by the command
 *  layer. Renderers stay pure string-formatters — they do no arithmetic on
 *  ages and issue no queries. */
export interface PlanPricing {
  /** null renders bare numbers, exactly as trip did before M5. */
  currency: string | null;
  /** A segment ABSENT from this map is UNKNOWN — which is why it is a Map and
   *  not an array of totals. */
  bySegment: Map<number, PartyPrice>;
  passes: { pass: Pass; price: PartyPrice }[];
  /** The party, in the order breakdowns should list them. Empty means no
   *  prices can be computed at all. */
  travellers: { id: number; label: string; birthDate: string }[];
}

/** A single line item. `free` and `?` are different words on purpose and must
 *  never be swapped: one says the place costs nothing, the other says nobody
 *  knows. They are one careless `??` apart in any renderer. */
function money(amount: number | null, currency: string | null): string {
  if (amount === null) return "?";
  if (amount === 0) return "free";
  return currency === null ? String(amount) : `${currency} ${amount}`;
}

/** A TOTAL never says `free`. "Day 2 total free + 2 unknown" reads as a
 *  contradiction, and a total is an arithmetic result rather than a statement
 *  about what a venue charges. */
function moneyTotal(amount: number, currency: string | null): string {
  return currency === null ? String(amount) : `${currency} ${amount}`;
}

/** Known sum plus a count of the things nobody knows. Never collapses the
 *  unknowns into the number, and never hides them. */
function totalLine(
  prices: (PartyPrice | undefined)[],
  currency: string | null,
): string {
  const known = prices.filter(
    (p): p is PartyPrice => p !== undefined && p.total !== null,
  );
  const unknown = prices.length - known.length;
  const sum = known.reduce((acc, p) => acc + (p.total ?? 0), 0);
  // NOTHING TO PRICE IS NOT THE SAME AS NOT KNOWING THE PRICE. A day with no
  // segments on it costs zero, definitively — there is no unpriced thing for
  // the number to be hiding. Rendering "?" there would claim ignorance the
  // renderer does not have, which is the same false-confidence failure as
  // claiming knowledge it does not have, pointed the other way.
  if (prices.length === 0) return moneyTotal(0, currency);
  const head = known.length === 0 ? "?" : moneyTotal(sum, currency);
  return unknown === 0 ? head : `${head} + ${unknown} unknown`;
}

/** The video's words, with OSM's local-script name beside them when it differs.
 *  Both are kept: `name` is what the traveller recognises, `localName` is what
 *  you show a taxi driver in a country whose script you do not read. */
function displayName(s: { name: string; localName?: string | null }): string {
  return s.localName && s.localName !== s.name
    ? `${s.name} (${s.localName})`
    : s.name;
}

/** Human rendering for the segment library and the compiled plan. Returns
 *  strings — printing belongs to cli.ts alone. */
export function renderSegmentList(
  segments: Segment[],
  // A segment's price is NOT knowable until it is placed: rules resolve
  // against a traveller's age on the visit date, and an unplaced segment has
  // no date. So this shows the RULES, never a resolved total (M5-8).
  rules: Map<number, PriceRule[]> = new Map(),
): string {
  const lines = ["  id  dur   name"];
  for (const s of segments) {
    const dur = `${s.dwellMinutes}m`.padStart(5);
    const marks: string[] = [];
    // The 60-minute fallback is a guess, so it is labelled. NOT "?" — that
    // already means unknown opening hours on this same line.
    if (s.dwellIsDefault) marks.push("[default]");
    if (s.latitude === null) marks.push("no coords");
    // A bare "?" is how unknown hours stay visible without pretending to a
    // value (M2-2).
    if (s.opensMin === null) marks.push("?");
    // F7: `closesMin ?? 1439` printed "10:00-23:59" for a genuinely UNKNOWN
    // closing time — a fabricated window, indistinguishable from a segment
    // that really is open until midnight. Unreachable in M2 (`--hours`
    // requires both ends), but closesMin is independently nullable in the
    // schema and M3's partial-hours ingestion will produce this shape for
    // real. Mark the unknown side, same convention as the opensMin case
    // right above.
    else marks.push(`${formatClock(s.opensMin)}-${s.closesMin === null ? "?" : formatClock(s.closesMin)}`);
    if (s.closedDays.length > 0) marks.push(`closed ${s.closedDays.join(",")}`);
    if (s.freeDays.length > 0) marks.push(`free ${s.freeDays.join(",")}`);
    const r = rules.get(s.id);
    // Rules, not a price. No rules is SILENT here rather than marked "?" —
    // that character already means unknown HOURS on this same line, and two
    // meanings for one mark is how a reader learns to ignore it.
    if (r !== undefined) marks.push(r.map(formatRule).join(" "));
    if (s.tags.length > 0) marks.push(`[${s.tags.join(",")}]`);
    lines.push(`  ${String(s.id).padStart(2)} ${dur}   ${displayName(s)}  ${marks.join("  ")}`);
  }
  return lines.join("\n");
}

export function renderDay(
  day: DayWindow,
  placements: Placement[],
  segments: Map<number, Segment>,
  // Pinned-to-this-day segments the compiler could NOT place this round
  // (fix round 1). Defaulted to [] so renderPlan's per-day calls, which
  // already report the complete unplaced list in their own trailer, are
  // unaffected — only `trip day`'s single-day view needs this.
  unplaced: Unplaced[] = [],
  // Absent means render exactly as trip did before M5, byte for byte.
  pricing?: PlanPricing,
  // `trip plan` shows the party totals only; `trip day` earns its name by
  // also breaking them down per traveller.
  withBreakdown = false,
  // Absent means no hop lines at all, exactly as before M8.
  travel?: PlanTravel,
): string {
  const lines = [
    `Day ${day.day}  ${day.date} ${day.weekday}  ` +
    `${formatClock(day.startMin)}-${formatClock(day.endMin)}`,
  ];
  const onDay = placements
    .filter((p) => p.day === day.day)
    // (ordinal, startMin, segmentId), not ordinal alone: between `trip
    // pin`/`trip move` and the next `trip replan`, setPinned writes ordinal
    // 0 unconditionally, which can tie with whatever the previous plan
    // already put at ordinal 0 on this day. `ordinal` is NOT NULL in the
    // schema, so there is no "no opinion yet" sentinel to fall back on, and
    // an unstable order here would render differently across calls.
    .sort((a, b) => a.ordinal - b.ordinal || a.startMin - b.startMin || a.segmentId - b.segmentId);

  if (onDay.length === 0) {
    lines.push("  (nothing planned)");
  } else {
    let previous: Segment | undefined;
    for (const p of onDay) {
      const s = segments.get(p.segmentId);
      // F6: this used to `continue` here, silently DROPPING the placement
      // from the day entirely — the exact false-confidence direction M2-2
      // exists to prevent (a day that looked shorter than it really was,
      // with no sign anything was omitted). The unplaced trailer below
      // already degrades honestly to `#<id>` for a segment it can't name;
      // match that instead of vanishing the line.
      const name = s ? displayName(s) : `#${p.segmentId}`;
      const dwell = s?.dwellMinutes ?? p.endMin - p.startMin;
      const marks: string[] = [];
      // Unknown hours are marked, never hidden. This is the visible half of
      // M2-2 — the plan says which segments it placed blind. Whether hours
      // are known is itself unknowable for a segment lookup failed, so no
      // mark is added rather than guessing either way.
      if (s && s.opensMin === null) marks.push("?");
      if (s?.dwellIsDefault) marks.push("[default]");
      if (p.pinned) marks.push("pinned");
      const price = pricing === undefined
        ? ""
        : `  ${money(pricing.bySegment.get(p.segmentId)?.total ?? null, pricing.currency).padStart(9)}`;
      // The hop that got you here. Printed BEFORE the stop it leads to, so a
      // reader scanning down the day sees travel and arrival in the order they
      // happen.
      //
      // "(estimated)" is a LOUD ABSENCE, not a hedge on a measured number: it
      // says no leg exists for this directed hop, so the figure came from a
      // straight line times a constant. M8 measured that model at 27%
      // optimistic on hops under 2 km -- which is most of a day -- so a reader
      // deserves to know which of the two kinds of number they are looking at.
      const hop = travel === undefined ? null : hopLine(previous, s, travel);
      if (hop !== null) lines.push(hop);
      previous = s;

      lines.push(
        `  ${formatClock(p.startMin)} ${name.padEnd(28)}` +
        `${String(dwell).padStart(4)}m${price}  ${marks.join(" ")}`.trimEnd(),
      );
    }
  }

  if (pricing !== undefined) {
    const dayPrices = onDay.map((p) => pricing.bySegment.get(p.segmentId));
    lines.push(
      `  Day ${day.day} total`.padEnd(46) + totalLine(dayPrices, pricing.currency),
    );

    if (withBreakdown && pricing.travellers.length > 0) {
      // THE RULE, and it is not the obvious one: a segment whose PARTY total
      // is unknown drops out wholesale — from the day total above AND from
      // every traveller's row here — and is counted once in a single shared
      // trailer.
      //
      // Propagating unknown per traveller instead is the natural-sounding
      // alternative and it breaks the milestone's headline invariant: on a day
      // with two priced places and one unpriced one, every traveller is
      // unknown at the unpriced place, so every row would render "?" while the
      // day total still reads a number. The two sums agree only if both drop
      // the same segments. Verified by mutation: propagating per traveller
      // fails five tests in this file.
      //
      // The consequence that looks wrong at a glance is correct: at a segment
      // carrying only `65+:0` the party total is unknown, so it leaves the
      // senior's row too, even though her free admission there is perfectly
      // well known. A row that kept it would not sum to a total that dropped it.
      const priced = dayPrices.filter(
        (p): p is PartyPrice => p !== undefined && p.total !== null,
      );
      const unknownCount = dayPrices.length - priced.length;
      lines.push("");
      for (const t of pricing.travellers) {
        const sum = priced.reduce((acc, p) => {
          const mine = p.perTraveller.find((x) => x.id === t.id);
          return acc + (mine?.price ?? 0);
        }, 0);
        // Age comes off any resolved segment — it is the same date for all of
        // them. Absent only when the whole day is unpriced, in which case the
        // row shows the birth date alone rather than inventing an age.
        const age = dayPrices
          .find((p) => p?.perTraveller.some((x) => x.id === t.id))
          ?.perTraveller.find((x) => x.id === t.id)?.age;
        const who = `    ${t.label.padEnd(8)} b.${t.birthDate}` +
                    (age === undefined ? "" : `  age ${age}`);
        lines.push(`${who.padEnd(46)}${money(sum, pricing.currency)}`);
      }
      if (unknownCount > 0) {
        lines.push(`${"".padEnd(46)}+ ${unknownCount} unknown`);
      }
    }
  }

  // A pinned segment the compiler dropped is called out here, not silently
  // omitted — the same M2 principle renderPlan's own "not placed" trailer
  // follows. Without this, a day with a failed pin looked identical to a
  // day that simply had less to do.
  if (unplaced.length > 0) {
    lines.push("", `${unplaced.length} pinned to this day but not placed:`);
    for (const u of unplaced) {
      lines.push(`  ${segments.get(u.segmentId)?.name ?? `#${u.segmentId}`} - ${u.reason}`);
    }
  }
  return lines.join("\n");
}

/** null when there is no hop to describe: the first stop of a day, a segment
 *  the renderer could not resolve, or one with no coordinates. A hop that
 *  cannot be computed says nothing rather than printing a zero. */
function hopLine(
  from: Segment | undefined,
  to: Segment | undefined,
  travel: PlanTravel,
): string | null {
  if (!from || !to) return null;
  if (from.latitude === null || from.longitude === null) return null;
  if (to.latitude === null || to.longitude === null) return null;
  const est = travel.model.estimate(
    { latitude: from.latitude, longitude: from.longitude },
    { latitude: to.latitude, longitude: to.longitude },
    travel.mode,
  );
  const word = travel.mode === "walking" ? "walk" : "transit";
  return `       -> ${est.minutes} min ${word} ` +
         `(${est.measured ? "measured" : "estimated"})`;
}

export function renderPlan(
  days: DayWindow[],
  placements: Placement[],
  segments: Segment[],
  unplaced: Unplaced[],
  pricing?: PlanPricing,
  travel?: PlanTravel,
): string {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const parts = days.map((d) =>
    renderDay(d, placements, byId, [], pricing, false, travel));

  if (pricing !== undefined) {
    if (pricing.travellers.length === 0) {
      // An unknown party means every total is unknown. Say so and name the
      // fix rather than printing zeros (M5-10).
      parts.push(
        "",
        "No travellers set, so no prices can be computed.",
        "Add one with: trip who add <label> --born=YYYY-MM-DD",
      );
    } else {
      const admission = placements.map((p) => pricing.bySegment.get(p.segmentId));
      const passPrices = pricing.passes.map((x) => x.price);
      parts.push("", `Admission    ${totalLine(admission, pricing.currency)}`);
      for (const { pass, price } of pricing.passes) {
        // Counted ONCE per eligible traveller and reported on its own line,
        // deliberately NOT sliced across the days it covers: no single day
        // costs a third of a three-day pass, and an average is not a fact.
        parts.push(
          `  ${pass.name.padEnd(24)} days ${pass.fromDay}-${pass.toDay}  ` +
          money(price.total, pricing.currency),
        );
      }
      if (pricing.passes.length > 0) {
        parts.push(`Passes       ${totalLine(passPrices, pricing.currency)}`);
      }
      parts.push(
        `Trip total   ${totalLine([...admission, ...passPrices], pricing.currency)}`,
      );
    }
  }

  // F6: `byId.get(...)?.opensMin === null` is FALSE for a segment the map
  // can't find (undefined?.opensMin is undefined, not null), which UNDER-
  // counts the exact thing this warning exists to catch — placed blind, no
  // sign of it. A segment we cannot even look up is the least-known case of
  // all, so it counts as blind rather than silently not counting.
  const blind = placements.filter((p) => {
    const s = byId.get(p.segmentId);
    return s === undefined || s.opensMin === null;
  });
  if (blind.length > 0) {
    parts.push(
      "",
      `${blind.length} segment${blind.length === 1 ? "" : "s"} placed without ` +
      `opening hours (?) - verify before you go.`,
    );
  }

  if (unplaced.length > 0) {
    parts.push("", `${unplaced.length} not placed:`);
    for (const u of unplaced) {
      parts.push(`  ${byId.get(u.segmentId)?.name ?? `#${u.segmentId}`} - ${u.reason}`);
    }
  }
  return parts.join("\n");
}

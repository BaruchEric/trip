import { formatClock } from "@/parse";
import type { Segment } from "@/segments";
import type { DayWindow } from "@/days";
import type { Placement, Unplaced } from "@/plan/types";

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
export function renderSegmentList(segments: Segment[]): string {
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
      lines.push(
        `  ${formatClock(p.startMin)} ${name.padEnd(28)}` +
        `${String(dwell).padStart(4)}m  ${marks.join(" ")}`.trimEnd(),
      );
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

export function renderPlan(
  days: DayWindow[],
  placements: Placement[],
  segments: Segment[],
  unplaced: Unplaced[],
): string {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const parts = days.map((d) => renderDay(d, placements, byId));

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

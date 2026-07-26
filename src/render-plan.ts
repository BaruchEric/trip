import { formatClock } from "@/parse";
import type { Segment } from "@/segments";
import type { DayWindow } from "@/days";
import type { Placement, Unplaced } from "@/plan/types";

/** Human rendering for the segment library and the compiled plan. Returns
 *  strings — printing belongs to cli.ts alone. */
export function renderSegmentList(segments: Segment[]): string {
  const lines = ["  id  dur   name"];
  for (const s of segments) {
    const dur = `${s.dwellMinutes}m`.padStart(5);
    const marks: string[] = [];
    if (s.latitude === null) marks.push("no coords");
    // A bare "?" is how unknown hours stay visible without pretending to a
    // value (M2-2).
    if (s.opensMin === null) marks.push("?");
    else marks.push(`${formatClock(s.opensMin)}-${formatClock(s.closesMin ?? 1439)}`);
    if (s.closedDays.length > 0) marks.push(`closed ${s.closedDays.join(",")}`);
    if (s.tags.length > 0) marks.push(`[${s.tags.join(",")}]`);
    lines.push(`  ${String(s.id).padStart(2)} ${dur}   ${s.name}  ${marks.join("  ")}`);
  }
  return lines.join("\n");
}

export function renderDay(
  day: DayWindow,
  placements: Placement[],
  segments: Map<number, Segment>,
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
    return lines.join("\n");
  }

  for (const p of onDay) {
    const s = segments.get(p.segmentId);
    if (!s) continue;
    const marks: string[] = [];
    // Unknown hours are marked, never hidden. This is the visible half of
    // M2-2 — the plan says which segments it placed blind.
    if (s.opensMin === null) marks.push("?");
    if (p.pinned) marks.push("pinned");
    lines.push(
      `  ${formatClock(p.startMin)} ${s.name.padEnd(28)}` +
      `${String(s.dwellMinutes).padStart(4)}m  ${marks.join(" ")}`.trimEnd(),
    );
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

  const blind = placements.filter((p) => byId.get(p.segmentId)?.opensMin === null);
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

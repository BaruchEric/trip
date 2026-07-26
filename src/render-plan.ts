import { formatClock } from "@/parse";
import type { Segment } from "@/segments";

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

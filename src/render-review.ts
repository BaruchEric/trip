import type { Mention } from "@/mentions";
import { formatStamp } from "@/watch/parse-report";

/** Human rendering for the review queue. Returns a string — printing belongs
 *  to cli.ts alone. */
export function renderReviewQueue(
  mentions: Mention[],
  destinationName: string,
  radiusKm: number,
): string {
  // The search extent is stated every time. The confidence rule is only as
  // good as the box it searched, so the box is never left implicit.
  const header =
    `${mentions.length} mention${mentions.length === 1 ? "" : "s"} pending review` +
    ` - searched a ${radiusKm} km box around ${destinationName}`;

  if (mentions.length === 0) return `nothing pending review (${header}).`;

  const lines = [header, ""];
  for (const m of mentions) {
    // A missing timestamp is named, not rendered as 00:00 — second 0 is the
    // first frame of the video and would send a reader to the wrong place.
    const at = m.atSeconds === null ? "no timestamp" : formatStamp(m.atSeconds);
    // BOTH facts, the way displayName keeps a segment's name beside its local
    // name. Rendering `text` alone meant a failed `--rename` left you looking
    // at the name you had just replaced, unable to see what was stored or
    // queried — found by M6's first real end-to-end run, where ten of eleven
    // caption names needed renaming and several still missed. Rendering
    // `name` alone would lose what the video actually SAID, which is the one
    // thing a mention exists to record.
    const said = m.resolvedName !== null && m.resolvedName !== m.text
      ? `  (said: "${m.text}")`
      : "";
    // What it was looked up BY, when that differs from what it is called.
    // A `no match` against a name that plainly exists is mysterious without
    // this, in exactly the way a failed --rename was before M6.
    const searched = m.query !== null && m.query !== m.name
      ? `  (searched: ${m.query})`
      : "";
    lines.push(
      `#${m.id}  "${m.name}"${said}${searched}  (source ${m.sourceId}, ${at}) - ${m.reason ?? "pending"}`,
    );
    if (m.candidates.length === 0) {
      lines.push(
        `    trip review resolve ${m.id} --rename="Actual Name"   or   --reject`,
      );
    } else {
      for (const c of m.candidates) {
        const what = [c.type, `${c.kmFromCentre.toFixed(1)} km`]
          .filter((x): x is string => Boolean(x))
          .join(", ");
        lines.push(`    ${c.rank}. ${c.localName ?? c.displayName} - ${what}`);
        lines.push(`       ${c.displayName}`);
      }
      lines.push(
        `    trip review resolve ${m.id} --pick=1   or   --reject   or   --rename="..."`,
      );
    }
    lines.push("");
  }
  return lines.join("\n").trimEnd();
}

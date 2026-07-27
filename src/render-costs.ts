import { perPersonPerDay, type CostObservation } from "@/observations";
import { formatStamp } from "@/watch/parse-report";

/** The observations table as a string. Pure — printing belongs to cli.ts.
 *
 *  NEVER SUMS. A source may state components AND their total: the measured
 *  Chongqing card lists transportation, accommodation, activities and then
 *  $401, so adding the rows double-counts by exactly the total. Rows are
 *  reported; a source says what it says.
 *
 *  Never shown beside the plan's own total either. One is what a stranger
 *  spent and the other is what your plan costs, in different currencies with
 *  no conversion available — a single line holding both would be a fabricated
 *  comparison. That is why this renderer exists rather than a column in
 *  render-plan.ts. */
export function renderObservations(observations: CostObservation[]): string {
  if (observations.length === 0) {
    return "No cost observations yet. Add one with: " +
      "trip costs add <label> --amount=230 --currency=USD [--days=4] [--people=1]";
  }

  const lines: string[] = [];
  for (const o of observations) {
    const coverage = o.coversDays === null || o.coversPeople === null
      ? "coverage unknown"
      : `${o.coversDays}d x ${o.coversPeople}p`;
    const rate = perPersonPerDay(o);
    // "?" and not a number: an unknown denominator makes the rate
    // UNAVAILABLE, not approximate.
    const pppd = rate === null ? "?" : `${o.currency} ${rate.toFixed(2)} pppd`;

    lines.push(
      `  #${String(o.id).padStart(2)}  ${o.label.padEnd(20)}` +
      `${`${o.currency} ${o.amount}`.padEnd(12)}${coverage.padEnd(18)}${pppd}`,
    );
    // Provenance on its own line, always. An observation without it is just
    // a number somebody typed, and the whole point of the table is that these
    // came from somewhere nameable.
    lines.push(
      o.sourceId === null
        ? "        entered by hand"
        : `        from source ${o.sourceId}` +
          (o.atSeconds === null ? "" : ` at ${formatStamp(o.atSeconds)}`),
    );
  }
  return lines.join("\n");
}

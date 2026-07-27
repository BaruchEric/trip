import { perPersonPerDay } from "@/observations";
import { combinedTotal, type BudgetReport } from "@/budget";
import { formatStamp } from "@/watch/parse-report";

/** A pure string formatter. Every refusal it prints names a specific missing
 *  input, because "cannot compute" is a shrug rather than an answer. */

function money(n: number | null, currency: string | null): string {
  if (n === null) return "unknown";
  const s = Number.isInteger(n) ? String(n) : n.toFixed(2);
  return currency === null ? s : `${s} ${currency}`;
}

export function renderBudget(r: BudgetReport): string {
  const lines = [
    `${r.tripName} - ${r.days} day${r.days === 1 ? "" : "s"}, ` +
    `${r.travellers} traveller${r.travellers === 1 ? "" : "s"}` +
    (r.currency === null ? "" : `, ${r.currency}`),
    "",
    "ADMISSIONS (from your plan)",
    `  known                  ${money(r.admissions.total, r.currency)}`,
  ];
  if (r.admissions.unknown > 0) {
    // Never rendered as zero. An unpriced segment is not a free one.
    lines.push(
      `  unknown                ${r.admissions.unknown} segment` +
      `${r.admissions.unknown === 1 ? " has" : "s have"} no price recorded`,
    );
  }

  if (r.passes.total !== null && r.passes.total > 0) {
    lines.push("", "PASSES", `  known                  ${money(r.passes.total, r.currency)}`);
  }

  lines.push("", "DAILY COSTS");
  if (r.daily === null) {
    if (r.observations.length === 0) {
      lines.push(
        "  None recorded. Lodging, food and local transport are UNACCOUNTED",
        "  FOR - which is not the same as free.",
        "  Record one with: trip costs add <label> --amount=<n> --currency=<c>",
        "                     --days=<n> --people=<n>",
      );
    } else {
      lines.push(`  Not selected. ${r.observations.length} recorded:`);
      for (const o of r.observations) {
        const rate = perPersonPerDay(o);
        lines.push(
          `    ${String(o.id).padStart(2)}  ${o.label.padEnd(20)}` +
          `${money(o.amount, o.currency).padStart(11)}  ` +
          (o.coversDays === null || o.coversPeople === null
            ? "coverage unknown"
            : `${o.coversDays}d x ${o.coversPeople}p  ` +
              `${rate!.toFixed(2).padStart(7)} per person per day`),
        );
      }
      lines.push(
        "  Choose one with --daily=<id>. They are NOT added together: a source",
        "  that states components AND a total describes the same money twice.",
      );
    }
  } else {
    const d = r.daily;
    const where = d.observation.sourceId === null
      ? "entered by hand"
      : `source ${d.observation.sourceId}` +
        (d.observation.atSeconds === null ? "" : ` at ${formatStamp(d.observation.atSeconds)}`);
    lines.push(
      `  From observation ${d.observation.id} "${d.observation.label}" (${where}):`,
      `    ${d.perPersonPerDay.toFixed(2)} ${d.observation.currency} per person per day`,
      `  Projected  ${d.perPersonPerDay.toFixed(2)} x ${d.days} days x ` +
      `${d.travellers} traveller${d.travellers === 1 ? "" : "s"} = ` +
      `${money(d.projected, d.observation.currency)}`,
      "",
      `  This is one source's claim about a DIFFERENT trip - ` +
      `${d.observation.coversDays} day${d.observation.coversDays === 1 ? "" : "s"}, ` +
      `${d.observation.coversPeople} ` +
      `person${d.observation.coversPeople === 1 ? "" : "s"} - and the` +
      (d.travellers > 1
        ? " projection assumes your other travellers cost the same per day."
        : " projection assumes your days resemble theirs."),
      "  It is not a rate.",
    );
  }

  const total = combinedTotal(r);
  lines.push("", r.limit === null ? "TOTAL" : `AGAINST YOUR LIMIT (${money(r.limit, r.currency)})`);

  if (total !== null) {
    lines.push(`  ${money(total, r.currency)}`);
    if (r.limit !== null) {
      const over = total - r.limit;
      lines.push(over > 0
        ? `  OVER by ${money(over, r.currency)}`
        : `  Within budget, with ${money(-over, r.currency)} to spare`);
    }
  } else {
    // Answer what can be answered. Refusing wholesale when admissions are
    // perfectly well known is the same error as guessing.
    if (r.admissions.total !== null && r.limit !== null) {
      lines.push(
        `  Admissions      ${money(r.admissions.total, r.currency)} of ` +
        `${money(r.limit, r.currency)}`,
      );
    } else if (r.admissions.total !== null) {
      lines.push(`  Admissions      ${money(r.admissions.total, r.currency)}`);
    }
    if (r.daily !== null) {
      lines.push(
        `  Daily costs     ${money(r.daily.projected, r.daily.observation.currency)}`,
      );
    }
    lines.push("", "  No single figure, because:");
    for (const b of r.blockers) lines.push(`    - ${b}`);
  }

  if (r.limit === null && total === null) {
    lines.push("", "  Set a budget to compare against with --limit=<amount>.");
  }

  return lines.join("\n");
}

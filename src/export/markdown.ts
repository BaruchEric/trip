import { formatClock } from "@/parse";
import type { ExportView, ExportStop } from "@/export/view";

/** The complete record.
 *
 *  The other two formats point AT this one, because both of them carry the
 *  unknown-count trailers as extension fields that calendar and map clients
 *  ignore, and neither has anywhere to put the per-traveller breakdown. */

function money(n: number | null, currency: string | null): string {
  if (n === null) return "unknown";
  if (n === 0) return "free";
  return currency === null ? String(n) : `${n} ${currency}`;
}

function total(t: { total: number | null; unknown: number }, currency: string | null): string {
  const head = t.total === null ? "unknown" : money(t.total, currency);
  return t.unknown > 0 ? `${head} + ${t.unknown} unknown` : head;
}

function stopLine(s: ExportStop, currency: string | null): string {
  const name = s.localName === null ? s.name : `${s.name} (${s.localName})`;
  const marks: string[] = [];
  // The visible half of M2-2: the plan says which segments it placed blind.
  if (!s.hoursKnown) marks.push("hours unknown");
  if (s.pinned) marks.push("pinned");
  if (s.endsNextDay) marks.push("ends next day");
  return `| ${formatClock(s.startMin)}-${formatClock(s.endMin % 1440)} | ${name} | ` +
    `${money(s.price, currency)} | ${marks.join(", ")} |`;
}

export function renderMarkdownExport(v: ExportView): string {
  const out: string[] = [
    `# ${v.tripName}`,
    "",
    `Mode: ${v.mode}. ${v.days.length} day${v.days.length === 1 ? "" : "s"} from ${v.startDate}.`,
    "",
  ];

  for (const d of v.days) {
    out.push(`## Day ${d.day} — ${d.date} ${d.weekday}`, "");
    if (d.stops.length === 0) {
      out.push("_Nothing planned._", "");
      continue;
    }
    out.push("| time | place | price | notes |", "|---|---|---|---|");
    for (const s of d.stops) {
      if (s.arriveBy) {
        // "(estimated)" is a loud absence: no measured leg exists for this
        // directed hop, so the number came from a straight line.
        out.push(`| | _→ ${s.arriveBy.minutes} min ${s.arriveBy.mode}` +
          ` (${s.arriveBy.measured ? "measured" : "estimated"})_ | | |`);
      }
      out.push(stopLine(s, v.currency));
    }
    out.push("", `**Day ${d.day} total: ${total(d.dayTotal, v.currency)}**`, "");
  }

  out.push("## Cost", "", `**Trip total: ${total(v.tripTotal, v.currency)}**`, "");
  if (v.tripTotal.unknown > 0) {
    out.push(
      `${v.tripTotal.unknown} segment${v.tripTotal.unknown === 1 ? " has" : "s have"} ` +
      "no price recorded. That is UNKNOWN, not free — the total above is a " +
      "floor, not an estimate.",
      "");
  }

  if (v.travellers.length === 0) {
    out.push("No travellers set, so no prices can be computed.",
      "Add one with: `trip who add <label> --born=YYYY-MM-DD`", "");
  } else {
    out.push("| traveller | born | total |", "|---|---|---|");
    for (const t of v.perTraveller) {
      const who = v.travellers.find((x) => x.id === t.id)!;
      out.push(`| ${t.label} | ${who.birthDate} | ${money(t.total, v.currency)} |`);
    }
    out.push("",
      "A segment whose party total is unknown drops out of every row above " +
      "AND out of the trip total, so the two agree.", "");
  }

  if (v.unplaced.length > 0) {
    // Never silently omitted. A trip that looked smaller than it is, with
    // nothing to say so, is the failure this section exists to prevent.
    out.push(`## Not planned (${v.unplaced.length})`, "");
    for (const u of v.unplaced) out.push(`- **${u.name}** — ${u.reason}`);
    out.push("");
  }

  out.push("## How far these times can be trusted", "");
  if (v.calibration === null) {
    out.push(
      "No measured legs, so every travel time here comes from a straight-line",
      "model and how wrong it is HERE is unknown. Measure them with `trip route`.",
      "");
  } else {
    for (const b of v.calibration.bands) {
      out.push(`- ${b.label}: ` + (b.medianRatio === null
        ? "no legs measured"
        : `model ${Math.round(b.medianRatio * 100)}% of measured (n=${b.legCount})`));
    }
    out.push("",
      "Below 100% means the model under-estimates and the plan runs late.",
      "Which way it goes depends on the city, not on the model.", "");
  }

  return `${out.join("\n").trimEnd()}\n`;
}

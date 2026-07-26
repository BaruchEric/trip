import type { ScoredMonth } from "@/comfort";

export const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
] as const;

function bar(score: number): string {
  const filled = Math.round((score / 100) * 10);
  return "#".repeat(filled).padEnd(10, ".");
}

export function renderMonthTable(city: string, months: ScoredMonth[]): string {
  const rows = [...months].sort((a, b) => a.month - b.month);
  const header = `${city} - best months by dew-point comfort\n` +
    `      dew   high  rain   score`;
  const body = rows.map((m) => {
    const name = MONTH_NAMES[m.month - 1] ?? "???";
    const dew = m.dewPointMean.toFixed(1).padStart(5);
    const high = m.tempMaxMean.toFixed(0).padStart(5);
    const rain = m.rainDays.toFixed(0).padStart(5);
    const score = String(m.score).padStart(5);
    return `${name} ${dew} ${high} ${rain} ${score}  ${bar(m.score)}  ${m.band}`;
  });
  return [header, ...body].join("\n");
}

export function renderVerdict(months: ScoredMonth[]): string {
  if (months.length === 0) return "No climate data available.";

  const ranked = [...months].sort((a, b) => b.score - a.score || a.month - b.month);
  const best = ranked.slice(0, 2).map((m) => MONTH_NAMES[m.month - 1]);
  const bad = ranked.filter((m) => m.band === "muggy" || m.band === "oppressive");

  const lines = [`Go in ${best.join(" or ")}.`];
  if (bad.length > 0) {
    const names = [...bad]
      .sort((a, b) => a.month - b.month)
      .map((m) => MONTH_NAMES[m.month - 1]);
    const worst = bad[0]!;
    lines.push(
      `Avoid ${names.join(", ")} - dew point peaks around ` +
      `${worst.dewPointMean.toFixed(0)}C (${worst.band}).`,
    );
  }
  return lines.join("\n");
}

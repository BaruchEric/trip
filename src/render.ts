import { partitionByComfort, type ScoredMonth } from "@/comfort";

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

  // The split comes from comfort.ts, next to the band table whose cliff it
  // encodes. Recommending only from months NOT on the avoid list is what stops
  // the self-contradiction tropical cities used to produce:
  // "Go in Feb or Mar. Avoid Jan, Feb, Mar, ... Dec."
  const { recommend: good, avoid: bad } = partitionByComfort(months);

  const lines: string[] = [];
  if (good.length === 0) {
    // Every month is muggy or worse. Say so instead of inventing a good window.
    const mildest = bad[0]!;
    lines.push(
      `No comfortable month here - every month is muggy or worse. ` +
      `${MONTH_NAMES[mildest.month - 1]} is the least bad.`,
    );
  } else {
    lines.push(
      `Go in ${good.slice(0, 2).map((m) => MONTH_NAMES[m.month - 1]).join(" or ")}.`,
    );
  }

  if (bad.length > 0) {
    const names = [...bad]
      .sort((a, b) => a.month - b.month)
      .map((m) => MONTH_NAMES[m.month - 1]);
    // The peak is the HIGHEST DEW POINT among bad months. Using bad[0] took the
    // highest-SCORING bad month, i.e. the mildest one, so Tokyo reported its
    // peak as 20C (Sep) when the real peak is 23C (Aug).
    const peak = bad.reduce((a, b) => (b.dewPointMean > a.dewPointMean ? b : a));
    lines.push(
      `Avoid ${names.join(", ")} - dew point peaks around ` +
      `${peak.dewPointMean.toFixed(0)}C in ${MONTH_NAMES[peak.month - 1]} (${peak.band}).`,
    );
  }
  return lines.join("\n");
}

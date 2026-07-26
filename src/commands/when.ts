import type { Client } from "@libsql/client";
import { geocodeCity, type GeoCandidate } from "@/geocode";
import { getClimate, upsertDestination } from "@/climate/cache";
import { rankMonths, monthsExcluded, partitionByComfort } from "@/comfort";
import { renderMonthTable, renderVerdict, MONTH_NAMES } from "@/render";
import { getActiveTrip, setTripDestination } from "@/trips";

export interface WhenDeps {
  geocode?: (name: string, timeoutMs?: number) => Promise<GeoCandidate[]>;
  fetchFn?: typeof fetch;
  todayIso?: string;
}

/** `--timeout=<seconds>` in milliseconds, or undefined for the client default. */
function parseTimeout(argv: string[]): number | undefined {
  const flag = argv.find((a) => a.startsWith("--timeout"));
  if (flag === undefined) return undefined;
  const seconds = Number(flag.slice("--timeout=".length));
  // Rejected rather than defaulted: an agent asking for a 60s budget and
  // silently getting 15s would read the resulting timeout as a dead endpoint.
  if (!flag.startsWith("--timeout=") || !Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`--timeout must be a positive number of seconds, got "${flag}"`);
  }
  return Math.round(seconds * 1000);
}

export async function runWhenCommand(
  db: Client,
  argv: string[],
  json: boolean,
  deps: WhenDeps = {},
): Promise<string> {
  const refresh = argv.includes("--refresh");
  // JOIN every positional, don't take the first. `trip when New York` used to
  // geocode just "New" and silently answer about Patna, India — a wrong-continent
  // answer with exit code 0. Most major cities are multi-word.
  const city = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!city) throw new Error("usage: trip when <city> [--refresh]");

  const timeoutMs = parseTimeout(argv);

  const geocode = deps.geocode ?? ((n: string, t?: number) => geocodeCity(n, undefined, t));
  const candidates = await geocode(city, timeoutMs);
  const chosen = candidates[0];
  if (!chosen) throw new Error(`no city found matching "${city}"`);

  const stats = await getClimate(db, chosen, {
    todayIso: deps.todayIso,
    fetchFn: deps.fetchFn,
    force: refresh,
    timeoutMs,
  });

  // M2-6: the compiler needs coordinates to plan against, which is what makes
  // this relationship meaningful. It stayed null through all of M1 because
  // nothing consumed it. No active trip is fine — `trip when` is also the
  // standalone M1 entry point and must keep working on its own.
  const activeTrip = await getActiveTrip(db);
  if (activeTrip) {
    await setTripDestination(db, activeTrip.id, await upsertDestination(db, chosen));
  }

  const scored = rankMonths(stats);
  const noData = monthsExcluded(stats);

  if (json) {
    const { recommend, avoid } = partitionByComfort(scored);
    return JSON.stringify({
      city: chosen.name,
      country: chosen.country,
      latitude: chosen.latitude,
      longitude: chosen.longitude,
      months: [...scored].sort((a, b) => a.month - b.month),
      // The answer, not the ingredients. Both are best-first and come from the
      // same partition the human verdict renders from, so an agent never has to
      // re-derive the good/bad split — the re-derivation that shipped a verdict
      // recommending and avoiding the same month.
      recommend: recommend.map((m) => m.month),
      avoid: avoid.map((m) => m.month),
      // Was `monthsWithoutData`, which is no longer accurate: an entry can hold
      // real-but-thin data. Each carries the coverage that got it excluded, so
      // an agent need not guess whether a month is unmeasured or merely sparse.
      monthsExcluded: noData,
    });
  }

  const label = chosen.country ? `${chosen.name}, ${chosen.country}` : chosen.name;
  const parts = [renderMonthTable(label, scored), "", renderVerdict(scored)];

  // Thinly covered months are excluded from the ranking rather than scored as
  // 0 C. Say so with the numbers, otherwise they silently vanish from the table
  // and a broken fetch is indistinguishable from a genuinely unmeasured month.
  if (noData.length > 0) {
    const names = noData
      .map((m) => {
        const name = MONTH_NAMES[m.month - 1];
        return m.dayCount === 0
          ? `${name} (no data)`
          : `${name} (${Math.round(m.coverage * 100)}% covered)`;
      })
      .join(", ");
    parts.push("", `Excluded from the ranking for thin data: ${names}.`);
  }

  if (candidates.length > 1) {
    const others = candidates
      .slice(1, 4)
      .map((c) => `${c.name}, ${c.country ?? "?"}`)
      .join("; ");
    parts.push("", `Also matched: ${others}. Showing the largest by population.`);
  }

  return parts.join("\n");
}

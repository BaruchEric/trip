import type { Client } from "@libsql/client";
import { geocodeCity, type GeoCandidate } from "@/geocode";
import { getClimate } from "@/climate/cache";
import { rankMonths, monthsWithoutData } from "@/comfort";
import { renderMonthTable, renderVerdict, MONTH_NAMES } from "@/render";

export interface WhenDeps {
  geocode?: (name: string) => Promise<GeoCandidate[]>;
  fetchFn?: typeof fetch;
  todayIso?: string;
}

export async function runWhenCommand(
  db: Client,
  argv: string[],
  json: boolean,
  deps: WhenDeps = {},
): Promise<string> {
  const refresh = argv.includes("--refresh");
  const city = argv.find((a) => !a.startsWith("--"));
  if (!city) throw new Error("usage: trip when <city> [--refresh]");

  const geocode = deps.geocode ?? ((n: string) => geocodeCity(n));
  const candidates = await geocode(city);
  const chosen = candidates[0];
  if (!chosen) throw new Error(`no city found matching "${city}"`);

  const stats = await getClimate(db, chosen, {
    todayIso: deps.todayIso,
    fetchFn: deps.fetchFn,
    force: refresh,
  });
  const scored = rankMonths(stats);
  const noData = monthsWithoutData(stats);

  if (json) {
    return JSON.stringify({
      city: chosen.name,
      country: chosen.country,
      latitude: chosen.latitude,
      longitude: chosen.longitude,
      months: [...scored].sort((a, b) => a.month - b.month),
      monthsWithoutData: noData,
    });
  }

  const label = chosen.country ? `${chosen.name}, ${chosen.country}` : chosen.name;
  const parts = [renderMonthTable(label, scored), "", renderVerdict(scored)];

  // Months with no coverage are excluded from the ranking rather than scored
  // as 0 C. Say so, otherwise they just silently vanish from the table.
  if (noData.length > 0) {
    const names = noData.map((m) => MONTH_NAMES[m - 1]).join(", ");
    parts.push("", `No climate data for: ${names} (excluded from the ranking).`);
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

import { fetchJson } from "@/http";

export interface GeoCandidate {
  name: string;
  country: string | null;
  countryCode: string | null;
  latitude: number;
  longitude: number;
  timezone: string | null;
  population: number | null;
}

const GEOCODE_URL = "https://geocoding-api.open-meteo.com/v1/search";

interface RawResult {
  name?: unknown;
  country?: unknown;
  country_code?: unknown;
  latitude?: unknown;
  longitude?: unknown;
  timezone?: unknown;
  population?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" ? v : null;
}

export function parseGeocodeResponse(json: unknown): GeoCandidate[] {
  const results = (json as { results?: RawResult[] } | null)?.results;
  if (!Array.isArray(results)) return [];

  return results
    .flatMap((r): GeoCandidate[] => {
      const lat = num(r.latitude);
      const lon = num(r.longitude);
      const name = str(r.name);
      if (lat === null || lon === null || name === null) return [];
      return [{
        name,
        country: str(r.country),
        countryCode: str(r.country_code),
        latitude: lat,
        longitude: lon,
        timezone: str(r.timezone),
        population: num(r.population),
      }];
    })
    .sort((a, b) => (b.population ?? 0) - (a.population ?? 0));
}

export async function geocodeCity(
  name: string,
  fetchFn?: typeof fetch,
  timeoutMs?: number,
): Promise<GeoCandidate[]> {
  const url =
    `${GEOCODE_URL}?name=${encodeURIComponent(name)}&count=10&language=en&format=json`;
  const json = await fetchJson(url, `geocoding for "${name}"`, {
    fetchFn,
    timeoutMs,
  });
  return parseGeocodeResponse(json);
}

import { fetchJson, type FetchOptions } from "@/http";
import { haversineKm } from "@/plan/geo";

export interface Centre {
  latitude: number;
  longitude: number;
}

export interface PoiCandidate {
  /** OSM's full address string. This is what distinguishes five restaurants
   *  that share a name, so it is what the review list shows. */
  displayName: string;
  /** OSM's own short name, in local script (洪崖洞). NULL for an unnamed
   *  feature — never "". This becomes the segment's local_name. */
  localName: string | null;
  latitude: number;
  longitude: number;
  category: string | null;
  type: string | null;
  importance: number | null;
  osmType: string | null;
  osmId: number | null;
  kmFromCentre: number;
}

/** Half-width of the search box, in km, in each of the four directions.
 *
 *  Deliberately NOT OSM's administrative boundary: Chongqing's covers roughly
 *  82,000 km2, so a lone match 200 km outside the city would satisfy the
 *  "exactly one result" confidence rule and become a confident, wrong segment. */
export const SEARCH_RADIUS_KM = 25;

/** Nominatim's usage policy allows at most 1 request per second. */
export const NOMINATIM_MIN_INTERVAL_MS = 1100;

/** The policy also requires a genuine User-Agent. The repo is public, so this
 *  is the project URL rather than a personal address. */
export const USER_AGENT = "trip/0.1 (+https://github.com/BaruchEric/trip)";

const SEARCH_URL = "https://nominatim.openstreetmap.org/search";
const KM_PER_DEGREE_LAT = 111;

/** Nominatim wants `left,top,right,bottom` — that is lon,lat,lon,lat.
 *
 *  Longitude degrees shrink with latitude, so the longitude half-width is
 *  divided by cos(lat). A flat offset would cover only 21.7 km instead of 25 at
 *  Chongqing's 29.6N, and 12.5 km by 59.9N. */
export function viewbox(centre: Centre, km: number): string {
  const dLat = km / KM_PER_DEGREE_LAT;
  // Clamped so a centre at the pole does not divide by ~0 and produce Infinity.
  const cos = Math.max(0.01, Math.cos((centre.latitude * Math.PI) / 180));
  const dLon = km / (KM_PER_DEGREE_LAT * cos);
  const left = centre.longitude - dLon;
  const right = centre.longitude + dLon;
  const top = centre.latitude + dLat;
  const bottom = centre.latitude - dLat;
  return `${left},${top},${right},${bottom}`;
}

interface RawPoi {
  lat?: unknown; lon?: unknown;
  name?: unknown; display_name?: unknown;
  category?: unknown; type?: unknown;
  importance?: unknown;
  osm_type?: unknown; osm_id?: unknown;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number | null {
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/** Order is preserved: Nominatim already ranks its results, and re-sorting by
 *  `importance` would shuffle POIs that all sit at 0.0001. */
export function parsePoiResponse(json: unknown, centre: Centre): PoiCandidate[] {
  if (!Array.isArray(json)) return [];
  return (json as RawPoi[]).flatMap((r): PoiCandidate[] => {
    const latitude = num(r.lat);
    const longitude = num(r.lon);
    // A result without coordinates is not a place we can schedule. Dropping it
    // is honest; defaulting to 0,0 would put it in the Gulf of Guinea.
    if (latitude === null || longitude === null) return [];
    const displayName = str(r.display_name) ?? str(r.name);
    if (displayName === null) return [];
    return [{
      displayName,
      localName: str(r.name),
      latitude,
      longitude,
      category: str(r.category),
      type: str(r.type),
      importance: num(r.importance),
      osmType: str(r.osm_type),
      osmId: num(r.osm_id),
      kmFromCentre: haversineKm(centre, { latitude, longitude }),
    }];
  });
}

export async function geocodePoi(
  query: string,
  centre: Centre,
  opts: FetchOptions & { radiusKm?: number } = {},
): Promise<PoiCandidate[]> {
  const box = viewbox(centre, opts.radiusKm ?? SEARCH_RADIUS_KM);
  const url =
    `${SEARCH_URL}?q=${encodeURIComponent(query)}&format=jsonv2` +
    `&viewbox=${encodeURIComponent(box)}&bounded=1&limit=5&addressdetails=1`;
  // No accept-language: results come back in local script by design, which is
  // the whole point of storing local_name beside the video's own words.
  const json = await fetchJson(url, `geocoding "${query}"`, {
    ...opts,
    headers: { "User-Agent": USER_AGENT, ...(opts.headers ?? {}) },
  });
  return parsePoiResponse(json, centre);
}

import { fetchJson, type FetchOptions } from "@/http";
import type { Point } from "@/plan/types";

/** The two free, keyless pedestrian routers, both FOSSGIS-hosted.
 *
 *  They are kept as TWO rather than one because they disagree in a structured
 *  way. Valhalla models grade — it is asymmetric uphill, by up to 8.7 minutes
 *  over 360 m in Chongqing. OSRM foot applies a flat 5 km/h and is exactly
 *  symmetric, but returns consistently longer distances. Median disagreement
 *  4.7 min, maximum 25.1. Neither is "the truth"; the pair is the evidence.
 *
 *  See docs/superpowers/specs/2026-07-27-trip-m8-recon.md. */

/** The PROFILE IS THE INSTANCE. `routing.openstreetmap.de` runs a separate
 *  OSRM per profile and ignores the name in the /route/v1/<name>/ segment, so
 *  "driving" here is inert and changing it changes nothing.
 *
 *  This is worth stating because the OTHER public OSRM — the demo server at
 *  router.project-osrm.org — ignores it too, and serves the CAR profile for
 *  every value including `foot`. Probing that server returned 4.51 km in 5
 *  minutes for a walk and nearly put "there is no free walking router" into
 *  the M8 record. */
export const OSRM_URL = "https://routing.openstreetmap.de/routed-foot/route/v1/driving";
export const VALHALLA_URL = "https://valhalla1.openstreetmap.de/route";

/** Shared, unfunded instances with a published fair-use policy, exactly like
 *  Nominatim. A real User-Agent is the minimum courtesy. */
const UA = { "User-Agent": "trip-cli (https://github.com/BaruchEric/trip)" };

export interface RouterResult {
  minutes: number;
  meters: number;
}

export function parseOsrm(body: unknown): RouterResult {
  const b = body as {
    code?: string;
    message?: string;
    routes?: { duration?: number; distance?: number }[];
  };
  if (b?.code !== undefined && b.code !== "Ok") {
    throw new Error(`OSRM returned ${b.code}${b.message ? `: ${b.message}` : ""}`);
  }
  const r = b?.routes?.[0];
  // Both fields checked, not just the object: a route with a distance and no
  // duration would otherwise become a zero-minute leg, which tells the planner
  // two places are the same place.
  if (!r || typeof r.duration !== "number" || typeof r.distance !== "number") {
    throw new Error("OSRM returned no route");
  }
  return { minutes: r.duration / 60, meters: r.distance };
}

export function parseValhalla(body: unknown): RouterResult {
  const b = body as {
    error?: string;
    trip?: { summary?: { time?: number; length?: number } };
  };
  if (typeof b?.error === "string") throw new Error(`Valhalla: ${b.error}`);
  const s = b?.trip?.summary;
  if (!s || typeof s.time !== "number" || typeof s.length !== "number") {
    throw new Error("Valhalla returned no trip summary");
  }
  // Requested with `units: "km"`, so `length` is kilometres.
  return { minutes: s.time / 60, meters: s.length * 1000 };
}

export async function osrmFootLeg(
  a: Point, b: Point, opts: FetchOptions = {},
): Promise<RouterResult> {
  // lon,lat. Reversed, this returns a real route somewhere off West Africa
  // rather than an error.
  const coords = `${a.longitude},${a.latitude};${b.longitude},${b.latitude}`;
  // overview=false: M8 stores durations and distances, not geometry. A route
  // the user can follow is a different milestone with a different data model.
  const url = `${OSRM_URL}/${coords}?overview=false&alternatives=false&steps=false`;
  return parseOsrm(await fetchJson(url, "OSRM foot routing", { headers: UA, ...opts }));
}

export async function valhallaPedestrianLeg(
  a: Point, b: Point, opts: FetchOptions = {},
): Promise<RouterResult> {
  const body = JSON.stringify({
    locations: [
      { lat: a.latitude, lon: a.longitude },
      { lat: b.latitude, lon: b.longitude },
    ],
    costing: "pedestrian",
    units: "km",
  });
  return parseValhalla(
    await fetchJson(VALHALLA_URL, "Valhalla pedestrian routing", {
      method: "POST",
      body,
      headers: { ...UA, "Content-Type": "application/json" },
      ...opts,
    }),
  );
}

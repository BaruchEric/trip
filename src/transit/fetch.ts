import { haversineKm } from "@/plan/geo";
import type { TransitStation, TransitEdge } from "@/transit/store";

/** The urban rail network for a city, from Overpass.
 *
 *  THE ONLY NETWORK CALL M12 MAKES, and it is to Overpass, never to a router.
 *  `test/transit-fetch.test.ts` asserts that nothing in this directory names a
 *  routing costing, because the M12 recon found that Valhalla answers
 *  `costing` bus with HTTP 200 and a 13-minute figure for a trip its
 *  pedestrian profile puts at 77 minutes. That response has no stops, no
 *  waiting, no transfers and no timetable, and it looks exactly like a transit
 *  answer. A comment would not have survived a refactor; the test does. */

/** THE MODE SET IS PART OF THE MEASUREMENT, and getting it wrong is not a
 *  small error.
 *
 *  Asking Overpass for `route=subway` alone — the obvious query, and the one
 *  the M12 handoff described — returns NO LINE 2 AND NO LINE 3 in Chongqing.
 *  Both are straddle-beam monorails, tagged `route=monorail`. Line 2 is the
 *  line that runs through the residential block at Liziba, and Liziba is one
 *  of the seven places this project has actually resolved to a segment. On the
 *  narrow query its nearest station computed as Eling, 688 m away, because its
 *  own station was not in the data. A plan built on that would have routed a
 *  traveller around two of the busiest lines in the city.
 *
 *  It matters in three of the four cities measured: Bangkok's BTS is
 *  `light_rail`, and Amsterdam and Lisbon run trams carrying real urban trips.
 *
 *  ANYONE ADDING A CITY: widen this only with a measurement, and never narrow
 *  it for tidiness. See docs/superpowers/specs/2026-07-27-trip-m12-recon.md. */
export const RAIL_MODES = ["subway", "monorail", "light_rail", "tram"] as const;

/** south, west, north, east — Overpass bbox order.
 *
 *  Written out in full rather than described, per M6: evidence gathered with a
 *  query that differs from the production query is evidence about a different
 *  question, and M4's viewbox discrepancy survived two milestones because the
 *  record paraphrased the query.
 *
 *  `out body` is load-bearing. It emits relation members IN DOCUMENT ORDER,
 *  and consecutive stop-role members are the station sequence — the only
 *  ordering a station graph can be built from. `out tags` would return the
 *  same relations with no way to order them. */
export function overpassQuery(bbox: readonly [number, number, number, number]): string {
  return `[out:json][timeout:180];
rel["route"~"^(${RAIL_MODES.join("|")})$"](${bbox.join(",")});
out body;`;
}

/** The node members of those relations, with coordinates and tags. */
export function overpassNodesQuery(bbox: readonly [number, number, number, number]): string {
  return `[out:json][timeout:180];
rel["route"~"^(${RAIL_MODES.join("|")})$"](${bbox.join(",")});
node(r);
out body;`;
}

interface OverpassNode { id: number; lat: number; lon: number; tags?: Record<string, string> }
interface OverpassRelation {
  id: number;
  tags?: Record<string, string>;
  members?: Array<{ type: string; ref: number; role?: string }>;
}
interface OverpassResponse<T> { elements?: T[] }

export interface ParsedNetwork {
  stations: TransitStation[];
  edges: TransitEdge[];
  modes: string[];
  relationCount: number;
}

const nameOf = (n: OverpassNode): string =>
  n.tags?.name ?? n.tags?.["name:zh"] ?? `node/${n.id}`;

export function parseNetwork(
  relations: OverpassResponse<OverpassRelation>,
  nodes: OverpassResponse<OverpassNode>,
): ParsedNetwork {
  const rels = relations.elements ?? [];
  const nodeList = nodes.elements ?? [];
  const byId = new Map(nodeList.map((n) => [n.id, n]));

  // A STATION IS A NAME, at the centroid of every stop node carrying it.
  //
  // A route relation has one stop node per platform per direction, so Line 1
  // and Line 6 at one interchange are different nodes with the same name.
  // Grouping by name is what makes a transfer possible in the graph at all.
  // The cost, recorded rather than fixed: two genuinely distinct stations
  // sharing a name inside one city merge into one node.
  const agg = new Map<string, { lat: number; lon: number; count: number }>();
  for (const n of nodeList) {
    const name = nameOf(n);
    const at = agg.get(name);
    if (at) { at.lat += n.lat; at.lon += n.lon; at.count++; }
    else agg.set(name, { lat: n.lat, lon: n.lon, count: 1 });
  }
  const stations: TransitStation[] = [...agg].map(([name, a]) => ({
    name,
    latitude: a.lat / a.count,
    longitude: a.lon / a.count,
  }));
  const stationAt = new Map(stations.map((s) => [s.name, s]));

  const modes = new Set<string>();
  const edges: TransitEdge[] = [];
  const seen = new Set<string>();
  for (const r of rels) {
    if (r.tags?.route) modes.add(r.tags.route);
    // The line's ref. Falling back to the relation name keeps an unlabelled
    // line DISTINCT from every other unlabelled line — defaulting to '' would
    // merge them all into one and make every change between them free.
    const line = r.tags?.ref ?? r.tags?.name ?? `relation/${r.id}`;

    const stops = (r.members ?? [])
      .filter((m) => m.type === "node" && /^stop/.test(m.role ?? ""))
      .map((m) => byId.get(m.ref))
      .filter((n): n is OverpassNode => n !== undefined)
      .map(nameOf);

    for (let i = 0; i < stops.length - 1; i++) {
      const from = stops[i]!, to = stops[i + 1]!;
      // A relation that lists the same station twice in a row (a mapping
      // artefact) would otherwise create a zero-length self-edge.
      if (from === to) continue;
      const key = `${from}|${to}|${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const a = stationAt.get(from)!, b = stationAt.get(to)!;
      edges.push({
        fromName: from,
        toName: to,
        line,
        km: haversineKm(
          { latitude: a.latitude, longitude: a.longitude },
          { latitude: b.latitude, longitude: b.longitude },
        ),
      });
    }
  }

  return { stations, edges, modes: [...modes], relationCount: rels.length };
}

export interface TransitFetchDeps {
  /** Injected by tests. Production passes the real Overpass POST. */
  overpass?: (query: string) => Promise<unknown>;
}

const ENDPOINT = "https://overpass-api.de/api/interpreter";
const UA = { "User-Agent": "trip-cli (https://github.com/BaruchEric/trip)" };

async function postOverpass(query: string): Promise<unknown> {
  const r = await fetch(ENDPOINT, {
    method: "POST",
    headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(240000),
  });
  if (!r.ok) {
    // Overpass rate-limits with 429 and times out with 504, and both come back
    // as an HTML page. Parsing that as JSON yields zero elements, and zero
    // stations is indistinguishable from "this city has no metro" to
    // everything downstream. Absence must be loud, so this throws.
    throw new Error(`overpass returned HTTP ${r.status}`);
  }
  const body = await r.json();
  if (!Array.isArray((body as { elements?: unknown }).elements)) {
    throw new Error("overpass returned no elements array");
  }
  return body;
}

export async function fetchNetwork(
  bbox: readonly [number, number, number, number],
  deps: TransitFetchDeps = {},
): Promise<ParsedNetwork> {
  const call = deps.overpass ?? postOverpass;
  const relations = await call(overpassQuery(bbox));
  const nodes = await call(overpassNodesQuery(bbox));
  return parseNetwork(
    relations as OverpassResponse<OverpassRelation>,
    nodes as OverpassResponse<OverpassNode>,
  );
}

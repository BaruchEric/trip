/** M12 recon ANALYSIS. Reads only captured fixtures; makes no network calls.
 *
 *  Run with: bun run test/fixtures/m12-transit/analyse.ts
 *
 *  Every number in docs/superpowers/specs/2026-07-27-trip-m12-recon.md comes
 *  from this file. It exists so the recon's numbers can be REGENERATED rather
 *  than trusted, which is the difference between a measurement and a memory.
 *
 *  It is NOT production code and deliberately duplicates the walking model
 *  and haversine rather than importing them from `@/plan/geo`: if the
 *  production model changes, this recon must keep reporting what it measured
 *  on the day, not silently re-report itself against a moved baseline. */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const OUT = import.meta.dir;
const M8 = join(OUT, "..", "m8-chongqing");
const M9 = join(OUT, "..", "m9-cities");

const R = 6371;
const rad = (d: number) => (d * Math.PI) / 180;
interface P { lat: number; lon: number }
function hav(a: P, b: P): number {
  const dLat = rad(b.lat - a.lat), dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
/** The production walking model, copied: haversine x 1.30 / 4.5 km/h. */
const walkMin = (km: number) => (km * 1.3) / 4.5 * 60;
/** The production transit CONSTANT, copied: haversine x 1.20 / 18 km/h + 6. */
const constMin = (a: P, b: P) => Math.round((hav(a, b) * 1.2) / 18 * 60 + 6);

const slug = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};
const readJson = (p: string) => JSON.parse(readFileSync(p, "utf8"));

interface Place { name: string; lat: number; lon: number }
interface Station { name: string; lat: number; lon: number }
interface Edge { a: string; b: string; km: number; line: string }

/** Build the station graph for one city from its captured relations.
 *
 *  A station is a NAME, not a node: a route relation carries one stop node
 *  per platform per direction, so Line 1 and Line 6 at the same interchange
 *  are different nodes with the same name. Grouping by name is what makes a
 *  transfer possible in the graph at all. It also merges any two genuinely
 *  distinct stations that share a name, which is recorded as a limitation
 *  rather than fixed — see the recon. */
function buildGraph(city: string) {
  const rels = readJson(join(OUT, `rail-${city}-relations.json`)).elements;
  const nodes = readJson(join(OUT, `rail-${city}-nodes.json`)).elements;
  const byId = new Map<number, any>(nodes.map((n: any) => [n.id, n]));
  const nameOf = (n: any) => (n.tags?.name ?? n.tags?.["name:zh"] ?? `id${n.id}`) as string;

  const agg = new Map<string, { lat: number; lon: number; c: number }>();
  for (const n of nodes) {
    const nm = nameOf(n);
    const a = agg.get(nm) ?? { lat: 0, lon: 0, c: 0 };
    a.lat += n.lat; a.lon += n.lon; a.c++;
    agg.set(nm, a);
  }
  const stations = new Map<string, Station>(
    [...agg].map(([k, v]) => [k, { name: k, lat: v.lat / v.c, lon: v.lon / v.c }]),
  );

  const edges: Edge[] = [];
  const seen = new Set<string>();
  const modes = new Set<string>();
  for (const r of rels) {
    modes.add(r.tags.route);
    const stops = (r.members ?? [])
      .filter((m: any) => m.type === "node" && /^stop/.test(m.role ?? ""))
      .map((m: any) => byId.get(m.ref))
      .filter(Boolean)
      .map(nameOf);
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i]!, b = stops[i + 1]!;
      if (a === b) continue;
      const k = `${a}|${b}`;
      if (seen.has(k)) continue;
      seen.add(k);
      edges.push({ a, b, km: hav(stations.get(a)!, stations.get(b)!), line: String(r.tags.ref ?? r.tags.name) });
    }
  }
  const intervals = readJson(join(OUT, `rail-${city}-intervals.json`)).elements.length;
  const masters = readJson(join(OUT, `rail-${city}-masters.json`)).elements.length;
  return { rels, stations, edges, intervals, masters, modes: [...modes] };
}

/** Earliest arrival over the station graph, in minutes, given the two
 *  constants OSM CANNOT SUPPLY: line-haul speed and a transfer penalty.
 *  Both are swept in the sensitivity table rather than chosen. */
function ride(
  adj: Map<string, Edge[]>, from: string, to: string, railKmh: number, xferMin: number,
): { minutes: number; hops: number; transfers: number } | null {
  const best = new Map<string, number>([[from, 0]]);
  const pq: Array<[number, string, string | null, number, number]> = [[0, from, null, 0, 0]];
  while (pq.length) {
    pq.sort((x, y) => x[0] - y[0]);
    const [t, u, line, x, hops] = pq.shift()!;
    if (t > (best.get(u) ?? Infinity) + 1e-9) continue;
    if (u === to) return { minutes: t, hops, transfers: x };
    for (const e of adj.get(u) ?? []) {
      const pen = line !== null && e.line !== line ? xferMin : 0;
      const nt = t + (e.km / railKmh) * 60 + pen + 0.5;
      if (nt < (best.get(e.b) ?? Infinity) - 1e-9) {
        best.set(e.b, nt);
        pq.push([nt, e.b, e.line, x + (pen ? 1 : 0), hops + 1]);
      }
    }
  }
  return null;
}

/** The SLOWER of the two routers, matching what `@/plan/travel` reads. */
function measuredWalk(dir: string, tag: string): number | null {
  let best: number | null = null;
  try {
    const v = readJson(join(dir, `valhalla-ped-${tag}.json`));
    if (v.trip?.summary) best = Math.max(best ?? 0, v.trip.summary.time / 60);
  } catch { /* absent */ }
  try {
    const o = readJson(join(dir, `osrm-foot-${tag}.json`));
    if (o.routes?.[0]) best = Math.max(best ?? 0, o.routes[0].duration / 60);
  } catch { /* absent */ }
  return best;
}

const CITY_PLACES: Record<string, { places: Place[]; dir: string; tag: (a: Place, b: Place) => string }> = {};
{
  const m8 = readJson(join(M8, "places.json")) as Array<{ name: string; lat: number; lon: number }>;
  CITY_PLACES["chongqing"] = {
    places: m8.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon })),
    dir: M8,
    tag: (a, b) => `${slug(a.name)}--${slug(b.name)}`,
  };
  const m9 = readJson(join(M9, "places.json")) as Array<{ city: string; enName: string; lat: number; lon: number }>;
  for (const city of ["Lisbon", "Bangkok", "Amsterdam"]) {
    CITY_PLACES[city.toLowerCase()] = {
      places: m9.filter((p) => p.city === city).map((p) => ({ name: p.enName, lat: p.lat, lon: p.lon })),
      dir: M9,
      tag: (a, b) => `${slug(city)}-${slug(a.name)}--${slug(b.name)}`,
    };
  }
}

const RAIL = 30, XFER = 4;
console.log("=== NETWORK, as captured (route in subway|monorail|light_rail|tram) ===");
console.log("city        rels  masters  stations  edges  modes                       interval-tagged");
const graphs: Record<string, ReturnType<typeof buildGraph>> = {};
for (const city of Object.keys(CITY_PLACES)) {
  const g = buildGraph(city);
  graphs[city] = g;
  console.log(
    `${city.padEnd(11)}${String(g.rels.length).padStart(5)}${String(g.masters).padStart(9)}` +
    `${String(g.stations.size).padStart(10)}${String(g.edges.length).padStart(7)}  ${g.modes.join(",").padEnd(28)}${String(g.intervals).padStart(5)}`,
  );
}

console.log("\n=== PER-CITY: the seven resolved places against the network ===");
console.log("city        median nearest  max nearest  pairs sharing a station  ride% of door-to-door");
const perCity: Record<string, any> = {};
for (const [city, { places, dir, tag }] of Object.entries(CITY_PLACES)) {
  const g = graphs[city]!;
  const adj = new Map<string, Edge[]>();
  for (const e of g.edges) (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e);
  const near = (p: Place) => {
    let bs: Station | null = null, bd = Infinity;
    for (const s of g.stations.values()) { const d = hav(p, s); if (d < bd) { bd = d; bs = s; } }
    return { st: bs!, km: bd };
  };
  const N = new Map(places.map((p) => [p.name, near(p)]));
  const rows: any[] = [];
  for (const a of places) for (const b of places) {
    if (a === b) continue;
    const na = N.get(a.name)!, nb = N.get(b.name)!;
    const same = na.st.name === nb.st.name;
    let graph: number, rideT = 0, hops = 0, transfers = 0;
    if (same) { graph = walkMin(hav(a, b)); }
    else {
      const r = ride(adj, na.st.name, nb.st.name, RAIL, XFER);
      if (!r) continue;
      rideT = r.minutes; hops = r.hops; transfers = r.transfers;
      graph = walkMin(na.km) + XFER + r.minutes + walkMin(nb.km);
    }
    rows.push({
      a: a.name, b: b.name, same, graph, rideT, hops, transfers,
      konst: constMin(a, b), walk: measuredWalk(dir, tag(a, b)),
    });
  }
  perCity[city] = { rows, N, places };
  const nears = places.map((p) => N.get(p.name)!.km);
  const rideShare = rows.filter((r) => !r.same).map((r) => 100 * r.rideT / r.graph);
  console.log(
    `${city.padEnd(11)}${(median(nears) * 1000).toFixed(0).padStart(11)} m${(Math.max(...nears) * 1000).toFixed(0).padStart(11)} m` +
    `${String(rows.filter((r) => r.same).length + "/" + rows.length).padStart(23)}${median(rideShare).toFixed(0).padStart(21)}%`,
  );
}

console.log("\n=== THE CONSTANT vs THE STATION GRAPH (rail 30 km/h, transfer 4 min) ===");
console.log("city        n   median signed diff   const OPTIMISTIC in   graph beats measured walk");
for (const [city, { rows }] of Object.entries<any>(perCity)) {
  const usable = rows.filter((r: any) => r.walk != null);
  const diffs = usable.map((r: any) => r.graph - r.konst);
  const opt = usable.filter((r: any) => r.graph > r.konst).length;
  const beats = usable.filter((r: any) => r.graph < r.walk).length;
  console.log(
    `${city.padEnd(11)}${String(usable.length).padStart(3)}${(median(diffs) >= 0 ? "+" : "") + median(diffs).toFixed(1) + " min"}`.padEnd(45) +
    `${(opt + "/" + usable.length).padStart(10)}${(beats + "/" + usable.length).padStart(28)}`,
  );
}

console.log("\n=== SENSITIVITY: does the SIGN survive the two constants OSM cannot supply? ===");
console.log("rail  xfer | " + Object.keys(perCity).map((c) => c.slice(0, 9).padStart(10)).join(" |"));
for (const railKmh of [25, 30, 35, 40]) for (const xferMin of [2, 4, 6]) {
  const cells: string[] = [];
  for (const [city, { rows, N, places }] of Object.entries<any>(perCity)) {
    const g = graphs[city]!;
    const adj = new Map<string, Edge[]>();
    for (const e of g.edges) (adj.get(e.a) ?? adj.set(e.a, []).get(e.a)!).push(e);
    let opt = 0, n = 0;
    for (const a of places) for (const b of places) {
      if (a === b) continue;
      const na = N.get(a.name)!, nb = N.get(b.name)!;
      let graph: number;
      if (na.st.name === nb.st.name) graph = walkMin(hav(a, b));
      else {
        const r = ride(adj, na.st.name, nb.st.name, railKmh, xferMin);
        if (!r) continue;
        graph = walkMin(na.km) + xferMin + r.minutes + walkMin(nb.km);
      }
      n++;
      if (graph > constMin(a, b)) opt++;
    }
    cells.push(`${opt}/${n}`.padStart(10));
  }
  console.log(`${String(railKmh).padStart(4)}${String(xferMin).padStart(6)} | ${cells.join(" |")}`);
}

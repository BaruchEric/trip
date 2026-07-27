/** M12 fixture capture: RAW Overpass and Valhalla bodies for the transit recon.
 *
 *  Run with: bun run test/fixtures/m12-transit/capture.ts
 *
 *  The PRODUCTION QUERY IS WRITTEN OUT IN FULL below rather than described.
 *  M4's viewbox discrepancy survived two milestones because its appendix
 *  recorded results and paraphrased the query, and the paraphrase was wrong.
 *  M6 turned that into a rule: evidence gathered with a query that differs
 *  from the production query is evidence about a different question.
 *
 *  THE BOUNDING BOX IS PART OF THE MEASUREMENT (M9). Chongqing's built-up
 *  area sprawls far past its core; this box is the core plus enough margin to
 *  reach the ends of the lines that serve it. A different box is a different
 *  count, and any claim of "26 relations" is a claim about THIS box.
 *
 *  WHY VALHALLA IS RE-PROBED HERE. The handoff records multimodal/transit
 *  failing and `bus` succeeding, measured yesterday against a live third-party
 *  host. M8 nearly recorded "there is no free walking router" from a single
 *  probe of a host that ignored the profile string. A recorded result from a
 *  shared instance is a hypothesis until re-run. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = import.meta.dir;
const UA = { "User-Agent": "trip-cli (https://github.com/BaruchEric/trip)" };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The same seven places as M8 and M9: the ones this project has ACTUALLY
 *  resolved to a segment. Copied deliberately rather than imported, so this
 *  file records the coordinates the measurement used even if the M8 fixture
 *  is later edited. */
const PLACES = [
  { name: "Ring Shopping Park",    local: "光环购物中心", lat: 29.6530663, lon: 106.5259717, from: "M6" },
  { name: "Luohan Temple",         local: "罗汉寺",       lat: 29.5625664, lon: 106.5778425, from: "M6" },
  { name: "Hongya Cave",           local: "洪崖洞",       lat: 29.5650738, lon: 106.5753425, from: "M6" },
  { name: "Testbed 2",             local: "贰厂文创园",   lat: 29.5537638, lon: 106.5368476, from: "M6" },
  { name: "Longmenhao Old Street", local: "龙门浩老街",   lat: 29.5588249, lon: 106.5912051, from: "M7" },
  { name: "Kuixinglou",            local: "魁星楼",       lat: 29.563255,  lon: 106.5699015, from: "M7" },
  { name: "Liziba",                local: "李子坝",       lat: 29.5556826, lon: 106.5338753, from: "M7" },
];

/** south, west, north, east — Overpass bbox order. */
const BBOX = [29.20, 106.10, 30.00, 107.00] as const;

const written = new Set<string>();
function put(file: string, body: string): void {
  // Assert no collision. A silently overwritten fixture is how the M7 bug hid.
  if (written.has(file)) throw new Error(`slug collision: ${file}`);
  written.add(file);
  writeFileSync(join(OUT, file), body);
}

async function overpass(file: string, query: string): Promise<void> {
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(180000),
  });
  const text = await r.text();
  put(file, text);
  console.log(`${file}: HTTP ${r.status}, ${text.length} bytes`);
  await nap(3000);
}

// 1. Every subway route relation in the box, with ITS TAGS AND ITS MEMBER
//    LIST IN ORDER. `out body` on a relation emits members with roles in
//    document order, which is the ordering a station graph would depend on.
//    The handoff says these relations carry "no timetables". That is an
//    inference from a COUNT. This query is what checks it at the tag level.
await overpass(
  "overpass-subway-relations.json",
  `[out:json][timeout:180];
rel["route"="subway"](${BBOX.join(",")});
out body;`,
);

// 2. The node members of those relations: stops and platforms, with coords
//    and tags. Needed to compute how far each of the seven places is from
//    the nearest station — the number that decides whether a station-graph
//    model is a transit model or a walking model wearing a hat.
await overpass(
  "overpass-subway-nodes.json",
  `[out:json][timeout:180];
rel["route"="subway"](${BBOX.join(",")});
node(r);
out body;`,
);

// 3. Route MASTER relations. A `route=subway` relation is one DIRECTION of
//    one line; the master groups them. Counting relations without this is
//    how "26 relations" could mean 13 lines, and the difference matters for
//    any claim about network size.
await overpass(
  "overpass-subway-masters.json",
  `[out:json][timeout:180];
rel["type"="route_master"]["route_master"="subway"](${BBOX.join(",")});
out body;`,
);

// 4. Anything tagged as a public transport interval/headway anywhere in the
//    box, on any route. If Chongqing has NO headway data at all, that is a
//    fact about the city; if some other mode carries it, that is a different
//    fact. Asking only about subway relations could not tell them apart.
await overpass(
  "overpass-any-interval.json",
  `[out:json][timeout:180];
(
  rel["interval"](${BBOX.join(",")});
  rel["headway"](${BBOX.join(",")});
);
out tags;`,
);

/** Valhalla, re-probed. Hongya Cave -> Testbed 2, the handoff's pair.
 *
 *  `bus` IS INCLUDED HERE ON PURPOSE, AND MUST NEVER REACH PRODUCTION. It
 *  returns 200 and looks like a transit answer. It is a vehicle driving on
 *  bus-legal roads: no stops, no waiting, no transfers, no timetable. It is
 *  captured so the recon can SHOW the trap rather than assert it. */
const A = PLACES.find((p) => p.name === "Hongya Cave")!;
const B = PLACES.find((p) => p.name === "Testbed 2")!;

for (const costing of ["multimodal", "transit", "bus", "pedestrian"]) {
  const body = JSON.stringify({
    locations: [{ lat: A.lat, lon: A.lon }, { lat: B.lat, lon: B.lon }],
    costing,
    units: "km",
  });
  const r = await fetch("https://valhalla1.openstreetmap.de/route", {
    method: "POST",
    headers: { ...UA, "Content-Type": "application/json" },
    body,
    signal: AbortSignal.timeout(30000),
  });
  const text = await r.text();
  put(`valhalla-${costing}.json`, text);
  console.log(`valhalla-${costing}: HTTP ${r.status}, ${text.length} bytes`);
  await nap(1200);
}

writeFileSync(
  join(OUT, "places.json"),
  `${JSON.stringify({ bbox: BBOX, places: PLACES }, null, 2)}\n`,
);
console.log(`files: ${written.size + 1}`);

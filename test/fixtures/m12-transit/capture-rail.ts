/** M12 fixture capture, SECOND PASS: all urban rail modes, four cities.
 *
 *  Run with: bun run test/fixtures/m12-transit/capture-rail.ts
 *
 *  WHY THIS FILE EXISTS, AND WHY capture.ts IS KEPT UNCHANGED BESIDE IT.
 *
 *  capture.ts asked Overpass for `route=subway` around Chongqing, which is
 *  what the M12 handoff described ("26 subway route relations"). It returned
 *  28 relations covering lines 1, 4, 5, 6, 9, 10, 18, the loop, and two
 *  suburban lines.
 *
 *  IT RETURNED NO LINE 2 AND NO LINE 3, because both are straddle-beam
 *  MONORAILS and OSM tags them `route=monorail`. Line 2 is the line that runs
 *  through the residential block at Liziba — and Liziba is one of the seven
 *  places this project has resolved. The first pass computed Liziba's nearest
 *  station as Eling, 688 m away, when Liziba HAS A STATION OF ITS OWN.
 *
 *  A model built on that capture would have routed a traveller around two of
 *  the busiest lines in the city and reported the detour as the answer. The
 *  first-pass files are kept, not deleted: they are the evidence for that
 *  finding, and deleting them would leave the recon asserting the undercount
 *  instead of showing it.
 *
 *  MODE SET. `subway|monorail|light_rail|tram` — chosen because Chongqing
 *  needs monorail, Bangkok's BTS is light_rail, and Amsterdam and Lisbon run
 *  trams that carry real urban trips. THE MODE SET IS PART OF THE
 *  MEASUREMENT (M9): a different set is a different network, and every count
 *  below is a claim about THIS set inside THIS box.
 *
 *  Two queries in the first pass failed — route_master returned HTTP 429 and
 *  the interval scan HTTP 504. Both are retried here with longer spacing.
 *  A failed capture that is never retried becomes an absent fact that reads
 *  like a measured zero. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = import.meta.dir;
const UA = { "User-Agent": "trip-cli (https://github.com/BaruchEric/trip)" };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODES = "subway|monorail|light_rail|tram";

/** south, west, north, east. Chongqing's box is the one capture.ts used, kept
 *  identical so the two passes are comparable. The other three are the city
 *  cores plus enough margin for the lines that serve them. */
const CITIES = [
  { city: "chongqing", bbox: [29.20, 106.10, 30.00, 107.00] },
  { city: "lisbon",    bbox: [38.65, -9.30, 38.85, -9.05] },
  { city: "bangkok",   bbox: [13.60, 100.35, 13.95, 100.70] },
  { city: "amsterdam", bbox: [52.28, 4.75, 52.43, 5.02] },
] as const;

const written = new Set<string>();
function put(file: string, body: string): void {
  // Assert no collision. A silently overwritten fixture is how the M7 bug hid.
  if (written.has(file)) throw new Error(`slug collision: ${file}`);
  written.add(file);
  writeFileSync(join(OUT, file), body);
}

async function overpass(file: string, query: string): Promise<number> {
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ data: query }).toString(),
    signal: AbortSignal.timeout(180000),
  });
  const text = await r.text();
  put(file, text);
  console.log(`${file}: HTTP ${r.status}, ${text.length} bytes`);
  // Overpass is a shared, unfunded instance and rate-limited the first pass.
  await nap(8000);
  return r.status;
}

for (const { city, bbox } of CITIES) {
  const b = bbox.join(",");

  // Relations WITH their ordered member lists. `out body` emits members in
  // document order; consecutive stop-role members are the station sequence,
  // which is the only ordering a station graph can be built from.
  await overpass(
    `rail-${city}-relations.json`,
    `[out:json][timeout:180];
rel["route"~"^(${MODES})$"](${b});
out body;`,
  );

  // The node members: stops and platforms, with coordinates and tags.
  await overpass(
    `rail-${city}-nodes.json`,
    `[out:json][timeout:180];
rel["route"~"^(${MODES})$"](${b});
node(r);
out body;`,
  );

  // Route masters: a route relation is ONE DIRECTION of one line. Without
  // these, "28 relations" could mean 28 lines or 14. Retried from the first
  // pass, which was rate-limited at HTTP 429.
  await overpass(
    `rail-${city}-masters.json`,
    `[out:json][timeout:180];
rel["type"="route_master"]["route_master"~"^(${MODES})$"](${b});
out tags;`,
  );

  // Do ANY of this city's rail relations carry a headway? Scoped to the same
  // route filter rather than every relation in the box, which is what made
  // the first pass time out at HTTP 504. This asks a narrower question than
  // the first pass intended, and the recon says so.
  await overpass(
    `rail-${city}-intervals.json`,
    `[out:json][timeout:180];
rel["route"~"^(${MODES})$"]["interval"](${b});
out tags;`,
  );
}

writeFileSync(
  join(OUT, "cities.json"),
  `${JSON.stringify({ modes: MODES, cities: CITIES }, null, 2)}\n`,
);
console.log(`files: ${written.size + 1}`);

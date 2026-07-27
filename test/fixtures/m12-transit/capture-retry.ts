/** M12 fixture capture, RETRY PASS.
 *
 *  Run with: bun run test/fixtures/m12-transit/capture-retry.ts
 *  Safe to run repeatedly: it refetches ONLY files that are currently
 *  missing or not valid Overpass JSON, and leaves good captures untouched.
 *
 *  overpass-api.de answered the second pass with a mix of 200, 429 (rate
 *  limited) and 504 (query timeout), differently on each run. A capture that
 *  half-failed is the dangerous case: `rail-chongqing-nodes.json` containing
 *  an HTML error page parses to zero stations, and zero stations is
 *  indistinguishable from "this city has no metro" to any code downstream.
 *  Absence is loud only if something checks for it — hence VALID() below,
 *  which requires an `elements` ARRAY, not merely parseable JSON.
 *
 *  THE QUERIES ARE COPIED VERBATIM from capture-rail.ts rather than imported,
 *  so this file records exactly what was asked. M4's viewbox discrepancy
 *  survived two milestones because the record paraphrased the query. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = import.meta.dir;
const UA = { "User-Agent": "trip-cli (https://github.com/BaruchEric/trip)" };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

const MODES = "subway|monorail|light_rail|tram";
const CITIES = [
  { city: "chongqing", bbox: [29.20, 106.10, 30.00, 107.00] },
  { city: "lisbon",    bbox: [38.65, -9.30, 38.85, -9.05] },
  { city: "bangkok",   bbox: [13.60, 100.35, 13.95, 100.70] },
  { city: "amsterdam", bbox: [52.28, 4.75, 52.43, 5.02] },
] as const;

/** Mirrors, tried in order per attempt. All are shared, unfunded instances. */
const ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.osm.jp/api/interpreter",
];

function valid(file: string): boolean {
  const p = join(OUT, file);
  if (!existsSync(p)) return false;
  try {
    const j = JSON.parse(readFileSync(p, "utf8"));
    return Array.isArray(j.elements);
  } catch {
    return false;
  }
}

async function ensure(file: string, query: string): Promise<void> {
  if (valid(file)) {
    const n = JSON.parse(readFileSync(join(OUT, file), "utf8")).elements.length;
    console.log(`${file}: ok (${n} elements)`);
    return;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const url = ENDPOINTS[attempt % ENDPOINTS.length]!;
    try {
      const r = await fetch(url, {
        method: "POST",
        headers: { ...UA, "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: query }).toString(),
        signal: AbortSignal.timeout(240000),
      });
      const text = await r.text();
      if (r.status === 200) {
        writeFileSync(join(OUT, file), text);
        if (valid(file)) {
          const n = JSON.parse(text).elements.length;
          console.log(`${file}: FETCHED ${n} elements (attempt ${attempt + 1}, ${new URL(url).host})`);
          await nap(5000);
          return;
        }
      }
      console.log(`${file}: attempt ${attempt + 1} ${new URL(url).host} -> HTTP ${r.status}`);
    } catch (e) {
      console.log(`${file}: attempt ${attempt + 1} ${new URL(url).host} -> ${(e as Error).name}`);
    }
    await nap(15000 * (attempt + 1));
  }
  throw new Error(`could not capture ${file} after 6 attempts across ${ENDPOINTS.length} mirrors`);
}

for (const { city, bbox } of CITIES) {
  const b = bbox.join(",");
  await ensure(
    `rail-${city}-relations.json`,
    `[out:json][timeout:180];
rel["route"~"^(${MODES})$"](${b});
out body;`,
  );
  await ensure(
    `rail-${city}-nodes.json`,
    `[out:json][timeout:180];
rel["route"~"^(${MODES})$"](${b});
node(r);
out body;`,
  );
  await ensure(
    `rail-${city}-masters.json`,
    `[out:json][timeout:180];
rel["type"="route_master"]["route_master"~"^(${MODES})$"](${b});
out tags;`,
  );
  await ensure(
    `rail-${city}-intervals.json`,
    `[out:json][timeout:180];
rel["route"~"^(${MODES})$"]["interval"](${b});
out tags;`,
  );
}
console.log("all four cities captured and validated");

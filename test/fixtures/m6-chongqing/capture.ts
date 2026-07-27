/** Captures the raw Nominatim bodies behind `test/m6-acceptance.test.ts`.
 *
 *  KEPT, not deleted after use. A fixture whose query shape is not recorded
 *  is a fixture nobody can re-verify — and that is precisely how M4's viewbox
 *  discrepancy survived two milestones: its appendix recorded the RESULTS of
 *  a query and paraphrased the query itself, so the mismatch with
 *  `geocodePoi` was invisible until M6 re-ran it four ways.
 *
 *  The query below is therefore written out in full rather than described,
 *  and must stay identical to `geocodePoi`'s in `src/geo/poi.ts`. If that
 *  ever changes, these fixtures are answering a different question and the
 *  acceptance test is measuring something other than what ships.
 *
 *  Run:  bun run test/fixtures/m6-chongqing/capture.ts
 */

import { viewbox, SEARCH_RADIUS_KM } from "@/geo/poi";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The destination `trip when Chongqing` geocoded during the real run. */
const CENTRE = { latitude: 29.56026, longitude: 106.55771 };

/** Raw caption name -> the name a human correction produces. `Ring Shopping
 *  Park` is the one the auto-captions got right. */
const NAMES: Record<string, string> = {
  "Arat Temple": "Luohan Temple",
  "Longman how old street": "Longmenhao Old Street",
  "Wulong casts": "Wulong Karst",
  "Tienfu Post House": "Tianfu Inn",
  "Fisher Gorge": "Longshuixia Fissure Gorge",
  "Don Shan Cafe": "Dongshan Cafe",
  "Shabbati": "Shibati",
  "Hongadong": "Hongya Cave",
  "Test Bed Creative Park": "Testbed 2",
  "Ring Shopping Park": "Ring Shopping Park",
  "Ji Fang Bay Pedestrian Street": "Jiefangbei Pedestrian Street",
};

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

const dir = import.meta.dir;
const box = viewbox(CENTRE, SEARCH_RADIUS_KM);
const queries = [...new Set([...Object.keys(NAMES), ...Object.values(NAMES)])];

console.log(`viewbox: ${box}`);
for (const q of queries) {
  // IDENTICAL to geocodePoi. Not "similar to", not "based on".
  const url =
    `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
    `&format=jsonv2` +
    `&viewbox=${encodeURIComponent(box)}&bounded=1&limit=5&addressdetails=1`;

  const res = await fetch(url, { headers: { "User-Agent": "trip-m6-fixtures" } });
  const body = await res.json();
  writeFileSync(
    join(dir, `nominatim-${slug(q)}.json`),
    JSON.stringify(body, null, 2),
  );
  console.log(`${q.padEnd(32)} n=${Array.isArray(body) ? body.length : "?"}`);
  // Nominatim's usage policy is 1 request/second.
  await new Promise((r) => setTimeout(r, 1200));
}
console.log(`\n${queries.length} responses captured into ${dir}`);

/** Captures the raw Nominatim bodies behind `test/m7-acceptance.test.ts`.
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
 *  Run:  bun run test/fixtures/m7-chongqing/capture.ts
 */

import { viewbox, SEARCH_RADIUS_KM } from "@/geo/poi";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

/** The destination `trip when Chongqing` geocoded during the real run. */
const CENTRE = { latitude: 29.56026, longitude: 106.55771 };

/** Raw caption name -> the name a human correction produces. `Ring Shopping
 *  Park` is the one the auto-captions got right. */
/** English name -> the local-script name a frame could give. M7's finding:
 *  local script recovers TWO of the five English misses M6 filed as OSM
 *  coverage, and makes one MORE ambiguous. Both halves need fixtures. */
const NAMES: Record<string, string> = {
  "Longmenhao Old Street": "龙门浩老街",
  "Kuixinglou": "魁星楼",
  "Dongshan Cafe": "东山咖啡",
  "air raid shelter old hot pot": "防空洞老火锅",
  "Shibati": "十八梯",
  "Liziba": "李子坝",
  "Testbed 2": "贰厂文创园",
};

/** Filename-safe, and it MUST preserve non-ASCII. M6's version stripped
 *  everything outside [a-z0-9], which is harmless for ASCII names and
 *  catastrophic here: all seven Chinese names slugged to the empty string
 *  and overwrote a single file, so every local-script fixture held whatever
 *  was captured last. Found by three acceptance tests failing at once.
 *
 *  \p{L}\p{N} keeps CJK letters; only genuinely unsafe characters go. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
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

  const res = await fetch(url, { headers: { "User-Agent": "trip-m7-fixtures" } });
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

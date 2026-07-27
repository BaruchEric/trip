/** M8 fixture capture: RAW router bodies, both directions, both routers.
 *
 *  Run with: bun run test/fixtures/m8-chongqing/capture.ts
 *
 *  The PRODUCTION QUERY IS WRITTEN OUT IN FULL below rather than described.
 *  M4's viewbox discrepancy survived two milestones because its appendix
 *  recorded results and paraphrased the query, and the paraphrase was wrong.
 *
 *  Two things about these endpoints that look like bugs and are not:
 *
 *  1. OSRM's profile is the INSTANCE, not the /route/v1/<name>/ path segment.
 *     `routing.openstreetmap.de` runs one OSRM per profile behind
 *     routed-foot / routed-bike / routed-car and ignores the name in the
 *     path, so "driving" below is inert. The OTHER public OSRM — the demo at
 *     router.project-osrm.org — ignores it too and serves CAR for every
 *     value, which is what made the first M8 probe report 54 km/h walking.
 *
 *  2. Valhalla is a POST. Its costing is chosen per request, not per host.
 *
 *  Both are shared, unfunded, fair-use instances. One request per 1.2 s. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = import.meta.dir;
const UA = { "User-Agent": "trip-cli (https://github.com/BaruchEric/trip)" };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The seven places this project has ACTUALLY RESOLVED to a segment: M6's
 *  four, from chongqing-resolved-state.json, plus M7's three recoveries.
 *
 *  NOT "the top Nominatim hit for every city-core fixture". That set is ten
 *  points and includes a hotel (你好酒店, the top hit for "Jiefangbei
 *  Pedestrian Street") along with candidates M6 rejected or left queued.
 *  Calling it "the real Chongqing segments" would be M4's paraphrased-query
 *  error in a new place. */
const PLACES = [
  { name: "Ring Shopping Park",    local: "光环购物中心", lat: 29.6530663, lon: 106.5259717, from: "M6" },
  { name: "Luohan Temple",         local: "罗汉寺",       lat: 29.5625664, lon: 106.5778425, from: "M6" },
  { name: "Hongya Cave",           local: "洪崖洞",       lat: 29.5650738, lon: 106.5753425, from: "M6" },
  { name: "Testbed 2",             local: "贰厂文创园",   lat: 29.5537638, lon: 106.5368476, from: "M6" },
  { name: "Longmenhao Old Street", local: "龙门浩老街",   lat: 29.5588249, lon: 106.5912051, from: "M7" },
  { name: "Kuixinglou",            local: "魁星楼",       lat: 29.5632550, lon: 106.5699015, from: "M7" },
  { name: "Liziba",                local: "李子坝",       lat: 29.5556826, lon: 106.5338753, from: "M7" },
];

/** \p{L}\p{N}, NOT [a-z0-9]. M7's capture inherited an ASCII-only slug and
 *  every Chinese name collapsed to the empty string, silently overwriting a
 *  single file so that each fixture held whatever was captured last. Three
 *  simultaneous test failures were the only signal. */
const slug = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

const written = new Set<string>();
function put(file: string, body: string): void {
  // Asserted, not assumed: a collision is exactly how the M7 bug hid.
  if (written.has(file)) throw new Error(`slug collision: ${file}`);
  written.add(file);
  writeFileSync(join(OUT, file), body);
}

let pairs = 0;
for (let i = 0; i < PLACES.length; i++) {
  for (let j = 0; j < PLACES.length; j++) {
    // BOTH directions, i !== j. A leg is directed because Valhalla models
    // grade: the uphill return over the same ground is a different number.
    if (i === j) continue;
    const a = PLACES[i]!, b = PLACES[j]!;
    const tag = `${slug(a.name)}--${slug(b.name)}`;

    const osrmUrl =
      `https://routing.openstreetmap.de/routed-foot/route/v1/driving/` +
      `${a.lon},${a.lat};${b.lon},${b.lat}` +
      `?overview=false&alternatives=false&steps=false`;
    const r1 = await fetch(osrmUrl, { headers: UA, signal: AbortSignal.timeout(30000) });
    put(`osrm-foot-${tag}.json`, await r1.text());
    await nap(1200);

    const valhallaBody = JSON.stringify({
      locations: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
      costing: "pedestrian",
      units: "km",
    });
    const r2 = await fetch("https://valhalla1.openstreetmap.de/route", {
      method: "POST",
      headers: { ...UA, "Content-Type": "application/json" },
      body: valhallaBody,
      signal: AbortSignal.timeout(30000),
    });
    put(`valhalla-ped-${tag}.json`, await r2.text());
    await nap(1200);
    pairs++;
  }
}

/** Open-Meteo, the same vendor the climate module already uses, keyless.
 *  Captured because the recon looked at elevation and could NOT settle
 *  whether it explains the detour outliers at this sample size. Kept so the
 *  question stays answerable, not because it was answered. */
const el = await fetch(
  `https://api.open-meteo.com/v1/elevation` +
  `?latitude=${PLACES.map((p) => p.lat).join(",")}` +
  `&longitude=${PLACES.map((p) => p.lon).join(",")}`,
  { headers: UA, signal: AbortSignal.timeout(30000) },
);
put("open-meteo-elevation.json", await el.text());
writeFileSync(join(OUT, "places.json"), `${JSON.stringify(PLACES, null, 2)}\n`);

console.log(`directed pairs: ${pairs}, files: ${written.size + 1}`);

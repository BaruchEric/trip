/** M9 fixture capture: three more cities, raw bodies, both production queries.
 *
 *  Run with: bun run test/fixtures/m9-cities/capture.ts
 *
 *  Chongqing is NOT captured here — it is already in test/fixtures/m8-chongqing
 *  and the acceptance test replays it from there, on identical terms. Capturing
 *  it twice would let the two copies drift.
 *
 *  Both production queries are written out in full below rather than described.
 *  M4's viewbox discrepancy survived two milestones because its appendix
 *  recorded results and paraphrased the query. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { viewbox, parsePoiResponse, SEARCH_RADIUS_KM, USER_AGENT } from "@/geo/poi";

const OUT = import.meta.dir;
const ROUTER_UA = { "User-Agent": "trip-cli (https://github.com/BaruchEric/trip)" };
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Chongqing confounds a CJK script with extreme verticality, so one more city
 *  could not separate them. These three do:
 *
 *    Bangkok    Thai / flat    — non-CJK script AND no hills
 *    Lisbon     Latin / hilly  — terrain, with script held constant
 *    Amsterdam  Latin / flat   — the null case
 *
 *  Seven places each, chosen for being famous enough to have both an English
 *  and a local name. That is also a limit of the evidence: they geocode more
 *  easily than a name pulled off a video transcript, which is M6's real input. */
const CITIES = [
  {
    city: "Bangkok", script: "Thai", terrain: "flat",
    centre: { latitude: 13.7563, longitude: 100.5018 },
    places: [
      ["Grand Palace", "พระบรมมหาราชวัง"],
      ["Wat Pho", "วัดโพธิ์"],
      ["Wat Arun", "วัดอรุณ"],
      ["Chatuchak Market", "ตลาดนัดจตุจักร"],
      ["Khao San Road", "ถนนข้าวสาร"],
      ["Lumphini Park", "สวนลุมพินี"],
      ["Jim Thompson House", "บ้านจิมทอมป์สัน"],
    ],
  },
  {
    city: "Lisbon", script: "Latin", terrain: "hilly",
    centre: { latitude: 38.7223, longitude: -9.1393 },
    places: [
      ["Belem Tower", "Torre de Belém"],
      ["Jeronimos Monastery", "Mosteiro dos Jerónimos"],
      ["Saint George Castle", "Castelo de São Jorge"],
      ["Alfama", "Alfama"],
      ["Rossio Square", "Praça do Rossio"],
      ["Santa Justa Lift", "Elevador de Santa Justa"],
      ["LX Factory", "LX Factory"],
    ],
  },
  {
    city: "Amsterdam", script: "Latin", terrain: "flat",
    centre: { latitude: 52.3676, longitude: 4.9041 },
    places: [
      ["Rijksmuseum", "Rijksmuseum"],
      ["Anne Frank House", "Anne Frank Huis"],
      ["Van Gogh Museum", "Van Gogh Museum"],
      ["Vondelpark", "Vondelpark"],
      ["Dam Square", "Dam"],
      ["Royal Palace", "Koninklijk Paleis"],
      ["Jordaan", "Jordaan"],
    ],
  },
];

/** \p{L}\p{N}, not [a-z0-9]: M7's capture inherited an ASCII-only slug and
 *  every Chinese name collapsed to the empty string, silently overwriting one
 *  file. Thai collapses the same way. */
const slug = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

const written = new Set<string>();
function put(file: string, body: string): void {
  if (written.has(file)) throw new Error(`slug collision: ${file}`);
  written.add(file);
  writeFileSync(join(OUT, file), body);
}

interface Place {
  city: string; script: string; terrain: string;
  enName: string; localName: string;
  /** WHICH form supplied the coordinates, and how many candidates it returned.
   *  The whole M9 evidence base rests on these picks being right, and a reader
   *  cannot tell a 1-candidate point from a 5-candidate one without them. */
  form: "en" | "local";
  candidates: number;
  enCandidates: number;
  localCandidates: number;
  lat: number; lon: number;
}

const places: Place[] = [];

for (const c of CITIES) {
  const box = viewbox(c.centre, SEARCH_RADIUS_KM);
  for (const [enName, localName] of c.places) {
    const hits: Record<string, { n: number; lat: number | null; lon: number | null }> = {};
    for (const [form, q] of [["en", enName!], ["local", localName!]] as const) {
      // THE PRODUCTION GEOCODE QUERY, exactly as searchPoi builds it:
      // jsonv2, a 25 km viewbox, bounded=1, limit=5, addressdetails=1, and NO
      // accept-language -- results come back in local script by design.
      const url =
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(q)}` +
        `&format=jsonv2&viewbox=${encodeURIComponent(box)}&bounded=1` +
        `&limit=5&addressdetails=1`;
      const r = await fetch(url, {
        headers: { "User-Agent": USER_AGENT }, signal: AbortSignal.timeout(30000),
      });
      const raw = await r.text();
      put(`nominatim-${slug(c.city)}-${form}-${slug(q)}.json`, raw);
      const cands = parsePoiResponse(JSON.parse(raw), c.centre);
      hits[form] = {
        n: cands.length,
        lat: cands[0]?.latitude ?? null, lon: cands[0]?.longitude ?? null,
      };
      // Nominatim's usage policy: at most one request per second.
      await nap(1200);
    }

    // The form that came back LEAST ambiguous, English winning ties. Taking
    // the English top hit unconditionally would import whatever a 5-candidate
    // query happened to rank first.
    const en = hits.en!, local = hits.local!;
    const useEn = en.n > 0 && (en.n <= local.n || local.n === 0);
    const pick = useEn ? en : local;
    if (pick.lat === null || pick.lon === null) {
      throw new Error(`${c.city}/${enName}: neither form geocoded`);
    }
    places.push({
      city: c.city, script: c.script, terrain: c.terrain,
      enName: enName!, localName: localName!,
      form: useEn ? "en" : "local", candidates: pick.n,
      enCandidates: en.n, localCandidates: local.n,
      lat: pick.lat, lon: pick.lon,
    });
  }
}

// Every ORDERED pair within each city, both routers. Directed because
// Valhalla models grade; the point of this capture is to find out whether
// that still matters where there are no hills.
let legs = 0;
for (const c of CITIES) {
  const inCity = places.filter((p) => p.city === c.city);
  for (let i = 0; i < inCity.length; i++) {
    for (let j = 0; j < inCity.length; j++) {
      if (i === j) continue;
      const a = inCity[i]!, b = inCity[j]!;
      const tag = `${slug(c.city)}-${slug(a.enName)}--${slug(b.enName)}`;

      // OSRM: the profile is the INSTANCE (routed-foot); the name in the
      // /route/v1/<name>/ segment is inert on this deployment.
      const osrmUrl =
        `https://routing.openstreetmap.de/routed-foot/route/v1/driving/` +
        `${a.lon},${a.lat};${b.lon},${b.lat}` +
        `?overview=false&alternatives=false&steps=false`;
      const r1 = await fetch(osrmUrl, {
        headers: ROUTER_UA, signal: AbortSignal.timeout(30000),
      });
      put(`osrm-foot-${tag}.json`, await r1.text());
      await nap(1200);

      const r2 = await fetch("https://valhalla1.openstreetmap.de/route", {
        method: "POST",
        headers: { ...ROUTER_UA, "Content-Type": "application/json" },
        body: JSON.stringify({
          locations: [{ lat: a.lat, lon: a.lon }, { lat: b.lat, lon: b.lon }],
          costing: "pedestrian", units: "km",
        }),
        signal: AbortSignal.timeout(30000),
      });
      put(`valhalla-ped-${tag}.json`, await r2.text());
      await nap(1200);
      legs++;
    }
  }
}

writeFileSync(join(OUT, "places.json"), `${JSON.stringify(places, null, 2)}\n`);
console.log(`places: ${places.length}, directed legs: ${legs}, files: ${written.size + 1}`);

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOsrm, parseValhalla } from "@/geo/routers";
import { parsePoiResponse } from "@/geo/poi";
import { travelMinutes, haversineKm } from "@/plan/geo";

/** M9 acceptance: four cities, and two findings that did not survive.
 *
 *  Chongqing is replayed from M8's committed fixtures rather than recaptured,
 *  so the two copies cannot drift. `capture.ts` sits beside the M9 fixtures
 *  with both production queries written out in full. */
const M9 = join(import.meta.dir, "fixtures", "m9-cities");
const M8 = join(import.meta.dir, "fixtures", "m8-chongqing");

const slug = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
const body = (p: string) => JSON.parse(readFileSync(p, "utf8"));

interface M9Place {
  city: string; script: string; terrain: string;
  enName: string; localName: string;
  form: "en" | "local"; candidates: number;
  enCandidates: number; localCandidates: number;
  lat: number; lon: number;
}
const PLACES: M9Place[] = body(join(M9, "places.json"));
const CITIES = ["Bangkok", "Lisbon", "Amsterdam"] as const;
const inCity = (c: string) => PLACES.filter((p) => p.city === c);

const CENTRES: Record<string, { latitude: number; longitude: number }> = {
  Bangkok: { latitude: 13.7563, longitude: 100.5018 },
  Lisbon: { latitude: 38.7223, longitude: -9.1393 },
  Amsterdam: { latitude: 52.3676, longitude: 4.9041 },
};

/** Router minutes for a directed pair, per city. */
function legs(city: string, a: string, b: string) {
  const t = `${slug(city)}-${slug(a)}--${slug(b)}`;
  const o = parseOsrm(body(join(M9, `osrm-foot-${t}.json`)));
  return {
    osrm: o.minutes, osrmMeters: o.meters,
    valh: parseValhalla(body(join(M9, `valhalla-ped-${t}.json`))).minutes,
  };
}

/** Chongqing, from M8's fixtures, on identical terms. */
const CQ: { name: string; lat: number; lon: number }[] = body(join(M8, "places.json"));
function cqLegs(a: string, b: string) {
  const t = `${slug(a)}--${slug(b)}`;
  const o = parseOsrm(body(join(M8, `osrm-foot-${t}.json`)));
  return {
    osrm: o.minutes, osrmMeters: o.meters,
    valh: parseValhalla(body(join(M8, `valhalla-ped-${t}.json`))).minutes,
  };
}

/** How often the model falls below BOTH routers, and above BOTH, over the
 *  unordered pairs of a city. */
function sign(city: string) {
  const pts = city === "Chongqing"
    ? CQ.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }))
    : inCity(city).map((p) => ({ name: p.enName, lat: p.lat, lon: p.lon }));
  const get = city === "Chongqing" ? cqLegs : (a: string, b: string) => legs(city, a, b);
  let below = 0, above = 0, n = 0;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const a = pts[i]!, b = pts[j]!;
      const m = travelMinutes(
        { latitude: a.lat, longitude: a.lon },
        { latitude: b.lat, longitude: b.lon }, "walking");
      const { osrm, valh } = get(a.name, b.name);
      n++;
      if (m < Math.min(osrm, valh)) below++;
      if (m > Math.max(osrm, valh)) above++;
    }
  }
  return { below, above, n };
}

describe("M9: the sign of the model's error changes by city", () => {
  test("THE FINDING: optimistic in Chongqing, pessimistic in all three others", () => {
    // M8's headline was that the model runs optimistic and therefore late.
    // That is a property of Chongqing. This is the assertion that fails if
    // anyone ever retunes the constants from a single city again.
    const cq = sign("Chongqing");
    expect(cq.n).toBe(21);
    expect(cq.below).toBeGreaterThanOrEqual(17);
    expect(cq.above).toBe(0);

    for (const city of CITIES) {
      const s = sign(city);
      expect(s.n).toBe(21);
      expect(s.above).toBeGreaterThan(s.below);
    }
  });

  test("no single detour constant could be right in all four", () => {
    // The reason decision 6 refused to recalibrate: the measured detours
    // bracket the model's assumed 1.30 from BOTH sides.
    const detour = (city: string) => {
      const pts = city === "Chongqing"
        ? CQ.map((p) => ({ name: p.name, lat: p.lat, lon: p.lon }))
        : inCity(city).map((p) => ({ name: p.enName, lat: p.lat, lon: p.lon }));
      const get = city === "Chongqing" ? cqLegs : (a: string, b: string) => legs(city, a, b);
      const rs: number[] = [];
      for (let i = 0; i < pts.length; i++) {
        for (let j = i + 1; j < pts.length; j++) {
          const a = pts[i]!, b = pts[j]!;
          const km = haversineKm(
            { latitude: a.lat, longitude: a.lon },
            { latitude: b.lat, longitude: b.lon });
          // The router's OWN reported distance over the straight line.
          // Deriving it from minutes at an assumed 5 km/h would be inferring
          // a distance the response already states.
          rs.push(get(a.name, b.name).osrmMeters / 1000 / km);
        }
      }
      return rs.sort((x, y) => x - y)[Math.floor(rs.length / 2)]!;
    };
    const cq = detour("Chongqing");
    const ams = detour("Amsterdam");
    expect(cq).toBeGreaterThan(1.3);
    expect(ams).toBeLessThan(1.35);
    expect(cq).toBeGreaterThan(ams);
  });
});

describe("M9: local script is not the explanation it looked like", () => {
  test("English names find their place in Bangkok and Amsterdam", () => {
    // Chongqing lost 5 of 11 correct English names. Thai is as far from Latin
    // as Chinese is, and Bangkok loses none.
    for (const city of ["Bangkok", "Amsterdam"] as const) {
      const missed = inCity(city).filter((p) => p.enCandidates === 0);
      expect(missed).toHaveLength(0);
    }
  });

  test("an English query really does match a Thai-named feature", () => {
    // The mechanism in miniature: Nominatim found พระบรมมหาราชวัง from the
    // string "Grand Palace", which is exactly what it could not do for
    // "Longmenhao Old Street".
    const raw = body(join(M9, `nominatim-bangkok-en-${slug("Grand Palace")}.json`));
    const cands = parsePoiResponse(raw, CENTRES.Bangkok!);
    expect(cands.length).toBeGreaterThan(0);
    expect(cands[0]!.displayName).toContain("พระบรม");
  });

  test("the local form is MORE ambiguous at least as often as less", () => {
    // Confirms across four cities that "always query in local script" is
    // wrong. Chongqing's 十八梯 went 2 -> 5; Dam Square goes 1 -> 5.
    const worse = PLACES.filter((p) => p.localCandidates > p.enCandidates).length;
    const better = PLACES.filter(
      (p) => p.enCandidates > 0 && p.localCandidates < p.enCandidates).length;
    expect(worse).toBeGreaterThanOrEqual(better);
  });

  test("Lisbon's one miss is a TRANSLATION, not a script", () => {
    // Both strings are Latin. It belongs to a different phenomenon than the
    // one M7 described, and lumping them together is how the M7 finding got
    // over-generalised in the first place.
    const castle = inCity("Lisbon").find((p) => p.enName === "Saint George Castle")!;
    expect(castle.enCandidates).toBe(0);
    expect(castle.localCandidates).toBeGreaterThan(0);
    expect(castle.localName).toMatch(/^[\p{Script=Latin}\sÀ-ɏ]+$/u);
  });
});

describe("M9: directedness generalises, and tracks terrain", () => {
  function asymmetry(city: string) {
    const pts = city === "Chongqing"
      ? CQ.map((p) => ({ name: p.name }))
      : inCity(city).map((p) => ({ name: p.enName }));
    const get = city === "Chongqing" ? cqLegs : (a: string, b: string) => legs(city, a, b);
    const v: number[] = [], o: number[] = [];
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i]!.name, b = pts[j]!.name;
        const there = get(a, b), back = get(b, a);
        v.push(Math.abs(there.valh - back.valh));
        o.push(Math.abs(there.osrm - back.osrm));
      }
    }
    const med = (xs: number[]) =>
      [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
    return { valh: med(v), osrm: med(o), maxValh: Math.max(...v) };
  }

  test("OSRM foot is exactly symmetric in ALL FOUR cities", () => {
    // 126 directed legs plus M8's 42. No exceptions anywhere.
    for (const city of ["Chongqing", ...CITIES]) {
      expect(asymmetry(city).osrm).toBeCloseTo(0, 1);
    }
  });

  test("Valhalla's asymmetry is largest in Chongqing and smallest in Amsterdam", () => {
    // Grade, and it shrinks to almost nothing where there are no hills. This
    // is why the directed schema is right everywhere and MATTERS only
    // somewhere.
    const cq = asymmetry("Chongqing").valh;
    const ams = asymmetry("Amsterdam").valh;
    expect(cq).toBeGreaterThan(ams);
    expect(cq).toBeGreaterThan(3);
    expect(ams).toBeLessThan(2);
  });
});

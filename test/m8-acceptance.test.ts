import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseOsrm, parseValhalla } from "@/geo/routers";
import { withLegs, modelOnly } from "@/plan/travel";
import { haversineKm } from "@/plan/geo";
import { runRouteCommand } from "@/commands/route";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip, setTripSchedule } from "@/trips";
import { addSegment } from "@/segments";
import { run } from "@/cli";
import type { MeasuredLeg } from "@/legs";
import { tmpdir } from "node:os";
import { rmSync } from "node:fs";

/** M8 acceptance: measured legs, replayed from captured real responses.
 *
 *  `capture.ts` sits beside these fixtures with the production query written
 *  out in full — M4's viewbox discrepancy survived two milestones because its
 *  appendix recorded results and paraphrased the query. */
const FIX = join(import.meta.dir, "fixtures", "m8-chongqing");

interface Place { name: string; local: string; lat: number; lon: number; from: string }
const PLACES: Place[] = JSON.parse(readFileSync(join(FIX, "places.json"), "utf8"));

const slug = (s: string) =>
  s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");

const P = (n: string) => {
  const p = PLACES.find((x) => x.name === n);
  if (!p) throw new Error(`no captured place named "${n}"`);
  return { latitude: p.lat, longitude: p.lon };
};

const body = (file: string) => JSON.parse(readFileSync(join(FIX, file), "utf8"));
const osrm = (a: string, b: string) =>
  parseOsrm(body(`osrm-foot-${slug(a)}--${slug(b)}.json`));
const valh = (a: string, b: string) =>
  parseValhalla(body(`valhalla-ped-${slug(a)}--${slug(b)}.json`));

/** Both sources, one direction — exactly the rows `trip route` would write. */
function legsFor(a: string, b: string): MeasuredLeg[] {
  const [A, B] = [P(a), P(b)];
  return [
    { r: osrm(a, b), source: "osrm-foot" },
    { r: valh(a, b), source: "valhalla-pedestrian" },
  ].map(({ r, source }) => ({
    fromLat: A.latitude, fromLon: A.longitude,
    toLat: B.latitude, toLon: B.longitude,
    mode: "walking", minutes: r.minutes, meters: r.meters,
    source, fetchedAt: "2026-07-27T12:00:00Z",
  }));
}

describe("M8 acceptance: a measured leg beats a straight line", () => {
  test("THE MILESTONE: Testbed 2 -> Liziba is 22 minutes, not 6", () => {
    const [A, B] = [P("Testbed 2"), P("Liziba")];
    // 360 m apart in a straight line, and no direct pedestrian path between
    // them. The model calls them neighbours.
    expect(modelOnly().minutes(A, B, "walking")).toBe(6);
    expect(withLegs(legsFor("Testbed 2", "Liziba")).minutes(A, B, "walking"))
      .toBeGreaterThanOrEqual(22);
  });

  test("the model is BELOW both routers on nearly every pair, and above both on none", () => {
    // The recon headline, replayed against the captured bodies. This is the
    // measurement the whole milestone rests on.
    let below = 0, above = 0, n = 0;
    for (let i = 0; i < PLACES.length; i++) {
      for (let j = i + 1; j < PLACES.length; j++) {
        const [a, b] = [PLACES[i]!.name, PLACES[j]!.name];
        const m = modelOnly().minutes(P(a), P(b), "walking");
        const both = [osrm(a, b).minutes, valh(a, b).minutes];
        n++;
        if (m < Math.min(...both)) below++;
        if (m > Math.max(...both)) above++;
      }
    }
    expect(n).toBe(21);
    expect(below).toBeGreaterThanOrEqual(17);
    // Never optimistic in the safe direction. This is the asymmetry that
    // makes the model dangerous rather than merely imprecise: a plan built on
    // it runs late, and lateness cascades.
    expect(above).toBe(0);
  });

  test("the model is worst on SHORT hops, which is where day-planning happens", () => {
    // Banded on the STRAIGHT-LINE distance, not on the routed time. Deriving
    // the band from the minutes being measured would make this circular.
    const ratios = (lo: number, hi: number) => {
      const out: number[] = [];
      for (let i = 0; i < PLACES.length; i++) {
        for (let j = i + 1; j < PLACES.length; j++) {
          const [a, b] = [PLACES[i]!.name, PLACES[j]!.name];
          const km = haversineKm(P(a), P(b));
          if (km < lo || km >= hi) continue;
          const mid = (osrm(a, b).minutes + valh(a, b).minutes) / 2;
          out.push(modelOnly().minutes(P(a), P(b), "walking") / mid);
        }
      }
      return out.sort((x, y) => x - y);
    };
    const short = ratios(0, 2);
    const long = ratios(2, 99);
    expect(short.length).toBeGreaterThan(0);
    expect(long.length).toBeGreaterThan(0);
    const med = (a: number[]) => a[Math.floor(a.length / 2)]!;
    // Short hops are underestimated by much more than long ones.
    expect(med(short)).toBeLessThan(med(long));
  });

  test("the REVERSE leg differs -- which is why legs are directed", () => {
    // Valhalla models grade; OSRM foot does not. Storing one row per
    // unordered pair would have made every uphill return silently wrong.
    const there = valh("Testbed 2", "Liziba").minutes;
    const back = valh("Liziba", "Testbed 2").minutes;
    expect(Math.abs(back - there)).toBeGreaterThan(5);
    expect(osrm("Testbed 2", "Liziba").minutes)
      .toBeCloseTo(osrm("Liziba", "Testbed 2").minutes, 1);
  });

  test("the two routers disagree, and both numbers survive", () => {
    const legs = legsFor("Testbed 2", "Liziba");
    expect(legs).toHaveLength(2);
    expect(legs[0]!.minutes).not.toBe(legs[1]!.minutes);
    // The schedule reads the slower.
    const t = withLegs(legs);
    expect(t.minutes(P("Testbed 2"), P("Liziba"), "walking"))
      .toBe(Math.round(Math.max(...legs.map((l) => l.minutes))));
  });

  test("a moved segment falls back to the model", () => {
    const t = withLegs(legsFor("Testbed 2", "Liziba"));
    const moved = { latitude: 29.56, longitude: 106.54 };
    expect(t.estimate(P("Testbed 2"), moved, "walking").measured).toBe(false);
  });

  test("a hop with no leg is unchanged from M7 -- the control", () => {
    // Without this, every test above proves only that the lookup runs.
    const t = withLegs(legsFor("Testbed 2", "Liziba"));
    const [A, B] = [P("Hongya Cave"), P("Luohan Temple")];
    expect(t.estimate(A, B, "walking").measured).toBe(false);
    expect(t.minutes(A, B, "walking")).toBe(modelOnly().minutes(A, B, "walking"));
  });

  test("transit is untouched by every leg in the fixture set", () => {
    // Nothing in M8 measured transit. A transit plan is exactly as
    // unevidenced after this milestone as before it, and that is asserted
    // rather than left as a paragraph in a spec.
    const t = withLegs(legsFor("Testbed 2", "Liziba"));
    const [A, B] = [P("Testbed 2"), P("Liziba")];
    expect(t.estimate(A, B, "transit").measured).toBe(false);
    expect(t.minutes(A, B, "transit")).toBe(modelOnly().minutes(A, B, "transit"));
  });
});

describe("M8 cross-command consistency", () => {
  /** Two commands describing the same state and disagreeing is the defect
   *  class M4 introduced this check for. */
  async function realTrip(tag: string) {
    const path = join(tmpdir(), `trip-m8-acc-${tag}-${process.pid}.db`);
    rmSync(path, { force: true });
    const db = openDb(path);
    await migrate(db);
    const trip = await createTrip(db, "chongqing", "2026-07-27");
    await setActiveTrip(db, "chongqing");
    await setTripSchedule(db, trip.id, {
      startDate: "2026-09-01", endDate: "2026-09-01",
      arrivalMin: null, departureMin: null,
      dayStartMin: 9 * 60, dayEndMin: 21 * 60,
    });
    for (const name of ["Testbed 2", "Liziba", "Hongya Cave"]) {
      const p = P(name);
      await addSegment(db, trip.id, {
        name, latitude: p.latitude, longitude: p.longitude, dwellMinutes: 60,
        tags: [], opensMin: null, closesMin: null, closedDays: [], freeDays: [],
      });
    }
    return { db, path };
  }

  /** Answers from the captured bodies, keyed on the coordinates asked for, so
   *  the command under test drives the same lookup the real one would. */
  function replay(which: "osrm" | "valhalla") {
    const at = new Map(PLACES.map((p) => [`${p.lat},${p.lon}`, p.name]));
    return async (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) => {
      const an = at.get(`${a.latitude},${a.longitude}`)!;
      const bn = at.get(`${b.latitude},${b.longitude}`)!;
      return which === "osrm" ? osrm(an, bn) : valh(an, bn);
    };
  }

  test("trip route and trip plan agree about which hops are measured", async () => {
    const { db, path } = await realTrip("consistency");
    const out = await runRouteCommand(db, [], true, {
      osrm: replay("osrm"), valhalla: replay("valhalla"),
      sleepFn: async () => {}, now: () => "2026-07-27T12:00:00Z",
    });
    const routed = JSON.parse(out);
    // 3 segments -> 6 directed pairs -> x2 sources.
    expect(routed.legs).toHaveLength(12);
    expect(routed.failures).toEqual([]);

    const planned = JSON.parse((await run(["plan", "--json"], { dbPath: path })).stdout);
    const hops = planned.days.flatMap(
      (d: { placements: { arriveBy: { measured: boolean } | null }[] }) =>
        d.placements.map((p) => p.arriveBy).filter(Boolean),
    );
    // Every pair was routed, so every hop the plan takes must be measured.
    // A single "estimated" here means the two commands disagree about the
    // same database.
    expect(hops.length).toBe(2);
    expect(hops.every((h: { measured: boolean }) => h.measured)).toBe(true);
  });

  test("trip plan and trip day describe the same hops", async () => {
    // This is the one that was missing. `trip day` rendered no hop lines at
    // all while `trip plan` rendered them for the same stored placements, and
    // the consistency test only compared `trip route` against `trip plan`.
    //
    // It hid because every renderDay test calls the function WITHOUT a travel
    // model, so the no-hop path stayed green while the CLI stopped using it.
    const { db, path } = await realTrip("planvsday");
    await runRouteCommand(db, [], true, {
      osrm: replay("osrm"), valhalla: replay("valhalla"),
      sleepFn: async () => {}, now: () => "2026-07-27T12:00:00Z",
    });
    const plan = (await run(["plan"], { dbPath: path })).stdout;
    const day = (await run(["day", "1"], { dbPath: path })).stdout;

    const hops = (s: string) => s.split("\n").filter((l) => l.includes("min walk"));
    expect(hops(plan).length).toBe(2);
    expect(hops(day)).toEqual(hops(plan));

    // And under --json, where the agent actually reads it.
    const planJ = JSON.parse((await run(["plan", "--json"], { dbPath: path })).stdout);
    const dayJ = JSON.parse((await run(["day", "1", "--json"], { dbPath: path })).stdout);
    const arrivals = (j: { days: { placements: { arriveBy: unknown }[] }[] }) =>
      j.days[0]!.placements.map((p) => p.arriveBy);
    expect(arrivals(dayJ)).toEqual(arrivals(planJ));
  });

  test("the measured plan really is slower than the modelled one", async () => {
    // The end-to-end consequence, in minutes on the clock rather than in a
    // lookup table.
    const { db, path } = await realTrip("slower");
    const before = JSON.parse((await run(["plan", "--json"], { dbPath: path })).stdout);
    await runRouteCommand(db, [], true, {
      osrm: replay("osrm"), valhalla: replay("valhalla"),
      sleepFn: async () => {}, now: () => "2026-07-27T12:00:00Z",
    });
    const after = JSON.parse((await run(["plan", "--json"], { dbPath: path })).stdout);

    const last = (j: { days: { placements: { endTime: string }[] }[] }) =>
      j.days[0]!.placements[j.days[0]!.placements.length - 1]!.endTime;
    expect(after.days[0].placements).toHaveLength(3);
    expect(last(after) > last(before)).toBe(true);
  });
});

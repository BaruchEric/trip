import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { listSegments } from "@/segments";
import { isPlannable } from "@/plan/types";
import type { Point } from "@/plan/types";
import { saveLeg, listLegs, legKey, roundCoord, type MeasuredLeg } from "@/legs";
import {
  osrmFootLeg, valhallaPedestrianLeg, type RouterResult,
} from "@/geo/routers";

/** Measure real walking legs and store them.
 *
 *  The ONLY planning command that touches the network. `trip plan` reads what
 *  this wrote and stays a pure, offline, synchronous compile — the contract
 *  `compile.ts` has carried since M2. */

/** Shared, unfunded, fair-use instances, exactly like Nominatim. One request
 *  per 1.2 s is the courtesy M3 settled on there. */
const GAP_MS = 1200;

export interface RouteDeps {
  osrm?: (a: Point, b: Point) => Promise<RouterResult>;
  valhalla?: (a: Point, b: Point) => Promise<RouterResult>;
  sleepFn?: (ms: number) => Promise<void>;
  now?: () => string;
}

const SOURCES = [
  { name: "osrm-foot", pick: (d: RouteDeps) => d.osrm ?? osrmFootLeg },
  { name: "valhalla-pedestrian", pick: (d: RouteDeps) => d.valhalla ?? valhallaPedestrianLeg },
] as const;

const pointKey = (p: Point) => `${roundCoord(p.latitude)},${roundCoord(p.longitude)}`;

export async function runRouteCommand(
  db: Client,
  argv: string[],
  json: boolean,
  deps: RouteDeps = {},
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  const refresh = argv.includes("--refresh");
  const sleep = deps.sleepFn
    ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => new Date().toISOString());

  const all = await listSegments(db, trip.id);
  const placed = all.filter(isPlannable);
  const unplaced = all.filter((s) => !isPlannable(s));

  if (placed.length < 2) {
    throw new Error(
      `routing needs at least two segments with coordinates; this trip has ` +
      `${placed.length}. Add one with \`trip seg add <name> --at=lat,lon\`, ` +
      `or resolve a queued mention with \`trip review resolve\`.`,
    );
  }

  const stored0 = new Set(
    (await listLegs(db)).map(
      (l) => `${legKey(l.fromLat, l.fromLon, l.toLat, l.toLon, l.mode)}|${l.source}`,
    ),
  );

  // ORDERED pairs, both ways. A leg is directed because one of the two routers
  // models grade: the uphill return over the same ground is a different
  // number, by up to 8.7 minutes over 360 m in this city.
  const jobs: { a: typeof placed[number]; b: typeof placed[number]; source: string }[] = [];
  for (const a of placed) {
    for (const b of placed) {
      if (a.id === b.id) continue;
      for (const s of SOURCES) {
        const k = `${legKey(a.latitude, a.longitude, b.latitude, b.longitude, "walking")}|${s.name}`;
        if (!refresh && stored0.has(k)) continue;
        jobs.push({ a, b, source: s.name });
      }
    }
  }

  const total = placed.length * (placed.length - 1) * SOURCES.length;
  const cached = total - jobs.length;
  const lines: string[] = [
    `${placed.length} placed segments: ${total} directed legs across ` +
    `${SOURCES.length} routers. ${jobs.length} request` +
    `${jobs.length === 1 ? "" : "s"} to make` +
    (cached > 0 ? `, ${cached} already cached.` : "."),
  ];
  if (jobs.length > 0) {
    lines.push(
      `about ${Math.ceil((jobs.length * GAP_MS) / 1000)}s at one request per ${GAP_MS}ms.`,
    );
  }

  const failures: string[] = [];
  let saved = 0;
  for (let i = 0; i < jobs.length; i++) {
    const { a, b, source } = jobs[i]!;
    const fetchLeg = SOURCES.find((s) => s.name === source)!.pick(deps);
    try {
      const r = await fetchLeg(a, b);
      const leg: MeasuredLeg = {
        fromLat: a.latitude, fromLon: a.longitude,
        toLat: b.latitude, toLon: b.longitude,
        mode: "walking", source, minutes: r.minutes, meters: r.meters,
        fetchedAt: now(),
      };
      await saveLeg(db, leg);
      saved++;
    } catch (err) {
      // Absence is loud: a failed fetch stores NOTHING. No zero, no fallback,
      // no partial row. The other source still gets its turn, and the
      // slower-of-the-two rule degrades correctly to "the only one there is".
      failures.push(`${source} ${a.name} -> ${b.name}: ${(err as Error).message}`);
    }
    if (i < jobs.length - 1) await sleep(GAP_MS);
  }

  const legs = await listLegs(db);

  if (json) {
    return JSON.stringify({
      placed: placed.length,
      requested: jobs.length,
      stored: saved,
      cached,
      failures,
      // BOTH sources per directed pair, never a midpoint: the spread between
      // the two routers is a finding about the city, and averaging it here
      // would erase it from every consumer downstream.
      legs,
      unplaced: unplaced.map((s) => ({ id: s.id, name: s.name })),
    });
  }

  lines.push(`stored ${saved}.`);
  for (const s of unplaced) lines.push(`  skipped ${s.name}: no coordinates`);
  for (const f of failures) lines.push(`  failed  ${f}`);

  const widest = widestDisagreement(legs, placed);
  if (widest) {
    lines.push(
      `widest router disagreement: ${Math.round(widest.spread)} min, ` +
      `${widest.from} -> ${widest.to}. Both numbers are stored; ` +
      `the schedule reads the slower.`,
    );
  }
  return lines.join("\n");
}

/** The spread is a fact about the city worth reading, so it is reported rather
 *  than left for someone to notice in the database. */
function widestDisagreement(
  legs: MeasuredLeg[],
  placed: (Point & { name: string })[],
): { spread: number; from: string; to: string } | null {
  const nameAt = new Map(placed.map((p) => [pointKey(p), p.name]));
  const byPair = new Map<string, { from: string; to: string; mins: number[] }>();

  for (const l of legs) {
    if (l.mode !== "walking") continue;
    const k = legKey(l.fromLat, l.fromLon, l.toLat, l.toLon, l.mode);
    const entry = byPair.get(k) ?? {
      from: nameAt.get(`${roundCoord(l.fromLat)},${roundCoord(l.fromLon)}`)
        ?? `${roundCoord(l.fromLat)},${roundCoord(l.fromLon)}`,
      to: nameAt.get(`${roundCoord(l.toLat)},${roundCoord(l.toLon)}`)
        ?? `${roundCoord(l.toLat)},${roundCoord(l.toLon)}`,
      mins: [],
    };
    entry.mins.push(l.minutes);
    byPair.set(k, entry);
  }

  let best: { spread: number; from: string; to: string } | null = null;
  for (const e of byPair.values()) {
    // A single source is not a disagreement. Reporting one as a zero spread
    // would put "0 min disagreement" beside a leg nobody cross-checked.
    if (e.mins.length < 2) continue;
    const spread = Math.max(...e.mins) - Math.min(...e.mins);
    if (spread < 1) continue;
    if (!best || spread > best.spread) best = { spread, from: e.from, to: e.to };
  }
  return best;
}

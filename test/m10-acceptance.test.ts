import { test, expect, describe } from "bun:test";
import { run } from "@/cli";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip, setTripSchedule } from "@/trips";
import { addSegment } from "@/segments";
import { addTraveller } from "@/travellers";
import { saveLeg } from "@/legs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";

/** The measured Chongqing trip: 7 segments, 3 days, 2 travellers, of which
 *  5 of 6 placed segments have unknown hours and 1 cannot be placed at all. */
const PLACES: [string, number | null, number | null][] = [
  ["Hongya Cave", 29.5650738, 106.5753425],
  ["Luohan Temple", 29.5625664, 106.5778425],
  ["Testbed 2", 29.5537638, 106.5368476],
  ["Ring Shopping Park", 29.6530663, 106.5259717],
  ["Longmenhao Old Street", 29.5588249, 106.5912051],
  ["Liziba", 29.5556826, 106.5338753],
  ["Wulong Karst", null, null],
];

async function chongqing(tag: string) {
  const path = join(tmpdir(), `trip-m10-acc-${tag}-${process.pid}.db`);
  rmSync(path, { force: true });
  const db = openDb(path);
  await migrate(db);
  const trip = await createTrip(db, "chongqing", "2026-07-27");
  await setActiveTrip(db, "chongqing");
  await setTripSchedule(db, trip.id, {
    startDate: "2026-09-01", endDate: "2026-09-03",
    arrivalMin: null, departureMin: null,
    dayStartMin: 9 * 60, dayEndMin: 19 * 60,
  });
  await addTraveller(db, trip.id, "eric", "1985-04-12");
  await addTraveller(db, trip.id, "mum", "1958-11-03");
  for (const [name, latitude, longitude] of PLACES) {
    await addSegment(db, trip.id, {
      name, latitude, longitude, dwellMinutes: 60, tags: [],
      // Only Luohan Temple has known hours -- 5 of 6 placed are unknown.
      opensMin: name === "Luohan Temple" ? 8 * 60 : null,
      closesMin: name === "Luohan Temple" ? 18 * 60 : null,
      closedDays: [], freeDays: [],
    });
  }
  await run(["plan"], { dbPath: path });
  return { db, path };
}

const DEPS = { export: { now: () => "2026-07-27T12:00:00.000Z" } };

describe("M10 acceptance: the plan leaves the terminal", () => {
  test("the unplaced segment survives into ALL THREE formats", async () => {
    // Absence is loud, three times over. Dropping it would make the trip look
    // smaller than it is with nothing anywhere to say so.
    const { path } = await chongqing("all3");
    for (const format of ["ics", "md", "geojson"] as const) {
      const out = (await run(["export", `--format=${format}`], { dbPath: path, deps: DEPS })).stdout;
      expect(out).toContain("Wulong Karst");
      expect(out).toContain("no coordinates");
    }
  });

  test("STATUS:TENTATIVE appears for every segment with unknown hours", async () => {
    const { path } = await chongqing("status");
    const ics = (await run(["export", "--format=ics"], { dbPath: path, deps: DEPS })).stdout;
    const tentative = ics.match(/STATUS:TENTATIVE/g) ?? [];
    const confirmed = ics.match(/STATUS:CONFIRMED/g) ?? [];
    // 5 placed with unknown hours, plus the unplaced all-day event.
    expect(tentative.length).toBe(6);
    // Luohan Temple alone.
    expect(confirmed.length).toBe(1);
  });

  test("the GeoJSON is structurally valid per RFC 7946", async () => {
    const { path } = await chongqing("valid");
    const g = JSON.parse(
      (await run(["export", "--format=geojson"], { dbPath: path, deps: DEPS })).stdout);
    expect(g.type).toBe("FeatureCollection");
    expect(Array.isArray(g.features)).toBe(true);
    for (const f of g.features) {
      expect(f.type).toBe("Feature");
      expect("geometry" in f && "properties" in f).toBe(true);
      expect("coordinates" in f).toBe(false);
      if (f.geometry !== null) {
        expect(["Point", "LineString"]).toContain(f.geometry.type);
      }
    }
    expect(g.features.some((f: any) => f.geometry === null)).toBe(true);
  });
});

describe("M10 cross-command: export and trip day cannot disagree", () => {
  test("every start time and every measured flag matches trip day --json", async () => {
    // THE assertion this milestone needs. M8 shipped `trip day` rendering no
    // hop lines while `trip plan` rendered them, because a second call site
    // was missed and every render test called the function without a travel
    // model. Export is the command whose ENTIRE JOB is faithful reproduction,
    // so the same divergence here would be that defect in the worst place.
    const { db, path } = await chongqing("cross");
    // Legs for one real pair, so at least one hop is measured and the
    // comparison is not trivially all-false.
    for (const [f, t] of [
      [[29.5650738, 106.5753425], [29.5625664, 106.5778425]],
      [[29.5625664, 106.5778425], [29.5650738, 106.5753425]],
    ] as const) {
      await saveLeg(db, {
        fromLat: f[0], fromLon: f[1], toLat: t[0], toLon: t[1],
        mode: "walking", source: "osrm-foot", minutes: 9, meters: 620,
        fetchedAt: "2026-07-27T12:00:00Z",
      });
    }

    const g = JSON.parse(
      (await run(["export", "--format=geojson"], { dbPath: path, deps: DEPS })).stdout);
    const stops = g.features.filter((f: any) => f.properties.kind === "stop");
    const hops = g.features.filter((f: any) => f.properties.kind === "hop");

    for (const dayNo of [1, 2, 3]) {
      const day = JSON.parse(
        (await run(["day", String(dayNo), "--json"], { dbPath: path })).stdout);
      const placements = day.days[0].placements;

      for (const p of placements) {
        const exported = stops.find((s: any) => s.properties.segmentId === p.segmentId);
        expect(exported).toBeDefined();
        // Same clock, to the minute.
        const hh = String(Math.floor(exported.properties.startMinute / 60)).padStart(2, "0");
        const mm = String(exported.properties.startMinute % 60).padStart(2, "0");
        expect(`${hh}:${mm}`).toBe(p.startTime);
        // Same view of what is known.
        expect(exported.properties.hoursKnown).toBe(p.hoursKnown);
        expect(exported.properties.price).toBe(p.price);
      }

      // Same view of which hops were measured.
      for (const p of placements) {
        if (p.arriveBy === null) continue;
        const to = stops.find((s: any) => s.properties.segmentId === p.segmentId);
        const hop = hops.find((h: any) => h.properties.day === dayNo
          && h.properties.to === to.properties.name);
        expect(hop).toBeDefined();
        expect(hop.properties.measured).toBe(p.arriveBy.measured);
        expect(hop.properties.minutes).toBe(p.arriveBy.minutes);
      }
    }
  });

  test("the ICS start times match trip day too", async () => {
    const { path } = await chongqing("icscross");
    const ics = (await run(["export", "--format=ics"], { dbPath: path, deps: DEPS })).stdout;
    for (const dayNo of [1, 2, 3]) {
      const day = JSON.parse(
        (await run(["day", String(dayNo), "--json"], { dbPath: path })).stdout);
      for (const p of day.days[0].placements) {
        const stamp = `${day.days[0].date.replace(/-/g, "")}T${p.startTime.replace(":", "")}00`;
        expect(ics).toContain(`DTSTART:${stamp}`);
      }
    }
  });
});

describe("trip export command", () => {
  test("--format is required and names the three", async () => {
    const { path } = await chongqing("noformat");
    const r = await run(["export"], { dbPath: path, deps: DEPS });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/--format is required/);
    expect(r.stderr).toContain("geojson");
  });

  test("an unknown --format is rejected, never defaulted", async () => {
    const { path } = await chongqing("badformat");
    const r = await run(["export", "--format=pdf"], { dbPath: path, deps: DEPS });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/invalid --format/);
  });

  test("--out writes the file and says what it wrote", async () => {
    const { path } = await chongqing("out");
    const target = join(tmpdir(), `trip-m10-out-${process.pid}.ics`);
    rmSync(target, { force: true });
    const r = await run(["export", "--format=ics", `--out=${target}`],
      { dbPath: path, deps: DEPS });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(target);
    expect(r.stdout).toMatch(/6 stops/);
    expect(r.stdout).toMatch(/1 not planned/);
    expect(existsSync(target)).toBe(true);
    expect(readFileSync(target, "utf8")).toContain("BEGIN:VCALENDAR");
    rmSync(target, { force: true });
  });

  test("--out refuses to overwrite without --force", async () => {
    // Silently replacing a file the user edited is data loss.
    const { path } = await chongqing("force");
    const target = join(tmpdir(), `trip-m10-force-${process.pid}.md`);
    writeFileSync(target, "mine");
    const denied = await run(["export", "--format=md", `--out=${target}`],
      { dbPath: path, deps: DEPS });
    expect(denied.code).toBe(1);
    expect(denied.stderr).toMatch(/already exists/);
    expect(readFileSync(target, "utf8")).toBe("mine");

    const forced = await run(["export", "--format=md", `--out=${target}`, "--force"],
      { dbPath: path, deps: DEPS });
    expect(forced.code).toBe(0);
    expect(readFileSync(target, "utf8")).not.toBe("mine");
    rmSync(target, { force: true });
  });

  test("with nothing planned it errors and names trip plan", async () => {
    const path = join(tmpdir(), `trip-m10-unplanned-${process.pid}.db`);
    rmSync(path, { force: true });
    const db = openDb(path);
    await migrate(db);
    const trip = await createTrip(db, "cq", "2026-07-27");
    await setActiveTrip(db, "cq");
    await setTripSchedule(db, trip.id, {
      startDate: "2026-09-01", endDate: "2026-09-01",
      arrivalMin: null, departureMin: null,
      dayStartMin: 9 * 60, dayEndMin: 19 * 60,
    });
    const r = await run(["export", "--format=md"], { dbPath: path, deps: DEPS });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("trip plan");
  });

  test("rejects a flag belonging to another command", async () => {
    const { path } = await chongqing("flags");
    const r = await run(["export", "--format=md", "--refresh"], { dbPath: path, deps: DEPS });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag for `trip export`");
  });

  test("--help describes all three formats", async () => {
    const { path } = await chongqing("help");
    const r = await run(["export", "--help"], { dbPath: path, deps: DEPS });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/TENTATIVE/);
    expect(r.stdout).toMatch(/null geometry/);
    expect(r.stdout).toMatch(/COMPLETE record/);
  });
});

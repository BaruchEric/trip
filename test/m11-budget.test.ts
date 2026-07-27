import { test, expect, describe } from "bun:test";
import { run } from "@/cli";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip, setTripSchedule } from "@/trips";
import { addSegment } from "@/segments";
import { addTraveller } from "@/travellers";
import { addObservation } from "@/observations";
import { selectDaily, buildBudget, combinedTotal } from "@/budget";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

const HONGYA = { lat: 29.5650738, lon: 106.5753425 };
const LUOHAN = { lat: 29.5625664, lon: 106.5778425 };

const base = {
  dwellMinutes: 60, tags: [], opensMin: null, closesMin: null,
  closedDays: [], freeDays: [],
};

/** The real Chongqing card, read off a video frame in M6. Rows 1-3 and row 4
 *  describe the same money, which is the whole reason --daily exists. */
const CARD: [string, number, number, number][] = [
  ["Transportation", 40, 4, 1],
  ["Accommodation", 230, 4, 1],
  ["Activities & food", 131, 4, 1],
  ["Total", 401, 4, 1],
];

async function tripDb(tag: string, opts: { currency?: string; card?: boolean } = {}) {
  const path = join(tmpdir(), `trip-m11-${tag}-${process.pid}.db`);
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
  if (opts.currency) await run(["set", `--currency=${opts.currency}`], { dbPath: path });
  await addTraveller(db, trip.id, "eric", "1985-04-12");
  await addTraveller(db, trip.id, "mum", "1958-11-03");
  await addSegment(db, trip.id, { ...base, name: "Hongya Cave",
    latitude: HONGYA.lat, longitude: HONGYA.lon });
  await addSegment(db, trip.id, { ...base, name: "Luohan Temple",
    latitude: LUOHAN.lat, longitude: LUOHAN.lon });
  await run(["seg", "price", "2", "--price=10"], { dbPath: path });
  await run(["plan"], { dbPath: path });

  await db.execute({
    sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
    args: [trip.id, "https://youtu.be/KHHlcCUTwZA", "2026-07-27T00:00:00Z"],
  });
  if (opts.card !== false) {
    for (const [label, amount, days, people] of CARD) {
      await addObservation(db, trip.id, {
        sourceId: 1, atSeconds: 1169, label, amount,
        currency: "USD", coversDays: days, coversPeople: people,
      });
    }
  }
  return { db, path, tripId: trip.id };
}

describe("trip budget", () => {
  test("NEVER sums the observations", async () => {
    // Rows 1-3 and row 4 describe the same money. 40+230+131+401 = 802, and
    // 40+230+131 = 401 which would look like a coincidence rather than the
    // double-count it is.
    const { path } = await tripDb("nosum", { currency: "CNY" });
    const out = (await run(["budget"], { dbPath: path })).stdout;
    expect(out).not.toContain("802");
    expect(out).toMatch(/NOT added together/);
  });

  test("with no --daily it lists every observation and picks none", async () => {
    const { path } = await tripDb("nopick", { currency: "CNY" });
    const out = (await run(["budget"], { dbPath: path })).stdout;
    expect(out).toMatch(/Not selected. 4 recorded/);
    expect(out).toContain("100.25 per person per day");
    expect(out).toContain("--daily=");
  });

  test("NEVER adds across currencies, and says why", async () => {
    const { path } = await tripDb("fx", { currency: "CNY" });
    const out = (await run(["budget", "--daily=4", "--limit=500"], { dbPath: path })).stdout;
    expect(out).toMatch(/no exchange rate is a fact this tool has/);
    // Both halves reported, neither combined. 601.50 USD alongside 10 CNY.
    expect(out).toContain("601.50 USD");
    expect(out).toContain("20 CNY");
    expect(out).not.toContain("621.5");
  });

  test("ANSWERS the part it can -- admissions against the limit", async () => {
    // The mirror of the failure being guarded against: refusing wholesale
    // when admissions are perfectly well known is as bad as guessing.
    const { path } = await tripDb("partial", { currency: "CNY" });
    const out = (await run(["budget", "--limit=500"], { dbPath: path })).stdout;
    expect(out).toMatch(/Admissions\s+20 CNY of 500 CNY/);
    expect(out).toMatch(/No single figure, because:/);
  });

  test("the projection says it is one source's claim about a different trip", async () => {
    const { path } = await tripDb("claim", { currency: "USD" });
    const out = (await run(["budget", "--daily=4"], { dbPath: path })).stdout;
    expect(out).toMatch(/DIFFERENT trip - 4 days, 1 person/);
    expect(out).toMatch(/assumes your other travellers cost the same/);
    expect(out).toMatch(/not a rate/i);
  });

  test("gives ONE figure when everything needed is known and same-currency", async () => {
    const { path } = await tripDb("whole", { currency: "USD" });
    // Price the remaining segment so nothing is unknown.
    await run(["seg", "price", "1", "--price=0"], { dbPath: path });
    await run(["plan"], { dbPath: path });
    const out = (await run(["budget", "--daily=4", "--limit=1000"], { dbPath: path })).stdout;
    // Admissions are a PARTY total: 10 each x 2 travellers = 20.
    // 20 + (100.25 x 3 days x 2 travellers = 601.50) = 621.50
    expect(out).toContain("621.50 USD");
    expect(out).toMatch(/Within budget/);
  });

  test("says OVER when it is over", async () => {
    const { path } = await tripDb("over", { currency: "USD" });
    await run(["seg", "price", "1", "--price=0"], { dbPath: path });
    await run(["plan"], { dbPath: path });
    const out = (await run(["budget", "--daily=4", "--limit=500"], { dbPath: path })).stdout;
    expect(out).toMatch(/OVER by 121.50 USD/);
  });

  test("with no observations it says daily costs are unaccounted, not free", async () => {
    const { path } = await tripDb("none", { currency: "CNY", card: false });
    const out = (await run(["budget"], { dbPath: path })).stdout;
    expect(out).toMatch(/UNACCOUNTED/);
    expect(out).toMatch(/not the same as free/);
    expect(out).toContain("trip costs add");
  });

  test("an unpriced segment is never rendered as zero", async () => {
    const { path } = await tripDb("unknown", { currency: "CNY" });
    const out = (await run(["budget"], { dbPath: path })).stdout;
    expect(out).toMatch(/1 segment has no price recorded/);
  });

  test("--json carries total null with the blockers, never 0", async () => {
    const { path } = await tripDb("json", { currency: "CNY" });
    const j = JSON.parse((await run(["budget", "--daily=4", "--json"], { dbPath: path })).stdout);
    expect(j.total).toBeNull();
    expect(j.blockers.length).toBeGreaterThan(0);
    expect(j.daily.perPersonPerDay).toBeCloseTo(100.25, 2);
    expect(j.daily.currency).toBe("USD");
  });
});

describe("selectDaily", () => {
  test("rejects an observation whose coverage is unknown", async () => {
    // perPersonPerDay is null when either axis is unknown, and projecting
    // from that would make a number out of a fact nobody has.
    const { db, path, tripId } = await tripDb("coverage", { currency: "USD" });
    await addObservation(db, tripId, {
      sourceId: 1, atSeconds: null, label: "Food, roughly", amount: 200,
      currency: "USD", coversDays: null, coversPeople: null,
    });
    const r = await run(["budget", "--daily=5"], { dbPath: path });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/does not say how many days or people/);
    expect(r.stderr).toContain("--days=");
  });

  test("rejects an id that does not exist", async () => {
    const { path } = await tripDb("noid", { currency: "USD" });
    const r = await run(["budget", "--daily=99"], { dbPath: path });
    expect(r.code).toBe(1);
    expect(r.stderr).toMatch(/no cost observation with id 99/);
    expect(r.stderr).toContain("trip costs ls");
  });
});

describe("combinedTotal", () => {
  const bare = {
    tripName: "t", currency: "USD", days: 2, travellers: 1,
    admissions: { total: 10, unknown: 0 },
    passes: { total: 0, unknown: 0 },
    observations: [], dailyId: null, limit: null,
  };

  test("is null whenever anything blocks it", () => {
    const r = buildBudget(bare);
    expect(r.blockers.length).toBeGreaterThan(0);
    expect(combinedTotal(r)).toBeNull();
  });

  test("is null, never 0, when admissions are unknown", () => {
    const r = buildBudget({ ...bare, admissions: { total: null, unknown: 3 } });
    expect(combinedTotal(r)).toBeNull();
  });
});

describe("trip budget flag validation", () => {
  test("rejects a flag belonging to another command", async () => {
    const { path } = await tripDb("flags", { currency: "USD" });
    const r = await run(["budget", "--format=md"], { dbPath: path });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag for `trip budget`");
  });

  test("rejects an empty --limit rather than reading it as zero", async () => {
    const { path } = await tripDb("emptylimit", { currency: "USD" });
    const r = await run(["budget", "--limit="], { dbPath: path });
    expect(r.code).toBe(1);
  });

  test("--help explains why currencies are never converted", async () => {
    const { path } = await tripDb("help", { currency: "USD" });
    const r = await run(["budget", "--help"], { dbPath: path });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/no\s+exchange rate is a fact this tool has/);
    expect(r.stdout).toMatch(/never picks one for you/);
  });
});

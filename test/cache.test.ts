import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { upsertDestination, readMonths, writeMonths, getClimate } from "@/climate/cache";
import type { GeoCandidate } from "@/geocode";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKYO: GeoCandidate = {
  name: "Tokyo", country: "Japan", countryCode: "JP",
  latitude: 35.68, longitude: 139.69, timezone: "Asia/Tokyo", population: 8336599,
};

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-cache-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  return db;
}

function fakeArchive(counter: { n: number }): typeof fetch {
  return (async () => {
    counter.n++;
    return new Response(JSON.stringify({
      daily: {
        time: ["2024-07-01", "2024-07-02"],
        dew_point_2m_mean: [24, 23],
        temperature_2m_max: [28.2, 31.4],
        precipitation_sum: [6.7, 4.9],
      },
    }), { status: 200 });
  }) as unknown as typeof fetch;
}

describe("destinations", () => {
  test("upsert returns a stable id for the same city", async () => {
    const db = await freshDb("upsert");
    const a = await upsertDestination(db, TOKYO);
    const b = await upsertDestination(db, TOKYO);
    expect(a).toBe(b);
  });
});

describe("months storage", () => {
  test("readMonths returns null before anything is cached", async () => {
    const db = await freshDb("empty");
    const id = await upsertDestination(db, TOKYO);
    expect(await readMonths(db, id)).toBeNull();
  });

  test("write then read round-trips all twelve months in order", async () => {
    const db = await freshDb("roundtrip");
    const id = await upsertDestination(db, TOKYO);
    const months = Array.from({ length: 12 }, (_, i) => ({
      month: i + 1, dewPointMean: i, tempMaxMean: i * 2, rainDays: i / 2,
      dayCount: i * 10, expectedDays: 280 + i,
    }));
    await writeMonths(db, id, months, "2026-07-26");
    const back = await readMonths(db, id);
    expect(back).toHaveLength(12);
    expect(back![0]!.month).toBe(1);
    expect(back![11]!.dewPointMean).toBe(11);
    // dayCount must survive the round trip — it is what distinguishes a real
    // 0 C month from a month with no data at all.
    expect(back![0]!.dayCount).toBe(0);
    expect(back![11]!.dayCount).toBe(110);
    // expectedDays is the denominator of the coverage test. Losing it in the
    // round trip makes every cached month read as 0% covered, which silently
    // empties the ranking for every city already in the cache.
    expect(back![0]!.expectedDays).toBe(280);
    expect(back![11]!.expectedDays).toBe(291);
  });

  test("writeMonths replaces prior data rather than duplicating it", async () => {
    const db = await freshDb("replace");
    const id = await upsertDestination(db, TOKYO);
    const first = [{ month: 1, dewPointMean: 1, tempMaxMean: 1, rainDays: 1, dayCount: 1, expectedDays: 300 }];
    const second = [{ month: 1, dewPointMean: 9, tempMaxMean: 9, rainDays: 9, dayCount: 9, expectedDays: 300 }];
    await writeMonths(db, id, first, "2026-07-26");
    await writeMonths(db, id, second, "2026-07-27");
    const back = await readMonths(db, id);
    expect(back).toHaveLength(1);
    expect(back![0]!.dewPointMean).toBe(9);
  });
});

describe("coordinate changes", () => {
  test("moving a destination's coordinates invalidates its cached climate", async () => {
    const db = await freshDb("moved");
    const counter = { n: 0 };
    const opts = { todayIso: "2026-07-26", fetchFn: fakeArchive(counter) };

    await getClimate(db, TOKYO, opts);
    expect(counter.n).toBe(1);

    // Same name and country code, different place. Serving the first Tokyo's
    // climate under these coordinates would be silently wrong.
    const elsewhere = { ...TOKYO, latitude: -6.2, longitude: 106.8 };
    await getClimate(db, elsewhere, opts);
    expect(counter.n).toBe(2);
  });

  test("an identical re-geocode does NOT invalidate the cache", async () => {
    const db = await freshDb("notmoved");
    const counter = { n: 0 };
    const opts = { todayIso: "2026-07-26", fetchFn: fakeArchive(counter) };

    await getClimate(db, TOKYO, opts);
    // A jitter far below the ~1.1km threshold must not trigger a refetch,
    // otherwise the cache would be useless against normal geocoder variation.
    await getClimate(db, { ...TOKYO, latitude: 35.681, longitude: 139.691 }, opts);
    expect(counter.n).toBe(1);
  });
});

describe("getClimate", () => {
  test("fetches on a miss and serves from cache on the second call", async () => {
    const db = await freshDb("miss-hit");
    const counter = { n: 0 };
    const opts = { todayIso: "2026-07-26", fetchFn: fakeArchive(counter) };

    const first = await getClimate(db, TOKYO, opts);
    expect(counter.n).toBe(1);
    expect(first).toHaveLength(12);

    const second = await getClimate(db, TOKYO, opts);
    expect(counter.n).toBe(1); // no second network call
    expect(second).toHaveLength(12);
  });

  test("force refetches even when cached", async () => {
    const db = await freshDb("force");
    const counter = { n: 0 };
    const fetchFn = fakeArchive(counter);
    await getClimate(db, TOKYO, { todayIso: "2026-07-26", fetchFn });
    await getClimate(db, TOKYO, { todayIso: "2026-07-26", fetchFn, force: true });
    expect(counter.n).toBe(2);
  });

  test("a zero-coverage fetch throws and is NOT cached, so a retry recovers", async () => {
    // Regression: an empty response was written as 12 zero-coverage rows, and
    // since readMonths only nulls on ZERO rows, every later run was a cache hit
    // — the city reported "no climate data" forever, even after the API healed.
    const db = await freshDb("nopoison");
    let broken = true;
    let calls = 0;
    const fetchFn = (async () => {
      calls++;
      if (broken) return new Response("{}", { status: 200 });
      return new Response(JSON.stringify({
        daily: {
          time: ["2024-07-01", "2024-07-02"],
          dew_point_2m_mean: [24, 23],
          temperature_2m_max: [28.2, 31.4],
          precipitation_sum: [6.7, 4.9],
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const opts = { todayIso: "2026-07-26", fetchFn };

    await expect(getClimate(db, TOKYO, opts)).rejects.toThrow(/no usable climate data/i);
    expect(calls).toBe(1);

    // Nothing was written, so the next call must hit the network again.
    broken = false;
    const recovered = await getClimate(db, TOKYO, opts);
    expect(calls).toBe(2);
    expect(recovered.some((m) => m.dayCount > 0)).toBe(true);
  });
});

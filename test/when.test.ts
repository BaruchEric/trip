import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runWhenCommand } from "@/commands/when";
import type { GeoCandidate } from "@/geocode";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKYO: GeoCandidate = {
  name: "Tokyo", country: "Japan", countryCode: "JP",
  latitude: 35.68, longitude: 139.69, timezone: "Asia/Tokyo", population: 8336599,
};

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-when-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  return db;
}

/** Two years of synthetic data: humid summer, mild winter. */
function syntheticArchive(): typeof fetch {
  const time: string[] = [];
  const dew: number[] = [];
  const temp: number[] = [];
  const precip: number[] = [];
  for (const year of [2023, 2024]) {
    for (let m = 1; m <= 12; m++) {
      const summer = m >= 6 && m <= 9;
      for (let d = 1; d <= 28; d++) {
        time.push(`${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
        dew.push(summer ? 23 : 8);
        temp.push(summer ? 32 : 16);
        precip.push(summer && d % 3 === 0 ? 5 : 0);
      }
    }
  }
  return (async () =>
    new Response(JSON.stringify({
      daily: {
        time,
        dew_point_2m_mean: dew,
        temperature_2m_max: temp,
        precipitation_sum: precip,
      },
    }), { status: 200 })) as unknown as typeof fetch;
}

const deps = (candidates: GeoCandidate[] = [TOKYO]) => ({
  geocode: async () => candidates,
  fetchFn: syntheticArchive(),
  todayIso: "2026-07-26",
});

describe("runWhenCommand", () => {
  test("ranks a humid-summer city away from summer months", async () => {
    const db = await freshDb("rank");
    const out = await runWhenCommand(db, ["Tokyo"], false, deps());
    expect(out).toContain("Tokyo");
    expect(out.toLowerCase()).toContain("avoid");
    expect(out).toMatch(/Jul|Aug/);
  });

  test("json output carries all twelve scored months", async () => {
    const db = await freshDb("json");
    const out = await runWhenCommand(db, ["Tokyo"], true, deps());
    const parsed = JSON.parse(out);
    expect(parsed.city).toBe("Tokyo");
    expect(parsed.months).toHaveLength(12);
    expect(parsed.months[0]).toHaveProperty("score");
    expect(parsed.months[0]).toHaveProperty("band");
  });

  test("reports ambiguity when several cities share a name", async () => {
    const db = await freshDb("ambig");
    const ohio: GeoCandidate = { ...TOKYO, name: "Lisbon", country: "United States",
      countryCode: "US", population: 2727 };
    const portugal: GeoCandidate = { ...TOKYO, name: "Lisbon", country: "Portugal",
      countryCode: "PT", population: 517802 };
    const out = await runWhenCommand(db, ["Lisbon"], false, deps([portugal, ohio]));
    expect(out).toContain("Portugal");
    expect(out.toLowerCase()).toContain("also matched");
  });

  test("unknown city produces a clear error", async () => {
    const db = await freshDb("unknown");
    await expect(
      runWhenCommand(db, ["Xyzzy"], false, deps([])),
    ).rejects.toThrow(/no city found/i);
  });

  test("missing city argument produces usage text", async () => {
    const db = await freshDb("usage");
    await expect(runWhenCommand(db, [], false, deps())).rejects.toThrow(/usage/i);
  });

  test("joins multi-word city names instead of using only the first word", async () => {
    // Regression: taking only the first positional made `trip when New York`
    // geocode "New" and answer about Patna, India with exit code 0.
    const db = await freshDb("multiword");
    let asked = "";
    const d = {
      geocode: async (name: string) => { asked = name; return [TOKYO]; },
      fetchFn: syntheticArchive(),
      todayIso: "2026-07-26",
    };
    await runWhenCommand(db, ["New", "York"], false, d);
    expect(asked).toBe("New York");

    // ...and flags must still be stripped, in any position.
    await runWhenCommand(db, ["San", "Francisco", "--refresh"], false, d);
    expect(asked).toBe("San Francisco");
  });

  test("--refresh bypasses the cache and refetches", async () => {
    const db = await freshDb("refresh");
    let calls = 0;
    const counting = (async () => {
      calls++;
      return new Response(JSON.stringify({
        daily: {
          time: ["2024-07-01"], dew_point_2m_mean: [23],
          temperature_2m_max: [32], precipitation_sum: [0],
        },
      }), { status: 200 });
    }) as unknown as typeof fetch;
    const d = { geocode: async () => [TOKYO], fetchFn: counting, todayIso: "2026-07-26" };

    await runWhenCommand(db, ["Tokyo"], false, d);
    expect(calls).toBe(1);
    await runWhenCommand(db, ["Tokyo"], false, d);       // cached
    expect(calls).toBe(1);
    await runWhenCommand(db, ["Tokyo", "--refresh"], false, d);
    expect(calls).toBe(2);
  });
});

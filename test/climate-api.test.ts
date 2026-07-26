import { expect, test, describe } from "bun:test";
import { fetchDailyClimate } from "@/climate/api";

const RESPONSE = {
  daily: {
    time: ["2024-07-01", "2024-07-02"],
    dew_point_2m_mean: [24, 23],
    temperature_2m_max: [28.2, 31.4],
    precipitation_sum: [6.7, 4.9],
  },
};

describe("fetchDailyClimate", () => {
  test("requests the three daily variables from the archive endpoint", async () => {
    let url = "";
    const fake = (async (u: string | URL) => {
      url = String(u);
      return new Response(JSON.stringify(RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await fetchDailyClimate(35.68, 139.69, "2024-07-01", "2024-07-02", fake);

    expect(url).toContain("archive-api.open-meteo.com/v1/archive");
    expect(url).toContain("dew_point_2m_mean");
    expect(url).toContain("temperature_2m_max");
    expect(url).toContain("precipitation_sum");
    expect(url).toContain("latitude=35.68");
    expect(url).toContain("longitude=139.69");
    expect(url).toContain("start_date=2024-07-01");
    expect(url).toContain("end_date=2024-07-02");
    expect(out.dewPoint).toEqual([24, 23]);
    expect(out.tempMax).toEqual([28.2, 31.4]);
    expect(out.precip).toEqual([6.7, 4.9]);
    expect(out.time).toHaveLength(2);
  });

  test("null readings survive as null rather than becoming zero", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({
        daily: {
          time: ["2024-07-01", "2024-07-02"],
          dew_point_2m_mean: [24, null],
          temperature_2m_max: [null, 31.4],
          precipitation_sum: [6.7, null],
        },
      }), { status: 200 })) as unknown as typeof fetch;

    const out = await fetchDailyClimate(0, 0, "a", "b", fake);
    // Coercing these to 0 here would reintroduce the null-as-zero bug one
    // layer above the guards in aggregate.ts that exist to prevent it.
    expect(out.dewPoint).toEqual([24, null]);
    expect(out.tempMax).toEqual([null, 31.4]);
    expect(out.precip).toEqual([6.7, null]);
  });

  test("throws with the API reason when the archive rejects the request", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ error: true, reason: "bad date" }), { status: 400 })
    ) as unknown as typeof fetch;
    await expect(
      fetchDailyClimate(0, 0, "x", "y", fake),
    ).rejects.toThrow(/bad date/);
  });

  test("throws on a 200 response whose body carries an error reason", async () => {
    const fake = (async () =>
      new Response(
        JSON.stringify({ error: true, reason: "invalid coordinates" }),
        { status: 200 },
      )) as unknown as typeof fetch;
    await expect(
      fetchDailyClimate(999, 999, "2024-01-01", "2024-01-02", fake),
    ).rejects.toThrow(/invalid coordinates/);
  });

  test("missing daily block yields empty arrays, not a crash", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const out = await fetchDailyClimate(0, 0, "a", "b", fake);
    expect(out.time).toEqual([]);
    expect(out.dewPoint).toEqual([]);
  });
});

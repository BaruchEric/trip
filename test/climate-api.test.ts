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
    expect(url).toContain("start_date=2024-07-01");
    expect(out.dewPoint).toEqual([24, 23]);
    expect(out.tempMax).toEqual([28.2, 31.4]);
    expect(out.time).toHaveLength(2);
  });

  test("throws with the API reason when the archive rejects the request", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({ error: true, reason: "bad date" }), { status: 400 })
    ) as unknown as typeof fetch;
    await expect(
      fetchDailyClimate(0, 0, "x", "y", fake),
    ).rejects.toThrow(/bad date/);
  });

  test("missing daily block yields empty arrays, not a crash", async () => {
    const fake = (async () =>
      new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;
    const out = await fetchDailyClimate(0, 0, "a", "b", fake);
    expect(out.time).toEqual([]);
    expect(out.dewPoint).toEqual([]);
  });
});

import { expect, test, describe } from "bun:test";
import { fetchDailyClimate } from "@/climate/api";
import { hangingFetch, within } from "./helpers";

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

  test("pins metric units rather than trusting the API default", async () => {
    // The entire comfort model is calibrated in Celsius: the muggy band starts
    // at 20 and oppressive at 24. If Open-Meteo's default ever moved to
    // Fahrenheit, every dew point would clear 24 and every city on earth would
    // report "no comfortable month" — wrong, confident, and with no error.
    let url = "";
    const fake = (async (u: string | URL) => {
      url = String(u);
      return new Response(JSON.stringify(RESPONSE), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchDailyClimate(35.68, 139.69, "2024-07-01", "2024-07-02", fake);
    expect(url).toContain("temperature_unit=celsius");
    expect(url).toContain("precipitation_unit=mm");
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

  test("throws when days are returned but a variable array is absent", async () => {
    // dayCount only covers the dew-point axis. A response with days but no
    // precipitation would zero rainDays for all 12 months, removing the rain
    // penalty differentially and silently reordering the ranking.
    for (const drop of ["dew_point_2m_mean", "temperature_2m_max", "precipitation_sum"]) {
      const daily: Record<string, unknown> = {
        time: ["2024-07-01", "2024-07-02"],
        dew_point_2m_mean: [24, 23],
        temperature_2m_max: [28.2, 31.4],
        precipitation_sum: [6.7, 4.9],
      };
      delete daily[drop];
      const fake = (async () =>
        new Response(JSON.stringify({ daily }), { status: 200 })) as unknown as typeof fetch;
      // The message must name the offending variable so the failure is debuggable.
      await expect(
        fetchDailyClimate(0, 0, "a", "b", fake),
      ).rejects.toThrow(new RegExp(drop));
    }
  });

  test("throws when a variable array is present but entirely null", async () => {
    // Regression: the guard checked only `.length`, so an all-null array passed.
    // An all-null temperature array left tempMaxMean at 0, rendering a muggy
    // 29C August as "cold, highs 0C" while dayCount stayed healthy.
    const fake = (async () =>
      new Response(JSON.stringify({
        daily: {
          time: ["2024-07-01", "2024-07-02"],
          dew_point_2m_mean: [24, 23],
          temperature_2m_max: [null, null],
          precipitation_sum: [6.7, 4.9],
        },
      }), { status: 200 })) as unknown as typeof fetch;
    await expect(
      fetchDailyClimate(0, 0, "a", "b", fake),
    ).rejects.toThrow(/temperature_2m_max/);
  });

  test("gives up rather than hanging when the archive never answers", async () => {
    // The archive pull is the long one (10 years of daily rows), so it is the
    // request most likely to stall — and a stall here means `trip when` prints
    // nothing and never exits.
    await expect(
      within(
        1000,
        fetchDailyClimate(35.68, 139.69, "2014-01-01", "2024-01-01", hangingFetch(), 30),
      ),
    ).rejects.toThrow(/timed out/i);
  });

  test("a proxy error page keeps its status instead of becoming a SyntaxError", async () => {
    const html = (async () =>
      new Response("<html>502 Bad Gateway</html>", { status: 502 })
    ) as unknown as typeof fetch;
    const err = await fetchDailyClimate(0, 0, "a", "b", html).catch((e: Error) => e);
    expect((err as Error).message).toContain("502");
    expect((err as Error).message).not.toMatch(/Unexpected token/i);
  });

  test("all-zero precipitation is legitimate data, not a missing axis", async () => {
    // A desert reports 0mm, not null. Rejecting zeros would break dry cities.
    const fake = (async () =>
      new Response(JSON.stringify({
        daily: {
          time: ["2024-07-01", "2024-07-02"],
          dew_point_2m_mean: [24, 23],
          temperature_2m_max: [40, 41],
          precipitation_sum: [0, 0],
        },
      }), { status: 200 })) as unknown as typeof fetch;
    const out = await fetchDailyClimate(0, 0, "a", "b", fake);
    expect(out.precip).toEqual([0, 0]);
  });
});

import { expect, test, describe } from "bun:test";
import { parseGeocodeResponse, geocodeCity } from "@/geocode";

const LISBON_FIXTURE = {
  results: [
    { name: "Lisbon", country: "United States", country_code: "US",
      latitude: 40.772, longitude: -80.76813, timezone: "America/New_York", population: 2727 },
    { name: "Lisbon", country: "Portugal", country_code: "PT",
      latitude: 38.72509, longitude: -9.1498, timezone: "Europe/Lisbon", population: 517802 },
  ],
};

describe("parseGeocodeResponse", () => {
  test("sorts by population descending so the real city wins", () => {
    const out = parseGeocodeResponse(LISBON_FIXTURE);
    expect(out).toHaveLength(2);
    expect(out[0]!.country).toBe("Portugal");
    expect(out[0]!.latitude).toBeCloseTo(38.725, 2);
  });

  test("returns empty array when the API reports no results", () => {
    expect(parseGeocodeResponse({})).toEqual([]);
    expect(parseGeocodeResponse({ results: [] })).toEqual([]);
  });

  test("tolerates missing optional fields", () => {
    const out = parseGeocodeResponse({
      results: [{ name: "Nowhere", latitude: 1, longitude: 2 }],
    });
    expect(out[0]!.population).toBeNull();
    expect(out[0]!.country).toBeNull();
  });
});

describe("geocodeCity", () => {
  test("calls the archive geocoding endpoint and parses the result", async () => {
    let calledUrl = "";
    const fakeFetch = (async (url: string | URL) => {
      calledUrl = String(url);
      return new Response(JSON.stringify(LISBON_FIXTURE), { status: 200 });
    }) as unknown as typeof fetch;

    const out = await geocodeCity("Lisbon", fakeFetch);
    expect(calledUrl).toContain("geocoding-api.open-meteo.com");
    expect(calledUrl).toContain("name=Lisbon");
    expect(out[0]!.country).toBe("Portugal");
  });

  test("throws a helpful error on a non-200", async () => {
    const failing = (async () =>
      new Response("nope", { status: 500 })) as unknown as typeof fetch;
    await expect(geocodeCity("Lisbon", failing)).rejects.toThrow(/geocoding failed/i);
  });
});

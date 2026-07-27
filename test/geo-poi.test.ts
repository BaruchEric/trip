import { expect, test, describe } from "bun:test";
import { viewbox, parsePoiResponse, geocodePoi, SEARCH_RADIUS_KM } from "@/geo/poi";

const CHONGQING = { latitude: 29.5630, longitude: 106.5516 };

/** Captured from the real Nominatim API on 2026-07-27, bounded to Chongqing. */
const HONGYA = [{
  place_id: 1, osm_type: "way", osm_id: 4242,
  lat: "29.5650", lon: "106.5751",
  category: "building", type: "yes",
  importance: 0.3408,
  name: "洪崖洞",
  display_name: "洪崖洞, 千厮门大桥, 江北, 朝天门街道, 渝中区, 重庆市, 400010, 中国",
}];

const HOTPOT = [
  {
    place_id: 2, osm_type: "node", osm_id: 1,
    lat: "29.5630", lon: "106.5670",
    category: "amenity", type: "restaurant", importance: 0.0001,
    name: "夜福火锅", display_name: "夜福火锅, 北区路, 解放碑, 渝中区, 重庆市, 中国",
  },
  {
    place_id: 3, osm_type: "node", osm_id: 2,
    lat: "29.5879", lon: "106.5480",
    category: "amenity", type: "restaurant", importance: 0.75,
    name: "地下之城老火锅", display_name: "地下之城老火锅, 五红路, 两江新区, 重庆市, 中国",
  },
];

describe("viewbox", () => {
  test("is left,top,right,bottom in Nominatim's order", () => {
    const [left, top, right, bottom] = viewbox(CHONGQING, 25).split(",").map(Number);
    expect(left!).toBeLessThan(right!);
    expect(bottom!).toBeLessThan(top!);
  });

  test("longitude half-width widens as latitude rises", () => {
    // A flat degree offset would cover only 21.7 km instead of 25 at
    // Chongqing's 29.6N, and 12.5 km by 59.9N. Longitude degrees shrink with
    // cos(lat).
    const wide = (c: { latitude: number; longitude: number }) => {
      const p = viewbox(c, 25).split(",").map(Number);
      return p[2]! - p[0]!;
    };
    const equator = wide({ latitude: 0, longitude: 0 });
    const chongqing = wide(CHONGQING);
    const oslo = wide({ latitude: 59.9, longitude: 10.7 });
    expect(chongqing).toBeGreaterThan(equator);
    expect(oslo).toBeGreaterThan(chongqing);
  });

  test("latitude half-width is independent of latitude", () => {
    const tall = (lat: number) => {
      const p = viewbox({ latitude: lat, longitude: 0 }, 25).split(",").map(Number);
      return p[1]! - p[3]!;
    };
    expect(tall(0)).toBeCloseTo(tall(59.9), 6);
  });
});

describe("parsePoiResponse", () => {
  test("maps a named landmark, keeping the local name separate from the address", () => {
    const [c] = parsePoiResponse(HONGYA, CHONGQING);
    expect(c!.localName).toBe("洪崖洞");
    expect(c!.displayName).toContain("渝中区");
    expect(c!.importance).toBeCloseTo(0.3408, 4);
    expect(c!.osmType).toBe("way");
    expect(c!.kmFromCentre).toBeGreaterThan(0);
    expect(c!.kmFromCentre).toBeLessThan(SEARCH_RADIUS_KM);
  });

  test("keeps every result, in the order Nominatim ranked them", () => {
    const cs = parsePoiResponse(HOTPOT, CHONGQING);
    expect(cs.length).toBe(2);
    expect(cs[0]!.localName).toBe("夜福火锅");
  });

  test("an unusable result is refused rather than silently dropped", () => {
    // Dropping it would be dishonest here in a way that matters beyond this
    // one result: classify() (src/watch/ingest.ts) is nothing but a count of
    // candidates, so silently dropping one result out of two would turn a
    // two-result response the confidence rule says must be QUEUED into a
    // false-confident single match. Throwing lets the caller queue the whole
    // mention with an honest reason instead.
    expect(() => parsePoiResponse(
      [{ ...HONGYA[0], lat: undefined, lon: undefined }], CHONGQING,
    )).toThrow("unusable geocode result");
  });

  test("a result missing both name fields is refused the same way", () => {
    expect(() => parsePoiResponse(
      [{ ...HONGYA[0], name: undefined, display_name: undefined }], CHONGQING,
    )).toThrow("unusable geocode result");
  });

  test("an unnamed feature has a null local name, not an empty string", () => {
    const cs = parsePoiResponse([{ ...HONGYA[0], name: "" }], CHONGQING);
    expect(cs[0]!.localName).toBeNull();
  });

  test("a non-array body yields no candidates", () => {
    expect(parsePoiResponse({ error: "Unable to geocode" }, CHONGQING)).toEqual([]);
  });
});

describe("geocodePoi", () => {
  test("sends a bounded, limited query with a User-Agent", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    const fetchFn = (async (u: string, init?: RequestInit) => {
      url = u;
      headers = (init?.headers ?? {}) as Record<string, string>;
      return new Response(JSON.stringify(HONGYA), { status: 200 });
    }) as unknown as typeof fetch;

    const cs = await geocodePoi("Hongya Cave", CHONGQING, { fetchFn });
    expect(url).toContain("bounded=1");
    expect(url).toContain("limit=5");
    expect(url).toContain("format=jsonv2");
    expect(url).toContain(encodeURIComponent("Hongya Cave"));
    // The repo is public; never a personal email.
    expect(headers["User-Agent"]).toContain("github.com/BaruchEric/trip");
    expect(headers["User-Agent"]).not.toContain("@gmail");
    expect(cs.length).toBe(1);
  });
});

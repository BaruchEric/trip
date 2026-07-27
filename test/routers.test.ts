import { test, expect, describe } from "bun:test";
import {
  parseOsrm, parseValhalla, osrmFootLeg, valhallaPedestrianLeg,
} from "@/geo/routers";

const A = { latitude: 29.5537638, longitude: 106.5368476 };
const B = { latitude: 29.5556826, longitude: 106.5338753 };

describe("parseOsrm", () => {
  test("reads seconds and metres from the first route", () => {
    const r = parseOsrm({ code: "Ok", routes: [{ duration: 1332.4, distance: 1670.2 }] });
    expect(r.minutes).toBeCloseTo(22.21, 2);
    expect(r.meters).toBeCloseTo(1670.2, 1);
  });

  test("a NoRoute reply is an error, never a zero", () => {
    // Absence is loud. A 0-minute leg between two places would tell the
    // planner they are the same place, which is worse than not knowing.
    expect(() => parseOsrm({ code: "NoRoute", message: "no route found" }))
      .toThrow(/NoRoute/);
  });

  test("an empty routes array is an error", () => {
    expect(() => parseOsrm({ code: "Ok", routes: [] })).toThrow(/no route/i);
  });

  test("a route missing duration is an error, not a zero", () => {
    expect(() => parseOsrm({ code: "Ok", routes: [{ distance: 100 }] })).toThrow(/no route/i);
  });
});

describe("parseValhalla", () => {
  test("reads the trip summary, converting km to metres", () => {
    const r = parseValhalla({ trip: { summary: { time: 1404, length: 1.783 }, status: 0 } });
    expect(r.minutes).toBeCloseTo(23.4, 1);
    expect(r.meters).toBeCloseTo(1783, 0);
  });

  test("an error envelope throws with the reported reason", () => {
    expect(() => parseValhalla({ error_code: 442, error: "No path could be found" }))
      .toThrow(/No path could be found/);
  });

  test("a missing summary is an error, not a zero", () => {
    expect(() => parseValhalla({ trip: {} })).toThrow(/summary/i);
  });
});

describe("request shape", () => {
  test("OSRM asks the routed-foot INSTANCE -- the /v1/ path segment is inert", async () => {
    // Recorded because it looks like a bug. The FOSSGIS deployment selects the
    // profile by URL PREFIX (routed-foot / routed-bike / routed-car) and
    // ignores the name in the /route/v1/<name>/ segment. The demo server at
    // router.project-osrm.org ignores it too and serves CAR for every value,
    // which is what made the first recon probe report 54 km/h walking and
    // nearly recorded "there is no free walking router".
    let seen = "";
    await osrmFootLeg(A, B, {
      fetchFn: (async (url: string) => {
        seen = String(url);
        return new Response(JSON.stringify({
          code: "Ok", routes: [{ duration: 60, distance: 100 }],
        }));
      }) as unknown as typeof fetch,
    });
    expect(seen).toContain("/routed-foot/");
    expect(seen).toContain("overview=false");
    // lon,lat order. Reversed, this returns a real route in the Indian Ocean
    // rather than an error, which is the worst kind of wrong.
    expect(seen).toContain("106.5368476,29.5537638");
  });

  test("Valhalla is a POST carrying costing=pedestrian", async () => {
    let body = "";
    let method = "";
    await valhallaPedestrianLeg(A, B, {
      fetchFn: (async (_url: string, init: RequestInit) => {
        body = String(init.body);
        method = String(init.method);
        return new Response(JSON.stringify({ trip: { summary: { time: 60, length: 0.1 } } }));
      }) as unknown as typeof fetch,
    });
    expect(method).toBe("POST");
    const j = JSON.parse(body);
    expect(j.costing).toBe("pedestrian");
    expect(j.units).toBe("km");
    expect(j.locations[0]).toEqual({ lat: 29.5537638, lon: 106.5368476 });
  });

  test("both routers surface a timeout as an error rather than a number", async () => {
    const dead = (async () => {
      const e = new Error("timed out");
      e.name = "TimeoutError";
      throw e;
    }) as unknown as typeof fetch;
    await expect(osrmFootLeg(A, B, { fetchFn: dead })).rejects.toThrow(/timed out/);
    await expect(valhallaPedestrianLeg(A, B, { fetchFn: dead })).rejects.toThrow(/timed out/);
  });
});

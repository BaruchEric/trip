import { expect, test, describe } from "bun:test";
import { haversineKm, travelMinutes } from "@/plan/geo";
import { PACE_CEILING, MEAL_WINDOWS, isPlannable } from "@/plan/types";
import type { Segment } from "@/segments";

const ROSSIO = { latitude: 38.7139, longitude: -9.1394 };
const BELEM = { latitude: 38.6916, longitude: -9.2160 };

describe("haversineKm", () => {
  test("matches a known real distance", () => {
    // Rossio to Belem is about 7 km along the Tagus.
    expect(haversineKm(ROSSIO, BELEM)).toBeCloseTo(7.0, 0);
  });

  test("is zero for a point against itself and symmetric otherwise", () => {
    expect(haversineKm(ROSSIO, ROSSIO)).toBe(0);
    expect(haversineKm(ROSSIO, BELEM)).toBeCloseTo(haversineKm(BELEM, ROSSIO), 9);
  });

  test("handles the antimeridian without wrapping the long way", () => {
    // 179E to 179W is 2 degrees apart, not 358.
    const a = { latitude: 0, longitude: 179 };
    const b = { latitude: 0, longitude: -179 };
    expect(haversineKm(a, b)).toBeLessThan(250);
  });
});

describe("travelMinutes", () => {
  test("walking is distance over speed with a detour factor", () => {
    // 7.0 km * 1.3 detour / 4.5 km/h * 60 = ~121 min
    expect(travelMinutes(ROSSIO, BELEM, "walking")).toBeCloseTo(121, -1);
  });

  test("transit beats walking over distance and loses over short hops", () => {
    // The 6-minute access penalty is what makes transit lose in the small.
    expect(travelMinutes(ROSSIO, BELEM, "transit"))
      .toBeLessThan(travelMinutes(ROSSIO, BELEM, "walking"));
    const near = { latitude: 38.7145, longitude: -9.1400 };
    expect(travelMinutes(ROSSIO, near, "transit"))
      .toBeGreaterThan(travelMinutes(ROSSIO, near, "walking"));
  });

  test("returns whole minutes so clock arithmetic never drifts", () => {
    const t = travelMinutes(ROSSIO, BELEM, "walking");
    expect(Number.isInteger(t)).toBe(true);
  });

  test("a zero-length hop still costs the transit access penalty", () => {
    expect(travelMinutes(ROSSIO, ROSSIO, "walking")).toBe(0);
    expect(travelMinutes(ROSSIO, ROSSIO, "transit")).toBe(6);
  });
});

describe("plan types", () => {
  test("pace ceilings are the spec's exact numbers", () => {
    expect(PACE_CEILING).toEqual({ easy: 3, normal: 5, packed: 7 });
  });

  test("meal windows are 12:30 and 19:30", () => {
    expect(MEAL_WINDOWS).toEqual([750, 1170]);
  });

  test("isPlannable rejects a segment with no coordinates", () => {
    const base: Segment = {
      id: 1, tripId: 1, name: "x", latitude: null, longitude: null,
      dwellMinutes: 30, cost: null, tags: [], opensMin: null,
      closesMin: null, closedDays: [], status: "confirmed",
    };
    expect(isPlannable(base)).toBe(false);
    expect(isPlannable({ ...base, latitude: 38.7, longitude: -9.1 })).toBe(true);
    // 0,0 is a real place. Only null means unknown.
    expect(isPlannable({ ...base, latitude: 0, longitude: 0 })).toBe(true);
  });
});

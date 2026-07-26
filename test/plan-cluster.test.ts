import { expect, test, describe } from "bun:test";
import { clusterSegments, centroidOf } from "@/plan/cluster";
import type { PlannableSegment } from "@/plan/types";

function seg(id: number, latitude: number, longitude: number): PlannableSegment {
  return {
    id, tripId: 1, name: `s${id}`, latitude, longitude,
    dwellMinutes: 60, cost: null, tags: [], opensMin: null,
    closesMin: null, closedDays: [], status: "confirmed",
  };
}

// Three tight geographic groups, far apart.
const ALFAMA = [seg(1, 38.712, -9.128), seg(2, 38.714, -9.130), seg(3, 38.710, -9.126)];
const BELEM = [seg(4, 38.6916, -9.216), seg(5, 38.6970, -9.2060)];
const SINTRA = [seg(6, 38.7975, -9.3905), seg(7, 38.7870, -9.3900)];

describe("clusterSegments", () => {
  test("separates obvious geographic groups", () => {
    const { clusters, overflow } = clusterSegments([...ALFAMA, ...BELEM, ...SINTRA], 3, 5);
    expect(overflow).toHaveLength(0);
    const ids = clusters.map((c) => c.map((s) => s.id).sort((a, b) => a - b));
    expect(ids).toContainEqual([1, 2, 3]);
    expect(ids).toContainEqual([4, 5]);
    expect(ids).toContainEqual([6, 7]);
  });

  test("is deterministic across input order", () => {
    // No RNG anywhere: shuffling the input must not change the grouping.
    const forward = clusterSegments([...ALFAMA, ...BELEM, ...SINTRA], 3, 5);
    const shuffled = clusterSegments([...SINTRA, ...ALFAMA.slice().reverse(), ...BELEM], 3, 5);
    const norm = (r: { clusters: PlannableSegment[][] }) =>
      r.clusters
        .map((c) => c.map((s) => s.id).sort((a, b) => a - b))
        .sort((a, b) => (a[0] ?? 0) - (b[0] ?? 0));
    expect(norm(shuffled)).toEqual(norm(forward));
  });

  test("repeated runs on identical input give identical output", () => {
    const a = clusterSegments([...ALFAMA, ...BELEM], 2, 5);
    const b = clusterSegments([...ALFAMA, ...BELEM], 2, 5);
    expect(b).toEqual(a);
  });

  test("respects capacity by rebalancing into a neighbour", () => {
    // k=2, capacity=2 is a pigeonhole impossibility here: 2 clusters x
    // capacity 2 = 4 slots for 5 segments, so "0 overflow" and "every
    // cluster <= 2" can never both hold no matter the algorithm. k=3
    // keeps a genuine over-capacity donor (the natural 3-point Alfama
    // cluster) alongside an under-capacity neighbour (a 1-point singleton)
    // so the segment can actually move rather than being forced out.
    const { clusters, overflow } = clusterSegments([...ALFAMA, ...BELEM], 3, 2);
    expect(overflow).toHaveLength(0);
    for (const c of clusters) expect(c.length).toBeLessThanOrEqual(2);
    expect(clusters.flat()).toHaveLength(5);
  });

  test("segments beyond total capacity become overflow, never silently lost", () => {
    // 7 segments, 2 days, 3 per day = 6 places. Exactly one must overflow,
    // and it must still be accounted for.
    const all = [...ALFAMA, ...BELEM, ...SINTRA];
    const { clusters, overflow } = clusterSegments(all, 2, 3);
    expect(clusters.flat().length + overflow.length).toBe(all.length);
    expect(overflow).toHaveLength(1);
    for (const c of clusters) expect(c.length).toBeLessThanOrEqual(3);
  });

  test("k larger than the segment count leaves empty clusters", () => {
    const { clusters, overflow } = clusterSegments(ALFAMA, 5, 3);
    expect(clusters).toHaveLength(5);
    expect(clusters.flat()).toHaveLength(3);
    expect(overflow).toHaveLength(0);
  });

  test("empty input and k of zero are handled", () => {
    expect(clusterSegments([], 3, 5).clusters).toHaveLength(3);
    expect(clusterSegments(ALFAMA, 0, 5)).toEqual({ clusters: [], overflow: ALFAMA });
  });

  test("identical coordinates do not crash the seeding", () => {
    const same = [seg(1, 38.7, -9.1), seg(2, 38.7, -9.1), seg(3, 38.7, -9.1)];
    const { clusters, overflow } = clusterSegments(same, 2, 2);
    expect(clusters.flat().length + overflow.length).toBe(3);
  });
});

describe("centroidOf", () => {
  test("averages the coordinates", () => {
    const c = centroidOf([seg(1, 0, 0), seg(2, 2, 4)]);
    expect(c.latitude).toBeCloseTo(1);
    expect(c.longitude).toBeCloseTo(2);
  });
});

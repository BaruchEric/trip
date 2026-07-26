import { haversineKm } from "@/plan/geo";
import type { PlannableSegment, Point } from "@/plan/types";

/** Geographic clustering with a hard per-cluster capacity.
 *
 *  Farthest-point seeding rather than k-means++: k-means++ needs a random
 *  number generator, and a plan that changes between two identical runs is
 *  not reviewable. Every tie here breaks on segment id, so the result is a
 *  pure function of the input SET, not of its order. */

export function centroidOf(segments: PlannableSegment[]): Point {
  if (segments.length === 0) return { latitude: 0, longitude: 0 };
  let lat = 0;
  let lon = 0;
  for (const s of segments) {
    lat += s.latitude;
    lon += s.longitude;
  }
  return { latitude: lat / segments.length, longitude: lon / segments.length };
}

export function clusterSegments(
  segments: PlannableSegment[],
  k: number,
  capacity: number,
): { clusters: PlannableSegment[][]; overflow: PlannableSegment[] } {
  if (k <= 0) return { clusters: [], overflow: [...segments] };

  // Sorting by id up front is what makes the output independent of input
  // order — every downstream tie-break inherits this ordering.
  const pool = [...segments].sort((a, b) => a.id - b.id);
  const clusters: PlannableSegment[][] = Array.from({ length: k }, () => []);
  if (pool.length === 0) return { clusters, overflow: [] };

  const seeds = pickSeeds(pool, k);

  for (const s of pool) {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < seeds.length; i++) {
      const d = haversineKm(s, seeds[i]!);
      if (d < bestDist) {
        bestDist = d;
        best = i;
      }
    }
    clusters[best]!.push(s);
  }

  const overflow = rebalance(clusters, seeds, capacity);
  return { clusters, overflow };
}

/** Farthest-point (k-center) seeding. Seed 1 is the segment farthest from the
 *  overall centroid; each next seed is the segment farthest from its nearest
 *  existing seed. Ties break on id. */
function pickSeeds(pool: PlannableSegment[], k: number): PlannableSegment[] {
  const centre = centroidOf(pool);
  const seeds: PlannableSegment[] = [];

  let first = pool[0]!;
  let firstDist = -1;
  for (const s of pool) {
    const d = haversineKm(s, centre);
    if (d > firstDist) {
      firstDist = d;
      first = s;
    }
  }
  seeds.push(first);

  while (seeds.length < k && seeds.length < pool.length) {
    let next = pool[0]!;
    let bestDist = -1;
    for (const s of pool) {
      if (seeds.includes(s)) continue;
      let nearest = Infinity;
      for (const seed of seeds) nearest = Math.min(nearest, haversineKm(s, seed));
      if (nearest > bestDist) {
        bestDist = nearest;
        next = s;
      }
    }
    if (seeds.includes(next)) break;
    seeds.push(next);
  }

  // Fewer segments than days: reuse the last seed so every cluster index is
  // valid. Empty clusters are legitimate — a day with nothing in it.
  while (seeds.length < k) seeds.push(seeds[seeds.length - 1]!);
  return seeds;
}

/** Move the worst-fitting members of over-capacity clusters into the nearest
 *  cluster with room. Anything that still does not fit becomes overflow — the
 *  caller reports it as unplaced. Nothing is dropped.
 *
 *  `seeds` is needed here, not just `clusters`: an empty cluster has no
 *  members to average, so centroidOf([]) would read as {0,0} — Null Island,
 *  thousands of km from anywhere real — and could out-compete a genuinely
 *  nearby non-empty cluster for the eviction target. An empty cluster is
 *  scored by the seed it was built around instead, which is always a real
 *  coordinate. */
function rebalance(
  clusters: PlannableSegment[][],
  seeds: PlannableSegment[],
  capacity: number,
): PlannableSegment[] {
  const overflow: PlannableSegment[] = [];

  for (;;) {
    const fromIdx = clusters.findIndex((c) => c.length > capacity);
    if (fromIdx === -1) break;

    const from = clusters[fromIdx]!;
    const centre = centroidOf(from);
    // Evict the member least representative of its cluster; id breaks ties.
    let victim = from[0]!;
    let worst = -1;
    for (const s of from) {
      const d = haversineKm(s, centre);
      if (d > worst) {
        worst = d;
        victim = s;
      }
    }
    from.splice(from.indexOf(victim), 1);

    let target = -1;
    let bestDist = Infinity;
    for (let i = 0; i < clusters.length; i++) {
      if (i === fromIdx || clusters[i]!.length >= capacity) continue;
      const targetCentre = clusters[i]!.length === 0 ? seeds[i]! : centroidOf(clusters[i]!);
      const d = haversineKm(victim, targetCentre);
      if (d < bestDist) {
        bestDist = d;
        target = i;
      }
    }

    if (target === -1) overflow.push(victim);
    else clusters[target]!.push(victim);
  }

  for (const c of clusters) c.sort((a, b) => a.id - b.id);
  overflow.sort((a, b) => a.id - b.id);
  return overflow;
}

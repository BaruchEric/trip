import type { Client } from "@libsql/client";
import { listLegs } from "@/legs";
import { withLegsAndTransit, type TravelModel } from "@/plan/travel";
import { buildGraph, type TransitGraph } from "@/transit/graph";
import { loadNetwork } from "@/transit/store";

/** The travel model, assembled from everything on disk. ONE place.
 *
 *  There were three call sites building this independently — `trip plan`,
 *  `trip day` and the export view — and M8 already shipped a defect of exactly
 *  that shape: `trip day` rendered no hop lines while `trip plan` did, for the
 *  same database, and it took until M10 to notice. A model assembled three
 *  ways is that defect waiting to happen, so it is assembled here or nowhere.
 *
 *  Still offline. `trip transit` and `trip route` do the fetching; this only
 *  READS what they wrote, so `compile()` keeps the promise it has carried
 *  since M2 — no DB, no network, no clock, no RNG — by receiving the model as
 *  data rather than looking anything up mid-compile. */
export async function loadTravelModel(
  db: Client,
  destinationId: number | null,
): Promise<TravelModel> {
  return withLegsAndTransit(await listLegs(db), await loadGraph(db, destinationId));
}

/** null means NO NETWORK IS STORED for this city — nobody has run
 *  `trip transit`. That is a different fact from a stored network in which
 *  some pair happens to be unreachable, and the two must stay
 *  distinguishable all the way to the renderer: one prints "estimated" off
 *  the old constant, the other can say the railway does not help here. */
export async function loadGraph(
  db: Client,
  destinationId: number | null,
): Promise<TransitGraph | null> {
  // A trip with no destination cannot have a network: the tables are keyed by
  // destination, and there is no "the city" to fall back on.
  if (destinationId === null) return null;
  const { stations, edges } = await loadNetwork(db, destinationId);
  // Zero stations is not an empty graph to route over, it is an ABSENT one.
  // Returning a graph here would make every pair "no station within reach",
  // which reads as a measured fact about the city rather than as nobody
  // having fetched it.
  if (stations.length === 0) return null;
  return buildGraph(stations, edges);
}

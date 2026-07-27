import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { listSegments } from "@/segments";
import { isPlannable } from "@/plan/types";
import { fetchNetwork, RAIL_MODES, type TransitFetchDeps } from "@/transit/fetch";
import { saveNetwork, loadNetwork } from "@/transit/store";
import { buildGraph, MAX_ACCESS_KM } from "@/transit/graph";

/** Fetch this city's rail network and store it.
 *
 *  Networked, like `trip route` and for the same reason: `trip plan` reads
 *  what this wrote and stays a pure, offline, synchronous compile. */

export type TransitDeps = TransitFetchDeps;

/** How far around the trip's own segments to ask for.
 *
 *  Derived from the segments rather than from the destination point, because
 *  the destination is a city centroid and a trip can reach well past it. The
 *  margin covers the far end of a line whose near end serves a segment — a box
 *  drawn tight around the segments would return stations with no lines
 *  attached and produce a graph with no edges. */
const MARGIN_DEG = 0.35;

export async function runTransitCommand(
  db: Client,
  argv: string[],
  json: boolean,
  deps: TransitDeps = {},
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");
  if (trip.destinationId === null) {
    throw new Error(
      "this trip has no destination, and the rail network is stored per city. " +
      "Set one with `trip when <city>`.",
    );
  }

  const refresh = argv.includes("--refresh");
  const all = await listSegments(db, trip.id);
  const placed = all.filter(isPlannable);
  if (placed.length === 0) {
    throw new Error(
      "no segments with coordinates, so there is nothing to draw a box around. " +
      "Add one with `trip seg add <name> --at=lat,lon`.",
    );
  }

  const stored = await loadNetwork(db, trip.destinationId);
  if (stored.stations.length > 0 && !refresh) {
    const lines = [
      `${stored.stations.length} stations and ${stored.edges.length} links already ` +
      `stored for this city. Nothing fetched.`,
      reachLine(stored, placed),
      "Re-fetch with: trip transit --refresh",
    ];
    if (json) {
      return JSON.stringify({
        fetched: false,
        // THE SAME KEYS AS THE FETCHED PATH, with null where this path cannot
        // know. Returning a narrower object would make the shape depend on
        // whether a fetch happened, and a MISSING `modes` reads as "no modes"
        // rather than "not re-derived" -- the same conflation as the
        // measured-versus-basis one M12 just fixed in the export layer.
        //
        // They are null rather than recomputed because they are genuinely not
        // recoverable: `transit_edges` stores a line ref, not the OSM route
        // mode it came from, and no bbox was drawn because nothing was
        // fetched.
        bbox: null,
        relations: null,
        modes: null,
        stations: stored.stations.length,
        edges: stored.edges.length,
        ...reachJson(stored, placed),
      });
    }
    return lines.join("\n");
  }

  const lats = placed.map((s) => s.latitude);
  const lons = placed.map((s) => s.longitude);
  const bbox: [number, number, number, number] = [
    Math.min(...lats) - MARGIN_DEG, Math.min(...lons) - MARGIN_DEG,
    Math.max(...lats) + MARGIN_DEG, Math.max(...lons) + MARGIN_DEG,
  ];

  const net = await fetchNetwork(bbox, deps);
  await saveNetwork(db, trip.destinationId, net.stations, net.edges);

  if (json) {
    return JSON.stringify({
      fetched: true,
      bbox,
      relations: net.relationCount,
      modes: net.modes,
      stations: net.stations.length,
      edges: net.edges.length,
      ...reachJson(net, placed),
    });
  }

  const lines = [
    `${net.relationCount} route relations, ${net.stations.length} stations, ` +
    `${net.edges.length} links.`,
    // The modes ACTUALLY FOUND, not the ones asked for. A city with no
    // monorail should not read as though one was ignored, and a city whose
    // monorail is missing from the answer is the M12 recon's finding 0.
    net.modes.length > 0
      ? `modes found: ${net.modes.sort().join(", ")}  (asked for ${RAIL_MODES.join(", ")})`
      : `no rail routes of any kind in this box (asked for ${RAIL_MODES.join(", ")})`,
    reachLine(net, placed),
  ];
  if (net.stations.length === 0) {
    lines.push(
      "Nothing was stored, so `trip plan --mode=transit` still uses the",
      "straight-line constant - which M12 measured wrong in four cities.",
    );
  }
  return lines.join("\n");
}

interface Net { stations: { name: string; latitude: number; longitude: number }[];
                edges: { fromName: string; toName: string; line: string; km: number }[] }

/** How many of the trip's own segments a station can actually be reached from.
 *
 *  The number that decides whether any of this changes a single hop. A network
 *  of 300 stations none of which is near anything you plan to visit is a
 *  network that will never be consulted, and reporting only the station count
 *  would hide that completely. */
function reach(net: Net, placed: { latitude: number; longitude: number }[]): number {
  if (net.stations.length === 0) return 0;
  const g = buildGraph(net.stations, net.edges);
  // A SELF-ROUTE is how proximity is asked here: `route` returns null when
  // either endpoint has no station inside MAX_ACCESS_KM, and returns a
  // zero-stop route when both ends land on the same one. So a point routed to
  // itself is non-null exactly when a station is in reach.
  //
  // It reads as a routing query and is a proximity query, and it DEPENDS on
  // the same-station branch returning non-null. If that branch ever starts
  // rejecting identical endpoints, this silently reports zero segments in
  // range -- which would read as "this city's network is useless to you".
  return placed.filter((s) =>
    g.route({ latitude: s.latitude, longitude: s.longitude },
            { latitude: s.latitude, longitude: s.longitude }) !== null).length;
}

function reachLine(net: Net, placed: { latitude: number; longitude: number }[]): string {
  const n = reach(net, placed);
  return `${n} of ${placed.length} placed segments have a station within ` +
         `${MAX_ACCESS_KM} km.`;
}

function reachJson(net: Net, placed: { latitude: number; longitude: number }[]) {
  return { segmentsInReach: reach(net, placed), segmentsPlaced: placed.length,
           maxAccessKm: MAX_ACCESS_KM };
}

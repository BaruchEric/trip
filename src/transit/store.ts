import type { Client } from "@libsql/client";

/** The urban rail network for one destination, as OSM has it.
 *
 *  Stations and edges only — no times. OSM carries no timetable for any of the
 *  four cities the M12 recon measured (zero `interval`, `headway` or
 *  `duration` tags across 126 route relations), so there is nothing here to
 *  store a minute in. Minutes are derived in `@/transit/graph`, where the
 *  constants that produce them are named and visibly unevidenced. */

export interface TransitStation {
  name: string;
  latitude: number;
  longitude: number;
}

export interface TransitEdge {
  fromName: string;
  toName: string;
  /** The line's `ref`. A change of line between consecutive edges is what a
   *  transfer is, so this is not decoration. */
  line: string;
  /** Straight line between station centroids. Under-states real track. */
  km: number;
}

export interface TransitNetwork {
  stations: TransitStation[];
  edges: TransitEdge[];
}

/** Replace this destination's network wholesale.
 *
 *  REPLACE, not merge. A refetch is a correction of the entire network: a
 *  station OSM has since renamed, or a line rerouted, must LEAVE the graph.
 *  Merging would keep it reachable and wrong forever, and unlike a stale
 *  route_leg — which is at worst an out-of-date measurement of a real thing —
 *  a stale station is a place the traveller cannot go. */
export async function saveNetwork(
  db: Client,
  destinationId: number,
  stations: TransitStation[],
  edges: TransitEdge[],
): Promise<void> {
  await db.batch(
    [
      {
        sql: `DELETE FROM transit_stations WHERE destination_id = ?`,
        args: [destinationId],
      },
      {
        sql: `DELETE FROM transit_edges WHERE destination_id = ?`,
        args: [destinationId],
      },
      ...stations.map((s) => ({
        sql: `INSERT OR REPLACE INTO transit_stations
                (destination_id, name, latitude, longitude)
              VALUES (?, ?, ?, ?)`,
        args: [destinationId, s.name, s.latitude, s.longitude],
      })),
      ...edges.map((e) => ({
        sql: `INSERT OR REPLACE INTO transit_edges
                (destination_id, from_name, to_name, line, km)
              VALUES (?, ?, ?, ?, ?)`,
        args: [destinationId, e.fromName, e.toName, e.line, e.km],
      })),
    ],
    "write",
  );
}

export async function loadNetwork(
  db: Client,
  destinationId: number,
): Promise<TransitNetwork> {
  const s = await db.execute({
    sql: `SELECT name, latitude, longitude FROM transit_stations
           WHERE destination_id = ? ORDER BY name`,
    args: [destinationId],
  });
  const e = await db.execute({
    sql: `SELECT from_name, to_name, line, km FROM transit_edges
           WHERE destination_id = ? ORDER BY from_name, to_name, line`,
    args: [destinationId],
  });
  return {
    stations: s.rows.map((r) => ({
      name: String(r.name),
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
    })),
    edges: e.rows.map((r) => ({
      fromName: String(r.from_name),
      toName: String(r.to_name),
      line: String(r.line),
      km: Number(r.km),
    })),
  };
}

export async function clearNetwork(
  db: Client,
  destinationId: number,
): Promise<void> {
  await db.batch(
    [
      {
        sql: `DELETE FROM transit_stations WHERE destination_id = ?`,
        args: [destinationId],
      },
      {
        sql: `DELETE FROM transit_edges WHERE destination_id = ?`,
        args: [destinationId],
      },
    ],
    "write",
  );
}

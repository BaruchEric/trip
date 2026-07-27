import { test, expect, describe } from "bun:test";
import {
  buildGraph, RAIL_KMH, TRANSFER_MINUTES, BOARDING_MINUTES, MAX_ACCESS_KM,
} from "@/transit/graph";
import type { TransitStation, TransitEdge } from "@/transit/store";

/** A hand-built network, so every expectation below is arithmetic on numbers
 *  written down here rather than on whatever OSM happens to contain today.
 *
 *  Line A runs west->east along 29.56: A1 - A2 - A3.
 *  Line B runs north->south through A2, which is therefore the interchange.
 *  Line C is a disconnected island 0.5 km from A1 but joined to nothing. */
const KM_PER_DEG_LON_AT_29_5 = 96.9;

const STATIONS: TransitStation[] = [
  { name: "A1", latitude: 29.56, longitude: 106.50 },
  { name: "A2", latitude: 29.56, longitude: 106.60 },
  { name: "A3", latitude: 29.56, longitude: 106.70 },
  { name: "B1", latitude: 29.66, longitude: 106.60 },
  { name: "C1", latitude: 29.90, longitude: 106.90 },
  { name: "C2", latitude: 29.91, longitude: 106.91 },
];

const EDGES: TransitEdge[] = [
  { fromName: "A1", toName: "A2", line: "A", km: 9.69 },
  { fromName: "A2", toName: "A1", line: "A", km: 9.69 },
  { fromName: "A2", toName: "A3", line: "A", km: 9.69 },
  { fromName: "A3", toName: "A2", line: "A", km: 9.69 },
  { fromName: "B1", toName: "A2", line: "B", km: 11.1 },
  { fromName: "A2", toName: "B1", line: "B", km: 11.1 },
  { fromName: "C1", toName: "C2", line: "C", km: 1.4 },
];

const g = () => buildGraph(STATIONS, EDGES);
const at = (latitude: number, longitude: number) => ({ latitude, longitude });

describe("transit station graph", () => {
  test("a straight two-hop ride reports its stops and no transfers", async () => {
    const r = g().route(at(29.5601, 106.5001), at(29.5601, 106.7001))!;
    expect(r).not.toBeNull();
    expect(r.fromStation).toBe("A1");
    expect(r.toStation).toBe("A3");
    expect(r.stops).toBe(2);
    expect(r.transfers).toBe(0);
    // 19.38 km at RAIL_KMH, plus one intermediate station's dwell.
    expect(r.rideMinutes).toBeGreaterThan((19.38 / RAIL_KMH) * 60);
  });

  test("crossing between lines is charged exactly one transfer", async () => {
    const r = g().route(at(29.5601, 106.5001), at(29.6601, 106.6001))!;
    expect(r.fromStation).toBe("A1");
    expect(r.toStation).toBe("B1");
    expect(r.transfers).toBe(1);
    expect(r.stops).toBe(2);
    // The transfer is REALLY charged, not merely counted.
    expect(r.rideMinutes).toBeGreaterThanOrEqual(TRANSFER_MINUTES);
  });

  test("both endpoints nearest the SAME station is a zero-stop ride", async () => {
    // The degenerate case the recon found in 4/42 Chongqing pairs and 6/42 in
    // Bangkok. The graph must not invent a ride here; the caller turns this
    // into "walk", and it can only do that if `stops` is honestly 0.
    const r = g().route(at(29.5605, 106.5005), at(29.5595, 106.4995))!;
    expect(r.fromStation).toBe("A1");
    expect(r.toStation).toBe("A1");
    expect(r.stops).toBe(0);
    expect(r.transfers).toBe(0);
    expect(r.rideMinutes).toBe(0);
  });

  test("an endpoint with no station within MAX_ACCESS_KM gets nothing", async () => {
    // Absence is loud. There is no station near the second point, so there is
    // no transit answer -- not a slow one, not a fallback one, none.
    const far = at(29.56, 106.50 + (MAX_ACCESS_KM + 2) / KM_PER_DEG_LON_AT_29_5);
    expect(g().route(at(29.5601, 106.5001), far)).toBeNull();
  });

  test("two stations on disconnected components get nothing", async () => {
    // C1/C2 are a real line the graph knows about, and there is still no way
    // to ride from A1 to C1. Returning a number here would be inventing a
    // connection OSM does not have.
    expect(g().route(at(29.5601, 106.5001), at(29.9001, 106.9001))).toBeNull();
  });

  test("the ride is directed: it uses only edges that exist", async () => {
    // C1 -> C2 exists; C2 -> C1 does not. A graph that sorted its endpoints
    // would answer the second with the first's measurement.
    const forward = g().route(at(29.9001, 106.9001), at(29.9101, 106.9101));
    const backward = g().route(at(29.9101, 106.9101), at(29.9001, 106.9001));
    expect(forward).not.toBeNull();
    expect(forward!.stops).toBe(1);
    expect(backward).toBeNull();
  });

  test("access and egress walks are reported, not folded into the ride", async () => {
    // The caller needs them separately: it prices them with the WALKING model
    // (or a measured walking leg), which the graph knows nothing about.
    const r = g().route(at(29.5601, 106.5001), at(29.5601, 106.7001))!;
    expect(r.accessKm).toBeGreaterThan(0);
    expect(r.accessKm).toBeLessThan(0.1);
    expect(r.egressKm).toBeGreaterThan(0);
    expect(r.rideMinutes).toBeGreaterThan(0);
  });

  test("an empty network answers nothing rather than throwing", async () => {
    const empty = buildGraph([], []);
    expect(empty.stationCount).toBe(0);
    expect(empty.route(at(29.56, 106.50), at(29.56, 106.70))).toBeNull();
  });

  test("the transfer penalty CHANGES WHICH ROUTE IS CHOSEN", async () => {
    // Written because the mutation sweep found this decision unguarded: with
    // TRANSFER_MINUTES set to 0, the only test that died was the constants
    // speed-bump below, which just reads the number back. Nothing asserted
    // that a transfer costs anything where it matters -- in the routing.
    //
    // P and Q are joined two ways. The one-line route is LONGER in track but
    // needs no change; the two-line route is shorter but transfers at X. With
    // a transfer charged, the through route wins; charge nothing and the
    // graph starts sending travellers through changes to save 20 seconds.
    const stations: TransitStation[] = [
      { name: "P", latitude: 29.50, longitude: 106.50 },
      { name: "X", latitude: 29.50, longitude: 106.55 },
      { name: "Q", latitude: 29.50, longitude: 106.60 },
      { name: "R", latitude: 29.51, longitude: 106.55 },
    ];
    const edges: TransitEdge[] = [
      // Two lines meeting at X: 8.6 km of track, one change.
      { fromName: "P", toName: "X", line: "P-line", km: 4.3 },
      { fromName: "X", toName: "Q", line: "Q-line", km: 4.3 },
      // One line the whole way via R: 10 km of track, no change.
      { fromName: "P", toName: "R", line: "through", km: 5.0 },
      { fromName: "R", toName: "Q", line: "through", km: 5.0 },
    ];
    const r = buildGraph(stations, edges)
      .route(at(29.5001, 106.5001), at(29.5001, 106.6001))!;
    expect(r).not.toBeNull();
    // 1.4 km of extra track costs 2.8 min at 30 km/h; a change costs 4.
    expect(r.transfers).toBe(0);
  });

  test("the four unevidenced constants are the ones the recon swept", async () => {
    // A speed bump, like the schema version test. These numbers are not
    // measured and the recon's sensitivity table is stated in terms of them;
    // changing one silently would leave that table describing a model that no
    // longer exists.
    expect(RAIL_KMH).toBe(30);
    expect(TRANSFER_MINUTES).toBe(4);
    expect(BOARDING_MINUTES).toBe(4);
    expect(MAX_ACCESS_KM).toBe(3.0);
  });
});

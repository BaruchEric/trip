import { test, expect, describe } from "bun:test";
import { openDb, migrate, migrateTo, schemaVersion } from "@/db";
import {
  saveNetwork, loadNetwork, clearNetwork,
  type TransitStation, type TransitEdge,
} from "@/transit/store";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync } from "node:fs";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-m12-store-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  // Two real destinations. The network tables carry a FOREIGN KEY to
  // destinations, so a network cannot be stored for a city that does not
  // exist — which is the point of scoping it by destination at all.
  await db.execute(
    `INSERT INTO destinations (name, country_code, latitude, longitude)
     VALUES ('Chongqing', 'cn', 29.5628, 106.5528), ('Lisbon', 'pt', 38.72, -9.14)`,
  );
  return db;
}

const STATIONS: TransitStation[] = [
  { name: "小什字", latitude: 29.5628, longitude: 106.5793 },
  { name: "较场口", latitude: 29.5556, longitude: 106.5722 },
];
const EDGES: TransitEdge[] = [
  { fromName: "小什字", toName: "较场口", line: "1", km: 1.32 },
];

describe("transit network store", () => {
  test("migration 14 creates both tables and they start empty", async () => {
    const db = await freshDb("mig");
    expect(await schemaVersion(db)).toBeGreaterThanOrEqual(14);
    const got = await loadNetwork(db, 1);
    expect(got.stations).toEqual([]);
    expect(got.edges).toEqual([]);
  });

  test("a saved network round-trips", async () => {
    const db = await freshDb("round");
    await saveNetwork(db, 1, STATIONS, EDGES);
    const got = await loadNetwork(db, 1);
    expect(got.stations.length).toBe(2);
    expect(got.edges.length).toBe(1);
    expect(got.stations.map((s) => s.name).sort()).toEqual(["小什字", "较场口"]);
    expect(got.edges[0]!.line).toBe("1");
    expect(got.edges[0]!.km).toBeCloseTo(1.32, 5);
  });

  test("saving again REPLACES rather than appends", async () => {
    // A refetch is a CORRECTION of the whole network, not a second opinion.
    // Appending would leave stations that OSM has since renamed or removed
    // sitting in the graph forever, reachable and wrong.
    const db = await freshDb("replace");
    await saveNetwork(db, 1, STATIONS, EDGES);
    await saveNetwork(db, 1, [STATIONS[0]!], []);
    const got = await loadNetwork(db, 1);
    expect(got.stations.length).toBe(1);
    expect(got.edges.length).toBe(0);
  });

  test("two destinations do not see each other's stations", async () => {
    // The whole reason this table is destination-scoped (M12-2): station
    // identity is a NAME, and a shared node between two cities would produce
    // an edge between them.
    const db = await freshDb("scope");
    await saveNetwork(db, 1, STATIONS, EDGES);
    await saveNetwork(db, 2, [
      { name: "小什字", latitude: 38.7, longitude: -9.1 },
    ], []);
    const one = await loadNetwork(db, 1);
    const two = await loadNetwork(db, 2);
    expect(one.stations.length).toBe(2);
    expect(two.stations.length).toBe(1);
    expect(two.stations[0]!.latitude).toBeCloseTo(38.7, 5);
    expect(two.edges).toEqual([]);
  });

  test("clearNetwork removes only its own destination", async () => {
    const db = await freshDb("clear");
    await saveNetwork(db, 1, STATIONS, EDGES);
    await saveNetwork(db, 2, [STATIONS[0]!], []);
    await clearNetwork(db, 1);
    expect((await loadNetwork(db, 1)).stations).toEqual([]);
    expect((await loadNetwork(db, 2)).stations.length).toBe(1);
  });

  test("migration 14 applies to a v13 database that already carries rows", async () => {
    const p = join(tmpdir(), `trip-m12-store-v13-${process.pid}.db`);
    rmSync(p, { force: true });
    const db = openDb(p);
    await migrateTo(db, 13);
    await db.execute(
      `INSERT INTO destinations (name, country_code, latitude, longitude)
       VALUES ('Chongqing', 'cn', 29.5628, 106.5528)`,
    );
    await migrate(db);
    expect(await schemaVersion(db)).toBeGreaterThanOrEqual(14);
    const r = await db.execute(`SELECT COUNT(*) AS c FROM destinations`);
    expect(Number(r.rows[0]!.c)).toBe(1);
    await saveNetwork(db, 1, STATIONS, EDGES);
    expect((await loadNetwork(db, 1)).stations.length).toBe(2);
  });
});

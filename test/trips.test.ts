import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import {
  createTrip, listTrips, getTripByName, setActiveTrip, getActiveTrip,
} from "@/trips";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-trips-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  return db;
}

describe("trips", () => {
  test("createTrip stores defaults from spec decision 10", async () => {
    const db = await freshDb("create");
    const t = await createTrip(db, "tokyo-2027", "2026-07-26");
    expect(t.name).toBe("tokyo-2027");
    expect(t.mode).toBe("walking");
    expect(t.pace).toBe("normal");
    // lodgingTier/foodTier were removed in M11 (migration 13): displayed as
    // settings since M2, settable by nothing, read by nothing.
  });

  test("duplicate trip names are rejected", async () => {
    const db = await freshDb("dupe");
    await createTrip(db, "tokyo-2027", "2026-07-26");
    await expect(createTrip(db, "tokyo-2027", "2026-07-26")).rejects.toThrow();
  });

  test("listTrips returns newest first", async () => {
    const db = await freshDb("list");
    await createTrip(db, "a", "2026-01-01");
    await createTrip(db, "b", "2026-02-01");
    const all = await listTrips(db);
    expect(all.map((t) => t.name)).toEqual(["b", "a"]);
  });

  test("orders by id when two trips share a created_at", async () => {
    const db = await freshDb("tiebreak");
    await createTrip(db, "first", "2026-03-01");
    await createTrip(db, "second", "2026-03-01");
    const all = await listTrips(db);
    // Identical created_at, so ONLY the `id DESC` tiebreak can order these.
    // Without it this assertion is at the mercy of SQLite's scan order.
    expect(all.map((t) => t.name)).toEqual(["second", "first"]);
  });

  test("a new trip has null destination and dates, not zeros", async () => {
    const db = await freshDb("nulls");
    const t = await createTrip(db, "tokyo-2027", "2026-07-26");
    // toTrip's `=== null` guards matter: an unguarded Number(null) yields 0,
    // which would read as "destination id 0" rather than "no destination".
    expect(t.destinationId).toBeNull();
    expect(t.startDate).toBeNull();
    expect(t.endDate).toBeNull();
  });

  test("getTripByName returns null for an unknown trip", async () => {
    const db = await freshDb("missing");
    expect(await getTripByName(db, "nope")).toBeNull();
  });

  test("active trip round-trips and survives being changed", async () => {
    const db = await freshDb("active");
    await createTrip(db, "a", "2026-01-01");
    await createTrip(db, "b", "2026-02-01");
    expect(await getActiveTrip(db)).toBeNull();
    await setActiveTrip(db, "a");
    expect((await getActiveTrip(db))!.name).toBe("a");
    await setActiveTrip(db, "b");
    expect((await getActiveTrip(db))!.name).toBe("b");
  });

  test("setting an unknown trip active throws", async () => {
    const db = await freshDb("badactive");
    await expect(setActiveTrip(db, "ghost")).rejects.toThrow(/no trip named/i);
  });
});

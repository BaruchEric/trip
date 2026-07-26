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
    expect(t.lodgingTier).toBe("mid");
    expect(t.foodTier).toBe("casual");
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

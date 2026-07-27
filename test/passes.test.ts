import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { addPass, listPasses, getPass, removePass } from "@/passes";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-pass-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: ["chongqing", "2026-07-27"],
  });
  return db;
}

describe("passes", () => {
  test("a pass round-trips", async () => {
    const db = await freshDb("roundtrip");
    await addPass(db, 1, "Metro 3-day", 2, 4);
    expect(await listPasses(db, 1)).toEqual([
      { id: 1, tripId: 1, name: "Metro 3-day", fromDay: 2, toDay: 4 },
    ]);
  });

  test("a single-day pass is fine", async () => {
    const db = await freshDb("single");
    await addPass(db, 1, "Day ticket", 3, 3);
    expect((await listPasses(db, 1))[0]!.toDay).toBe(3);
  });

  test("a backwards day range is rejected", async () => {
    const db = await freshDb("backwards");
    await expect(addPass(db, 1, "X", 4, 2)).rejects.toThrow(/ends before it starts/);
  });

  test("day 0 is rejected -- days are 1-based everywhere else", async () => {
    const db = await freshDb("zero");
    await expect(addPass(db, 1, "X", 0, 2)).rejects.toThrow(/numbered from 1/);
  });

  test("a fractional day is rejected", async () => {
    const db = await freshDb("frac");
    await expect(addPass(db, 1, "X", 1.5, 2)).rejects.toThrow(/invalid from day/);
  });

  test("a blank name is rejected", async () => {
    const db = await freshDb("blank");
    await expect(addPass(db, 1, "   ", 1, 2)).rejects.toThrow(/name/);
  });

  test("passes list by start day", async () => {
    const db = await freshDb("order");
    await addPass(db, 1, "Later", 4, 5);
    await addPass(db, 1, "Earlier", 1, 2);
    expect((await listPasses(db, 1)).map((p) => p.name)).toEqual(["Earlier", "Later"]);
  });

  test("getPass scopes to the trip", async () => {
    const db = await freshDb("scope");
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["lisbon", "2026-07-27"],
    });
    await addPass(db, 1, "Metro", 1, 2);
    expect(await getPass(db, 1, 1)).not.toBeNull();
    expect(await getPass(db, 2, 1)).toBeNull();
  });

  test("removing reports whether it existed", async () => {
    const db = await freshDb("rm");
    await addPass(db, 1, "X", 1, 2);
    expect(await removePass(db, 1, 1)).toBe(true);
    expect(await removePass(db, 1, 1)).toBe(false);
  });
});

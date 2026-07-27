import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { addTraveller, listTravellers, removeTraveller } from "@/travellers";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-who-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: ["chongqing", "2026-07-27"],
  });
  return db;
}

describe("travellers", () => {
  test("a traveller round-trips", async () => {
    const db = await freshDb("roundtrip");
    await addTraveller(db, 1, "Mom", "1949-03-14");
    expect(await listTravellers(db, 1)).toEqual([
      { id: 1, tripId: 1, label: "Mom", birthDate: "1949-03-14" },
    ]);
  });

  test("a malformed birth date is rejected at the store", async () => {
    const db = await freshDb("baddate");
    await expect(addTraveller(db, 1, "X", "14/03/1949")).rejects.toThrow(/birth date/);
    await expect(addTraveller(db, 1, "X", "1949")).rejects.toThrow(/birth date/);
    await expect(addTraveller(db, 1, "X", "")).rejects.toThrow(/birth date/);
  });

  test("a date that looks well-formed but does not exist is rejected", async () => {
    // Date rolls 1949-13-01 into 1950 and 2026-02-30 into March, both
    // silently. The regex alone would let them through and the traveller
    // would carry a birthday nobody typed.
    const db = await freshDb("nosuchday");
    await expect(addTraveller(db, 1, "X", "1949-13-01")).rejects.toThrow(/no such day/);
    await expect(addTraveller(db, 1, "X", "2026-02-30")).rejects.toThrow(/no such day/);
  });

  test("a leap day in a leap year is accepted", async () => {
    const db = await freshDb("leap");
    await addTraveller(db, 1, "Leaper", "2024-02-29");
    expect((await listTravellers(db, 1))[0]!.birthDate).toBe("2024-02-29");
  });

  test("a leap day in a non-leap year is rejected", async () => {
    const db = await freshDb("noleap");
    await expect(addTraveller(db, 1, "X", "2025-02-29")).rejects.toThrow(/no such day/);
  });

  test("a blank label is rejected", async () => {
    const db = await freshDb("blank");
    await expect(addTraveller(db, 1, "  ", "1949-03-14")).rejects.toThrow(/label/);
  });

  test("labels and dates are trimmed", async () => {
    const db = await freshDb("trim");
    await addTraveller(db, 1, "  Mom  ", "  1949-03-14  ");
    const [t] = await listTravellers(db, 1);
    expect(t!.label).toBe("Mom");
    expect(t!.birthDate).toBe("1949-03-14");
  });

  test("a duplicate label on one trip is rejected, naming it", async () => {
    const db = await freshDb("dup");
    await addTraveller(db, 1, "Mom", "1949-03-14");
    await expect(addTraveller(db, 1, "Mom", "1950-01-01")).rejects.toThrow(/Mom/);
  });

  test("the same label on a DIFFERENT trip is fine", async () => {
    const db = await freshDb("othertrip");
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["lisbon", "2026-07-27"],
    });
    await addTraveller(db, 1, "Mom", "1949-03-14");
    await addTraveller(db, 2, "Mom", "1949-03-14");
    expect((await listTravellers(db, 1)).length).toBe(1);
    expect((await listTravellers(db, 2)).length).toBe(1);
  });

  test("travellers list oldest first", async () => {
    const db = await freshDb("order");
    await addTraveller(db, 1, "Kid", "2015-11-20");
    await addTraveller(db, 1, "Mom", "1949-03-14");
    await addTraveller(db, 1, "Eric", "1971-06-02");
    expect((await listTravellers(db, 1)).map((t) => t.label))
      .toEqual(["Mom", "Eric", "Kid"]);
  });

  test("removing a traveller reports whether it existed", async () => {
    const db = await freshDb("rm");
    await addTraveller(db, 1, "Mom", "1949-03-14");
    expect(await removeTraveller(db, 1, "Mom")).toBe(true);
    expect(await removeTraveller(db, 1, "Mom")).toBe(false);
    expect(await listTravellers(db, 1)).toEqual([]);
  });
});

import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import {
  addObservation, listObservations, removeObservation, perPersonPerDay,
  type CostObservation,
} from "@/observations";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-obs-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: ["chongqing", "2026-07-27"],
  });
  return db;
}

const BASE = {
  sourceId: null, atSeconds: null, label: "Accommodation",
  amount: 230, currency: "USD", coversDays: 4, coversPeople: 1,
};

describe("cost observations", () => {
  test("an observation round-trips", async () => {
    const db = await freshDb("roundtrip");
    const id = await addObservation(db, 1, BASE);
    expect(await listObservations(db, 1)).toEqual([{ id, tripId: 1, ...BASE }]);
  });

  test("a blank label is rejected", async () => {
    const db = await freshDb("blank");
    await expect(addObservation(db, 1, { ...BASE, label: "  " }))
      .rejects.toThrow(/label/);
  });

  test("a blank currency is rejected -- a bare number has no meaning", async () => {
    const db = await freshDb("nocurrency");
    await expect(addObservation(db, 1, { ...BASE, currency: "" }))
      .rejects.toThrow(/currency/);
  });

  test("a non-finite or negative amount is rejected", async () => {
    const db = await freshDb("badamount");
    await expect(addObservation(db, 1, { ...BASE, amount: Infinity }))
      .rejects.toThrow(/amount/);
    await expect(addObservation(db, 1, { ...BASE, amount: -1 }))
      .rejects.toThrow(/amount/);
  });

  test("zero days or zero people is rejected, not stored as a divide by zero", async () => {
    const db = await freshDb("zero");
    await expect(addObservation(db, 1, { ...BASE, coversDays: 0 }))
      .rejects.toThrow(/covers_days/);
    await expect(addObservation(db, 1, { ...BASE, coversPeople: 0 }))
      .rejects.toThrow(/covers_people/);
  });

  test("a fractional coverage is rejected", async () => {
    const db = await freshDb("frac");
    await expect(addObservation(db, 1, { ...BASE, coversDays: 3.5 }))
      .rejects.toThrow(/covers_days/);
  });

  test("NULL coverage is allowed -- it means UNKNOWN", async () => {
    const db = await freshDb("nullcover");
    await addObservation(db, 1, { ...BASE, coversDays: null, coversPeople: null });
    const [o] = await listObservations(db, 1);
    expect(o!.coversDays).toBeNull();
    expect(o!.coversPeople).toBeNull();
  });

  test("label and currency are trimmed", async () => {
    const db = await freshDb("trim");
    await addObservation(db, 1, { ...BASE, label: "  Food  ", currency: " USD " });
    const [o] = await listObservations(db, 1);
    expect(o!.label).toBe("Food");
    expect(o!.currency).toBe("USD");
  });

  test("provenance round-trips", async () => {
    const db = await freshDb("prov");
    await db.execute({
      sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
      args: [1, "https://youtu.be/KHHlcCUTwZA", "2026-07-27T00:00:00Z"],
    });
    await addObservation(db, 1, { ...BASE, sourceId: 1, atSeconds: 1169 });
    const [o] = await listObservations(db, 1);
    expect(o!.sourceId).toBe(1);
    expect(o!.atSeconds).toBe(1169);
  });

  test("a source that does not exist is refused by the foreign key", async () => {
    // Found by writing the test above without seeding a source. Worth keeping:
    // provenance that points at nothing is worse than no provenance, because
    // it reads as a citation.
    const db = await freshDb("badsource");
    await expect(addObservation(db, 1, { ...BASE, sourceId: 99 }))
      .rejects.toThrow(/FOREIGN KEY|constraint/i);
  });

  test("a negative timestamp is rejected", async () => {
    const db = await freshDb("badat");
    await expect(addObservation(db, 1, { ...BASE, atSeconds: -1 }))
      .rejects.toThrow(/timestamp/);
  });

  test("observations are scoped to their trip", async () => {
    const db = await freshDb("scope");
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["lisbon", "2026-07-27"],
    });
    await addObservation(db, 1, BASE);
    expect(await listObservations(db, 2)).toEqual([]);
  });

  test("removing reports whether it existed", async () => {
    const db = await freshDb("rm");
    const id = await addObservation(db, 1, BASE);
    expect(await removeObservation(db, 1, id)).toBe(true);
    expect(await removeObservation(db, 1, id)).toBe(false);
  });
});

describe("perPersonPerDay", () => {
  const O: CostObservation = {
    id: 1, tripId: 1, sourceId: null, atSeconds: null,
    label: "x", amount: 400, currency: "USD",
    coversDays: 4, coversPeople: 1,
  };

  test("divides by both axes when both are known", () => {
    expect(perPersonPerDay(O)).toBe(100);
    expect(perPersonPerDay({ ...O, coversPeople: 2 })).toBe(50);
  });

  test("either axis unknown makes the answer UNKNOWN, not approximate", () => {
    // A figure divided by a guessed denominator is more confident than its
    // inputs. "$401 for four days" means something very different for one
    // traveller than for two.
    expect(perPersonPerDay({ ...O, coversDays: null })).toBeNull();
    expect(perPersonPerDay({ ...O, coversPeople: null })).toBeNull();
    expect(perPersonPerDay({ ...O, coversDays: null, coversPeople: null })).toBeNull();
  });

  test("a zero amount normalises to zero, which is a real answer", () => {
    expect(perPersonPerDay({ ...O, amount: 0 })).toBe(0);
  });

  test("a zero denominator is unknown, never Infinity", () => {
    // validate() rejects these on the way in, but a row that predates the
    // guard must not render Infinity, which looks like a number and reads
    // like a fact.
    expect(perPersonPerDay({ ...O, coversDays: 0 })).toBeNull();
    expect(perPersonPerDay({ ...O, coversPeople: 0 })).toBeNull();
  });

  test("the measured Chongqing total works out to 100.25 pppd", () => {
    expect(perPersonPerDay({ ...O, amount: 401, coversDays: 4, coversPeople: 1 }))
      .toBeCloseTo(100.25);
  });
});

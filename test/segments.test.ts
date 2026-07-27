import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { addSegment, listSegments, removeSegment } from "@/segments";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-seg-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: ["lisbon", "2026-07-26"],
  });
  return db;
}

const FULL = {
  name: "Time Out Market",
  latitude: 38.707, longitude: -9.145,
  dwellMinutes: 90, cost: 25,
  tags: ["food", "indoor"],
  opensMin: 600, closesMin: 1440,
  closedDays: ["mon"],
};

describe("segments", () => {
  test("a fully specified segment round-trips", async () => {
    const db = await freshDb("round");
    const id = await addSegment(db, 1, FULL);
    const [seg] = await listSegments(db, 1);
    expect(seg!.id).toBe(id);
    expect(seg!.name).toBe("Time Out Market");
    expect(seg!.dwellMinutes).toBe(90);
    expect(seg!.tags).toEqual(["food", "indoor"]);
    expect(seg!.closedDays).toEqual(["mon"]);
    expect(seg!.opensMin).toBe(600);
    expect(seg!.status).toBe("confirmed");
  });

  test("unknown hours and missing coordinates survive as null, not zero", async () => {
    // The whole M2-2 decision rests on this. If opensMin came back 0, the
    // scheduler would read it as "opens at midnight" — a guess wearing the
    // costume of a fact, which is how a zero-filled climate month once
    // scored 79 and outranked real destinations.
    const db = await freshDb("nulls");
    await addSegment(db, 1, {
      name: "Some Viewpoint", latitude: null, longitude: null,
      dwellMinutes: 30, cost: null, tags: [],
      opensMin: null, closesMin: null, closedDays: [],
    });
    const [seg] = await listSegments(db, 1);
    expect(seg!.opensMin).toBeNull();
    expect(seg!.closesMin).toBeNull();
    expect(seg!.latitude).toBeNull();
    expect(seg!.cost).toBeNull();
    expect(seg!.tags).toEqual([]);
    expect(seg!.closedDays).toEqual([]);
  });

  test("segments are scoped to their trip", async () => {
    const db = await freshDb("scope");
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["tokyo", "2026-07-26"],
    });
    await addSegment(db, 1, { ...FULL, name: "Lisbon thing" });
    await addSegment(db, 2, { ...FULL, name: "Tokyo thing" });
    expect((await listSegments(db, 1)).map((s) => s.name)).toEqual(["Lisbon thing"]);
    expect((await listSegments(db, 2)).map((s) => s.name)).toEqual(["Tokyo thing"]);
  });

  test("removing reports whether anything was removed", async () => {
    const db = await freshDb("rm");
    const id = await addSegment(db, 1, FULL);
    expect(await removeSegment(db, 1, id)).toBe(true);
    expect(await removeSegment(db, 1, id)).toBe(false);
    expect(await listSegments(db, 1)).toHaveLength(0);
  });

  test("removing another trip's segment does nothing", async () => {
    const db = await freshDb("rm-scope");
    const id = await addSegment(db, 1, FULL);
    expect(await removeSegment(db, 2, id)).toBe(false);
    expect(await listSegments(db, 1)).toHaveLength(1);
  });

  test("a tag containing a comma cannot forge two tags", async () => {
    // tags are stored comma-separated, so the separator has to be rejected
    // at the boundary or "food,free" becomes two tags on read.
    const db = await freshDb("tagsep");
    await expect(
      addSegment(db, 1, { ...FULL, tags: ["street,food"] }),
    ).rejects.toThrow(/comma/i);
  });

  test("a blank name is rejected", async () => {
    const db = await freshDb("blank-name");
    await expect(addSegment(db, 1, { ...FULL, name: "   " })).rejects.toThrow(/name/i);
  });

  test("a non-positive dwell is rejected", async () => {
    const db = await freshDb("bad-dwell");
    await expect(addSegment(db, 1, { ...FULL, dwellMinutes: 0 })).rejects.toThrow(/dwell/i);
  });

  test("a fractional dwell is rejected", async () => {
    const db = await freshDb("frac-dwell");
    await expect(addSegment(db, 1, { ...FULL, dwellMinutes: 90.5 })).rejects.toThrow(/dwell/i);
  });

  test("an empty tag is rejected rather than stored as a phantom tag", async () => {
    const db = await freshDb("empty-tag");
    await expect(addSegment(db, 1, { ...FULL, tags: ["food", ""] })).rejects.toThrow(/tag/i);
  });

  test("closed days are normalised to lowercase 3-letter codes", async () => {
    const db = await freshDb("closed-case");
    await addSegment(db, 1, { ...FULL, closedDays: ["MON", "Tuesday"] });
    const [seg] = await listSegments(db, 1);
    expect(seg!.closedDays).toEqual(["mon", "tue"]);
  });

  test("an invalid closed day is rejected", async () => {
    const db = await freshDb("closed-bad");
    await expect(addSegment(db, 1, { ...FULL, closedDays: ["monkey"] })).rejects.toThrow(/weekday/i);
  });

  test("cross-midnight hours are rejected at the storage boundary", async () => {
    const db = await freshDb("cross-midnight");
    await expect(
      addSegment(db, 1, { ...FULL, opensMin: 1200, closesMin: 120 }),
    ).rejects.toThrow(/close after/i);
  });

  test("midnight close (1440) is accepted", async () => {
    const db = await freshDb("midnight-close");
    const id = await addSegment(db, 1, { ...FULL, opensMin: 600, closesMin: 1440 });
    expect(id).toBeGreaterThan(0);
  });

  test("out-of-range coordinates are rejected", async () => {
    const db = await freshDb("bad-coords");
    await expect(
      addSegment(db, 1, { ...FULL, latitude: 91, longitude: 0 }),
    ).rejects.toThrow(/latitude/i);
  });

  test("non-finite coordinates are rejected", async () => {
    const db = await freshDb("nan-coords");
    await expect(
      addSegment(db, 1, { ...FULL, latitude: NaN, longitude: NaN }),
    ).rejects.toThrow(/latitude/i);
  });

  test("a latitude without a longitude is rejected", async () => {
    const db = await freshDb("half-coords");
    await expect(
      addSegment(db, 1, { ...FULL, latitude: 38.7, longitude: null }),
    ).rejects.toThrow(/both/i);
  });
});

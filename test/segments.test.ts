import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { addSegment, listSegments, removeSegment, setSegmentDwell } from "@/segments";
import { createMention, resolveMention, getMention } from "@/mentions";
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
    await db.execute({
      sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
      args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
    });
    const mentionId = await createMention(db, 1, 1, {
      text: "Hongya Cave", atSeconds: 272, dwellMinutes: null, tags: [],
    });
    const id = await addSegment(db, 1, { ...FULL, sourceId: 1 });
    await resolveMention(db, mentionId, id);

    expect(await removeSegment(db, 2, id)).toBe(false);
    expect(await listSegments(db, 1)).toHaveLength(1);
    // A no-op removal must not touch the mention either. The ownership check
    // has to run BEFORE unlinkSegment, or a wrong-trip removeSegment call —
    // one that correctly refuses to delete the segment — would still bump
    // another trip's resolved mention back onto the review queue.
    const m = (await getMention(db, 1, mentionId))!;
    expect(m.state).toBe("resolved");
    expect(m.segmentId).toBe(id);
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

  test("a padded name is stored trimmed", async () => {
    const db = await freshDb("trim-name");
    await addSegment(db, 1, { ...FULL, name: "  Museum  " });
    const [seg] = await listSegments(db, 1);
    expect(seg!.name).toBe("Museum");
  });

  test("a non-finite or negative source timestamp is rejected", async () => {
    const db = await freshDb("bad-source-ts");
    await expect(
      addSegment(db, 1, { ...FULL, sourceAtSeconds: NaN }),
    ).rejects.toThrow(/source timestamp/i);
    await expect(
      addSegment(db, 1, { ...FULL, sourceAtSeconds: -1 }),
    ).rejects.toThrow(/source timestamp/i);
  });

  test("a hand-added segment has no provenance and no defaulted dwell", async () => {
    const db = await freshDb("no-provenance");
    await addSegment(db, 1, FULL);
    const [seg] = await listSegments(db, 1);
    expect(seg!.localName).toBeNull();
    expect(seg!.sourceId).toBeNull();
    expect(seg!.sourceAtSeconds).toBeNull();
    expect(seg!.dwellIsDefault).toBe(false);
  });

  test("provenance round-trips", async () => {
    const db = await freshDb("provenance");
    await db.execute({
      sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
      args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
    });
    await addSegment(db, 1, {
      ...FULL, name: "Hongya Cave", localName: "洪崖洞",
      sourceId: 1, sourceAtSeconds: 272, dwellIsDefault: true,
    });
    const [seg] = await listSegments(db, 1);
    expect(seg!.name).toBe("Hongya Cave");
    expect(seg!.localName).toBe("洪崖洞");
    expect(seg!.sourceId).toBe(1);
    expect(seg!.sourceAtSeconds).toBe(272);
    expect(seg!.dwellIsDefault).toBe(true);
  });

  test("listSegments can filter to one source", async () => {
    const db = await freshDb("by-source");
    await db.execute({
      sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
      args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
    });
    await addSegment(db, 1, FULL);
    await addSegment(db, 1, { ...FULL, name: "From video", sourceId: 1 });

    // A second trip with a segment carrying the SAME source id. A query that
    // filtered on source_id alone would return this one too.
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["other", "2026-07-27"],
    });
    await addSegment(db, 2, { ...FULL, name: "Other trip video", sourceId: 1 });

    expect((await listSegments(db, 1)).length).toBe(2);
    const fromVideo = await listSegments(db, 1, { sourceId: 1 });
    expect(fromVideo.length).toBe(1);
    expect(fromVideo[0]!.name).toBe("From video");
  });

  test("removing a video-sourced segment returns its mention to the queue", async () => {
    const db = await freshDb("rm-requeue");
    await db.execute({
      sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
      args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
    });
    const mentionId = await createMention(db, 1, 1, {
      text: "Hongya Cave", atSeconds: 272, dwellMinutes: null, tags: [],
    });
    const segId = await addSegment(db, 1, { ...FULL, sourceId: 1 });
    await resolveMention(db, mentionId, segId);

    expect(await removeSegment(db, 1, segId)).toBe(true);
    const m = (await getMention(db, 1, mentionId))!;
    // A place the video mentioned does not stop having been mentioned.
    expect(m.state).toBe("pending");
    expect(m.reason).toBe("segment deleted");
    expect(m.segmentId).toBeNull();
  });

  test("setSegmentDwell replaces a defaulted dwell and clears the flag", async () => {
    const db = await freshDb("set-dwell");
    const id = await addSegment(db, 1, { ...FULL, dwellMinutes: 60, dwellIsDefault: true });
    expect(await setSegmentDwell(db, 1, id, 75)).toBe(true);
    const [seg] = await listSegments(db, 1);
    expect(seg!.dwellMinutes).toBe(75);
    expect(seg!.dwellIsDefault).toBe(false);
  });

  test("setSegmentDwell will not reach into another trip", async () => {
    const db = await freshDb("set-dwell-scope");
    const id = await addSegment(db, 1, FULL);
    await db.execute({
      sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
      args: ["other", "2026-07-27"],
    });
    expect(await setSegmentDwell(db, 2, id, 75)).toBe(false);
    expect((await listSegments(db, 1))[0]!.dwellMinutes).toBe(90);
  });
});

import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip } from "@/trips";
import { runSegmentsCommand } from "@/commands/segments";
import { listSegments } from "@/segments";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-segcmd-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  // createTrip takes (db, name, createdAt) - the brief's scaffold omitted
  // createdAt; Task 9 hit this same arity mismatch first.
  await createTrip(db, "lisbon", "2026-07-26");
  await setActiveTrip(db, "lisbon");
  return db;
}

describe("trip seg add", () => {
  test("adds a fully specified segment", async () => {
    const db = await freshDb("full");
    const out = await runSegmentsCommand(db, [
      "add", "Time", "Out", "Market", "--dur=90m", "--cost=25", "--tag=food",
      "--at=38.707,-9.145", "--hours=10:00-24:00", "--closed=mon",
    ], false);
    expect(out).toContain("Time Out Market");
    const [s] = await listSegments(db, 1);
    expect(s!.name).toBe("Time Out Market");
    expect(s!.dwellMinutes).toBe(90);
    expect(s!.cost).toBe(25);
    expect(s!.tags).toEqual(["food"]);
    expect(s!.latitude).toBeCloseTo(38.707);
    expect(s!.opensMin).toBe(600);
    expect(s!.closedDays).toEqual(["mon"]);
  });

  test("a multi-word name is joined, not truncated", async () => {
    // The exact bug that made `trip when New York` answer about Patna.
    const db = await freshDb("multiword");
    await runSegmentsCommand(db, ["add", "Museu", "Nacional", "do", "Azulejo", "--dur=60m"], false);
    expect((await listSegments(db, 1))[0]!.name).toBe("Museu Nacional do Azulejo");
  });

  test("--dur is required", async () => {
    const db = await freshDb("nodur");
    await expect(runSegmentsCommand(db, ["add", "Thing"], false))
      .rejects.toThrow(/dur/i);
  });

  test("a segment without --at is accepted and lands unplaced", async () => {
    // M2-7: forcing a coordinate lookup at add time is the research tax the
    // spec rejects.
    const db = await freshDb("nocoords");
    await runSegmentsCommand(db, ["add", "Somewhere", "--dur=45m"], false);
    const [s] = await listSegments(db, 1);
    expect(s!.latitude).toBeNull();
    const out = await runSegmentsCommand(db, ["ls", "--unplaced"], false);
    expect(out).toContain("Somewhere");
  });

  test("multiple --tag flags accumulate", async () => {
    const db = await freshDb("tags");
    await runSegmentsCommand(db,
      ["add", "Thing", "--dur=30m", "--tag=food", "--tag=cheap"], false);
    expect((await listSegments(db, 1))[0]!.tags).toEqual(["food", "cheap"]);
  });

  test("unknown hours stay null rather than becoming a full day", async () => {
    const db = await freshDb("nohours");
    await runSegmentsCommand(db, ["add", "Thing", "--dur=30m"], false);
    const [s] = await listSegments(db, 1);
    expect(s!.opensMin).toBeNull();
    expect(s!.closesMin).toBeNull();
  });
});

describe("trip seg ls", () => {
  test("filters by tag", async () => {
    const db = await freshDb("filter");
    await runSegmentsCommand(db, ["add", "Lunch", "--dur=60m", "--tag=food"], false);
    await runSegmentsCommand(db, ["add", "Museum", "--dur=90m", "--tag=art"], false);
    const out = await runSegmentsCommand(db, ["ls", "--tag=food"], false);
    expect(out).toContain("Lunch");
    expect(out).not.toContain("Museum");
  });

  test("json lists every field an agent needs", async () => {
    const db = await freshDb("lsjson");
    await runSegmentsCommand(db, ["add", "Thing", "--dur=30m", "--at=38.7,-9.1"], false);
    const parsed = JSON.parse(await runSegmentsCommand(db, ["ls"], true));
    expect(parsed.segments).toHaveLength(1);
    expect(parsed.segments[0].dwellMinutes).toBe(30);
    expect(parsed.segments[0].latitude).toBeCloseTo(38.7);
  });

  test("an empty library says so instead of printing a bare header", async () => {
    const db = await freshDb("empty");
    expect(await runSegmentsCommand(db, ["ls"], false)).toMatch(/no segments/i);
  });
});

describe("trip seg rm", () => {
  test("removes by id and reports a miss", async () => {
    const db = await freshDb("rm");
    await runSegmentsCommand(db, ["add", "Thing", "--dur=30m"], false);
    expect(await runSegmentsCommand(db, ["rm", "1"], false)).toMatch(/removed/i);
    await expect(runSegmentsCommand(db, ["rm", "1"], false)).rejects.toThrow(/no segment/i);
  });

  test("a non-numeric id is rejected", async () => {
    const db = await freshDb("rmbad");
    await expect(runSegmentsCommand(db, ["rm", "abc"], false)).rejects.toThrow(/id/i);
  });
});

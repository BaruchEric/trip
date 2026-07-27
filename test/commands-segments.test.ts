import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip } from "@/trips";
import { runSegmentsCommand } from "@/commands/segments";
import { addSegment, listSegments } from "@/segments";
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
    // A swap of opensMin/closesMin was previously caught only incidentally,
    // via the closesMin <= opensMin guard throwing. Assert closesMin directly.
    expect(s!.closesMin).toBe(1439);
    expect(s!.closedDays).toEqual(["mon"]);
  });

  test("json flags whether coordinates and hours are known, not just id/name", async () => {
    // The human path warns "(no coordinates - cannot be placed until you add
    // --at)" but the json path used to return only {id, name} - an agent had
    // to issue a follow-up `seg ls --json` to learn a segment it just
    // created can't be placed or scheduled. Field names match Task 11's plan
    // JSON, which uses hoursKnown.
    const db = await freshDb("addjsonflags");
    const bare = JSON.parse(
      await runSegmentsCommand(db, ["add", "Somewhere", "--dur=30m"], true),
    );
    expect(bare.hasCoordinates).toBe(false);
    expect(bare.hoursKnown).toBe(false);

    const full = JSON.parse(
      await runSegmentsCommand(db,
        ["add", "Cafe", "--dur=30m", "--at=38.7,-9.1", "--hours=09:00-18:00"], true),
    );
    expect(full.hasCoordinates).toBe(true);
    expect(full.hoursKnown).toBe(true);
  });

  test("a multi-word name is joined, not truncated", async () => {
    // The exact bug that made `trip when New York` answer about Patna.
    const db = await freshDb("multiword");
    await runSegmentsCommand(db, ["add", "Museu", "Nacional", "do", "Azulejo", "--dur=60m"], false);
    expect((await listSegments(db, 1))[0]!.name).toBe("Museu Nacional do Azulejo");
  });

  test("--cost= (empty) is rejected rather than stored as 0", async () => {
    // F5: Number("") is 0, not NaN, so this used to pass Number.isFinite and
    // silently store a real $0 cost instead of throwing -- the same trap
    // parseCoords already guards against for --at=.
    const db = await freshDb("costempty");
    await expect(runSegmentsCommand(db, ["add", "Thing", "--dur=30m", "--cost="], false))
      .rejects.toThrow(/cost/i);
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

  // These three lock down render-plan.ts's markers, which are the visible
  // expression of M2-2: unknown hours/coordinates are REPORTED, never guessed.
  // Each test gives the OTHER fact (coords or hours) so it isolates exactly
  // one marker - a silently-dropped marker would otherwise hide behind the
  // other one still being present.

  test("unknown hours render the '?' marker, not a guessed full-day range", async () => {
    const db = await freshDb("marker-unknown-hours");
    // --at given, --hours withheld: isolates the hours marker from "no coords".
    await runSegmentsCommand(db, ["add", "Miradouro", "--dur=30m", "--at=38.71,-9.13"], false);
    const out = await runSegmentsCommand(db, ["ls"], false);
    expect(out).toContain("?");
    expect(out).not.toContain("00:00");
  });

  test("known hours render the actual window, not the unknown marker", async () => {
    const db = await freshDb("marker-known-hours");
    await runSegmentsCommand(db,
      ["add", "Cafe", "--dur=30m", "--at=38.71,-9.13", "--hours=09:00-18:00"], false);
    const out = await runSegmentsCommand(db, ["ls"], false);
    expect(out).toContain("09:00-18:00");
    expect(out).not.toContain("?");
  });

  test("a segment without coordinates says so in the listing", async () => {
    const db = await freshDb("marker-no-coords");
    // --hours given, --at withheld: isolates "no coords" from the "?" marker.
    await runSegmentsCommand(db, ["add", "Mystery", "--dur=30m", "--hours=09:00-18:00"], false);
    const out = await runSegmentsCommand(db, ["ls"], false);
    expect(out).toContain("no coords");
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

describe("trip seg set", () => {
  test("seg set --dur updates the dwell", async () => {
    const db = await freshDb("cmd-set");
    await runSegmentsCommand(db, ["add", "Museum", "--dur=60m"], false);
    const out = await runSegmentsCommand(db, ["set", "1", "--dur=2h"], false);
    expect(out).toContain("120m");
    expect((await listSegments(db, 1))[0]!.dwellMinutes).toBe(120);
  });

  test("seg set requires --dur", async () => {
    const db = await freshDb("cmd-set-nodur");
    await runSegmentsCommand(db, ["add", "Museum", "--dur=60m"], false);
    await expect(runSegmentsCommand(db, ["set", "1"], false)).rejects.toThrow(/--dur/);
  });

  test("seg set on an unknown id says so", async () => {
    const db = await freshDb("cmd-set-missing");
    await expect(runSegmentsCommand(db, ["set", "42", "--dur=1h"], false)).rejects.toThrow(/42/);
  });
});

describe("trip seg ls --from", () => {
  test("seg ls --from scopes to one video", async () => {
    const db = await freshDb("cmd-from");
    await db.execute({
      sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
      args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
    });
    await runSegmentsCommand(db, ["add", "By hand", "--dur=60m"], false);
    await addSegment(db, 1, {
      name: "From video", latitude: 1, longitude: 1, dwellMinutes: 60,
      cost: null, tags: [], opensMin: null, closesMin: null, closedDays: [],
      sourceId: 1,
    });
    const out = JSON.parse(await runSegmentsCommand(db, ["ls", "--from=1"], true));
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].name).toBe("From video");
  });
});

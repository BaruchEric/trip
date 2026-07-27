import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip } from "@/trips";
import { runSegmentsCommand } from "@/commands/segments";
import { addSegment, listSegments } from "@/segments";
import { renderSegmentList } from "@/render-plan";
import { readPriceRules } from "@/prices";
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
      "add", "Time", "Out", "Market", "--dur=90m", "--tag=food",
      "--at=38.707,-9.145", "--hours=10:00-24:00", "--closed=mon",
    ], false);
    expect(out).toContain("Time Out Market");
    const [s] = await listSegments(db, 1);
    expect(s!.name).toBe("Time Out Market");
    expect(s!.dwellMinutes).toBe(90);
    expect(s!.tags).toEqual(["food"]);
    expect(s!.latitude).toBeCloseTo(38.707);
    expect(s!.opensMin).toBe(600);
    // A swap of opensMin/closesMin was previously caught only incidentally,
    // via the closesMin <= opensMin guard throwing. Assert closesMin directly.
    // 1440, not 1439: M4-7 canonicalised midnight on the spelling the rest of
    // the codebase already used.
    expect(s!.closesMin).toBe(1440);
    expect(s!.closedDays).toEqual(["mon"]);
  });

  test("--hours=...-24:00 renders back as 24:00, not 23:59", async () => {
    // M4-7. The CLI used to store 1439 for 24:00, so it echoed the user's
    // `10:00-24:00` back as `10:00-23:59` — restating their input as
    // something they did not type. Reverting the fix fails this line.
    const db = await freshDb("midnight-render");
    await runSegmentsCommand(db, [
      "add", "Late", "Bar", "--dur=60m", "--hours=18:00-24:00",
    ], false);
    expect(renderSegmentList(await listSegments(db, 1))).toContain("18:00-24:00");
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
      freeDays: [], tags: [], opensMin: null, closesMin: null, closedDays: [],
      sourceId: 1,
    });
    const out = JSON.parse(await runSegmentsCommand(db, ["ls", "--from=1"], true));
    expect(out.segments.length).toBe(1);
    expect(out.segments[0].name).toBe("From video");
  });
});

describe("trip seg prices and free days", () => {
  test("--price rules are stored against the segment, in order", async () => {
    const db = await freshDb("price");
    await runSegmentsCommand(
      db,
      ["add", "Hongya", "Cave", "--dur=90m", "--price=30", "--price=65+:0"],
      false,
    );
    expect((await readPriceRules(db, "segment", [1])).get(1)).toEqual([
      { minAge: null, maxAge: null, price: 30 },
      { minAge: 65, maxAge: null, price: 0 },
    ]);
  });

  test("no --price at all leaves the segment UNKNOWN, with no rule row", async () => {
    const db = await freshDb("noprice");
    await runSegmentsCommand(db, ["add", "Jiefangbei", "--dur=60m"], false);
    expect((await readPriceRules(db, "segment", [1])).has(1)).toBe(false);
  });

  test("--cost is an exact alias for a bare --price", async () => {
    const db = await freshDb("costalias");
    await runSegmentsCommand(db, ["add", "A", "--dur=30m", "--cost=25"], false);
    await runSegmentsCommand(db, ["add", "B", "--dur=30m", "--price=25"], false);
    const rules = await readPriceRules(db, "segment", [1, 2]);
    expect(rules.get(1)).toEqual(rules.get(2)!);
  });

  test("--cost and --price together are an error, not a silent winner", async () => {
    // A silent precedence rule would price the place differently from what
    // the user typed, with nothing in the output saying which won.
    const db = await freshDb("both");
    await expect(
      runSegmentsCommand(db, ["add", "A", "--dur=30m", "--cost=25", "--price=30"], false),
    ).rejects.toThrow(/--cost and --price/);
  });

  test("overlapping --price rules are rejected, naming both", async () => {
    const db = await freshDb("overlap");
    await expect(
      runSegmentsCommand(
        db, ["add", "A", "--dur=30m", "--price=60-70:5", "--price=65+:0"], false),
    ).rejects.toThrow(/overlapping/);
  });

  test("a base rule alongside a bounded one is accepted", async () => {
    // The carve-out, exercised through the CLI: an unbounded rule overlaps
    // every age, so a uniform overlap check would reject the commonest case.
    const db = await freshDb("baseok");
    await runSegmentsCommand(
      db, ["add", "A", "--dur=30m", "--price=30", "--price=65+:0"], false);
    expect((await readPriceRules(db, "segment", [1])).get(1)!.length).toBe(2);
  });

  test("a rejected rule set adds NO segment at all", async () => {
    // Half-adding a segment and then failing on its prices leaves a row the
    // user did not ask for and cannot see the price of.
    const db = await freshDb("atomic");
    await expect(
      runSegmentsCommand(
        db, ["add", "A", "--dur=30m", "--price=60-70:5", "--price=65+:0"], false),
    ).rejects.toThrow();
    expect(await listSegments(db, 1)).toEqual([]);
  });

  test("--free-days accepts the same weekday vocabulary as --closed", async () => {
    const db = await freshDb("freedays");
    await runSegmentsCommand(
      db, ["add", "Museum", "--dur=60m", "--free-days=Tuesday,wed"], false);
    expect((await listSegments(db, 1))[0]!.freeDays).toEqual(["tue", "wed"]);
  });

  test("an invalid free day is rejected, naming it", async () => {
    const db = await freshDb("badfreeday");
    await expect(
      runSegmentsCommand(db, ["add", "M", "--dur=60m", "--free-days=funday"], false),
    ).rejects.toThrow(/funday/);
  });

  test("a weekday in both --closed and --free-days is allowed and inert", async () => {
    // Not a contradiction to reject: the scheduler never places the segment
    // on a closed day, so the free rule simply never fires -- and a venue's
    // own listing can genuinely say both. This test exists so a later
    // contributor who "fixes the contradiction" finds out it was deliberate.
    const db = await freshDb("closedandfree");
    await runSegmentsCommand(
      db, ["add", "M", "--dur=60m", "--closed=mon", "--free-days=mon"], false);
    const [s] = await listSegments(db, 1);
    expect(s!.closedDays).toEqual(["mon"]);
    expect(s!.freeDays).toEqual(["mon"]);
  });

  test("seg price replaces a segment's whole rule set", async () => {
    const db = await freshDb("priceset");
    await runSegmentsCommand(db, ["add", "M", "--dur=60m", "--price=30"], false);
    await runSegmentsCommand(db, ["price", "1", "--price=40", "--price=65+:0"], false);
    expect((await readPriceRules(db, "segment", [1])).get(1)!.map((r) => r.price))
      .toEqual([40, 0]);
  });

  test("seg price --clear reaches UNKNOWN, not free", async () => {
    // The distinction the whole milestone rests on, exercised through the CLI.
    const db = await freshDb("priceclear");
    await runSegmentsCommand(db, ["add", "M", "--dur=60m", "--price=30"], false);
    const out = await runSegmentsCommand(db, ["price", "1", "--clear"], false);
    // The message must say the distinction out loud, because "cleared the
    // prices" alone reads as "set them to nothing", i.e. free.
    expect(out).toContain("UNKNOWN");
    expect(out).toMatch(/not free/);
    expect((await readPriceRules(db, "segment", [1])).has(1)).toBe(false);
  });

  test("seg price --clear with a price is an error", async () => {
    const db = await freshDb("clearboth");
    await runSegmentsCommand(db, ["add", "M", "--dur=60m"], false);
    await expect(
      runSegmentsCommand(db, ["price", "1", "--clear", "--price=5"], false),
    ).rejects.toThrow(/--clear takes no prices/);
  });

  test("seg price with no price and no --clear is an error", async () => {
    const db = await freshDb("pricenothing");
    await runSegmentsCommand(db, ["add", "M", "--dur=60m"], false);
    await expect(runSegmentsCommand(db, ["price", "1"], false))
      .rejects.toThrow(/at least one --price/);
  });

  test("seg price on an unknown id is an error", async () => {
    const db = await freshDb("pricemissing");
    await expect(runSegmentsCommand(db, ["price", "99", "--price=5"], false))
      .rejects.toThrow(/99/);
  });

  test("seg rm takes the price rules with it", async () => {
    const db = await freshDb("rmprices");
    await runSegmentsCommand(db, ["add", "M", "--dur=60m", "--price=30"], false);
    await runSegmentsCommand(db, ["rm", "1"], false);
    expect((await readPriceRules(db, "segment", [1])).has(1)).toBe(false);
  });
});

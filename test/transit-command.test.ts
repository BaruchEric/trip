import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runTransitCommand } from "@/commands/transit";
import { loadNetwork } from "@/transit/store";
import { overpassQuery, overpassNodesQuery } from "@/transit/fetch";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, readFileSync } from "node:fs";

const FIX = join(import.meta.dir, "fixtures", "m12-transit");
const rels = JSON.parse(readFileSync(join(FIX, "rail-chongqing-relations.json"), "utf8"));
const nodes = JSON.parse(readFileSync(join(FIX, "rail-chongqing-nodes.json"), "utf8"));

/** The captured Chongqing responses, served without a network. Which query
 *  arrived decides which body comes back, so a swapped pair would be caught
 *  rather than silently parsed. */
function fakeOverpass(calls: string[] = []) {
  return async (query: string) => {
    calls.push(query);
    return query.includes("node(r)") ? nodes : rels;
  };
}

async function tripDb(tag: string, opts: { segments?: boolean; destination?: boolean } = {}) {
  const p = join(tmpdir(), `trip-m12-cmd-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  if (opts.destination !== false) {
    await db.execute(
      `INSERT INTO destinations (name, country_code, latitude, longitude)
       VALUES ('Chongqing', 'cn', 29.5628, 106.5528)`,
    );
  }
  await db.execute(
    `INSERT INTO trips (name, destination_id, mode, pace, created_at)
     VALUES ('cq', ${opts.destination === false ? "NULL" : "1"}, 'transit', 'normal', '2026-07-27')`,
  );
  // The active trip is stored by NAME, not by id.
  await db.execute(`INSERT INTO app_state (key, value) VALUES ('active_trip', 'cq')`);
  if (opts.segments !== false) {
    await db.execute(
      `INSERT INTO segments (trip_id, name, latitude, longitude, dwell_minutes)
       VALUES (1, 'Hongya Cave', 29.5650738, 106.5753425, 60),
              (1, 'Liziba', 29.5556826, 106.5338753, 60)`,
    );
  }
  return { db, path: p };
}

describe("trip transit", () => {
  test("it stores the network and reports what it found", async () => {
    const { db } = await tripDb("store");
    const out = await runTransitCommand(db, [], false, { overpass: fakeOverpass() });
    expect(out).toContain("route relations");
    expect(out).toContain("monorail");
    const net = await loadNetwork(db, 1);
    expect(net.stations.length).toBeGreaterThan(250);
    expect(net.stations.map((s) => s.name)).toContain("李子坝");
    expect(net.edges.length).toBeGreaterThan(400);
  });

  test("it reports how many segments have a station in reach", async () => {
    // The number that decides whether any of this changes a single hop. A
    // network of 300 stations none of which is near anything you plan to
    // visit will never be consulted, and a station count alone would hide it.
    const { db } = await tripDb("reach");
    const out = await runTransitCommand(db, [], false, { overpass: fakeOverpass() });
    expect(out).toMatch(/2 of 2 placed segments have a station within/);
  });

  test("it names the modes FOUND, beside the ones asked for", async () => {
    const { db } = await tripDb("modes");
    const out = await runTransitCommand(db, [], false, { overpass: fakeOverpass() });
    expect(out).toContain("modes found:");
    expect(out).toContain("asked for subway, monorail, light_rail, tram");
  });

  test("a second run does not refetch, and says so", async () => {
    const { db } = await tripDb("cached");
    const calls: string[] = [];
    await runTransitCommand(db, [], false, { overpass: fakeOverpass(calls) });
    const first = calls.length;
    const out = await runTransitCommand(db, [], false, { overpass: fakeOverpass(calls) });
    expect(calls.length).toBe(first);
    expect(out).toContain("already stored");
    expect(out).toContain("--refresh");
  });

  test("--refresh does refetch", async () => {
    const { db } = await tripDb("refresh");
    const calls: string[] = [];
    await runTransitCommand(db, [], false, { overpass: fakeOverpass(calls) });
    const first = calls.length;
    await runTransitCommand(db, ["--refresh"], false, { overpass: fakeOverpass(calls) });
    expect(calls.length).toBeGreaterThan(first);
  });

  test("the query it sends asks for all four rail modes", async () => {
    const { db } = await tripDb("query");
    const calls: string[] = [];
    await runTransitCommand(db, [], false, { overpass: fakeOverpass(calls) });
    expect(calls[0]).toContain("monorail");
    expect(calls[0]).toContain("light_rail");
    expect(calls[0]).toContain("tram");
    // The production query, not a paraphrase of it (M6).
    expect(calls[0]!.startsWith("[out:json]")).toBe(true);
  });

  test("the box is drawn around the SEGMENTS, not the city point", async () => {
    // A trip can reach well past a city centroid, and a box tight around the
    // segments returns stations with no lines attached.
    const { db } = await tripDb("bbox");
    const calls: string[] = [];
    const out = await runTransitCommand(db, [], true, { overpass: fakeOverpass(calls) });
    const j = JSON.parse(out);
    expect(j.bbox[0]).toBeLessThan(29.5556826);
    expect(j.bbox[2]).toBeGreaterThan(29.5650738);
    expect(j.fetched).toBe(true);
  });

  test("no active trip is an error naming the fix", async () => {
    const p = join(tmpdir(), `trip-m12-cmd-none-${process.pid}.db`);
    rmSync(p, { force: true });
    const db = openDb(p);
    await migrate(db);
    await expect(runTransitCommand(db, [], false, { overpass: fakeOverpass() }))
      .rejects.toThrow(/no active trip/);
  });

  test("no destination is an error that explains WHY it matters", async () => {
    const { db } = await tripDb("nodest", { destination: false });
    await expect(runTransitCommand(db, [], false, { overpass: fakeOverpass() }))
      .rejects.toThrow(/stored per city/);
  });

  test("no placed segments is an error, not an empty box", async () => {
    const { db } = await tripDb("noseg", { segments: false });
    await expect(runTransitCommand(db, [], false, { overpass: fakeOverpass() }))
      .rejects.toThrow(/nothing to draw a box around/);
  });

  test("an empty network says the constant is still in use", async () => {
    // Absence is loud. "0 stations" alone would read as success.
    const { db } = await tripDb("empty");
    const out = await runTransitCommand(db, [], false, {
      overpass: async () => ({ elements: [] }),
    });
    expect(out).toContain("no rail routes of any kind");
    expect(out).toContain("straight-line constant");
  });

  test("BOTH exported queries are what the command actually sends", async () => {
    // Verbatim, per M6: evidence gathered with a query that differs from the
    // production query is evidence about a different question.
    //
    // The nodes query is checked too, and that is not redundant. fakeOverpass
    // picks its fixture by testing for "node(r)", so a nodes query that had
    // drifted in any OTHER respect -- a changed mode set, a wrong bbox --
    // would still be handed the right body and every other test would pass.
    const { db } = await tripDb("verbatim");
    const calls: string[] = [];
    const out = await runTransitCommand(db, [], true, { overpass: fakeOverpass(calls) });
    const j = JSON.parse(out);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe(overpassQuery(j.bbox));
    expect(calls[1]).toBe(overpassNodesQuery(j.bbox));
  });

  test("the cached --json shape has the SAME KEYS as the fetched one", async () => {
    // A shape that depends on whether a fetch happened makes an agent branch
    // on presence, and a missing `modes` reads as "no modes" rather than "not
    // re-derived".
    const { db } = await tripDb("shape");
    const fetched = JSON.parse(
      await runTransitCommand(db, [], true, { overpass: fakeOverpass() }));
    const cached = JSON.parse(
      await runTransitCommand(db, [], true, { overpass: fakeOverpass() }));
    expect(cached.fetched).toBe(false);
    expect(Object.keys(cached).sort()).toEqual(Object.keys(fetched).sort());
    // null is UNKNOWN, never an empty answer.
    expect(cached.modes).toBeNull();
    expect(cached.bbox).toBeNull();
    expect(cached.relations).toBeNull();
    // What the cached path DOES know, it still reports.
    expect(cached.stations).toBe(fetched.stations);
    expect(cached.segmentsInReach).toBe(fetched.segmentsInReach);
  });
});

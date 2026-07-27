import { test, expect, describe } from "bun:test";
import { RAIL_MODES, overpassQuery, parseNetwork } from "@/transit/fetch";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const FIX = join(import.meta.dir, "fixtures", "m12-transit");
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), "utf8"));

const chongqing = () => parseNetwork(
  load("rail-chongqing-relations.json"),
  load("rail-chongqing-nodes.json"),
);

describe("overpass query", () => {
  test("asks for exactly the four rail modes", async () => {
    const q = overpassQuery([29.2, 106.1, 30.0, 107.0]);
    expect(RAIL_MODES).toEqual(["subway", "monorail", "light_rail", "tram"]);
    for (const m of RAIL_MODES) expect(q).toContain(m);
    expect(q).toContain("29.2,106.1,30,107");
  });

  test("the bounding box reaches the query rather than being described", async () => {
    // M4's viewbox discrepancy survived two milestones because the record
    // paraphrased the query. The box is an argument, so it cannot drift from
    // what was asked.
    const q = overpassQuery([1.5, 2.5, 3.5, 4.5]);
    expect(q).toContain("1.5,2.5,3.5,4.5");
  });
});

describe("the bus trap stays unreachable", () => {
  test("nothing under src/transit names a routing costing", async () => {
    // The recon captured Valhalla answering `costing: "bus"` with HTTP 200 and
    // 13 minutes for a trip pedestrian routing puts at 77. It is a vehicle on
    // bus-legal roads: no stops, no waiting, no transfers, no timetable, and
    // it looks exactly like a transit answer.
    //
    // M12 ships no router call at all, only Overpass. THIS TEST IS THE GUARD
    // THAT IT STAYS THAT WAY. A comment would not survive a refactor.
    const dir = join(import.meta.dir, "..", "src", "transit");
    for (const f of readdirSync(dir)) {
      const src = readFileSync(join(dir, f), "utf8");
      // Comments explaining the trap are fine; a request built from one is not.
      const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
      expect(code).not.toMatch(/costing/i);
      expect(code).not.toMatch(/valhalla/i);
      expect(code).not.toMatch(/multimodal/i);
      expect(code).not.toMatch(/\bbus\b/i);
    }
  });

  test("the mode set contains no road mode", async () => {
    expect(RAIL_MODES).not.toContain("bus");
    expect(RAIL_MODES).not.toContain("trolleybus");
    expect(RAIL_MODES).not.toContain("share_taxi");
  });
});

describe("parsing the captured Chongqing network", () => {
  test("the monorail lines are present, which route=subway alone loses", async () => {
    // Finding 0 of the recon, as a regression guard. Lines 2 and 3 are
    // straddle-beam monorails; asking only for route=subway returns neither,
    // and Liziba - one of the seven places this project has RESOLVED - has no
    // station at all in that capture.
    const n = chongqing();
    expect(n.modes).toContain("monorail");
    expect(n.stations.map((s) => s.name)).toContain("李子坝");
  });

  test("the wide capture finds more stations than the subway-only one did", async () => {
    const wide = chongqing();
    const narrow = parseNetwork(
      load("overpass-subway-relations.json"),
      load("overpass-subway-nodes.json"),
    );
    expect(narrow.stations.map((s) => s.name)).not.toContain("李子坝");
    expect(wide.stations.length).toBeGreaterThan(narrow.stations.length);
    expect(wide.stations.length).toBeGreaterThan(250);
  });

  test("consecutive stops in a relation become directed edges", async () => {
    const n = chongqing();
    expect(n.edges.length).toBeGreaterThan(400);
    for (const e of n.edges) {
      expect(e.fromName).not.toBe(e.toName);
      expect(e.km).toBeGreaterThan(0);
      expect(e.line.length).toBeGreaterThan(0);
    }
  });

  test("every edge names stations the network actually has", async () => {
    // An edge naming a station with no position would route through a node at
    // an unknown place, and haversine to it would answer with 0,0.
    const n = chongqing();
    const names = new Set(n.stations.map((s) => s.name));
    for (const e of n.edges) {
      expect(names.has(e.fromName)).toBe(true);
      expect(names.has(e.toName)).toBe(true);
    }
  });

  test("a station appears once, at the centroid of its stop nodes", async () => {
    // One stop node per platform per direction, so an interchange has several.
    // Grouping by name is what makes a transfer possible in the graph at all.
    const n = chongqing();
    const seen = new Set<string>();
    for (const s of n.stations) {
      expect(seen.has(s.name)).toBe(false);
      seen.add(s.name);
      expect(Number.isFinite(s.latitude)).toBe(true);
      expect(s.latitude).toBeGreaterThan(28);
      expect(s.latitude).toBeLessThan(31);
    }
  });

  test("an empty response parses to an empty network rather than throwing", async () => {
    const n = parseNetwork({ elements: [] }, { elements: [] });
    expect(n.stations).toEqual([]);
    expect(n.edges).toEqual([]);
    expect(n.modes).toEqual([]);
    expect(n.relationCount).toBe(0);
  });
});

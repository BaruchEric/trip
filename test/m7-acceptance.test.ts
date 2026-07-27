import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { ingestMentions } from "@/watch/ingest";
import { parsePoiResponse } from "@/geo/poi";
import { listSegments } from "@/segments";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** M7 acceptance: local script recovers what English misses.
 *
 *  Captured by `test/fixtures/m7-chongqing/capture.ts`, kept beside the
 *  fixtures with the production query written out in full — M4's viewbox
 *  discrepancy survived two milestones because its appendix recorded results
 *  and paraphrased the query. */
const CENTRE = { latitude: 29.56026, longitude: 106.55771 };
const NO_SLEEP = async () => {};
const FIXTURES = join(import.meta.dir, "fixtures", "m7-chongqing");

function slug(name: string): string {
  return name.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-|-$/g, "");
}

function response(name: string): unknown {
  return JSON.parse(readFileSync(join(FIXTURES, `nominatim-${slug(name)}.json`), "utf8"));
}

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-m7-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: ["chongqing", "2026-07-27"],
  });
  await db.execute({
    sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
    args: [1, "https://youtu.be/KHHlcCUTwZA", "2026-07-27T00:00:00Z"],
  });
  return db;
}

describe("M7 acceptance: local script recovers what English misses", () => {
  test("龙门浩老街 returns a result where Longmenhao Old Street returns none", () => {
    expect(parsePoiResponse(response("Longmenhao Old Street"), CENTRE)).toHaveLength(0);
    expect(parsePoiResponse(response("龙门浩老街"), CENTRE)).toHaveLength(1);
  });

  test("魁星楼 likewise", () => {
    expect(parsePoiResponse(response("Kuixinglou"), CENTRE)).toHaveLength(0);
    expect(parsePoiResponse(response("魁星楼"), CENTRE)).toHaveLength(1);
  });

  test("local script is NOT uniformly better -- 十八梯 is MORE ambiguous", () => {
    // The measurement that kills "always query in local script". More
    // candidates means MORE likely to stay queued, so the obvious clever
    // version is measurably worse than doing nothing. This is why the tool
    // infers nothing and the agent decides.
    expect(parsePoiResponse(response("Shibati"), CENTRE)).toHaveLength(2);
    expect(parsePoiResponse(response("十八梯"), CENTRE).length).toBeGreaterThan(2);
  });

  test("two of the five English misses are OSM coverage, not script", () => {
    // M6 filed all five as coverage. Half of that was right, and neither
    // half was distinguishable before M7 tried the other script.
    for (const zh of ["东山咖啡", "防空洞老火锅"]) {
      expect(parsePoiResponse(response(zh), CENTRE)).toHaveLength(0);
    }
  });

  test("a place the video never NAMED is findable once a frame names it", () => {
    // 李子坝 -- the Line 2 monorail through the residential block, which the
    // transcript only ever describes.
    expect(parsePoiResponse(response("李子坝"), CENTRE).length).toBeGreaterThan(0);
  });

  test("a name that already worked is unchanged in either script", () => {
    // Testbed 2 geocoded in M6 and still does. Local script is not a
    // replacement, it is an alternative.
    expect(parsePoiResponse(response("Testbed 2"), CENTRE)).toHaveLength(1);
    expect(parsePoiResponse(response("贰厂文创园"), CENTRE)).toHaveLength(1);
  });

  test("THE RECOVERY: found by 龙门浩老街, called Longmenhao Old Street", async () => {
    // The whole milestone, end to end against captured real responses.
    const db = await freshDb("recovery");
    const r = await ingestMentions(db, 1, 1, [{
      text: "Longmenhao Old Street", atSeconds: 178, dwellMinutes: null,
      tags: [], kind: null, price: [], query: "龙门浩老街",
    }], CENTRE, {
      geocode: async (q) => parsePoiResponse(response(q), CENTRE),
      sleepFn: NO_SLEEP,
    });
    expect(r.geocoded).toBe(1);
    const [seg] = await listSegments(db, 1);
    expect(seg!.name).toBe("Longmenhao Old Street");
    expect(seg!.localName).toContain("龙门浩");
    // The collapse M7 exists to prevent. Before this milestone the only way
    // to geocode this place was to rename it to the Chinese, which left
    // these two identical and rendered a plan Eric cannot read.
    expect(seg!.name).not.toBe(seg!.localName);
  });

  test("without the query, the same mention still misses", async () => {
    // The control. Without it, the test above proves only that ingest works.
    const db = await freshDb("control");
    const r = await ingestMentions(db, 1, 1, [{
      text: "Longmenhao Old Street", atSeconds: 178, dwellMinutes: null,
      tags: [], kind: null, price: [], query: null,
    }], CENTRE, {
      geocode: async (q) => parsePoiResponse(response(q), CENTRE),
      sleepFn: NO_SLEEP,
    });
    expect(r.geocoded).toBe(0);
    expect(r.queued).toBe(1);
  });
});

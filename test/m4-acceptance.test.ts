import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { ingestMentions } from "@/watch/ingest";
import { parsePoiResponse, type PoiCandidate } from "@/geo/poi";
import { listMentions } from "@/mentions";
import { listSegments } from "@/segments";
import { renderReviewQueue } from "@/render-review";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import luohan from "./fixtures/nominatim-luohan-temple.json";
import hongya from "./fixtures/nominatim-hongya-cave.json";
import jiefangbei from "./fixtures/nominatim-jiefangbei.json";

const CHONGQING = { latitude: 29.5630, longitude: 106.5516 };
const NO_SLEEP = async () => {};

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-m4-${tag}-${process.pid}.db`);
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

function hotel(): PoiCandidate {
  return {
    displayName: "你好酒店(重庆解放碑步行街店), 渝中区, 重庆市",
    localName: "你好酒店(重庆解放碑步行街店)",
    latitude: 29.557, longitude: 106.577,
    category: "tourism", type: "hotel", importance: 0.0001,
    osmType: "way", osmId: 9, kmFromCentre: 2.1,
  };
}

describe("M4 acceptance, against captured Nominatim responses", () => {
  // The kinds below were fixed IN THE PLAN, before any response was consulted,
  // and are assigned from the mention text alone. Labelling Jiefangbei
  // `street` because it is known to be the failure case would prove only that
  // the table flags what it was written for.
  const MENTIONS = [
    { text: "Luohan Temple", atSeconds: 100, dwellMinutes: null, tags: [], kind: "temple" as const, price: [] },
    { text: "Hongya Cave", atSeconds: 272, dwellMinutes: null, tags: [], kind: "landmark" as const, price: [] },
    { text: "Jiefangbei Pedestrian Street", atSeconds: 400, dwellMinutes: null, tags: [], kind: "street" as const, price: [] },
  ];

  const RESPONSES: Record<string, unknown> = {
    "Luohan Temple": luohan,
    "Hongya Cave": hongya,
    "Jiefangbei Pedestrian Street": jiefangbei,
  };

  test("the wrong match queues; the two correct ones become segments", async () => {
    const db = await freshDb("acceptance");
    const result = await ingestMentions(
      db, 1, 1, MENTIONS, CHONGQING,
      {
        geocode: async (q) => parsePoiResponse(RESPONSES[q], CHONGQING),
        sleepFn: NO_SLEEP,
      },
    );

    // This single assertion is the milestone.
    expect(result.geocoded).toBe(2);
    expect(result.queued).toBe(1);
    expect(result.failed).toBe(0);

    const pending = (await listMentions(db, 1)).filter((m) => m.state === "pending");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.text).toBe("Jiefangbei Pedestrian Street");
    expect(pending[0]!.reason)
      .toBe("type mismatch: expected street, got tourism/hotel");

    const names = (await listSegments(db, 1)).map((s) => s.name).sort();
    expect(names).toEqual(["Hongya Cave", "Luohan Temple"]);
  });

  test("Hongya Cave really does come back as tourism/attraction", async () => {
    // Captured from the live API with addressdetails=1, which is what
    // geocodePoi sends. WITHOUT that parameter Nominatim reports the same OSM
    // object (way/939578294) as building/yes — the scoping query for the M4
    // design record omitted it, which is why the record first said so.
    //
    // This is why `tourism/attraction` is unmapped rather than filed under
    // `culture`. It is not a hypothetical: it is what `trip` actually sees for
    // a CORRECT match, and as an informative type it would contradict `park`,
    // `street`, `station`, `nature`, `viewpoint` and `neighbourhood`.
    const cands = parsePoiResponse(hongya, CHONGQING);
    expect(cands).toHaveLength(1);
    expect(`${cands[0]!.category}/${cands[0]!.type}`).toBe("tourism/attraction");
  });

  test("the M3 accounting identity survives a demotion", async () => {
    // seg ls --from + review ls + rejected = mention count. Nothing vanishes.
    // M3's worst bugs were all found by two commands describing the same
    // state and disagreeing, not by unit tests.
    const db = await freshDb("accounting");
    const result = await ingestMentions(
      db, 1, 1,
      [{ text: "Jiefangbei Pedestrian Street", atSeconds: 400,
         dwellMinutes: null, tags: [], kind: "street", price: [] }],
      CHONGQING,
      { geocode: async () => [hotel()], sleepFn: NO_SLEEP },
    );

    const all = await listMentions(db, 1);
    const segments = await listSegments(db, 1);
    const pending = all.filter((m) => m.state === "pending");
    const rejected = all.filter((m) => m.state === "rejected");
    expect(segments.length + pending.length + rejected.length).toBe(result.total);
  });

  test("a demoted mention renders its candidate, not just its reason", async () => {
    // M4 creates a state M3 never produced: a reason AND a candidate. In M3
    // those were disjoint — candidates meant ambiguous, a reason meant no
    // match. A renderer branching on `reason` would print the reason and hide
    // the candidate, leaving --pick=1 working and invisible.
    // render-review.ts branches on candidates.length, so it is already
    // correct; nothing currently forces it to stay that way except this.
    const db = await freshDb("render");
    await ingestMentions(
      db, 1, 1,
      [{ text: "Jiefangbei Pedestrian Street", atSeconds: 400,
         dwellMinutes: null, tags: [], kind: "street", price: [] }],
      CHONGQING,
      { geocode: async () => [hotel()], sleepFn: NO_SLEEP },
    );

    const pending = (await listMentions(db, 1)).filter((m) => m.state === "pending");
    const out = renderReviewQueue(pending, "Chongqing", 25);
    expect(out).toContain("type mismatch");
    expect(out).toContain("--pick=1");
    expect(out).toContain("你好酒店(重庆解放碑步行街店)");
  });
});

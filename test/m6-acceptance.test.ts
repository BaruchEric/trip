import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { ingestMentions, classify, type MentionSpec } from "@/watch/ingest";
import { parsePoiResponse } from "@/geo/poi";
import { listSegments } from "@/segments";
import { listMentions } from "@/mentions";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** M6 acceptance, against captured responses from the real Chongqing video.
 *
 *  `youtube.com/watch?v=KHHlcCUTwZA`, measured 2026-07-27. The fixtures were
 *  captured by `test/fixtures/m6-chongqing/capture.ts`, which is kept beside
 *  them with the production query written out in full — M4's viewbox
 *  discrepancy survived two milestones precisely because its appendix
 *  recorded results and paraphrased the query.
 *
 *  The centre is the one `trip when Chongqing` actually geocoded during the
 *  run, not a rounded stand-in: a different centre is a different box is a
 *  different question. */
const CENTRE = { latitude: 29.56026, longitude: 106.55771 };
const NO_SLEEP = async () => {};

const FIXTURES = join(import.meta.dir, "fixtures", "m6-chongqing");

function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

/** Read from disk rather than 21 static imports. The capture script writes
 *  these files by the same slug rule, so a name with no fixture throws here
 *  instead of silently geocoding to nothing — which would look exactly like
 *  a real miss and quietly weaken the measurement. */
function response(name: string): unknown {
  const path = join(FIXTURES, `nominatim-${slug(name)}.json`);
  return JSON.parse(readFileSync(path, "utf8"));
}

/** Raw caption name -> the name a human correction produces. Ten of eleven
 *  needed one; `Ring Shopping Park` is what the auto-captions got right. */
const NAMES: [string, string, MentionSpec["kind"]][] = [
  ["Arat Temple", "Luohan Temple", "temple"],
  ["Longman how old street", "Longmenhao Old Street", "street"],
  ["Wulong casts", "Wulong Karst", "nature"],
  ["Tienfu Post House", "Tianfu Inn", "landmark"],
  ["Fisher Gorge", "Longshuixia Fissure Gorge", "nature"],
  ["Don Shan Cafe", "Dongshan Cafe", "restaurant"],
  ["Shabbati", "Shibati", "neighbourhood"],
  ["Hongadong", "Hongya Cave", "landmark"],
  ["Test Bed Creative Park", "Testbed 2", "neighbourhood"],
  ["Ring Shopping Park", "Ring Shopping Park", "shop"],
  ["Ji Fang Bay Pedestrian Street", "Jiefangbei Pedestrian Street", "street"],
];

function specs(which: "raw" | "corrected"): MentionSpec[] {
  return NAMES.map(([raw, fixed, kind], i) => ({
    text: which === "raw" ? raw : fixed,
    atSeconds: 100 + i,
    dwellMinutes: null,
    tags: [],
    kind,
    price: [],
  }));
}

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-m6-${tag}-${process.pid}.db`);
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

const geocode = async (q: string) => parsePoiResponse(response(q), CENTRE);

describe("M6 acceptance, against the real Chongqing video", () => {
  test("raw caption names geocode 1 of 11", async () => {
    // THE measurement. Ten of eleven proper nouns are mangled by the
    // auto-captions, and every failure is "no match" rather than a wrong
    // match — the safe direction M3 and M4 designed for, holding on real
    // data for the first time.
    const db = await freshDb("raw");
    const r = await ingestMentions(db, 1, 1, specs("raw"), CENTRE,
      { geocode, sleepFn: NO_SLEEP });
    expect(r.total).toBe(11);
    expect(r.geocoded).toBe(1);
    expect(r.queued).toBe(10);
    expect(r.failed).toBe(0);
    // The one that survives is the name the captions got right.
    expect((await listSegments(db, 1))[0]!.name).toBe("Ring Shopping Park");
  });

  test("every raw failure is 'no match', never a wrong confident match", async () => {
    // The direction matters more than the rate. A 9% hit rate is survivable;
    // a 9% hit rate plus wrong segments would not be.
    const db = await freshDb("rawdirection");
    await ingestMentions(db, 1, 1, specs("raw"), CENTRE,
      { geocode, sleepFn: NO_SLEEP });
    const pending = (await listMentions(db, 1)).filter((m) => m.state === "pending");
    expect(pending).toHaveLength(10);
    for (const m of pending) expect(m.reason).toMatch(/no match/);
  });

  test("corrected names geocode 4 of 11", async () => {
    // Correcting the names by hand is the whole delta: 9% to 36%. That is
    // why the agent contract now says to do it.
    const db = await freshDb("corrected");
    const r = await ingestMentions(db, 1, 1, specs("corrected"), CENTRE,
      { geocode, sleepFn: NO_SLEEP });
    expect(r.geocoded).toBe(4);
    expect((await listSegments(db, 1)).map((s) => s.name).sort()).toEqual([
      "Hongya Cave", "Luohan Temple", "Ring Shopping Park", "Testbed 2",
    ]);
  });

  test("Ring Shopping Park geocodes -- M4's record said it could not", () => {
    // The correction Task 6 wrote into M4's appendix, held by a test so it
    // cannot quietly revert to the old claim. It returned n=0 only through
    // M4's hand-typed viewbox, which was under half the area of the real one.
    const c = parsePoiResponse(response("Ring Shopping Park"), CENTRE);
    expect(c).toHaveLength(1);
    expect(c[0]!.localName).toContain("光环");
  });

  test("Jiefangbei still queues on the M4 type mismatch", async () => {
    // M4's plausibility check, confirmed against a live capture. This is the
    // first time that mechanism has been exercised on data from the video it
    // was designed against.
    const c = parsePoiResponse(response("Jiefangbei Pedestrian Street"), CENTRE);
    expect(c).toHaveLength(1);
    const v = classify(c, "street");
    expect(v.kind).toBe("queued");
    if (v.kind === "queued") expect(v.reason).toMatch(/type mismatch/);
  });

  test("Shibati queues on ambiguity, not on a wrong pick", async () => {
    // Two candidates. M3's uniqueness rule refuses to choose, which is the
    // behaviour that keeps a 36% hit rate honest rather than a 45% one that
    // is sometimes wrong.
    const c = parsePoiResponse(response("Shibati"), CENTRE);
    expect(c).toHaveLength(2);
    const v = classify(c, "neighbourhood");
    expect(v.kind).toBe("queued");
  });

  test("a correct name can still miss, and that is OSM's coverage not ours", async () => {
    // Longmenhao Old Street, Dongshan Cafe, Wulong Karst, Tianfu Inn and
    // Longshuixia Fissure Gorge are all real places with correct English
    // names that OSM does not carry inside the box. Recorded so nobody
    // "fixes" the geocoder for something it is not doing wrong.
    for (const name of [
      "Longmenhao Old Street", "Dongshan Cafe", "Wulong Karst",
      "Tianfu Inn", "Longshuixia Fissure Gorge",
    ]) {
      expect(parsePoiResponse(response(name), CENTRE)).toHaveLength(0);
    }
  });
});

import { expect, test, describe } from "bun:test";
import {
  parseMentionsFile, classify, DEFAULT_DWELL_MINUTES, ingestMentions,
} from "@/watch/ingest";
import { parsePoiResponse, type PoiCandidate } from "@/geo/poi";
import { openDb, migrate } from "@/db";
import { listMentions } from "@/mentions";
import { listSegments } from "@/segments";
import { readPriceRules } from "@/prices";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function poi(name: string): PoiCandidate {
  return {
    displayName: name, localName: name,
    latitude: 29.56, longitude: 106.55,
    category: "amenity", type: "restaurant", importance: 0.0001,
    osmType: "node", osmId: 1, kmFromCentre: 1.2,
  };
}

describe("parseMentionsFile", () => {
  test("reads the full form", () => {
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "Hongya Cave", at: "04:32", dwell: "90m", tags: ["sight"] },
    ]));
    expect(errors).toEqual([]);
    expect(specs[0]).toEqual({
      text: "Hongya Cave", atSeconds: 272, dwellMinutes: 90, tags: ["sight"],
      kind: null, price: [],
    });
  });

  test("optional fields are absent, not defaulted", () => {
    const { specs } = parseMentionsFile(JSON.stringify([{ text: "hot pot" }]));
    // dwell stays NULL here; the 60-minute default is applied at segment
    // creation and flagged there, so "nobody said" survives in the mention.
    expect(specs[0]).toEqual({
      text: "hot pot", atSeconds: null, dwellMinutes: null, tags: [],
      kind: null, price: [],
    });
  });

  test("accepts minutes beyond 59 in a timestamp", () => {
    const { specs } = parseMentionsFile(JSON.stringify([{ text: "x", at: "102:15" }]));
    expect(specs[0]!.atSeconds).toBe(6135);
  });

  test("a malformed entry is reported by index and the rest still parse", () => {
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "good" },
      { text: "bad time", at: "banana" },
      { text: "also good" },
    ]));
    expect(specs.length).toBe(2);
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("[1]");
  });

  test("an entry with no text is rejected", () => {
    const { specs, errors } = parseMentionsFile(JSON.stringify([{ at: "01:00" }]));
    expect(specs).toEqual([]);
    expect(errors[0]).toMatch(/text/i);
  });

  test("a non-array body is a hard error", () => {
    expect(() => parseMentionsFile(JSON.stringify({ text: "x" }))).toThrow(/array/i);
  });

  test("an explicit null at, dwell, or tags reads as absent, not as an error", () => {
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "hot pot", at: null, dwell: null, tags: null },
    ]));
    expect(errors).toEqual([]);
    expect(specs[0]).toEqual({
      text: "hot pot", atSeconds: null, dwellMinutes: null, tags: [],
      kind: null, price: [],
    });
  });

  test("a non-array tags field rejects that entry only", () => {
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "good" },
      { text: "bad tags", tags: "food" },
    ]));
    expect(specs.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/^\[1\] tags/);
  });

  test("a tag containing a comma is rejected, and the rest of the file still parses", () => {
    // Tags share one comma-separated storage column (src/validate.ts's
    // joinList). Without this check, a comma-bearing tag parses cleanly here
    // and then throws deep inside createMention -> joinList mid-ingest,
    // aborting every mention after it in the same batch.
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "good" },
      { text: "bad tags", tags: ["food,drink"] },
    ]));
    expect(specs.length).toBe(1);
    expect(errors.length).toBe(1);
    expect(errors[0]).toMatch(/^\[1\]/);
    expect(errors[0]).toMatch(/comma/i);
  });

  test("invalid JSON is a hard error naming the problem", () => {
    expect(() => parseMentionsFile("{not json")).toThrow(/JSON/i);
  });

  test("kind is read when present and NULL when absent", () => {
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "Jiefangbei Pedestrian Street", kind: "street", price: [] },
      { text: "hot pot" },
    ]));
    expect(errors).toEqual([]);
    expect(specs[0]!.kind).toBe("street");
    expect(specs[1]!.kind).toBeNull();
  });

  test("an unrecognised kind is rejected with its index; neighbours still ingest", () => {
    // Silently ignoring it would let one typo disable the check with no signal.
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "Luohan Temple", kind: "temple", price: [] },
      { text: "Hongya Cave", kind: "cave", price: [] },
      { text: "Liziba Station", kind: "station", price: [] },
    ]));
    expect(specs).toHaveLength(2);
    expect(specs.map((s) => s.text)).toEqual(["Luohan Temple", "Liziba Station"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[1]");
    expect(errors[0]).toContain("cave");
  });

  test("every M3-era mentions file still PARSES unchanged", () => {
    // Backward compatibility at the parse boundary, asserted rather than
    // assumed: `kind` is additive and optional, so a file written before M4
    // existed produces exactly the specs it always did, with kind NULL.
    //
    // Deliberately scoped to parsing. At INGEST, a no-kind file does not
    // always behave as it did in M3: the denylist queues a lone lodging or
    // retail match that M3 would have made a confident segment. That is the
    // milestone working, not a compatibility break — do not "fix" the
    // denylist to make this sentence true of ingest too.
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "Hongya Cave", at: "04:32", dwell: "90m", tags: ["sight"] },
    ]));
    expect(errors).toEqual([]);
    expect(specs[0]).toEqual({
      text: "Hongya Cave", atSeconds: 272, dwellMinutes: 90,
      tags: ["sight"], kind: null, price: [],
    });
  });
});

describe("classify", () => {
  test("exactly one result is confident", () => {
    const v = classify([poi("洪崖洞")], null);
    expect(v.kind).toBe("confident");
  });

  test("no results are queued with a reason that says so", () => {
    const v = classify([], null);
    expect(v).toEqual({ kind: "queued", reason: "no match" });
  });

  test("several results are queued with the count", () => {
    const v = classify([poi("a"), poi("b"), poi("c"), poi("d"), poi("e")], null);
    expect(v).toEqual({ kind: "queued", reason: "5 candidates" });
  });

  test("importance never promotes an ambiguous match", () => {
    // Real data: every Chongqing restaurant sits at importance 0.0001, and
    // Hongya Cave at 0.34. Thresholding on it would queue every food segment,
    // so uniqueness is the whole rule.
    const strong = { ...poi("famous"), importance: 0.9 };
    expect(classify([strong, poi("other")], null).kind).toBe("queued");
  });

  test("low importance never demotes a unique match", () => {
    expect(classify([{ ...poi("obscure"), importance: 0.0001 }], null).kind).toBe("confident");
  });

  test("a lone result contradicting its declared kind is demoted to queued", () => {
    // Jiefangbei Pedestrian Street: one result, a hotel whose name merely
    // CONTAINS the street's. The single wrong confident match M3 measured,
    // and the reason this milestone exists.
    const hotel = { ...poi("你好酒店"), category: "tourism", type: "hotel" };
    const v = classify([hotel], "street");
    expect(v.kind).toBe("queued");
    expect(v.kind === "queued" && v.reason)
      .toBe("type mismatch: expected street, got tourism/hotel");
  });

  test("a lone result with an uninformative type stays confident", () => {
    // Hongya Cave. The naive form of this check would have queued it.
    const cave = { ...poi("洪崖洞"), category: "building", type: "yes" };
    expect(classify([cave], "landmark").kind).toBe("confident");
    expect(classify([cave], "park").kind).toBe("confident");
  });

  test("a lone compatible result stays confident", () => {
    const temple = { ...poi("罗汉寺"), category: "amenity", type: "place_of_worship" };
    expect(classify([temple], "temple").kind).toBe("confident");
  });

  test("the check does not run at zero or two-plus results", () => {
    // Uniqueness already queues those, so a contradiction there changes no
    // outcome. Asserted rather than assumed: the reasons must stay M3's.
    const hotel = { ...poi("h"), category: "tourism", type: "hotel" };
    const v0 = classify([], "street");
    expect(v0.kind === "queued" && v0.reason).toBe("no match");
    const v2 = classify([hotel, hotel], "street");
    expect(v2.kind === "queued" && v2.reason).toBe("2 candidates");
  });

  test("with no declared kind, a lone hotel queues and a lone restaurant does not", () => {
    const hotel = { ...poi("h"), category: "tourism", type: "hotel" };
    const food = { ...poi("f"), category: "amenity", type: "restaurant" };
    expect(classify([hotel], null).kind).toBe("queued");
    expect(classify([food], null).kind).toBe("confident");
  });

  test("a declared compatible kind beats the denylist", () => {
    // A video that genuinely recommends a hotel.
    const hotel = { ...poi("h"), category: "tourism", type: "hotel" };
    expect(classify([hotel], "hotel").kind).toBe("confident");
  });
});

describe("ingestMentions, demotion", () => {
  test("a demoted mention is queued WITH its candidate, so --pick=1 can accept it", async () => {
    const db = await ingestDb("demote");
    const hotel = { ...poi("你好酒店"), category: "tourism", type: "hotel" };

    const result = await ingestMentions(
      db, 1, 1,
      [{ text: "Jiefangbei Pedestrian Street", atSeconds: 272,
         dwellMinutes: null, tags: [], kind: "street", price: [] }],
      CENTRE,
      { geocode: async () => [hotel], sleepFn: NO_SLEEP },
    );

    expect(result.geocoded).toBe(0);
    expect(result.queued).toBe(1);

    // The escape hatch is load-bearing: a check with a non-zero
    // false-positive rate must leave a one-command path to say "no, that is
    // right". Without the candidate there is no --pick to run.
    const [m] = await listMentions(db, 1);
    expect(m!.reason).toContain("type mismatch");
    expect(m!.segmentId).toBeNull();
    expect(m!.candidates).toHaveLength(1);
    expect(m!.candidates[0]!.rank).toBe(1);
    // No segment was created for it.
    expect(await listSegments(db, 1)).toHaveLength(0);
  });
});

describe("DEFAULT_DWELL_MINUTES", () => {
  test("is 60", () => {
    expect(DEFAULT_DWELL_MINUTES).toBe(60);
  });
});

async function ingestDb(tag: string) {
  const p = join(tmpdir(), `trip-ingest-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await db.execute({
    sql: `INSERT INTO trips (name, created_at) VALUES (?, ?)`,
    args: ["chongqing", "2026-07-27"],
  });
  await db.execute({
    sql: `INSERT INTO sources (trip_id, url, fetched_at) VALUES (?, ?, ?)`,
    args: [1, "https://youtu.be/x", "2026-07-27T00:00:00Z"],
  });
  return db;
}

const CENTRE = { latitude: 29.5630, longitude: 106.5516 };
const NO_SLEEP = async () => {};

describe("ingestMentions", () => {
  test("a unique match becomes a segment carrying its provenance", async () => {
    const db = await ingestDb("confident");
    const r = await ingestMentions(db, 1, 1,
      [{ text: "Hongya Cave", atSeconds: 272, dwellMinutes: 90, tags: ["sight"], kind: null, price: [] }],
      CENTRE,
      { geocode: async () => [poi("洪崖洞")], sleepFn: NO_SLEEP },
    );
    expect(r).toEqual({ total: 1, geocoded: 1, queued: 0, failed: 0 });

    const [seg] = await listSegments(db, 1);
    expect(seg!.name).toBe("Hongya Cave");
    expect(seg!.localName).toBe("洪崖洞");
    expect(seg!.sourceId).toBe(1);
    expect(seg!.sourceAtSeconds).toBe(272);
    expect(seg!.dwellMinutes).toBe(90);
    expect(seg!.dwellIsDefault).toBe(false);
    expect(seg!.tags).toEqual(["sight"]);
    // Hours, price, and closed days are UNKNOWN, not invented. A geocoder does
    // not know any of them, and a fabricated value here is worse than the NULL
    // that says "nobody has answered this yet" (mutation sweep: both `cost`
    // and `closedDays` were unchecked and a hardcoded value survived).
    expect(seg!.opensMin).toBeNull();
    expect(seg!.closesMin).toBeNull();
    expect(seg!.closedDays).toEqual([]);
    expect(seg!.freeDays).toEqual([]);
    // M5: price is the ABSENCE of a rule row, not a null column. Asserting the
    // owner is absent from the map is the same fact the `cost` assertion used
    // to carry, and it is stronger -- a zero rule would now be visible here.
    expect((await readPriceRules(db, "segment", [seg!.id])).has(seg!.id)).toBe(false);

    const [m] = await listMentions(db, 1);
    expect(m!.state).toBe("resolved");
    expect(m!.segmentId).toBe(seg!.id);
    // A resolved mention keeps its candidate on record too. `unlinkSegment`
    // (src/mentions.ts) returns a mention to the queue if its segment is ever
    // deleted, and a resolved mention with no stored candidates would come
    // back to the queue with nothing for `--pick` to choose from.
    expect(m!.candidates.length).toBe(1);
    expect(m!.candidates[0]!.localName).toBe("洪崖洞");
  });

  test("localName carries OSM's own name, not its address string", async () => {
    // Regression: poi()'s displayName and localName are equal in every other
    // fixture in this file, so a bug swapping the two fields would pass every
    // other assertion here silently (mutation sweep found this).
    const db = await ingestDb("localname");
    await ingestMentions(db, 1, 1,
      [{ text: "Hongya Cave", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] }],
      CENTRE,
      {
        geocode: async () => [{
          ...poi("洪崖洞"),
          displayName: "Hongya Cave, Cangbai Rd, Yuzhong, Chongqing, China",
        }],
        sleepFn: NO_SLEEP,
      },
    );
    const [seg] = await listSegments(db, 1);
    expect(seg!.localName).toBe("洪崖洞");
  });

  test("no proposed dwell yields 60 minutes, flagged as a default", async () => {
    const db = await ingestDb("default-dwell");
    await ingestMentions(db, 1, 1,
      [{ text: "Hongya Cave", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] }],
      CENTRE, { geocode: async () => [poi("洪崖洞")], sleepFn: NO_SLEEP },
    );
    const [seg] = await listSegments(db, 1);
    expect(seg!.dwellMinutes).toBe(DEFAULT_DWELL_MINUTES);
    expect(seg!.dwellIsDefault).toBe(true);
  });

  test("an ambiguous match is queued with all its candidates and no segment", async () => {
    const db = await ingestDb("ambiguous");
    const r = await ingestMentions(db, 1, 1,
      [{ text: "hot pot", atSeconds: 400, dwellMinutes: null, tags: [], kind: null, price: [] }],
      CENTRE,
      { geocode: async () => [poi("a"), poi("b"), poi("c")], sleepFn: NO_SLEEP },
    );
    expect(r).toEqual({ total: 1, geocoded: 0, queued: 1, failed: 0 });
    expect(await listSegments(db, 1)).toEqual([]);

    const [m] = await listMentions(db, 1);
    expect(m!.state).toBe("pending");
    expect(m!.reason).toBe("3 candidates");
    expect(m!.candidates.length).toBe(3);
    expect(m!.candidates.map((c) => c.rank)).toEqual([1, 2, 3]);
  });

  test("no match is queued with a reason and no candidates", async () => {
    const db = await ingestDb("nomatch");
    const r = await ingestMentions(db, 1, 1,
      [{ text: "that ramen spot", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] }],
      CENTRE, { geocode: async () => [], sleepFn: NO_SLEEP },
    );
    expect(r.queued).toBe(1);
    const [m] = await listMentions(db, 1);
    expect(m!.reason).toBe("no match");
    expect(m!.candidates).toEqual([]);
  });

  test("an unusable result inside a two-result response cannot upgrade an ambiguous match to confident", async () => {
    // Regression (M3 final review): parsePoiResponse used to silently drop a
    // result missing coordinates or a name. A two-result response with one
    // droppable entry then counted as ONE candidate, and classify() (this
    // file) made a mention the confidence rule says must be QUEUED into a
    // confident segment with no review and no mark. parsePoiResponse now
    // throws instead of dropping (src/geo/poi.ts); ingestMentions's existing
    // try/catch around the geocode call queues the mention with that message
    // as its reason, so the mention below must stay PENDING, not resolved.
    const db = await ingestDb("unusable-result");
    const r = await ingestMentions(db, 1, 1,
      [{ text: "hot pot", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] }],
      CENTRE,
      {
        geocode: async (q, c) => parsePoiResponse([
          {
            lat: "29.5630", lon: "106.5670",
            name: "夜福火锅", display_name: "夜福火锅, 北区路, 解放碑, 渝中区, 重庆市, 中国",
          },
          { lat: undefined, lon: undefined, name: "地下之城老火锅" },
        ], c),
        sleepFn: NO_SLEEP,
      },
    );
    expect(r).toEqual({ total: 1, geocoded: 0, queued: 0, failed: 1 });
    expect(await listSegments(db, 1)).toEqual([]);

    const [m] = await listMentions(db, 1);
    expect(m!.state).toBe("pending");
    expect(m!.reason).toContain("geocode failed");
    expect(m!.reason).toContain("unusable geocode result");
  });

  test("one failed lookup does not abort the others", async () => {
    const db = await ingestDb("resilient");
    let call = 0;
    const r = await ingestMentions(db, 1, 1, [
      { text: "first", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] },
      { text: "boom", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] },
      { text: "third", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] },
    ], CENTRE, {
      geocode: async () => {
        call += 1;
        if (call === 2) throw new Error("geocoding failed (HTTP 429)");
        return [poi("ok")];
      },
      sleepFn: NO_SLEEP,
    });
    expect(r).toEqual({ total: 3, geocoded: 2, queued: 0, failed: 1 });
    const failed = (await listMentions(db, 1)).find((m) => m.text === "boom");
    expect(failed!.state).toBe("pending");
    expect(failed!.reason).toContain("geocode failed");
    expect(failed!.reason).toContain("429");
  });

  test("a geocode result that fails segment creation is queued, and the batch survives", async () => {
    // A malformed or hostile API response can carry an out-of-range
    // coordinate (parsePoiResponse only checks lat/lon are finite, not in
    // range). That reaches addSegment's own validate(), which throws — and
    // until this fix, that throw was outside ingestMentions's try, aborting
    // the whole batch after any earlier mentions had already been written.
    const db = await ingestDb("segment-fail");
    const r = await ingestMentions(db, 1, 1, [
      { text: "bad coords", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] },
      { text: "good spot", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] },
    ], CENTRE, {
      geocode: async (q) => q === "bad coords"
        ? [{ ...poi("x"), latitude: 999 }]
        : [poi("洪崖洞")],
      sleepFn: NO_SLEEP,
    });
    expect(r).toEqual({ total: 2, geocoded: 1, queued: 0, failed: 1 });

    const mentions = await listMentions(db, 1);
    const bad = mentions.find((m) => m.text === "bad coords");
    expect(bad!.state).toBe("pending");
    expect(bad!.reason).toMatch(/could not create segment/);

    // The point of the fix: the SECOND, well-formed mention in the same
    // batch still became a segment, rather than the batch dying on the first.
    const good = mentions.find((m) => m.text === "good spot");
    expect(good!.state).toBe("resolved");
    const segs = await listSegments(db, 1);
    expect(segs.length).toBe(1);
    expect(segs[0]!.name).toBe("good spot");
  });

  test("lookups are spaced to respect the 1 req/sec policy", async () => {
    const db = await ingestDb("throttle");
    const waits: number[] = [];
    await ingestMentions(db, 1, 1, [
      { text: "a", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] },
      { text: "b", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] },
      { text: "c", atSeconds: null, dwellMinutes: null, tags: [], kind: null, price: [] },
    ], CENTRE, {
      geocode: async () => [],
      sleepFn: async (ms) => { waits.push(ms); },
    });
    // Two gaps for three lookups: nothing is waited for before the first.
    expect(waits.length).toBe(2);
    expect(waits.every((w) => w >= 1000)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// M5 — the agent contract carries `price`.
// ---------------------------------------------------------------------------

describe("the price field on the agent contract", () => {
  test("absent price parses to no rules, which is UNKNOWN not free", () => {
    const { specs, errors } = parseMentionsFile(
      JSON.stringify([{ text: "Hongya Cave" }]));
    expect(errors).toEqual([]);
    expect(specs[0]!.price).toEqual([]);
  });

  test("price rules parse as raw strings, validated at parse time", () => {
    const { specs, errors } = parseMentionsFile(
      JSON.stringify([{ text: "Hongya Cave", price: ["30", "65+:0"] }]));
    expect(errors).toEqual([]);
    expect(specs[0]!.price).toEqual(["30", "65+:0"]);
  });

  test("a malformed price rejects that entry alone, naming its index", () => {
    // Same contract as dwell and kind: losing thirteen good mentions to one
    // bad one is the wrong trade.
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "Good", price: ["30"] },
      { text: "Bad", price: ["sixty"] },
    ]));
    expect(specs.map((s) => s.text)).toEqual(["Good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("[1]");
    expect(errors[0]).toMatch(/sixty/);
  });

  test("overlapping rules from a video reject that mention, not the file", () => {
    // Validated HERE rather than deep inside setPriceRules mid-ingest, which
    // would abort every mention after it in the same batch.
    const { specs, errors } = parseMentionsFile(JSON.stringify([
      { text: "Good", price: ["30"] },
      { text: "Bad", price: ["60-70:5", "65+:0"] },
    ]));
    expect(specs.map((s) => s.text)).toEqual(["Good"]);
    expect(errors[0]).toMatch(/overlapping/);
  });

  test("a non-array price is rejected", () => {
    const { errors } = parseMentionsFile(
      JSON.stringify([{ text: "X", price: "30" }]));
    expect(errors[0]).toMatch(/must be an array/);
  });

  test("an empty rule string is rejected", () => {
    const { errors } = parseMentionsFile(
      JSON.stringify([{ text: "X", price: ["30", ""] }]));
    expect(errors[0]).toMatch(/non-empty/);
  });

  test("a confidently ingested mention's price becomes the segment's rules", async () => {
    const db = await ingestDb("price-confident");
    await ingestMentions(db, 1, 1,
      [{ text: "Hongya Cave", atSeconds: 272, dwellMinutes: 90, tags: [],
         kind: null, price: ["30", "65+:0"] }],
      CENTRE,
      { geocode: async () => [poi("洪崖洞")], sleepFn: NO_SLEEP },
    );
    const [seg] = await listSegments(db, 1);
    expect((await readPriceRules(db, "segment", [seg!.id])).get(seg!.id)!
      .map((r) => r.price)).toEqual([30, 0]);
  });

  test("a mention with no price produces NO rules, not a zero rule", async () => {
    const db = await ingestDb("price-absent");
    await ingestMentions(db, 1, 1,
      [{ text: "Hongya Cave", atSeconds: 272, dwellMinutes: 90, tags: [],
         kind: null, price: [] }],
      CENTRE,
      { geocode: async () => [poi("洪崖洞")], sleepFn: NO_SLEEP },
    );
    const [seg] = await listSegments(db, 1);
    expect((await readPriceRules(db, "segment", [seg!.id])).has(seg!.id)).toBe(false);
  });

  test("price round-trips on the mention row itself, for the queued path", async () => {
    // A queued mention has no segment to own price_rules, so the rules live
    // on the mention until it resolves.
    const db = await ingestDb("price-queued");
    await ingestMentions(db, 1, 1,
      [{ text: "somewhere vague", atSeconds: null, dwellMinutes: null, tags: [],
         kind: null, price: ["30"] }],
      CENTRE,
      { geocode: async () => [], sleepFn: NO_SLEEP },
    );
    const [m] = await listMentions(db, 1);
    expect(m!.state).toBe("pending");
    expect(m!.price).toEqual(["30"]);
  });
});

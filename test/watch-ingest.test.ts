import { expect, test, describe } from "bun:test";
import { parseMentionsFile, classify, DEFAULT_DWELL_MINUTES } from "@/watch/ingest";
import type { PoiCandidate } from "@/geo/poi";

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
    });
  });

  test("optional fields are absent, not defaulted", () => {
    const { specs } = parseMentionsFile(JSON.stringify([{ text: "hot pot" }]));
    // dwell stays NULL here; the 60-minute default is applied at segment
    // creation and flagged there, so "nobody said" survives in the mention.
    expect(specs[0]).toEqual({
      text: "hot pot", atSeconds: null, dwellMinutes: null, tags: [],
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

  test("invalid JSON is a hard error naming the problem", () => {
    expect(() => parseMentionsFile("{not json")).toThrow(/JSON/i);
  });
});

describe("classify", () => {
  test("exactly one result is confident", () => {
    const v = classify([poi("洪崖洞")]);
    expect(v.kind).toBe("confident");
  });

  test("no results are queued with a reason that says so", () => {
    const v = classify([]);
    expect(v).toEqual({ kind: "queued", reason: "no match" });
  });

  test("several results are queued with the count", () => {
    const v = classify([poi("a"), poi("b"), poi("c"), poi("d"), poi("e")]);
    expect(v).toEqual({ kind: "queued", reason: "5 candidates" });
  });

  test("importance never promotes an ambiguous match", () => {
    // Real data: every Chongqing restaurant sits at importance 0.0001, and
    // Hongya Cave at 0.34. Thresholding on it would queue every food segment,
    // so uniqueness is the whole rule.
    const strong = { ...poi("famous"), importance: 0.9 };
    expect(classify([strong, poi("other")]).kind).toBe("queued");
  });

  test("low importance never demotes a unique match", () => {
    expect(classify([{ ...poi("obscure"), importance: 0.0001 }]).kind).toBe("confident");
  });
});

describe("DEFAULT_DWELL_MINUTES", () => {
  test("is 60", () => {
    expect(DEFAULT_DWELL_MINUTES).toBe(60);
  });
});

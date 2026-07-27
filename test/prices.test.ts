import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { setPriceRules, readPriceRules, deletePriceRules } from "@/prices";
import { parsePriceRule } from "@/pricing/rules";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-prices-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  return db;
}

describe("price rule storage", () => {
  test("rules round-trip in insertion order", async () => {
    // Order matters: the base rule is a fallback, and a reader that shuffled
    // them would still resolve correctly but would render them in an order
    // the user did not type.
    const db = await freshDb("roundtrip");
    const rules = [parsePriceRule("30"), parsePriceRule("65+:0")];
    await setPriceRules(db, "segment", 1, rules);
    expect((await readPriceRules(db, "segment", [1])).get(1)).toEqual(rules);
  });

  test("an owner with no rules is ABSENT from the map, not an empty array", async () => {
    // Absence is loud, expressed in the return type: a caller can tell "no
    // rules" from "never asked", and `?? []` reads as unknown.
    const db = await freshDb("absent");
    expect((await readPriceRules(db, "segment", [7])).has(7)).toBe(false);
  });

  test("no owner ids means no query and an empty map", async () => {
    const db = await freshDb("noids");
    expect((await readPriceRules(db, "segment", [])).size).toBe(0);
  });

  test("setting replaces rather than appends", async () => {
    const db = await freshDb("replace");
    await setPriceRules(db, "segment", 1, [parsePriceRule("30")]);
    await setPriceRules(db, "segment", 1, [parsePriceRule("40")]);
    const back = (await readPriceRules(db, "segment", [1])).get(1)!;
    expect(back).toEqual([parsePriceRule("40")]);
  });

  test("setting an empty rule set clears the owner back to unknown", async () => {
    const db = await freshDb("clear");
    await setPriceRules(db, "segment", 1, [parsePriceRule("30")]);
    await setPriceRules(db, "segment", 1, []);
    expect((await readPriceRules(db, "segment", [1])).has(1)).toBe(false);
  });

  test("segment and pass rules with the same owner id do not collide", async () => {
    // One table, two owners. Without owner_kind in the WHERE clause, pass #1
    // would silently inherit segment #1's admission price.
    const db = await freshDb("kinds");
    await setPriceRules(db, "segment", 1, [parsePriceRule("30")]);
    await setPriceRules(db, "pass", 1, [parsePriceRule("45")]);
    expect((await readPriceRules(db, "segment", [1])).get(1)![0]!.price).toBe(30);
    expect((await readPriceRules(db, "pass", [1])).get(1)![0]!.price).toBe(45);
  });

  test("an invalid rule set is rejected AT THE STORE, not just at the CLI", async () => {
    // The M4 lesson, applied before it can bite: ingest and review resolve
    // both write segments without ever touching an argv parser.
    const db = await freshDb("validate");
    await expect(
      setPriceRules(db, "segment", 1, [{ minAge: null, maxAge: null, price: Infinity }]),
    ).rejects.toThrow(/invalid price/);
    await expect(
      setPriceRules(db, "segment", 1, [{ minAge: null, maxAge: null, price: -1 }]),
    ).rejects.toThrow(/negative price/);
    await expect(
      setPriceRules(db, "segment", 1, [parsePriceRule("60-70:5"), parsePriceRule("65+:0")]),
    ).rejects.toThrow(/overlapping/);
    await expect(
      setPriceRules(db, "segment", 1, [parsePriceRule("30"), parsePriceRule("40")]),
    ).rejects.toThrow(/one base price/);
  });

  test("a rejected set leaves the previous rules intact", async () => {
    // Validation runs before the DELETE, so a bad write cannot destroy a good
    // rule set on its way to failing.
    const db = await freshDb("atomic");
    await setPriceRules(db, "segment", 1, [parsePriceRule("30")]);
    await expect(
      setPriceRules(db, "segment", 1, [{ minAge: null, maxAge: null, price: -1 }]),
    ).rejects.toThrow();
    expect((await readPriceRules(db, "segment", [1])).get(1)![0]!.price).toBe(30);
  });

  test("delete removes only the named owner", async () => {
    const db = await freshDb("delete");
    await setPriceRules(db, "segment", 1, [parsePriceRule("30")]);
    await setPriceRules(db, "segment", 2, [parsePriceRule("40")]);
    await deletePriceRules(db, "segment", 1);
    const back = await readPriceRules(db, "segment", [1, 2]);
    expect(back.has(1)).toBe(false);
    expect(back.get(2)![0]!.price).toBe(40);
  });

  test("many owners come back in one query, keyed correctly", async () => {
    const db = await freshDb("batch");
    await setPriceRules(db, "segment", 1, [parsePriceRule("10")]);
    await setPriceRules(db, "segment", 2, [parsePriceRule("20"), parsePriceRule("65+:0")]);
    const back = await readPriceRules(db, "segment", [1, 2, 3]);
    expect(back.get(1)!.length).toBe(1);
    expect(back.get(2)!.length).toBe(2);
    expect(back.has(3)).toBe(false);
  });

  test("a zero price survives as a real rule, not as absence", async () => {
    // 0 is free and free is a fact. If this came back as no-rule, a free
    // museum would be indistinguishable from one nobody has priced.
    const db = await freshDb("zero");
    await setPriceRules(db, "segment", 1, [parsePriceRule("0")]);
    expect((await readPriceRules(db, "segment", [1])).get(1)![0]!.price).toBe(0);
  });
});

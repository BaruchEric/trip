import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runPassCommand } from "@/commands/passes";
import { runTripsCommand } from "@/commands/trips";
import { runDatesCommand } from "@/commands/dates";
import { readPriceRules } from "@/prices";
import { listPasses } from "@/passes";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function withTrip(tag: string, dated = true) {
  const p = join(tmpdir(), `trip-passcmd-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  await runTripsCommand(db, ["new", "chongqing"], false);
  // 2026-10-02..2026-10-06 is five days.
  if (dated) await runDatesCommand(db, ["set", "2026-10-02..2026-10-06"], false);
  return db;
}

describe("trip pass", () => {
  test("pass add stores the pass and its price rules", async () => {
    const db = await withTrip("add");
    await runPassCommand(
      db, ["add", "Metro", "3-day", "--days=2-4", "--price=45", "--price=65+:0"], false);
    const [p] = await listPasses(db, 1);
    expect(p!.name).toBe("Metro 3-day");
    expect(p!.fromDay).toBe(2);
    expect((await readPriceRules(db, "pass", [1])).get(1)!.map((r) => r.price))
      .toEqual([45, 0]);
  });

  test("a pass with no price says it counts as UNKNOWN, not free", async () => {
    const db = await withTrip("noprice");
    const out = await runPassCommand(db, ["add", "Mystery", "--days=1-2"], false);
    expect(out).toContain("UNKNOWN");
    expect((await readPriceRules(db, "pass", [1])).has(1)).toBe(false);
  });

  test("a day range beyond the trip's length is rejected, naming the real count", async () => {
    const db = await withTrip("toolong");
    await expect(
      runPassCommand(db, ["add", "X", "--days=8-10", "--price=45"], false),
    ).rejects.toThrow(/5 days/);
  });

  test("a range ending exactly on the last day is accepted", async () => {
    const db = await withTrip("lastday");
    await runPassCommand(db, ["add", "X", "--days=1-5", "--price=45"], false);
    expect((await listPasses(db, 1)).length).toBe(1);
  });

  test("a day range is NOT validated when the trip has no dates", async () => {
    // A check that cannot be sure says nothing. With no dates there is no day
    // count to check against, and inventing one would be a guess.
    const db = await withTrip("nodates", false);
    await runPassCommand(db, ["add", "X", "--days=8-10", "--price=45"], false);
    expect(await runPassCommand(db, ["ls"], false)).toContain("8-10");
  });

  test("pass add requires --days, naming the pass", async () => {
    const db = await withTrip("nodays");
    await expect(runPassCommand(db, ["add", "X", "--price=45"], false))
      .rejects.toThrow(/--days/);
  });

  test("a malformed --days names the expected form", async () => {
    const db = await withTrip("baddays");
    await expect(runPassCommand(db, ["add", "X", "--days=two", "--price=45"], false))
      .rejects.toThrow(/expected N-M/);
  });

  test("pass add requires a name", async () => {
    const db = await withTrip("noname");
    await expect(runPassCommand(db, ["add", "--days=1-2", "--price=45"], false))
      .rejects.toThrow(/usage/);
  });

  test("passes use the SAME age-rule grammar as segments", async () => {
    // The point of one rule table with two owners: a senior transit discount
    // needs no new concept.
    const db = await withTrip("samegrammar");
    await expect(
      runPassCommand(db, ["add", "X", "--days=1-2", "--price=60-70:5", "--price=65+:0"], false),
    ).rejects.toThrow(/overlapping/);
  });

  test("pass ls shows rules, and ? for a pass with none", async () => {
    const db = await withTrip("ls");
    await runPassCommand(db, ["add", "Priced", "--days=1-2", "--price=45"], false);
    await runPassCommand(db, ["add", "Unpriced", "--days=3-4"], false);
    const out = await runPassCommand(db, ["ls"], false);
    expect(out).toContain("all ages:45");
    expect(out).toMatch(/Unpriced.*\?/);
  });

  test("pass ls on an empty list names the fix", async () => {
    const db = await withTrip("empty");
    expect(await runPassCommand(db, ["ls"], false)).toContain("trip pass add");
  });

  test("pass rm removes the pass AND its price rules", async () => {
    // Orphaned rules would be invisible and would accumulate silently.
    const db = await withTrip("rm");
    await runPassCommand(db, ["add", "X", "--days=1-2", "--price=45"], false);
    await runPassCommand(db, ["rm", "1"], false);
    expect((await readPriceRules(db, "pass", [1])).has(1)).toBe(false);
    expect(await listPasses(db, 1)).toEqual([]);
  });

  test("pass rm on an unknown id deletes nothing", async () => {
    const db = await withTrip("rmmissing");
    await runPassCommand(db, ["add", "Keep", "--days=1-2", "--price=45"], false);
    await expect(runPassCommand(db, ["rm", "99"], false)).rejects.toThrow(/99/);
    expect((await readPriceRules(db, "pass", [1])).has(1)).toBe(true);
  });

  test("pass with no active trip says so", async () => {
    const p = join(tmpdir(), `trip-passcmd-notrip-${process.pid}.db`);
    rmSync(p, { force: true });
    const db = openDb(p);
    await migrate(db);
    await expect(runPassCommand(db, ["ls"], false)).rejects.toThrow(/no active trip/);
  });
});

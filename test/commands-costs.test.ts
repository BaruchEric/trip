import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runCostsCommand } from "@/commands/costs";
import { runTripsCommand } from "@/commands/trips";
import { listObservations } from "@/observations";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-costs-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  return db;
}

async function withTrip(tag: string) {
  const db = await freshDb(tag);
  await runTripsCommand(db, ["new", "chongqing"], false);
  return db;
}

describe("trip costs", () => {
  test("costs add stores the observation", async () => {
    const db = await withTrip("add");
    await runCostsCommand(db,
      ["add", "Accommodation", "--amount=230", "--currency=USD",
       "--days=4", "--people=1"], false);
    const [o] = await listObservations(db, 1);
    expect(o!.label).toBe("Accommodation");
    expect(o!.amount).toBe(230);
    expect(o!.coversDays).toBe(4);
  });

  test("a multi-word label is joined, not truncated", async () => {
    // The exact bug that made `trip when New York` answer about Patna.
    const db = await withTrip("multiword");
    await runCostsCommand(db,
      ["add", "Activities", "&", "food", "--amount=131", "--currency=USD"], false);
    expect((await listObservations(db, 1))[0]!.label).toBe("Activities & food");
  });

  test("--amount and --currency are both required", async () => {
    const db = await withTrip("required");
    await expect(runCostsCommand(db, ["add", "X", "--currency=USD"], false))
      .rejects.toThrow(/--amount/);
    await expect(runCostsCommand(db, ["add", "X", "--amount=1"], false))
      .rejects.toThrow(/--currency/);
  });

  test("--amount= (empty) is rejected rather than stored as 0", async () => {
    // F5, third occurrence: Number("") is 0, not NaN, so this would silently
    // record a free trip.
    const db = await withTrip("emptyamount");
    await expect(runCostsCommand(db,
      ["add", "X", "--amount=", "--currency=USD"], false))
      .rejects.toThrow(/--amount/);
  });

  test("--days and --people are optional and mean UNKNOWN when omitted", async () => {
    const db = await withTrip("optional");
    await runCostsCommand(db, ["add", "X", "--amount=1", "--currency=USD"], false);
    const [o] = await listObservations(db, 1);
    expect(o!.coversDays).toBeNull();
    expect(o!.coversPeople).toBeNull();
  });

  test("--days=0 is rejected, not stored as a divide by zero", async () => {
    const db = await withTrip("zerodays");
    await expect(runCostsCommand(db,
      ["add", "X", "--amount=1", "--currency=USD", "--days=0"], false))
      .rejects.toThrow(/--days/);
  });

  test("--at is parsed with the same grammar the mentions file uses", async () => {
    const db = await withTrip("at");
    await runCostsCommand(db,
      ["add", "X", "--amount=1", "--currency=USD", "--at=19:29"], false);
    expect((await listObservations(db, 1))[0]!.atSeconds).toBe(1169);
  });

  test("--source must name a source this trip has", async () => {
    const db = await withTrip("badsource");
    await expect(runCostsCommand(db,
      ["add", "X", "--amount=1", "--currency=USD", "--source=9"], false))
      .rejects.toThrow(/9/);
  });

  test("costs ls on an empty list names the fix", async () => {
    const db = await withTrip("empty");
    expect(await runCostsCommand(db, ["ls"], false)).toContain("trip costs add");
  });

  test("costs rm on an unknown id is an error", async () => {
    const db = await withTrip("rmmissing");
    await expect(runCostsCommand(db, ["rm", "99"], false)).rejects.toThrow(/99/);
  });

  test("costs rm removes it", async () => {
    const db = await withTrip("rm");
    await runCostsCommand(db, ["add", "X", "--amount=1", "--currency=USD"], false);
    await runCostsCommand(db, ["rm", "1"], false);
    expect(await listObservations(db, 1)).toEqual([]);
  });

  test("costs with no active trip says so", async () => {
    const db = await freshDb("notrip");
    await expect(runCostsCommand(db, ["ls"], false)).rejects.toThrow(/no active trip/);
  });

  test("an unknown subcommand shows usage", async () => {
    const db = await withTrip("unknownsub");
    await expect(runCostsCommand(db, ["frobnicate"], false)).rejects.toThrow(/usage/);
  });

  test("json returns the observations, not prose", async () => {
    const db = await withTrip("json");
    await runCostsCommand(db, ["add", "X", "--amount=1", "--currency=USD"], false);
    const parsed = JSON.parse(await runCostsCommand(db, ["ls"], true));
    expect(parsed.observations[0].label).toBe("X");
  });

  test("THE MEASURED CHONGQING CARD round-trips end to end", async () => {
    // The four rows read off frame_0002.jpg of the real video -- the first
    // price data this project has ever held.
    const db = await withTrip("chongqing");
    for (const [label, amount] of [
      ["Transportation", "40"], ["Accommodation", "230"],
      ["Activities & food", "131"], ["Total", "401"],
    ] as const) {
      await runCostsCommand(db, ["add", ...label.split(" "),
        `--amount=${amount}`, "--currency=USD", "--days=4", "--people=1"], false);
    }
    const out = await runCostsCommand(db, ["ls"], false);
    expect(out).toContain("USD 401");
    expect(out).toContain("100.25 pppd");
    expect(out).toContain("Activities & food");
    // Still no sum, even with a row literally called Total.
    expect(out).not.toContain("802");
  });
});

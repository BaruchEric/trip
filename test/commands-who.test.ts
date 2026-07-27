import { test, expect, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runWhoCommand } from "@/commands/who";
import { runTripsCommand } from "@/commands/trips";
import { listTravellers } from "@/travellers";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-whocmd-${tag}-${process.pid}.db`);
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

describe("trip who", () => {
  test("who add reports the traveller and stores the birth date", async () => {
    const db = await withTrip("add");
    const out = await runWhoCommand(db, ["add", "Mom", "--born=1949-03-14"], false);
    expect(out).toContain("Mom");
    expect(out).toContain("1949-03-14");
    expect((await listTravellers(db, 1))[0]!.birthDate).toBe("1949-03-14");
  });

  test("who add requires --born, naming the traveller", async () => {
    const db = await withTrip("noborn");
    await expect(runWhoCommand(db, ["add", "Mom"], false)).rejects.toThrow(/--born/);
    await expect(runWhoCommand(db, ["add", "Mom"], false)).rejects.toThrow(/Mom/);
  });

  test("who add requires a label", async () => {
    const db = await withTrip("nolabel");
    await expect(runWhoCommand(db, ["add", "--born=1949-03-14"], false))
      .rejects.toThrow(/usage/);
  });

  test("who add rejects a malformed date through the command layer too", async () => {
    const db = await withTrip("baddate");
    await expect(runWhoCommand(db, ["add", "X", "--born=14/03/1949"], false))
      .rejects.toThrow(/birth date/);
  });

  test("who ls lists travellers oldest first", async () => {
    const db = await withTrip("ls");
    await runWhoCommand(db, ["add", "Kid", "--born=2015-11-20"], false);
    await runWhoCommand(db, ["add", "Mom", "--born=1949-03-14"], false);
    const out = await runWhoCommand(db, ["ls"], false);
    expect(out.indexOf("Mom")).toBeLessThan(out.indexOf("Kid"));
  });

  test("who ls labels the age it shows as TODAY's, not the trip's", async () => {
    // The distinction is the entire point of storing birth dates. If this
    // line ever reads as the price-time age, someone will trust it.
    const db = await withTrip("agelabel");
    await runWhoCommand(db, ["add", "Mom", "--born=1949-03-14"], false);
    expect(await runWhoCommand(db, ["ls"], false)).toContain("today");
  });

  test("who ls on an empty party names the fix rather than printing nothing", async () => {
    const db = await withTrip("empty");
    expect(await runWhoCommand(db, ["ls"], false)).toContain("trip who add");
  });

  test("who rm on an unknown label is an error, not a silent success", async () => {
    const db = await withTrip("rmmissing");
    await expect(runWhoCommand(db, ["rm", "Nobody"], false)).rejects.toThrow(/Nobody/);
  });

  test("who rm removes and says no replan is needed", async () => {
    const db = await withTrip("rm");
    await runWhoCommand(db, ["add", "Mom", "--born=1949-03-14"], false);
    const out = await runWhoCommand(db, ["rm", "Mom"], false);
    expect(out).toMatch(/no replan/i);
    expect(await listTravellers(db, 1)).toEqual([]);
  });

  test("who with no active trip says so", async () => {
    const db = await freshDb("notrip");
    await expect(runWhoCommand(db, ["ls"], false)).rejects.toThrow(/no active trip/);
  });

  test("an unknown subcommand is named", async () => {
    const db = await withTrip("unknownsub");
    await expect(runWhoCommand(db, ["frobnicate"], false))
      .rejects.toThrow(/frobnicate/);
  });

  test("--json returns the traveller list, not prose", async () => {
    const db = await withTrip("json");
    await runWhoCommand(db, ["add", "Mom", "--born=1949-03-14"], true);
    const out = await runWhoCommand(db, ["ls"], true);
    expect(JSON.parse(out)[0].label).toBe("Mom");
  });
});

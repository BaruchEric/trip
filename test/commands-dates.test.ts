import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { createTrip, setActiveTrip, getTripByName } from "@/trips";
import { runDatesCommand } from "@/commands/dates";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function freshDb(tag: string, withTrip = true) {
  const p = join(tmpdir(), `trip-dates-${tag}-${process.pid}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  if (withTrip) {
    // createTrip takes (db, name, createdAt) - the brief's scaffold omitted
    // createdAt; Task 9 hit this same arity mismatch first.
    await createTrip(db, "lisbon", "2026-07-26");
    await setActiveTrip(db, "lisbon");
  }
  return db;
}

describe("trip dates set", () => {
  test("stores the range and reports the day count", async () => {
    const db = await freshDb("basic");
    const out = await runDatesCommand(db, ["set", "2027-05-08..05-16"], false);
    expect(out).toContain("9 days");
    const t = await getTripByName(db, "lisbon");
    expect(t!.startDate).toBe("2027-05-08");
    expect(t!.endDate).toBe("2027-05-16");
  });

  test("arrival and departure shorten the ends", async () => {
    const db = await freshDb("ends");
    await runDatesCommand(db,
      ["set", "2027-05-08..05-16", "--arrive=15:30", "--depart=11:00"], false);
    const t = await getTripByName(db, "lisbon");
    expect(t!.arrivalMin).toBe(930);
    expect(t!.departureMin).toBe(660);
  });

  test("without arrival and departure the output says days are assumed full", async () => {
    // M2-3: the assumption has to be visible, not silent.
    const db = await freshDb("assumed");
    const out = await runDatesCommand(db, ["set", "2027-05-08..05-16"], false);
    expect(out.toLowerCase()).toMatch(/assum|full/);
  });

  test("--day-window overrides the default", async () => {
    const db = await freshDb("window");
    await runDatesCommand(db, ["set", "2027-05-08..05-09", "--day-window=08:00-22:00"], false);
    const t = await getTripByName(db, "lisbon");
    expect(t!.dayStartMin).toBe(480);
    expect(t!.dayEndMin).toBe(1320);
  });

  test("json output carries the derived days", async () => {
    const db = await freshDb("json");
    const out = await runDatesCommand(db, ["set", "2027-05-08..05-09"], true);
    const parsed = JSON.parse(out);
    expect(parsed.days).toHaveLength(2);
    expect(parsed.days[0].date).toBe("2027-05-08");
    expect(parsed.days[0].startMin).toBe(540);
  });

  test("no active trip fails loudly", async () => {
    const db = await freshDb("notrip", false);
    await expect(runDatesCommand(db, ["set", "2027-05-08..05-09"], false))
      .rejects.toThrow(/active trip/i);
  });

  test("a backwards range is rejected", async () => {
    const db = await freshDb("backwards");
    await expect(runDatesCommand(db, ["set", "2027-05-16..05-08"], false))
      .rejects.toThrow(/date/i);
  });

  test("an inverted day window is rejected", async () => {
    const db = await freshDb("badwindow");
    await expect(
      runDatesCommand(db, ["set", "2027-05-08..05-09", "--day-window=22:00-08:00"], false),
    ).rejects.toThrow(/window/i);
  });

  test("an unknown subcommand is rejected", async () => {
    const db = await freshDb("badsub");
    await expect(runDatesCommand(db, ["clear"], false)).rejects.toThrow(/usage/i);
  });
});

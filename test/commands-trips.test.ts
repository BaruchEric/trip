import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runTripsCommand } from "@/commands/trips";
import { runWhoCommand } from "@/commands/who";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let seq = 0;
async function freshDb(tag: string) {
  const p = join(tmpdir(), `trip-cmd-${tag}-${process.pid}-${seq++}.db`);
  rmSync(p, { force: true });
  const db = openDb(p);
  await migrate(db);
  return db;
}

/**
 * These pin the JSON shapes an agent consumes. test/trips.test.ts covers the
 * STORE; this covers the command layer, which was previously untested — any of
 * these shapes could change with the whole suite still green.
 */
describe("runTripsCommand: new", () => {
  test("creates, activates, and reports in human form", async () => {
    const db = await freshDb("new");
    const out = await runTripsCommand(db, ["new", "tokyo-2027"], false);
    expect(out).toContain("tokyo-2027");
    expect(out.toLowerCase()).toContain("active");
  });

  test("--json returns the full trip object with tier defaults", async () => {
    const db = await freshDb("newjson");
    const parsed = JSON.parse(await runTripsCommand(db, ["new", "tokyo-2027"], true));
    expect(parsed.name).toBe("tokyo-2027");
    expect(parsed.mode).toBe("walking");
    expect(parsed.pace).toBe("normal");
    // Removed in M11 (migration 13) -- see test/db.test.ts for the drop.
    expect(parsed.lodgingTier).toBeUndefined();
    expect(parsed.foodTier).toBeUndefined();
    // Nulls, not zeros — an unset destination must not read as id 0.
    expect(parsed.destinationId).toBeNull();
    expect(parsed.startDate).toBeNull();
  });

  test("a missing name throws usage text", async () => {
    const db = await freshDb("newnoname");
    await expect(runTripsCommand(db, ["new"], false)).rejects.toThrow(/usage: trip new/);
  });
});

describe("runTripsCommand: use", () => {
  test("switches the active trip", async () => {
    const db = await freshDb("use");
    await runTripsCommand(db, ["new", "a"], false);
    await runTripsCommand(db, ["new", "b"], false);
    const out = await runTripsCommand(db, ["use", "a"], false);
    expect(out).toContain("a");
    expect(JSON.parse(await runTripsCommand(db, ["ls"], true)).active).toBe("a");
  });

  test("--json reports the new active trip", async () => {
    const db = await freshDb("usejson");
    await runTripsCommand(db, ["new", "a"], false);
    expect(JSON.parse(await runTripsCommand(db, ["use", "a"], true)).active).toBe("a");
  });

  test("a missing name throws usage text", async () => {
    const db = await freshDb("usenoname");
    await expect(runTripsCommand(db, ["use"], false)).rejects.toThrow(/usage: trip use/);
  });
});

describe("runTripsCommand: ls", () => {
  test("empty state tells you how to start", async () => {
    const db = await freshDb("lsempty");
    expect(await runTripsCommand(db, ["ls"], false)).toContain("No trips yet");
  });

  test("empty state under --json is still the object shape", async () => {
    // Shape must not change between empty and populated, or an agent breaks
    // on its first run.
    const db = await freshDb("lsemptyjson");
    const parsed = JSON.parse(await runTripsCommand(db, ["ls"], true));
    expect(parsed.trips).toEqual([]);
    expect(parsed.active).toBeNull();
  });

  test("marks exactly the active trip with an asterisk", async () => {
    const db = await freshDb("lsmark");
    await runTripsCommand(db, ["new", "a"], false);
    await runTripsCommand(db, ["new", "b"], false);
    const lines = (await runTripsCommand(db, ["ls"], false)).split("\n");
    expect(lines.filter((l) => l.startsWith("*"))).toHaveLength(1);
    expect(lines.find((l) => l.startsWith("*"))).toContain("b");
  });

  test("--json shape is {trips, active}", async () => {
    const db = await freshDb("lsjson");
    await runTripsCommand(db, ["new", "a"], false);
    const parsed = JSON.parse(await runTripsCommand(db, ["ls"], true));
    expect(Object.keys(parsed).sort()).toEqual(["active", "trips"]);
    expect(parsed.active).toBe("a");
  });
});

describe("runTripsCommand: show", () => {
  test("no active trip says so in human form", async () => {
    const db = await freshDb("shownone");
    expect(await runTripsCommand(db, ["show"], false)).toBe("No active trip.");
  });

  test("no active trip under --json is parseable, currently bare null", async () => {
    // KNOWN INCONSISTENCY, pinned deliberately rather than quietly changed:
    // `ls --json` always returns an object but `show --json` returns bare
    // `null`. Both are valid JSON so an agent will not crash, but the shapes
    // differ. Changing this to {"trip": null} is a pending decision for Eric;
    // this test documents today's behavior so the change is deliberate.
    const db = await freshDb("shownonejson");
    const out = await runTripsCommand(db, ["show"], true);
    expect(() => JSON.parse(out)).not.toThrow();
    expect(JSON.parse(out)).toBeNull();
  });

  test("renders every field of the active trip", async () => {
    const db = await freshDb("show");
    await runTripsCommand(db, ["new", "tokyo-2027"], false);
    const out = await runTripsCommand(db, ["show"], false);
    for (const label of ["Trip:", "Dates:", "Mode:", "Pace:"]) {
      expect(out).toContain(label);
    }
    // M11 dropped these. They were displayed as settings from M2 onwards while
    // no command could set them and no computation read them, which made the
    // display itself the defect.
    for (const gone of ["Lodging:", "Food:"]) {
      expect(out).not.toContain(gone);
    }
    expect(out).toContain("not set"); // dates are unset in M1
  });
});

describe("runTripsCommand: unknown", () => {
  test("an unknown subcommand throws and names it", async () => {
    const db = await freshDb("unknown");
    await expect(runTripsCommand(db, ["bogus"], false)).rejects.toThrow(/unknown command/);
  });

  test("no subcommand at all also throws", async () => {
    const db = await freshDb("nosub");
    await expect(runTripsCommand(db, [], false)).rejects.toThrow(/unknown command/);
  });
});

describe("trip set and trip show", () => {
  test("currency starts NULL and renders nothing, exactly as before M5", async () => {
    // A "Currency: not set" line would be noise on every pre-M5 trip, and
    // NULL already renders as bare numbers wherever a price appears.
    const db = await freshDb("nocurrency");
    await runTripsCommand(db, ["new", "x"], false);
    expect(await runTripsCommand(db, ["show"], false)).not.toContain("Currency");
  });

  test("trip set --currency is shown by trip show", async () => {
    const db = await freshDb("currency");
    await runTripsCommand(db, ["new", "x"], false);
    await runTripsCommand(db, ["set", "--currency=CNY"], false);
    expect(await runTripsCommand(db, ["show"], false)).toContain("CNY");
  });

  test("trip set --mode and --pace write the columns plan reads as fallbacks", async () => {
    // These two have been read by `plan` since M2 with nothing able to write
    // them -- defaults nobody could change.
    const db = await freshDb("modepace");
    await runTripsCommand(db, ["new", "x"], false);
    await runTripsCommand(db, ["set", "--mode=transit", "--pace=easy"], false);
    const out = await runTripsCommand(db, ["show"], false);
    expect(out).toContain("transit");
    expect(out).toContain("easy");
  });

  test("setting one field does not reset the others", async () => {
    const db = await freshDb("partial");
    await runTripsCommand(db, ["new", "x"], false);
    await runTripsCommand(db, ["set", "--mode=transit", "--currency=CNY"], false);
    await runTripsCommand(db, ["set", "--pace=easy"], false);
    const out = await runTripsCommand(db, ["show"], false);
    expect(out).toContain("transit");
    expect(out).toContain("CNY");
    expect(out).toContain("easy");
  });

  test("an unknown mode is rejected against the same list plan uses", async () => {
    // Storing a mode the compiler cannot resolve would leave the trip unable
    // to plan, with the bad value invisible until the next `trip plan`.
    const db = await freshDb("badmode");
    await runTripsCommand(db, ["new", "x"], false);
    await expect(runTripsCommand(db, ["set", "--mode=teleport"], false))
      .rejects.toThrow(/teleport/);
    await expect(runTripsCommand(db, ["set", "--pace=frantic"], false))
      .rejects.toThrow(/frantic/);
  });

  test("an empty --currency is rejected rather than stored as blank", async () => {
    const db = await freshDb("emptycurrency");
    await runTripsCommand(db, ["new", "x"], false);
    await expect(runTripsCommand(db, ["set", "--currency="], false))
      .rejects.toThrow(/may not be empty/);
  });

  test("trip set with no flags is an error, not a silent no-op", async () => {
    const db = await freshDb("setnothing");
    await runTripsCommand(db, ["new", "x"], false);
    await expect(runTripsCommand(db, ["set"], false)).rejects.toThrow(/nothing to set/);
  });

  test("trip set with no active trip says so", async () => {
    const db = await freshDb("setnotrip");
    await expect(runTripsCommand(db, ["set", "--currency=CNY"], false))
      .rejects.toThrow(/no active trip/);
  });

  test("trip show lists travellers with their birth dates", async () => {
    const db = await freshDb("showwho");
    await runTripsCommand(db, ["new", "x"], false);
    await runWhoCommand(db, ["add", "Mom", "--born=1949-03-14"], false);
    const out = await runTripsCommand(db, ["show"], false);
    expect(out).toContain("Mom");
    expect(out).toContain("1949-03-14");
  });

  test("trip show says 'none' rather than omitting the travellers line", async () => {
    // A trip with no travellers can compute no prices at all. Worth stating
    // here rather than leaving it to be discovered at `trip plan`.
    const db = await freshDb("shownowho");
    await runTripsCommand(db, ["new", "x"], false);
    expect(await runTripsCommand(db, ["show"], false)).toMatch(/Travellers:\s+none/);
  });

  test("show --json carries currency and travellers", async () => {
    const db = await freshDb("showjson");
    await runTripsCommand(db, ["new", "x"], false);
    await runTripsCommand(db, ["set", "--currency=CNY"], false);
    await runWhoCommand(db, ["add", "Mom", "--born=1949-03-14"], false);
    const parsed = JSON.parse(await runTripsCommand(db, ["show"], true));
    expect(parsed.currency).toBe("CNY");
    expect(parsed.travellers[0].label).toBe("Mom");
  });
});

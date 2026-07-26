import { expect, test, describe } from "bun:test";
import { openDb, migrate } from "@/db";
import { runTripsCommand } from "@/commands/trips";
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
    expect(parsed.lodgingTier).toBe("mid");
    expect(parsed.foodTier).toBe("casual");
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
    for (const label of ["Trip:", "Dates:", "Mode:", "Pace:", "Lodging:", "Food:"]) {
      expect(out).toContain(label);
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

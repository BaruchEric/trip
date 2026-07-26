import { expect, test, describe } from "bun:test";
import { run, USAGE } from "@/cli";
import { rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let seq = 0;
/** A fresh database path per call, so no two cases share state. */
function dbPath(tag: string): string {
  const p = join(tmpdir(), `trip-cli-${tag}-${process.pid}-${seq++}.db`);
  rmSync(p, { force: true });
  return p;
}

describe("cli: usage and help", () => {
  test("no arguments prints usage and exits 0", async () => {
    const r = await run([], { dbPath: dbPath("noargs") });
    expect(r.code).toBe(0);
    expect(r.stdout).toBe(USAGE);
    expect(r.stderr).toBe("");
  });

  test("help and --help both print usage", async () => {
    for (const arg of ["help", "--help"]) {
      const r = await run([arg], { dbPath: dbPath("help") });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("trip - heat-aware trip planner");
    }
  });

  test("--json usage is parseable JSON, not the human text block", async () => {
    // A success exit whose stdout an agent cannot parse is the worst
    // combination for a consumer, so --json gets an envelope instead.
    const r = await run(["--json"], { dbPath: dbPath("jsonusage") });
    expect(r.code).toBe(0);
    const parsed = JSON.parse(r.stdout);
    expect(Array.isArray(parsed.usage)).toBe(true);
    expect(parsed.usage.join("\n")).toContain("trip when <city>");
  });
});

describe("cli: --json flag handling", () => {
  test("--json is stripped from argv in any position", async () => {
    const p = dbPath("jsonpos");
    await run(["new", "tokyo"], { dbPath: p });

    // Before the subcommand, after it, and twice — all must reach `ls`.
    for (const argv of [["--json", "ls"], ["ls", "--json"], ["--json", "ls", "--json"]]) {
      const r = await run(argv, { dbPath: p });
      expect(r.code).toBe(0);
      const parsed = JSON.parse(r.stdout);
      expect(parsed.active).toBe("tokyo");
      expect(parsed.trips).toHaveLength(1);
    }
  });

  test("without --json the output is human text, not JSON", async () => {
    const p = dbPath("humantext");
    await run(["new", "tokyo"], { dbPath: p });
    const r = await run(["ls"], { dbPath: p });
    expect(r.stdout).toBe("* tokyo");
    expect(() => JSON.parse(r.stdout)).toThrow();
  });
});

describe("cli: unknown flags", () => {
  test("a mistyped flag fails loudly instead of being ignored", async () => {
    // `--refres` used to be silently dropped: the cache was served and the
    // process exited 0, so an agent asking to refresh got stale data.
    const r = await run(["when", "Tokyo", "--refres"], { dbPath: dbPath("badflag") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag");
    expect(r.stderr).toContain("--refres");
  });

  test("a value flag is recognised by name, and a typo of it still is not", async () => {
    // --timeout=<n> has to pass the unknown-flag gate without turning that gate
    // into a prefix match that waves through anything starting with --time.
    const ok = await run(["when", "Tokyo", "--timeout=abc", "--json"],
      { dbPath: dbPath("timeoutknown") });
    expect(JSON.parse(ok.stdout).error).not.toContain("unknown flag");
    expect(JSON.parse(ok.stdout).error).toContain("timeout");

    const typo = await run(["when", "Tokyo", "--timeoutt=5", "--json"],
      { dbPath: dbPath("timeouttypo") });
    expect(JSON.parse(typo.stdout).error).toContain("unknown flag");
  });

  test("an unknown flag under --json still yields an error envelope", async () => {
    const r = await run(["ls", "--nope", "--json"], { dbPath: dbPath("badflagjson") });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("--nope");
  });

  test("known flags are accepted", async () => {
    const p = dbPath("goodflags");
    const r = await run(["new", "trip-a", "--json"], { dbPath: p });
    expect(r.code).toBe(0);
  });
});

describe("cli: routing", () => {
  test("routes trip subcommands to the trips command", async () => {
    const p = dbPath("routetrips");
    const created = await run(["new", "tokyo-2027"], { dbPath: p });
    expect(created.code).toBe(0);
    expect(created.stdout).toContain("tokyo-2027");

    const shown = await run(["show"], { dbPath: p });
    expect(shown.stdout).toContain("Trip:");
    expect(shown.stdout).toContain("tokyo-2027");
  });

  test("routes `when` to the when command, not the trips command", async () => {
    // With no city, `when` must produce ITS usage error. Getting
    // "unknown command" instead would mean the route fell through to trips.
    // No network is touched, because the argument check runs first.
    const r = await run(["when"], { dbPath: dbPath("routewhen") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("usage: trip when <city>");
    expect(r.stderr).not.toContain("unknown command");
  });

  test("an unknown command exits 1 and says so", async () => {
    const r = await run(["bogus"], { dbPath: dbPath("unknowncmd") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown command");
  });
});

describe("cli: error contract", () => {
  test("human errors go to stderr and leave stdout empty", async () => {
    const r = await run(["use", "does-not-exist"], { dbPath: dbPath("errhuman") });
    expect(r.code).toBe(1);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("no trip named");
  });

  test("--json errors go to stdout as a parseable envelope", async () => {
    // An agent that only captures stdout must still see the failure.
    const r = await run(["use", "does-not-exist", "--json"], { dbPath: dbPath("errjson") });
    expect(r.code).toBe(1);
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout).error).toContain("no trip named");
  });

  test("a database failure yields an error envelope, not an unhandled crash", async () => {
    // openDb/migrate used to run outside the try, so this escaped as an
    // unhandled rejection with no envelope even under --json.
    const blocker = join(tmpdir(), `trip-cli-blocker-${process.pid}`);
    writeFileSync(blocker, "not a directory");
    // mkdirSync of a path whose parent is a regular file must fail.
    const r = await run(["ls", "--json"], { dbPath: join(blocker, "sub", "trip.db") });
    expect(r.code).toBe(1);
    expect(() => JSON.parse(r.stdout)).not.toThrow();
    expect(JSON.parse(r.stdout).error.length).toBeGreaterThan(0);
    rmSync(blocker, { force: true });
  });
});

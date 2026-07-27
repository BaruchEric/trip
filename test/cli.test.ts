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

describe("cli: M2 routing", () => {
  test("the M2 commands are routed and reach their handlers", async () => {
    const p = dbPath("m2routing");
    expect((await run(["new", "lisbon"], { dbPath: p })).code).toBe(0);
    expect((await run(["dates", "set", "2027-05-08..05-10"], { dbPath: p })).code).toBe(0);
    expect((await run(["seg", "add", "Se", "--dur=60m", "--at=38.71,-9.13"], { dbPath: p })).code).toBe(0);
    expect((await run(["plan"], { dbPath: p })).code).toBe(0);
    const day = await run(["day", "1"], { dbPath: p });
    expect(day.code).toBe(0);
    expect(day.stdout).toContain("Day 1");
  });

  test("M2 value flags pass the unknown-flag gate", async () => {
    const p = dbPath("m2flags");
    await run(["new", "lisbon"], { dbPath: p });
    const r = await run(
      ["seg", "add", "X", "--dur=30m", "--tag=food", "--at=1,2",
       "--hours=10:00-18:00", "--closed=mon", "--json"],
      { dbPath: p },
    );
    expect(JSON.parse(r.stdout).error).toBeUndefined();
  });

  test("usage lists the M2 commands", async () => {
    const r = await run([], { dbPath: dbPath("m2usage") });
    for (const cmd of ["dates set", "seg add", "plan", "pin", "replan"]) {
      expect(r.stdout).toContain(cmd);
    }
  });
});

describe("cli: per-command flag validation (M3)", () => {
  test("a flag belonging to another command is rejected, not silently ignored", async () => {
    const r = await run(["plan", "--day=2"], { dbPath: dbPath("flag-plan") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--day");
  });

  test("a value flag given space-separated is still rejected", async () => {
    // This is the Patna bug: "30" would land among the positionals. Asserting
    // only `code === 1` here is not enough: if the space-separated check were
    // removed, `when`'s own --timeout parser would ALSO throw (it requires a
    // "=" and finds none), giving code 1 for the wrong reason. Pinning the
    // validator's own wording is what actually catches that mutation.
    const r = await run(["when", "New", "York", "--timeout", "30"], { dbPath: dbPath("flag-space") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("never space-separated");
    expect(r.stderr).toContain("--timeout");
  });

  test("a boolean flag used with a value is rejected", async () => {
    const p = dbPath("flag-bool");
    // A trip exists so `seg ls` would otherwise succeed -- without this the
    // "no active trip" error would also yield code 1, masking a validator
    // that stopped checking bool-vs-value.
    await run(["new", "x"], { dbPath: p });
    const r = await run(["seg", "ls", "--unplaced=yes"], { dbPath: p });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag");
    expect(r.stderr).toContain("--unplaced");
  });

  test("an empty value for a value flag is rejected, not treated as zero", async () => {
    // The gap carried from M3's segments task: Number("") is 0, so
    // `seg ls --from=` used to silently mean source id 0.
    const p = dbPath("flag-empty");
    await run(["new", "x"], { dbPath: p });
    const r = await run(["seg", "ls", "--from="], { dbPath: p });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--from");
    expect(r.stderr).toContain("needs a value");
  });

  test("an unknown command still runs the validator, not a blanket accept", async () => {
    // Under the "unknown command accepts everything" mutation, this would
    // fall through to "unknown command: trip bogus" instead of naming the
    // flag -- code 1 either way, so the message is what discriminates.
    const r = await run(["bogus", "--anything"], { dbPath: dbPath("flag-unknown-cmd") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag");
    expect(r.stderr).toContain("--anything");
  });

  test("--json is accepted everywhere", async () => {
    const r = await run(["ls", "--json"], { dbPath: dbPath("flag-json") });
    expect(r.code).toBe(0);
  });

  test("M3 value and boolean flags pass their commands' gates", async () => {
    const p = dbPath("m3flags");
    await run(["new", "lisbon"], { dbPath: p });

    // seg set: reaches setCmd's own "no segment" error, not the validator.
    const segSet = await run(["seg", "set", "999", "--dur=45m", "--json"], { dbPath: p });
    expect(JSON.parse(segSet.stdout).error).not.toContain("unknown flag");
    expect(JSON.parse(segSet.stdout).error).toContain("no segment #999");

    // watch: --refresh and --whisper reach runWatchCommand's own "no
    // destination" error, not the validator.
    const watch = await run(
      ["watch", "https://youtu.be/x", "--refresh", "--whisper", "--json"], { dbPath: p },
    );
    expect(JSON.parse(watch.stdout).error).not.toContain("unknown flag");
    expect(JSON.parse(watch.stdout).error).toContain("no destination");

    // watch ingest: --mentions, --source and --replace reach ingestCmd's own
    // "no destination" error (checked before the file is even read).
    const ingest = await run(
      ["watch", "ingest", "--mentions=x.json", "--source=1", "--replace", "--json"],
      { dbPath: p },
    );
    expect(JSON.parse(ingest.stdout).error).not.toContain("unknown flag");
    expect(JSON.parse(ingest.stdout).error).toContain("no destination");

    // review resolve: --reject reaches resolveCmd's own "no mention" error.
    const review = await run(["review", "resolve", "1", "--reject", "--json"], { dbPath: p });
    expect(JSON.parse(review.stdout).error).not.toContain("unknown flag");
    expect(JSON.parse(review.stdout).error).toContain("no mention #1");
  });

  test("review ls --reject is now rejected, not silently ignored", async () => {
    // INVERTED IN M4, deliberately. Through M3 this test asserted the
    // opposite: --reject (owned by "resolve") passed the validator for "ls"
    // too, reached lsCmd, and was silently ignored — and the test, and the
    // USAGE block, documented that honestly rather than fixing it.
    //
    // M4 re-keyed the allowlist on command + subcommand, so the behaviour
    // this test guards changed on purpose. It is kept, inverted, because the
    // gap is exactly the kind that reappears when someone "simplifies" the
    // key lookup back to the top-level command.
    const p = dbPath("review-ls-reject");
    await run(["new", "lisbon"], { dbPath: p });
    const r = await run(["review", "ls", "--reject", "--json"], { dbPath: p });
    expect(r.code).toBe(1);
    expect(JSON.parse(r.stdout).error).toContain("unknown flag for `trip review ls`");
  });

  test("watch and review are routed", async () => {
    const p = dbPath("route");
    // No active trip: the command must be REACHED and report that, rather
    // than falling through to the trips command.
    const watch = await run(["watch", "https://youtu.be/x"], { dbPath: p });
    expect(watch.stderr).toContain("no active trip");
    const review = await run(["review", "ls"], { dbPath: p });
    expect(review.stderr).toContain("no active trip");
  });

  test("the usage block mentions the new commands", async () => {
    const r = await run([], { dbPath: dbPath("usage") });
    expect(r.stdout).toContain("trip watch");
    expect(r.stdout).toContain("trip review");
  });
});

describe("cli: per-subcommand flag validation", () => {
  test("a flag belonging to a sibling subcommand is rejected", async () => {
    // The failure cli.ts's own policy comment existed to prevent while not
    // preventing: --reject is `review resolve`'s, and `review ls` accepted it
    // and silently ignored it.
    const r = await run(["review", "ls", "--reject"], { dbPath: dbPath("sub-flag") });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("unknown flag for `trip review ls`");
  });

  test("each subcommand still accepts its own flags", async () => {
    // Not asserting the command succeeds — only that flag validation let it
    // through to the command, which then fails for its own reasons.
    const r = await run(["review", "ls", "--source=1"], { dbPath: dbPath("sub-ok") });
    expect(r.stderr).not.toContain("unknown flag");
  });

  test("`trip watch <url>` is not mistaken for a subcommand", async () => {
    // The second positional is a URL here, not a subcommand. Only a positional
    // that names a real key may narrow validation.
    const r = await run(
      ["watch", "https://youtu.be/KHHlcCUTwZA", "--refresh"],
      { dbPath: dbPath("watch-url") },
    );
    expect(r.stderr).not.toContain("unknown flag");
  });

  test("seg add rejects seg ls's flag and vice versa", async () => {
    const a = await run(["seg", "add", "X", "--unplaced"], { dbPath: dbPath("seg-a") });
    expect(a.stderr).toContain("unknown flag for `trip seg add`");
    const b = await run(["seg", "ls", "--dur=60m"], { dbPath: dbPath("seg-b") });
    expect(b.stderr).toContain("unknown flag for `trip seg ls`");
  });

  test("--help on a subcommand describes that subcommand", async () => {
    const r = await run(["review", "resolve", "--help"], { dbPath: dbPath("sub-help") });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("--pick");
    expect(r.stdout).toContain("--rename");
    expect(r.stdout).not.toContain("trip replan");
  });

  test("watch ingest --help documents the kind vocabulary", async () => {
    // This is where the agent contract is discoverable from the CLI itself.
    const r = await run(["watch", "ingest", "--help"], { dbPath: dbPath("ing-help") });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("kind");
    expect(r.stdout).toContain("landmark");
  });

  test("--help on a command with no subcommand help prints usage, never runs it", async () => {
    // --help is a global bool flag, so without a fallback it would pass
    // validation and then RUN the command — a silently ignored flag, in the
    // very change that exists to end silently ignored flags.
    const r = await run(["plan", "--help"], { dbPath: dbPath("plan-help") });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("trip replan");
  });

  test("--help with no command at all still prints the full usage", async () => {
    const r = await run(["--help"], { dbPath: dbPath("top-help") });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("trip replan");
  });
});

describe("M6: the watch fallback key is not a union", () => {
  test("a URL watch rejects flags only its subcommands read", async () => {
    // `trip watch <url>` lands on the bare `watch` key -- there is no
    // "watch <url>" key and none can exist. So anything listed there is a
    // flag the URL path ACCEPTS AND THEN IGNORES, which is the exact
    // anti-pattern COMMAND_FLAGS exists to prevent, sitting inside it.
    //
    // --replace/--mentions/--source were there for `ingest` since M3 and were
    // silently ignored on the URL path the whole time; M6 widened it with the
    // frames flags before noticing.
    for (const flag of ["--from=1:00", "--to=2:00", "--max=5", "--width=900",
                        "--replace", "--mentions=x.json", "--source=1"]) {
      const r = await run(["watch", "https://youtu.be/x", flag]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain("unknown flag for `trip watch`");
    }
  });

  test("the subcommands still accept their own flags", async () => {
    // The narrowing must not reach the keys that legitimately own these.
    const ingest = await run(["watch", "ingest", "--mentions=/nope.json"]);
    expect(ingest.stderr).not.toContain("unknown flag");
    const frames = await run(["watch", "frames", "9", "--from=1:00", "--to=2:00"]);
    expect(frames.stderr).not.toContain("unknown flag");
  });

  test("--refresh and --whisper still reach the URL path", async () => {
    const r = await run(["watch", "https://youtu.be/x", "--refresh", "--whisper"]);
    expect(r.stderr).not.toContain("unknown flag");
  });
});

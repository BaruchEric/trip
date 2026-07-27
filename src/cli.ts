#!/usr/bin/env bun
import type { Client } from "@libsql/client";
import { openDb, migrate } from "@/db";
import { runTripsCommand } from "@/commands/trips";
import { runWhenCommand } from "@/commands/when";
import { runDatesCommand } from "@/commands/dates";
import { runSegmentsCommand } from "@/commands/segments";
import { runPlanCommand } from "@/commands/plan";
import { runWatchCommand, type WatchCommandDeps } from "@/commands/watch";
import { runReviewCommand, type ReviewDeps } from "@/commands/review";

export const USAGE = `trip - heat-aware trip planner

Usage:
  trip new <name>              Create a trip and make it active
  trip use <name>              Switch the active trip
  trip ls / trip show          List trips / show the active one
  trip when <city>             Rank every month by dew-point comfort [--timeout=<seconds>]

  trip dates set <a>..<b>      Set trip dates [--arrive=HH:MM] [--depart=HH:MM]
  trip seg add <name>          Add a segment --dur=90m [--at=lat,lon] [--tag=food]
  trip seg ls                  List segments [--tag=food] [--unplaced] [--from=<source-id>]
  trip seg set <id> --dur=90m  Correct a segment's dwell time
  trip seg rm <id>             Remove a segment
  trip plan                    Compile a day-by-day itinerary [--pace=] [--mode=]
  trip day <n>                 Show one day
  trip pin <seg> --day=<n>     Fix a segment in place [--at=HH:MM]
  trip unpin <seg>             Release a pinned segment
  trip move <seg> --to=day<n>  Move a segment to another day (pins it)
  trip replan                  Rebuild the plan, respecting pins

  trip watch <url>             Fetch a video transcript [--refresh] [--whisper]
  trip watch ingest            Geocode mentions --mentions=<file.json> [--replace]
  trip review ls               Mentions awaiting a decision
  trip review resolve <id>     --pick=<n> | --reject | --rename="Actual Name"

Flags:
  --json                       Machine-readable output (accepted by every command)

Every command validates its own flags: one it does not own, or a value flag
given space-separated instead of --name=value, is rejected rather than
silently ignored. Validation is keyed per TOP-LEVEL command, not per
subcommand, though - "review"'s flags cover "ls" and "resolve" together, so
"trip review ls --reject" passes validation but ls itself never reads
--reject and silently ignores it.
`;

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** Injection point for the two commands that reach the network by default
 *  (`watch`, which downloads a video, and `review resolve --rename`, which
 *  re-geocodes). Nothing else needs one: every other command is pure CLI +
 *  DB.
 *
 *  DELIBERATE DESIGN DECISION (Task 17), not scope creep: the M3 consistency
 *  suite has to drive the CLI through `run(argv, { dbPath })` — that is what
 *  makes it a *cross-command* test rather than a module test — while ALSO
 *  using the same injected, no-network fixtures every per-command suite
 *  already uses. Those two requirements are only jointly satisfiable if
 *  `run()` can pass deps down; without this, `watch` would really invoke
 *  yt-dlp and `review resolve --rename` would really hit Nominatim.
 *
 *  This completes an existing seam rather than inventing one:
 *  `runWatchCommand`/`runReviewCommand` already accept an optional `deps`
 *  argument (as does everything below them — `WatchRunner`, `IngestDeps`,
 *  `geocode`), and `route()` was simply never handed one to forward. `CliDeps`
 *  carries only those two existing, narrowly-typed shapes — it is not a
 *  general-purpose escape hatch, and it does not touch either command's
 *  signature (both were already `(db, argv, json, deps = {})`).
 *
 *  Additive and optional, mirroring `dbPath`: existing callers of `run()`
 *  (the `import.meta.main` entry point below, and every pre-Task-17 test)
 *  pass nothing and get today's behaviour unchanged. */
export interface CliDeps {
  watch?: WatchCommandDeps;
  review?: ReviewDeps;
}

/** Flags every command accepts, bare, regardless of what it declares below. */
const GLOBAL_BOOL_FLAGS = new Set(["--json", "--help"]);

/** Per command, because a global allowlist accepted `trip plan --day=2` and
 *  silently ignored it — the exact failure this file's policy comment used
 *  to warn about while not actually preventing it once a flag belonged to
 *  the wrong command.
 *
 *  `bool` flags are valid only bare; `value` flags only as `--name=value`.
 *  That split is load-bearing: `trip when New York --timeout 30` leaves the
 *  30 among the positionals, where `when` joins it into the city name. That
 *  is the bug that once made `trip when New York` answer about Patna, India. */
interface CommandFlags {
  bool?: string[];
  value?: string[];
}

const COMMAND_FLAGS: Record<string, CommandFlags> = {
  new: {}, use: {}, ls: {}, show: {},
  when: { bool: ["--refresh"], value: ["--timeout"] },
  dates: { value: ["--arrive", "--depart", "--day-window"] },
  seg: {
    bool: ["--unplaced"],
    value: ["--dur", "--cost", "--tag", "--at", "--hours", "--closed", "--from"],
  },
  plan: { value: ["--mode", "--pace"] },
  replan: { value: ["--mode", "--pace"] },
  day: {},
  pin: { value: ["--day", "--at"] },
  unpin: {},
  move: { value: ["--to"] },
  // No --timeout here: nothing under src/watch reads one. Declaring it would
  // let it pass validation and then be silently ignored by runWatchCommand —
  // the exact anti-pattern this file exists to prevent, for a brand-new flag.
  watch: {
    bool: ["--refresh", "--whisper", "--replace"],
    value: ["--mentions", "--source"],
  },
  review: { bool: ["--reject"], value: ["--source", "--pick", "--rename"] },
};

interface FlagIssues {
  /** Wrong command, a typo, or a value flag given bare (the Patna case). */
  unknown: string[];
  /** A value flag given as `--name=` with nothing after the `=`. Kept apart
   *  from `unknown`: the flag IS the command's own, so "unknown flag" would
   *  be a lie. `Number("")` is `0`, which let `seg ls --from=` silently mean
   *  source id 0 instead of failing loudly — the same trap already fixed for
   *  `--cost=` in `seg add`, closed here at the CLI layer for every command's
   *  value flags at once. */
  empty: string[];
}

function flagIssues(cmd: string, argv: string[]): FlagIssues {
  const spec = COMMAND_FLAGS[cmd] ?? {};
  const bools = new Set(spec.bool ?? []);
  const values = new Set(spec.value ?? []);
  const unknown: string[] = [];
  const empty: string[] = [];

  for (const a of argv) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    const name = eq === -1 ? a : a.slice(0, eq);

    if (GLOBAL_BOOL_FLAGS.has(name)) {
      if (eq !== -1) unknown.push(name);
      continue;
    }
    if (eq === -1) {
      if (!bools.has(name)) unknown.push(name);
      continue;
    }
    if (!values.has(name)) unknown.push(name);
    else if (a.slice(eq + 1) === "") empty.push(name);
  }
  return { unknown, empty };
}

function fail(msg: string, json: boolean): CliResult {
  return json
    ? { stdout: JSON.stringify({ error: msg }), stderr: "", code: 1 }
    : { stdout: "", stderr: `error: ${msg}`, code: 1 };
}

/**
 * The whole CLI as a pure-ish function: argv in, output and exit code out.
 * It never touches process.argv, never prints, and never exits — that is the
 * entry shim's job below. This is what makes the argv handling, routing, and
 * exit codes testable.
 */
export async function run(
  argv: string[],
  opts: { dbPath?: string; deps?: CliDeps } = {},
): Promise<CliResult> {
  const json = argv.includes("--json");

  const rest = argv.filter((a) => a !== "--json");

  if (rest.length === 0 || rest[0] === "help" || rest[0] === "--help") {
    // Under --json, emit a parseable envelope. Printing the human usage block
    // on a success exit gave an agent unparseable stdout with code 0 — the
    // worst combination for a consumer.
    return json
      ? { stdout: JSON.stringify({ usage: USAGE.trimEnd().split("\n") }), stderr: "", code: 0 }
      : { stdout: USAGE, stderr: "", code: 0 };
  }

  // Checked here, not before the command is known: which flags are valid
  // depends entirely on which command owns them (`--day` means one thing to
  // `pin` and nothing to `plan`), so there is no correct answer before `cmd`
  // is resolved.
  const cmd = rest[0]!;
  const { unknown, empty } = flagIssues(cmd, argv);
  if (unknown.length > 0) {
    return fail(
      `unknown flag for \`trip ${cmd}\`: ${unknown.join(", ")}` +
      ` (values are --name=value, never space-separated)`,
      json,
    );
  }
  if (empty.length > 0) {
    return fail(
      `${empty.join(", ")} needs a value (e.g. ${empty[0]}=<value>); ` +
      `an empty value is not the same as zero`,
      json,
    );
  }

  // openDb/migrate live INSIDE the try. Previously a database failure
  // (unwritable ~/.trip, corrupt file) escaped as an unhandled rejection:
  // a stack trace on stderr and no {"error": ...} envelope even under --json.
  try {
    const db = openDb(opts.dbPath);
    await migrate(db);

    const [, ...args] = rest;
    const output = await route(db, cmd, args, rest, json, opts.deps ?? {});
    return { stdout: output, stderr: "", code: 0 };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), json);
  }
}

const PLAN_COMMANDS = ["plan", "replan", "day", "pin", "unpin", "move"];

async function route(
  db: Client, cmd: string, args: string[], rest: string[], json: boolean,
  deps: CliDeps,
): Promise<string> {
  if (cmd === "when") return runWhenCommand(db, args, json);
  if (cmd === "dates") return runDatesCommand(db, args, json);
  if (cmd === "seg") return runSegmentsCommand(db, args, json);
  if (PLAN_COMMANDS.includes(cmd)) return runPlanCommand(db, cmd, args, json);
  if (cmd === "watch") return runWatchCommand(db, args, json, deps.watch);
  if (cmd === "review") return runReviewCommand(db, args, json, deps.review);
  return runTripsCommand(db, rest, json);
}

// Entry point only when executed directly, so tests can import `run`.
if (import.meta.main) {
  // TRIP_TEST_DB lets a manual acceptance run (or anyone poking at the CLI
  // from a shell) target a scratch database instead of the real
  // ~/.trip/trip.db. Without this, `bun run src/cli.ts ...` always writes to
  // the live database — there was no way to override it from outside a test.
  // `|| undefined`, not a bare read: openDb's default parameter only fires on
  // `undefined`. A bare `export TRIP_TEST_DB=` (empty string) would otherwise
  // pass through as `openDb("")` -> `file:` in the current directory,
  // silently missing the real database without ever pointing at a scratch one.
  const result = await run(process.argv.slice(2), { dbPath: process.env.TRIP_TEST_DB || undefined });
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}

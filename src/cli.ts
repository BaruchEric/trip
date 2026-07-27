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
import { runWhoCommand } from "@/commands/who";

export const USAGE = `trip - heat-aware trip planner

Usage:
  trip new <name>              Create a trip and make it active
  trip use <name>              Switch the active trip
  trip ls / trip show          List trips / show the active one
  trip when <city>             Rank every month by dew-point comfort [--timeout=<seconds>]

  trip dates set <a>..<b>      Set trip dates [--arrive=HH:MM] [--depart=HH:MM]
  trip who add <label>         Add a traveller --born=YYYY-MM-DD
  trip who ls / rm <label>     List or remove travellers
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

Every command validates its own flags, PER SUBCOMMAND: one it does not own, or
a value flag given space-separated instead of --name=value, is rejected rather
than silently ignored. "trip review ls --reject" is an error, because --reject
belongs to "review resolve". Add --help after any command or subcommand for
its own usage.
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
  // Fallback for a bare `trip who`, and the union of the three below.
  who: { value: ["--born"] },
  "who add": { value: ["--born"] },
  "who ls": {},
  "who rm": {},
  // Fallback for a bare `trip seg`, and the union of the four below. It is
  // what a subcommand-less invocation validates against, before the command
  // itself fails for the right reason.
  seg: {
    bool: ["--unplaced"],
    value: ["--dur", "--cost", "--tag", "--at", "--hours", "--closed", "--from"],
  },
  "seg add": {
    value: ["--dur", "--cost", "--tag", "--at", "--hours", "--closed"],
  },
  "seg ls": { bool: ["--unplaced"], value: ["--from"] },
  "seg rm": {},
  "seg set": { value: ["--dur"] },

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
  // No `"watch <url>"` key exists, and none can: `trip watch https://...`
  // takes a URL where `trip watch ingest` takes a subcommand, so it falls
  // back to `watch` above. That is why the key lookup below tests for
  // EXISTENCE rather than for "this command has subcommands".
  "watch ingest": {
    bool: ["--replace"],
    value: ["--mentions", "--source"],
  },

  review: { bool: ["--reject"], value: ["--source", "--pick", "--rename"] },
  "review ls": { value: ["--source"] },
  "review resolve": { bool: ["--reject"], value: ["--pick", "--rename"] },
};

/** Per-subcommand usage. A key absent here falls back to the full USAGE
 *  block, which is the honest default — a stub reading "no help available"
 *  would be worse than the real thing. */
const SUBCOMMAND_HELP: Record<string, string> = {
  "seg add": `trip seg add <name...> [--dur=90m] [--cost=25] [--tag=food]
                    [--at=<lat,lon>] [--hours=10:00-24:00] [--closed=mon,tue]

  --hours accepts 24:00 as a closing time, stored as the end of the day.
  Omitting --hours means opening hours are UNKNOWN, not "open all day".
`,
  "seg ls": `trip seg ls [--unplaced] [--from=<source-id>]

  --unplaced  only segments with no coordinates
  --from      only segments a given video produced
`,
  "seg rm": `trip seg rm <id>

  A video-sourced segment returns its mention to the review queue rather
  than vanishing from the record of what the video said.
`,
  "seg set": `trip seg set <id> --dur=90m

  Corrects a dwell without delete-and-re-add.
`,
  "watch ingest": `trip watch ingest --mentions=<file.json> [--source=<id>] [--replace]

  The file is a JSON array. One required field, four optional:

    text   required, the name as the video said it
    at     MM:SS or HH:MM:SS, minutes unbounded (102:15 is valid)
    dwell  same grammar as --dur; absent means 60m, flagged [default]
    tags   array of strings
    kind   one of: street, temple, park, museum, station, restaurant,
           market, shop, hotel, viewpoint, nature, neighbourhood, landmark

  kind is compared against the geocoder's own classification, so a lone
  result that contradicts it is queued for review instead of becoming a
  segment. Declare the most precise kind you are confident in: a vaguer one
  is safe but buys less checking, and omitting it is checked least.
`,
  "who add": `trip who add <label> --born=YYYY-MM-DD

  A birth date, not an age. An age is a claim about a date nobody recorded:
  a 64 written while planning is a 65 by the time you travel, and the row
  cannot tell you which.

  Every concession price is computed from this against THE DAY THE PLAN
  VISITS that place, so a birthday falling mid-trip prices correctly on
  both sides of itself.
`,
  "who rm": `trip who rm <label>

  Prices are derived at render time and stored nowhere, so this needs no
  replan. Totals simply change on the next command.
`,
  "review ls": `trip review ls [--source=<id>]

  Mentions awaiting a decision, with their candidates ranked and the reason
  each is queued.
`,
  "review resolve": `trip review resolve <id> --pick=<n> | --reject | --rename="Actual Name"

  Exactly one of the three is required.

  --pick    accept candidate N from the list "trip review ls" printed
  --reject  discard the mention, keeping the record that it was said
  --rename  re-geocode under a corrected name; the mention may resolve or
            return to the queue with fresh candidates
`,
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

/** `trip review ls` validates against "review ls" when that key exists, and
 *  against "review" otherwise.
 *
 *  Keyed on EXISTENCE, not on "this command has subcommands": `trip watch
 *  <url>` takes a URL in the same position `trip watch ingest` takes a
 *  subcommand, so treating every second positional as a subcommand would
 *  look up "watch https://youtu.be/..." and fall through to an empty flag
 *  set, rejecting every flag the command legitimately owns. */
function flagKey(cmd: string, rest: string[]): string {
  const sub = rest[1];
  if (sub === undefined || sub.startsWith("--")) return cmd;
  const composite = `${cmd} ${sub}`;
  return composite in COMMAND_FLAGS ? composite : cmd;
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
  const key = flagKey(cmd, rest);

  // Before validation, because `--help` is a GLOBAL_BOOL_FLAG and would
  // otherwise pass validation and then let the command RUN — a silently
  // ignored flag, in the very mechanism that exists to end them. Falls back
  // to the full usage, so `--help` is never ignored anywhere.
  if (argv.includes("--help")) {
    const help = SUBCOMMAND_HELP[key] ?? USAGE;
    return json
      ? { stdout: JSON.stringify({ usage: help.trimEnd().split("\n") }), stderr: "", code: 0 }
      : { stdout: help, stderr: "", code: 0 };
  }

  const { unknown, empty } = flagIssues(key, argv);
  if (unknown.length > 0) {
    return fail(
      // Names the SUBCOMMAND, which is the point: "unknown flag for
      // `trip review ls`" tells the reader why a flag they know exists was
      // rejected, where "for `trip review`" would read as a lie.
      `unknown flag for \`trip ${key}\`: ${unknown.join(", ")}` +
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
  if (cmd === "who") return runWhoCommand(db, args, json);
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

#!/usr/bin/env bun
import type { Client } from "@libsql/client";
import { openDb, migrate } from "@/db";
import { runTripsCommand } from "@/commands/trips";
import { runWhenCommand } from "@/commands/when";
import { runDatesCommand } from "@/commands/dates";
import { runSegmentsCommand } from "@/commands/segments";
import { runPlanCommand } from "@/commands/plan";

export const USAGE = `trip - heat-aware trip planner

Usage:
  trip new <name>              Create a trip and make it active
  trip use <name>              Switch the active trip
  trip ls / trip show          List trips / show the active one
  trip when <city>             Rank every month by dew-point comfort

  trip dates set <a>..<b>      Set trip dates [--arrive=HH:MM] [--depart=HH:MM]
  trip seg add <name>          Add a segment --dur=90m [--at=lat,lon] [--tag=food]
  trip seg ls                  List segments [--tag=food] [--unplaced]
  trip seg rm <id>             Remove a segment
  trip plan                    Compile a day-by-day itinerary [--pace=] [--mode=]
  trip day <n>                 Show one day
  trip pin <seg> --day=<n>     Fix a segment in place [--at=HH:MM]
  trip unpin <seg>             Release a pinned segment
  trip move <seg> --to=day<n>  Move a segment to another day (pins it)
  trip replan                  Rebuild the plan, respecting pins

Flags:
  --json                       Machine-readable output
  --timeout=<seconds>          Network timeout per request (default 15)
`;

export interface CliResult {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Flags the CLI accepts. Anything else is rejected rather than ignored:
 * `trip when Tokyo --refres` used to serve the cache and exit 0, so an agent
 * asking for fresh data got stale data with a success code.
 */
const KNOWN_FLAGS = new Set(["--json", "--refresh", "--help", "--unplaced"]);

/** Flags that carry a value as `--name=<value>`. The value itself is validated
 *  by the command that owns the flag, not here. A space-separated form is
 *  deliberately not accepted: `trip when New York --timeout 30` would leave the
 *  30 among the positionals, which `when` joins into the city name. Same class
 *  of bug `trip pin "Time Out" --day 2` would hit, which is why every M2 value
 *  flag below is `--name=value` only. */
const KNOWN_VALUE_FLAGS = [
  "--timeout",
  "--arrive", "--depart", "--day-window",
  "--dur", "--cost", "--tag", "--at", "--hours", "--closed",
  "--mode", "--pace", "--day", "--to",
];

function isKnownFlag(arg: string): boolean {
  return (
    KNOWN_FLAGS.has(arg) ||
    KNOWN_VALUE_FLAGS.some((f) => arg === f || arg.startsWith(`${f}=`))
  );
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
  opts: { dbPath?: string } = {},
): Promise<CliResult> {
  const json = argv.includes("--json");

  const unknown = argv.filter((a) => a.startsWith("--") && !isKnownFlag(a));
  if (unknown.length > 0) return fail(`unknown flag: ${unknown.join(", ")}`, json);

  const rest = argv.filter((a) => a !== "--json");

  if (rest.length === 0 || rest[0] === "help" || rest[0] === "--help") {
    // Under --json, emit a parseable envelope. Printing the human usage block
    // on a success exit gave an agent unparseable stdout with code 0 — the
    // worst combination for a consumer.
    return json
      ? { stdout: JSON.stringify({ usage: USAGE.trimEnd().split("\n") }), stderr: "", code: 0 }
      : { stdout: USAGE, stderr: "", code: 0 };
  }

  // openDb/migrate live INSIDE the try. Previously a database failure
  // (unwritable ~/.trip, corrupt file) escaped as an unhandled rejection:
  // a stack trace on stderr and no {"error": ...} envelope even under --json.
  try {
    const db = openDb(opts.dbPath);
    await migrate(db);

    const [cmd, ...args] = rest;
    const output = await route(db, cmd!, args, rest, json);
    return { stdout: output, stderr: "", code: 0 };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), json);
  }
}

const PLAN_COMMANDS = ["plan", "replan", "day", "pin", "unpin", "move"];

async function route(
  db: Client, cmd: string, args: string[], rest: string[], json: boolean,
): Promise<string> {
  if (cmd === "when") return runWhenCommand(db, args, json);
  if (cmd === "dates") return runDatesCommand(db, args, json);
  if (cmd === "seg") return runSegmentsCommand(db, args, json);
  if (PLAN_COMMANDS.includes(cmd)) return runPlanCommand(db, cmd, args, json);
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

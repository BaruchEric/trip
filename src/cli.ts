#!/usr/bin/env bun
import { openDb, migrate } from "@/db";
import { runTripsCommand } from "@/commands/trips";
import { runWhenCommand } from "@/commands/when";

export const USAGE = `trip - heat-aware trip planner

Usage:
  trip new <name>              Create a trip and make it active
  trip use <name>              Switch the active trip
  trip ls                      List trips (* marks active)
  trip show                    Show the active trip
  trip when <city>             Rank every month by dew-point comfort
  trip when <city> --refresh   Refetch climate data instead of using the cache

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
const KNOWN_FLAGS = new Set(["--json", "--refresh", "--help"]);

/** Flags that carry a value as `--name=<value>`. The value itself is validated
 *  by the command that owns the flag, not here. A space-separated form is
 *  deliberately not accepted: `trip when New York --timeout 30` would leave the
 *  30 among the positionals, which `when` joins into the city name. */
const KNOWN_VALUE_FLAGS = ["--timeout"];

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
    const output = cmd === "when"
      ? await runWhenCommand(db, args, json)
      : await runTripsCommand(db, rest, json);
    return { stdout: output, stderr: "", code: 0 };
  } catch (err) {
    return fail(err instanceof Error ? err.message : String(err), json);
  }
}

// Entry point only when executed directly, so tests can import `run`.
if (import.meta.main) {
  const result = await run(process.argv.slice(2));
  if (result.stdout) console.log(result.stdout);
  if (result.stderr) console.error(result.stderr);
  process.exit(result.code);
}

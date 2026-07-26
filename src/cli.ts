#!/usr/bin/env bun
import { openDb, migrate } from "@/db";
import { runTripsCommand } from "@/commands/trips";
import { runWhenCommand } from "@/commands/when";

const USAGE = `trip - heat-aware trip planner

Usage:
  trip new <name>              Create a trip and make it active
  trip use <name>              Switch the active trip
  trip ls                      List trips (* marks active)
  trip show                    Show the active trip
  trip when <city>             Rank every month by dew-point comfort
  trip when <city> --refresh   Refetch climate data instead of using the cache

Global flags:
  --json                       Machine-readable output
`;

async function main(): Promise<number> {
  const raw = process.argv.slice(2);
  const json = raw.includes("--json");
  const argv = raw.filter((a) => a !== "--json");

  if (argv.length === 0 || argv[0] === "help" || argv[0] === "--help") {
    console.log(USAGE);
    return 0;
  }

  const db = openDb();
  await migrate(db);

  try {
    const [cmd, ...rest] = argv;
    const output = cmd === "when"
      ? await runWhenCommand(db, rest, json)
      : await runTripsCommand(db, argv, json);
    console.log(output);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(`error: ${msg}`);
    return 1;
  }
}

process.exit(await main());

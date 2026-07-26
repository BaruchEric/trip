#!/usr/bin/env bun
import { openDb, migrate } from "@/db";
import { runTripsCommand } from "@/commands/trips";

const USAGE = `trip - heat-aware trip planner

Usage:
  trip new <name>              Create a trip and make it active
  trip use <name>              Switch the active trip
  trip ls                      List trips (* marks active)
  trip show                    Show the active trip

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
    console.log(await runTripsCommand(db, argv, json));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (json) console.log(JSON.stringify({ error: msg }));
    else console.error(`error: ${msg}`);
    return 1;
  }
}

process.exit(await main());

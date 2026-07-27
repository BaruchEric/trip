import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { getSource } from "@/sources";
import { parseStamp } from "@/watch/parse-report";
import {
  addObservation, listObservations, removeObservation,
} from "@/observations";
import { renderObservations } from "@/render-costs";

const USAGE =
  "usage: trip costs add <label...> --amount=230 --currency=USD " +
  "[--days=4] [--people=1] [--source=1] [--at=19:29]\n" +
  "       trip costs ls\n" +
  "       trip costs rm <id>";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

/** A count that is absent means UNKNOWN; a count that is present must be a
 *  real one. `Number("")` is 0, which would divide a total by zero people. */
function readCount(argv: string[], name: string): number | null {
  const raw = flag(argv, name);
  if (raw === null) return null;
  if (raw.trim() === "") throw new Error(`invalid ${name} "" (omit it entirely for unknown)`);
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`invalid ${name} "${raw}" (expected a whole number >= 1)`);
  }
  return n;
}

export async function runCostsCommand(
  db: Client,
  argv: string[],
  json: boolean,
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  const [sub, ...rest] = argv;

  if (sub === "add") {
    // JOIN the positionals. Taking rest[0] is what made `trip when New York`
    // answer about Patna, and "Activities & food" is three words.
    const label = rest.filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!label) throw new Error(USAGE);

    const amountRaw = flag(argv, "--amount");
    if (amountRaw === null) throw new Error("--amount is required (e.g. --amount=230)");
    // F5, third occurrence: Number("") is 0, not NaN, so `--amount=` would
    // silently record a free trip.
    if (amountRaw.trim() === "") throw new Error(`invalid --amount "${amountRaw}"`);
    const amount = Number(amountRaw);
    if (!Number.isFinite(amount)) throw new Error(`invalid --amount "${amountRaw}"`);

    const currency = flag(argv, "--currency");
    if (currency === null) {
      throw new Error("--currency is required - an amount with no unit cannot be compared");
    }

    const sourceRaw = flag(argv, "--source");
    let sourceId: number | null = null;
    if (sourceRaw !== null) {
      if (!/^\d+$/.test(sourceRaw)) {
        throw new Error(`invalid --source "${sourceRaw}" (expected a source id)`);
      }
      sourceId = Number(sourceRaw);
      // Checked here so the error names the source rather than surfacing a
      // SQLITE_CONSTRAINT string. Provenance pointing at nothing is worse
      // than none, because it reads as a citation.
      if (!(await getSource(db, trip.id, sourceId))) {
        throw new Error(`no source #${sourceId} on this trip`);
      }
    }

    const atRaw = flag(argv, "--at");
    // Same grammar the mentions file uses, so 19:29 means the same thing in
    // both places.
    const atSeconds = atRaw === null ? null : parseStamp(atRaw);

    const id = await addObservation(db, trip.id, {
      sourceId, atSeconds, label, amount, currency,
      coversDays: readCount(argv, "--days"),
      coversPeople: readCount(argv, "--people"),
    });
    if (json) return JSON.stringify(await listObservations(db, trip.id));
    return `Recorded #${id} ${label}: ${currency.trim()} ${amount}.`;
  }

  if (sub === "ls") {
    const all = await listObservations(db, trip.id);
    if (json) return JSON.stringify({ observations: all });
    return renderObservations(all);
  }

  if (sub === "rm") {
    const raw = rest[0];
    if (!raw || !/^\d+$/.test(raw)) throw new Error("usage: trip costs rm <id>");
    const id = Number(raw);
    const gone = await removeObservation(db, trip.id, id);
    if (!gone) throw new Error(`no cost observation #${id} on this trip`);
    return json ? JSON.stringify({ removed: id }) : `Removed #${id}.`;
  }

  throw new Error(USAGE);
}

import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { addPass, listPasses, getPass, removePass } from "@/passes";
import { deriveDays } from "@/days";
import { parsePriceFlags } from "@/pricing/flags";
import { formatRule } from "@/pricing/rules";
import { setPriceRules, readPriceRules, deletePriceRules } from "@/prices";

const USAGE =
  "usage: trip pass add <name...> --days=2-4 --price=45 [--price=65+:0]\n" +
  "       trip pass ls\n" +
  "       trip pass rm <id>";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

function flags(argv: string[], name: string): string[] {
  return argv
    .filter((a) => a.startsWith(`${name}=`))
    .map((a) => a.slice(name.length + 1));
}

const DAYS = /^(\d+)-(\d+)$/;

function parseDays(raw: string): { fromDay: number; toDay: number } {
  const m = DAYS.exec(raw.trim());
  if (!m) throw new Error(`invalid --days "${raw}" (expected N-M, e.g. 2-4)`);
  return { fromDay: Number(m[1]), toDay: Number(m[2]) };
}

export async function runPassCommand(
  db: Client,
  argv: string[],
  json: boolean,
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  const [sub, ...rest] = argv;

  if (sub === "add") {
    const name = rest.filter((a) => !a.startsWith("--")).join(" ").trim();
    if (!name) throw new Error(USAGE);

    const daysRaw = flag(argv, "--days");
    if (daysRaw === null) {
      throw new Error(`pass "${name}" needs --days=N-M (e.g. --days=2-4)`);
    }
    const { fromDay, toDay } = parseDays(daysRaw);

    // Validated against the trip's REAL day count when there is one. With no
    // dates set there is no count to check against, and inventing one would
    // be a guess -- a check that cannot be sure says nothing, so the range is
    // stored unvalidated rather than rejected or fabricated against.
    if (trip.startDate !== null && trip.endDate !== null) {
      const days = deriveDays({
        startDate: trip.startDate, endDate: trip.endDate,
        arrivalMin: trip.arrivalMin, departureMin: trip.departureMin,
        dayStartMin: trip.dayStartMin, dayEndMin: trip.dayEndMin,
      });
      if (toDay > days.length) {
        throw new Error(
          `--days=${fromDay}-${toDay} runs past the end of the trip, ` +
          `which has ${days.length} days`,
        );
      }
    }

    // Parsed before the row is written, same reason as `seg add`: a bad rule
    // set must leave no pass behind.
    const rules = parsePriceFlags(argv, flags, flag);
    const id = await addPass(db, trip.id, name, fromDay, toDay);
    if (rules.length > 0) await setPriceRules(db, "pass", id, rules);

    if (json) return JSON.stringify({ id, name, fromDay, toDay, rules });
    const note = rules.length === 0
      ? " (no price given, so it counts as UNKNOWN rather than free)"
      : "";
    return `added pass #${id} ${name}, days ${fromDay}-${toDay}${note}`;
  }

  if (sub === "ls") {
    const all = await listPasses(db, trip.id);
    const rules = await readPriceRules(db, "pass", all.map((p) => p.id));
    if (json) {
      return JSON.stringify({
        passes: all.map((p) => ({ ...p, rules: rules.get(p.id) ?? [] })),
      });
    }
    if (all.length === 0) {
      return "No passes yet. Add one with: trip pass add <name> --days=2-4 --price=45";
    }
    return all
      .map((p) => {
        const r = rules.get(p.id);
        // No rules is UNKNOWN, and it says so rather than showing a blank
        // column that reads as free.
        const priced = r === undefined ? "?" : r.map(formatRule).join(" ");
        return `  #${p.id} ${p.name.padEnd(22)} days ${p.fromDay}-${p.toDay}  ${priced}`;
      })
      .join("\n");
  }

  if (sub === "rm") {
    const raw = rest[0];
    if (!raw || !/^\d+$/.test(raw)) throw new Error("usage: trip pass rm <id>");
    const id = Number(raw);
    // Existence checked BEFORE deleting rules, so a bad id cannot delete
    // rules belonging to nothing.
    const pass = await getPass(db, trip.id, id);
    if (!pass) throw new Error(`no pass #${id} on this trip`);
    await deletePriceRules(db, "pass", id);
    await removePass(db, trip.id, id);
    return json ? JSON.stringify({ removed: id }) : `removed pass #${id}`;
  }

  throw new Error(USAGE);
}

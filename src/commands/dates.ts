import type { Client } from "@libsql/client";
import { getActiveTrip, setTripSchedule } from "@/trips";
import { parseClock, parseDateRange, formatClock } from "@/parse";
import { deriveDays, DEFAULT_DAY_START, DEFAULT_DAY_END } from "@/days";

const USAGE =
  "usage: trip dates set <start>..<end> [--arrive=HH:MM] [--depart=HH:MM] " +
  "[--day-window=HH:MM-HH:MM]";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

export async function runDatesCommand(
  db: Client,
  argv: string[],
  json: boolean,
): Promise<string> {
  if (argv[0] !== "set") throw new Error(USAGE);

  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  const positional = argv.slice(1).filter((a) => !a.startsWith("--"));
  const range = positional[0];
  if (!range) throw new Error(USAGE);
  const { start, end } = parseDateRange(range);

  const arriveRaw = flag(argv, "--arrive");
  const departRaw = flag(argv, "--depart");
  const arrivalMin = arriveRaw === null ? null : parseClock(arriveRaw);
  const departureMin = departRaw === null ? null : parseClock(departRaw);

  let dayStartMin = DEFAULT_DAY_START;
  let dayEndMin = DEFAULT_DAY_END;
  const windowRaw = flag(argv, "--day-window");
  if (windowRaw !== null) {
    const [from, to] = windowRaw.split("-");
    if (!from || !to) throw new Error("--day-window must look like 09:00-19:00");
    dayStartMin = parseClock(from);
    dayEndMin = parseClock(to);
    if (dayEndMin <= dayStartMin) {
      throw new Error("--day-window must end after it starts");
    }
  }

  await setTripSchedule(db, trip.id, {
    startDate: start, endDate: end, arrivalMin, departureMin,
    dayStartMin, dayEndMin,
  });

  const days = deriveDays({
    startDate: start, endDate: end, arrivalMin, departureMin,
    dayStartMin, dayEndMin,
  });

  if (json) {
    return JSON.stringify({ trip: trip.name, start, end, days });
  }

  const lines = [`${trip.name}: ${start} to ${end} - ${days.length} days`];
  for (const d of days) {
    lines.push(
      `  Day ${String(d.day).padStart(2)}  ${d.date}  ${d.weekday}  ` +
      `${formatClock(d.startMin)}-${formatClock(d.endMin)}`,
    );
  }
  // M2-3: the assumption has to be visible. A silently-full arrival day
  // overpacks every real trip's first day.
  if (arrivalMin === null || departureMin === null) {
    lines.push(
      "",
      "No arrival/departure times given - all days assumed full. " +
      "Use --arrive/--depart if you fly in or out mid-day.",
    );
  }
  return lines.join("\n");
}

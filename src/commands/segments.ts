import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { addSegment, listSegments, removeSegment, setSegmentDwell } from "@/segments";
import { readPlacements } from "@/placements";
import { parseClock, parseCoords, parseDuration, parseWeekdays } from "@/parse";
import { renderSegmentList } from "@/render-plan";
import { parsePriceFlags } from "@/pricing/flags";
import { validateRuleSet } from "@/pricing/rules";
import { setPriceRules, readPriceRules, deletePriceRules } from "@/prices";

const USAGE =
  "usage: trip seg add <name> --dur=<90m> [--price=30] [--price=65+:0] " +
  "[--tag=food] [--at=lat,lon] [--hours=HH:MM-HH:MM] [--closed=mon,tue] " +
  "[--free-days=tue]\n" +
  "       trip seg ls [--tag=food] [--unplaced] [--from=<source-id>]\n" +
  "       trip seg set <id> --dur=<90m>\n" +
  "       trip seg price <id> --price=30 | --clear\n" +
  "       trip seg rm <id>";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

function flags(argv: string[], name: string): string[] {
  return argv
    .filter((a) => a.startsWith(`${name}=`))
    .map((a) => a.slice(name.length + 1));
}

export async function runSegmentsCommand(
  db: Client,
  argv: string[],
  json: boolean,
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  const [sub, ...rest] = argv;
  if (sub === "add") return addCmd(db, trip.id, rest, json);
  if (sub === "ls") return lsCmd(db, trip.id, rest, json);
  if (sub === "rm") return rmCmd(db, trip.id, rest, json);
  if (sub === "set") return setCmd(db, trip.id, rest, json);
  if (sub === "price") return priceCmd(db, trip.id, rest, json);
  throw new Error(USAGE);
}

async function addCmd(
  db: Client, tripId: number, argv: string[], json: boolean,
): Promise<string> {
  // JOIN the positionals. Taking argv[0] is what made `trip when New York`
  // answer about Patna, India, with exit code 0.
  const name = argv.filter((a) => !a.startsWith("--")).join(" ").trim();
  if (!name) throw new Error(USAGE);

  const durRaw = flag(argv, "--dur");
  if (durRaw === null) throw new Error("--dur is required (e.g. --dur=90m)");
  const dwellMinutes = parseDuration(durRaw);

  const atRaw = flag(argv, "--at");
  const coords = atRaw === null ? null : parseCoords(atRaw);

  // NULL means UNKNOWN hours, never "open all day" (M2-2).
  let opensMin: number | null = null;
  let closesMin: number | null = null;
  const hoursRaw = flag(argv, "--hours");
  if (hoursRaw !== null) {
    const [from, to] = hoursRaw.split("-");
    if (!from || !to) throw new Error("--hours must look like 10:00-18:00");
    opensMin = parseClock(from);
    // 24:00 is a legitimate closing time and parseClock rejects it (it bounds
    // hours at 23), so this is the single place the string is understood.
    //
    // It maps to 1440, NOT 1439. The rest of the codebase already spells the
    // end of day 1440 — `plan/order.ts` calls a day 1440 minutes, `plan.ts`
    // tests day overflow at >= 1440, and `addSegment`'s bound accepts 1440 —
    // so 1439 here was the lone dissenter, and it cost a real minute:
    // `schedule.ts` rejects a placement when `start + dwell > closesMin`, so
    // 22:00 + 120m == 1440 was refused at a place the user said closes at
    // midnight. It also made the CLI render `--hours=10:00-24:00` back as
    // `10:00-23:59`, restating the user's input as something they did not type.
    closesMin = to === "24:00" ? 1440 : parseClock(to);
    if (closesMin <= opensMin) throw new Error("--hours must close after it opens");
  }

  const closedRaw = flag(argv, "--closed");
  const closedDays = closedRaw === null ? [] : parseWeekdays(closedRaw);

  // Same weekday vocabulary as --closed, deliberately. A day listed in both
  // is allowed and inert: the scheduler never places the segment there, so
  // the free rule never fires, and a venue's own listing can say both.
  const freeRaw = flag(argv, "--free-days");
  const freeDays = freeRaw === null ? [] : parseWeekdays(freeRaw);

  // Parsed and validated BEFORE the row is written. A bad rule set must add
  // no segment at all -- half-adding one and then failing on its prices
  // leaves a row the user did not ask for and cannot see the price of.
  const rules = parsePriceFlags(argv, flags, flag);
  validateRuleSet(rules);

  const id = await addSegment(db, tripId, {
    name,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    dwellMinutes, tags: flags(argv, "--tag"),
    opensMin, closesMin, closedDays, freeDays,
  });
  if (rules.length > 0) await setPriceRules(db, "segment", id, rules);

  // Same facts as the human warning below, as booleans an agent can branch
  // on directly instead of parsing prose or issuing a follow-up `seg ls
  // --json` to learn a segment it just created can't be placed or scheduled.
  // Names match Task 11's plan JSON, which also emits hoursKnown.
  if (json) {
    return JSON.stringify({
      id, name,
      hasCoordinates: coords !== null,
      hoursKnown: opensMin !== null,
    });
  }
  const warn = coords === null
    ? " (no coordinates - cannot be placed until you add --at)"
    : "";
  return `added #${id} ${name}${warn}`;
}

async function lsCmd(
  db: Client, tripId: number, argv: string[], json: boolean,
): Promise<string> {
  const fromRaw = flag(argv, "--from");
  if (fromRaw !== null && !Number.isInteger(Number(fromRaw))) {
    throw new Error(`invalid --from "${fromRaw}" (expected a source id)`);
  }
  let segments = await listSegments(db, tripId,
    fromRaw === null ? {} : { sourceId: Number(fromRaw) });

  const tag = flag(argv, "--tag");
  if (tag !== null) segments = segments.filter((s) => s.tags.includes(tag));

  if (argv.includes("--unplaced")) {
    const placed = new Set((await readPlacements(db, tripId)).map((p) => p.segmentId));
    segments = segments.filter((s) => !placed.has(s.id));
  }

  const rules = await readPriceRules(db, "segment", segments.map((s) => s.id));
  if (json) {
    return JSON.stringify({
      segments: segments.map((s) => ({ ...s, priceRules: rules.get(s.id) ?? [] })),
    });
  }
  if (segments.length === 0) return "no segments match.";
  // Rules, never a resolved price: an unplaced segment has no date, so no
  // age, so no price (M5-8).
  return renderSegmentList(segments, rules);
}

async function rmCmd(
  db: Client, tripId: number, argv: string[], json: boolean,
): Promise<string> {
  const raw = argv[0];
  const id = Number(raw);
  if (!raw || !Number.isInteger(id)) {
    throw new Error(`invalid segment id "${raw ?? ""}"`);
  }
  const removed = await removeSegment(db, tripId, id);
  if (!removed) throw new Error(`no segment #${id} in this trip`);
  // Rules go with the segment. `segments.id` is AUTOINCREMENT so an id is
  // never reused and an orphan could not re-attach to anything, but a table
  // that accumulates rows nobody can reach is how a later reader concludes
  // the data means something it does not.
  await deletePriceRules(db, "segment", id);
  return json ? JSON.stringify({ removed: id }) : `removed #${id}`;
}

async function priceCmd(
  db: Client, tripId: number, argv: string[], json: boolean,
): Promise<string> {
  const raw = argv[0];
  const id = Number(raw);
  if (!raw || !/^\d+$/.test(raw)) {
    throw new Error(
      "usage: trip seg price <id> --price=30 [--price=65+:0] | --clear",
    );
  }
  const segments = await listSegments(db, tripId);
  if (!segments.some((s) => s.id === id)) {
    throw new Error(`no segment #${id} in this trip`);
  }

  if (argv.includes("--clear")) {
    if (flags(argv, "--price").length > 0 || flag(argv, "--cost") !== null) {
      throw new Error("--clear takes no prices");
    }
    await deletePriceRules(db, "segment", id);
    return json
      ? JSON.stringify({ id, rules: [] })
      : `Cleared the prices on #${id}. It now costs UNKNOWN, not free.`;
  }

  const rules = parsePriceFlags(argv, flags, flag);
  if (rules.length === 0) {
    throw new Error("give at least one --price, or --clear to make it unknown");
  }
  await setPriceRules(db, "segment", id, rules);
  return json
    ? JSON.stringify({ id, rules })
    : `Set ${rules.length} price rule${rules.length === 1 ? "" : "s"} on #${id}.`;
}

async function setCmd(
  db: Client, tripId: number, argv: string[], json: boolean,
): Promise<string> {
  const raw = argv[0];
  const id = Number(raw);
  if (!raw || !Number.isInteger(id)) {
    throw new Error(`invalid segment id "${raw ?? ""}"`);
  }
  const durRaw = flag(argv, "--dur");
  if (durRaw === null) throw new Error("--dur is required (e.g. --dur=90m)");
  const dwellMinutes = parseDuration(durRaw);

  const updated = await setSegmentDwell(db, tripId, id, dwellMinutes);
  if (!updated) throw new Error(`no segment #${id} in this trip`);
  return json
    ? JSON.stringify({ id, dwellMinutes })
    : `#${id} now ${dwellMinutes}m`;
}

import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { addSegment, listSegments, removeSegment } from "@/segments";
import { readPlacements } from "@/placements";
import { parseClock, parseCoords, parseDuration, parseWeekdays } from "@/parse";
import { renderSegmentList } from "@/render-plan";

const USAGE =
  "usage: trip seg add <name> --dur=<90m> [--cost=25] [--tag=food] " +
  "[--at=lat,lon] [--hours=HH:MM-HH:MM] [--closed=mon,tue]\n" +
  "       trip seg ls [--tag=food] [--unplaced]\n" +
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

  const costRaw = flag(argv, "--cost");
  // F5: Number("") is 0, not NaN, so `--cost=` (empty) would silently store a
  // real 0 instead of the NULL "unknown" absence means -- the identical trap
  // already fixed in parseCoords for `--at=`. Reject it explicitly before
  // the conversion, same as every other value flag here.
  if (costRaw === "") throw new Error(`invalid --cost "${costRaw}"`);
  const cost = costRaw === null ? null : Number(costRaw);
  if (cost !== null && !Number.isFinite(cost)) {
    throw new Error(`invalid --cost "${costRaw}"`);
  }

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
    // 24:00 is a legitimate closing time and parseClock rejects it, so the
    // end of day is spelled 23:59 internally.
    closesMin = to === "24:00" ? 1439 : parseClock(to);
    if (closesMin <= opensMin) throw new Error("--hours must close after it opens");
  }

  const closedRaw = flag(argv, "--closed");
  const closedDays = closedRaw === null ? [] : parseWeekdays(closedRaw);

  const id = await addSegment(db, tripId, {
    name,
    latitude: coords?.latitude ?? null,
    longitude: coords?.longitude ?? null,
    dwellMinutes, cost, tags: flags(argv, "--tag"),
    opensMin, closesMin, closedDays,
  });

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
  let segments = await listSegments(db, tripId);

  const tag = flag(argv, "--tag");
  if (tag !== null) segments = segments.filter((s) => s.tags.includes(tag));

  if (argv.includes("--unplaced")) {
    const placed = new Set((await readPlacements(db, tripId)).map((p) => p.segmentId));
    segments = segments.filter((s) => !placed.has(s.id));
  }

  if (json) return JSON.stringify({ segments });
  if (segments.length === 0) return "no segments match.";
  return renderSegmentList(segments);
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
  return json ? JSON.stringify({ removed: id }) : `removed #${id}`;
}

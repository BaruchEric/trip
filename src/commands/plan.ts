import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { listSegments, type Segment } from "@/segments";
import { readPins, readPlacements, savePlacements, setPinned, clearPin } from "@/placements";
import { deriveDays, type DayWindow } from "@/days";
import { compile } from "@/plan/compile";
import { MODES, PACES, type Mode, type Pace, type Unplaced } from "@/plan/types";
import { formatClock, parseClock } from "@/parse";
import { renderDay, renderPlan } from "@/render-plan";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

/** Resolve `<seg>` to an id. A number is an id; anything else is a
 *  case-insensitive substring of the name. An ambiguous match is an ERROR:
 *  silently picking the first would pin the wrong thing and look like it
 *  worked. */
function resolveSegment(segments: Segment[], token: string): Segment {
  if (/^\d+$/.test(token)) {
    const byId = segments.find((s) => s.id === Number(token));
    if (!byId) throw new Error(`no segment #${token} in this trip`);
    return byId;
  }
  const needle = token.toLowerCase();
  const hits = segments.filter((s) => s.name.toLowerCase().includes(needle));
  if (hits.length === 0) throw new Error(`no segment matching "${token}"`);
  if (hits.length > 1) {
    throw new Error(
      `"${token}" matches ${hits.length} segments: ` +
      `${hits.map((s) => `#${s.id} ${s.name}`).join(", ")}`,
    );
  }
  return hits[0]!;
}

async function loadContext(db: Client) {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");
  if (trip.startDate === null || trip.endDate === null) {
    throw new Error("no dates set - run `trip dates set <start>..<end>` first");
  }
  const days = deriveDays({
    startDate: trip.startDate, endDate: trip.endDate,
    arrivalMin: trip.arrivalMin, departureMin: trip.departureMin,
    dayStartMin: trip.dayStartMin, dayEndMin: trip.dayEndMin,
  });
  const segments = await listSegments(db, trip.id);
  return { trip, days, segments };
}

export async function runPlanCommand(
  db: Client,
  command: string,
  argv: string[],
  json: boolean,
): Promise<string> {
  if (command === "plan" || command === "replan") return doPlan(db, argv, json);
  if (command === "day") return doDay(db, argv, json);
  if (command === "pin") return doPin(db, argv, json);
  if (command === "unpin") return doUnpin(db, argv, json);
  if (command === "move") return doMove(db, argv, json);
  throw new Error(`unknown plan command "${command}"`);
}

async function doPlan(db: Client, argv: string[], json: boolean): Promise<string> {
  const { trip, days, segments } = await loadContext(db);
  if (segments.length === 0) {
    throw new Error("no segments yet - run `trip seg add <name> --dur=<90m>` first");
  }

  const modeRaw = flag(argv, "--mode") ?? trip.mode;
  const paceRaw = flag(argv, "--pace") ?? trip.pace;
  // Rejected, never defaulted: a typo that silently falls back to `normal`
  // gives a plan the user did not ask for, with a success exit code.
  if (!MODES.includes(modeRaw as Mode)) {
    throw new Error(`invalid --mode "${modeRaw}" (expected ${MODES.join(" or ")})`);
  }
  if (!PACES.includes(paceRaw as Pace)) {
    throw new Error(`invalid --pace "${paceRaw}" (expected ${PACES.join(", ")})`);
  }

  const result = compile(segments, days, {
    mode: modeRaw as Mode, pace: paceRaw as Pace, pins: await readPins(db, trip.id),
  });
  await savePlacements(db, trip.id, result.placements);

  if (json) return planJson(days, result.placements, segments, result.unplaced);
  return renderPlan(days, result.placements, segments, result.unplaced);
}

/** (ordinal, startMin, segmentId): same tie-break `renderDay` uses, and for
 *  the same reason — between a `pin`/`move` and the next `replan`, ordinal 0
 *  can be shared by more than one placement, and this is agent-facing output
 *  that must not vary across calls. */
function byOrdinalThenClock(
  a: { ordinal: number; startMin: number; segmentId: number },
  b: { ordinal: number; startMin: number; segmentId: number },
): number {
  return a.ordinal - b.ordinal || a.startMin - b.startMin || a.segmentId - b.segmentId;
}

function planJson(
  days: DayWindow[],
  placements: { segmentId: number; day: number; ordinal: number; startMin: number; endMin: number; pinned: boolean }[],
  segments: Segment[],
  unplaced: { segmentId: number; reason: string }[],
): string {
  const byId = new Map(segments.map((s) => [s.id, s]));
  return JSON.stringify({
    days: days.map((d) => ({
      day: d.day, date: d.date, weekday: d.weekday,
      startTime: formatClock(d.startMin), endTime: formatClock(d.endMin),
      placements: placements
        .filter((p) => p.day === d.day)
        .sort(byOrdinalThenClock)
        .map((p) => ({
          segmentId: p.segmentId,
          name: byId.get(p.segmentId)?.name ?? null,
          startTime: formatClock(p.startMin),
          endTime: formatClock(p.endMin),
          pinned: p.pinned,
          // Explicit, so an agent never has to infer that a missing field
          // means "we guessed" (M2-2).
          hoursKnown: byId.get(p.segmentId)?.opensMin !== null,
        })),
    })),
    unplaced: unplaced.map((u) => ({
      segmentId: u.segmentId,
      name: byId.get(u.segmentId)?.name ?? null,
      reason: u.reason,
    })),
  });
}

async function doDay(db: Client, argv: string[], json: boolean): Promise<string> {
  const { trip, days, segments } = await loadContext(db);
  const n = Number(argv[0]);
  const day = days.find((d) => d.day === n);
  if (!day) throw new Error(`no day ${argv[0] ?? ""} in this trip (1-${days.length})`);

  const placements = await readPlacements(db, trip.id);
  if (placements.length === 0) throw new Error("nothing planned yet - run `trip plan`");

  // A pin asserted onto THIS day that the last compile could not place has
  // no row in `placements` at all (fix round 1 in placements.ts: its
  // compiled result gets cleared rather than left stale) — cross-reference
  // against the pins themselves so it is called out here, not silently
  // absent. `trip plan`'s own reason string is not persisted (compile()
  // recomputes it fresh each run), so this can only say THAT it was
  // dropped, not why.
  const pins = await readPins(db, trip.id);
  const placedIds = new Set(placements.map((p) => p.segmentId));
  const dayUnplaced: Unplaced[] = pins
    .filter((p) => p.day === day.day && !placedIds.has(p.segmentId))
    .map((p) => ({
      segmentId: p.segmentId,
      reason: "not placed by the last plan - run `trip plan` to see why",
    }));

  if (json) return planJson([day], placements, segments, dayUnplaced);
  return renderDay(day, placements, new Map(segments.map((s) => [s.id, s])), dayUnplaced);
}

async function doPin(db: Client, argv: string[], json: boolean): Promise<string> {
  const { days, segments } = await loadContext(db);
  const token = argv.find((a) => !a.startsWith("--"));
  if (!token) throw new Error("usage: trip pin <seg> --day=<n> [--at=HH:MM]");
  const segment = resolveSegment(segments, token);

  const dayRaw = flag(argv, "--day");
  if (dayRaw === null) throw new Error("--day is required (e.g. --day=2)");
  const day = Number(dayRaw);
  if (!days.some((d) => d.day === day)) {
    throw new Error(`day ${dayRaw} is outside the trip (1-${days.length})`);
  }

  const atRaw = flag(argv, "--at");
  const startMin = atRaw === null ? null : parseClock(atRaw);
  await setPinned(db, segment.id, day, startMin);

  const when = startMin === null ? `day ${day}` : `day ${day} at ${formatClock(startMin)}`;
  return json
    ? JSON.stringify({ pinned: segment.id, day, startTime: atRaw })
    : `pinned ${segment.name} to ${when}. Run \`trip replan\` to rebuild around it.`;
}

async function doUnpin(db: Client, argv: string[], json: boolean): Promise<string> {
  const { segments } = await loadContext(db);
  const token = argv.find((a) => !a.startsWith("--"));
  if (!token) throw new Error("usage: trip unpin <seg>");
  const segment = resolveSegment(segments, token);

  if (!(await clearPin(db, segment.id))) {
    throw new Error(`${segment.name} is not pinned`);
  }
  return json
    ? JSON.stringify({ unpinned: segment.id })
    : `unpinned ${segment.name}. Run \`trip replan\` to let the compiler place it.`;
}

async function doMove(db: Client, argv: string[], json: boolean): Promise<string> {
  const { days, segments } = await loadContext(db);
  const token = argv.find((a) => !a.startsWith("--"));
  if (!token) throw new Error("usage: trip move <seg> --to=day<n>");
  const segment = resolveSegment(segments, token);

  const toRaw = flag(argv, "--to");
  if (toRaw === null) throw new Error("--to is required (e.g. --to=day4)");
  const day = Number(toRaw.replace(/^day/i, ""));
  if (!days.some((d) => d.day === day)) {
    throw new Error(`day ${toRaw} is outside the trip (1-${days.length})`);
  }

  // move PINS (M2 spec). Leaving it unpinned would mean the next replan
  // silently undoes the move.
  await setPinned(db, segment.id, day, null);
  return json
    ? JSON.stringify({ moved: segment.id, day })
    : `moved ${segment.name} to day ${day} (pinned to the day, time is the compiler's). ` +
      "Run `trip replan`.";
}

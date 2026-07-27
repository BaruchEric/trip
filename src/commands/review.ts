import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { getDestination } from "@/climate/cache";
import { listMentions } from "@/mentions";
import { SEARCH_RADIUS_KM } from "@/geo/poi";
import { renderReviewQueue } from "@/render-review";

const USAGE =
  "usage: trip review ls [--source=<id>]\n" +
  "       trip review resolve <id> --pick=<n> | --reject | --rename=\"Actual Name\"";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

export interface ReviewDeps {
  now?: () => string;
  geocode?: (query: string, centre: { latitude: number; longitude: number }) =>
    Promise<import("@/geo/poi").PoiCandidate[]>;
}

export async function runReviewCommand(
  db: Client,
  argv: string[],
  json: boolean,
  deps: ReviewDeps = {},
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  const [sub, ...rest] = argv;
  if (sub === "ls") return lsCmd(db, trip, rest, json);
  if (sub === "resolve") return resolveCmd(db, trip, rest, json, deps);
  throw new Error(USAGE);
}

async function lsCmd(
  db: Client,
  trip: { id: number; name: string; destinationId: number | null },
  argv: string[],
  json: boolean,
): Promise<string> {
  const sourceRaw = flag(argv, "--source");
  const pending = await listMentions(db, trip.id, {
    state: "pending",
    ...(sourceRaw === null ? {} : { sourceId: Number(sourceRaw) }),
  });

  const dest = trip.destinationId === null
    ? null
    : await getDestination(db, trip.destinationId);
  const where = dest?.name ?? "the trip destination";

  if (json) {
    return JSON.stringify({
      searchRadiusKm: SEARCH_RADIUS_KM,
      destination: dest?.name ?? null,
      pending: pending.map((m) => ({
        id: m.id, sourceId: m.sourceId, text: m.text, name: m.name,
        atSeconds: m.atSeconds, reason: m.reason,
        candidates: m.candidates,
      })),
    });
  }
  return renderReviewQueue(pending, where, SEARCH_RADIUS_KM);
}

// Task 14 implements `trip review resolve`. This stub exists only so `ls`'s
// suite can be green in isolation — do not test against it; a test asserting
// this throws USAGE would have to be deleted by whoever implements it, with
// no way to tell whether that assertion was a placeholder or a real
// requirement.
async function resolveCmd(
  _db: Client,
  _trip: { id: number; name: string; destinationId: number | null },
  _argv: string[],
  _json: boolean,
  _deps: ReviewDeps,
): Promise<string> {
  throw new Error(USAGE);
}

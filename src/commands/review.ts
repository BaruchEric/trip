import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { getDestination } from "@/climate/cache";
import {
  listMentions, getMention, resolveMention, rejectMention, renameMention,
  queueMention, setCandidates, type Mention,
} from "@/mentions";
import { addSegment } from "@/segments";
import { parsePriceRule } from "@/pricing/rules";
import { setPriceRules } from "@/prices";
import { classify, DEFAULT_DWELL_MINUTES } from "@/watch/ingest";
import { SEARCH_RADIUS_KM, geocodePoi } from "@/geo/poi";
import { getSource } from "@/sources";
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
  let sourceId: number | null = null;
  if (sourceRaw !== null) {
    sourceId = Number(sourceRaw);
    // A NaN id (e.g. --source=abc) must not reach the driver as a query
    // param - that surfaces as a raw driver error instead of a message
    // naming the problem. Validated the same way `watch ingest` validates
    // --source, so a typo reads as "no such source", never as a drained
    // queue (an empty filter result IS a legitimate answer for a source
    // that exists; it is not for one that does not).
    if (!Number.isInteger(sourceId)) {
      throw new Error(`invalid --source "${sourceRaw}" - must be a whole number`);
    }
    const source = await getSource(db, trip.id, sourceId);
    if (source === null) throw new Error(`no source #${sourceRaw} in this trip`);
  }
  const pending = await listMentions(db, trip.id, {
    state: "pending",
    ...(sourceId === null ? {} : { sourceId }),
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

async function resolveCmd(
  db: Client,
  trip: { id: number; name: string; destinationId: number | null },
  argv: string[],
  json: boolean,
  deps: ReviewDeps,
): Promise<string> {
  const idRaw = argv.find((a) => !a.startsWith("--"));
  const id = Number(idRaw);
  if (idRaw === undefined || !Number.isInteger(id)) {
    throw new Error(`invalid mention id "${idRaw ?? ""}"`);
  }

  const pick = flag(argv, "--pick");
  const rename = flag(argv, "--rename");
  const reject = argv.includes("--reject");
  const actions = [pick !== null, rename !== null, reject].filter(Boolean).length;
  if (actions === 0) {
    throw new Error(
      `one of --pick=<n>, --reject or --rename="Actual Name" is required`,
    );
  }
  if (actions > 1) {
    throw new Error(`exactly one of --pick, --reject or --rename may be given`);
  }

  const mention = await getMention(db, trip.id, id);
  if (mention === null) throw new Error(`no mention #${id} in this trip`);
  // A second resolve is an error naming the state, never a silent second
  // segment. The queue is drained once per mention.
  if (mention.state !== "pending") {
    throw new Error(
      `mention #${id} is already ${mention.state}` +
      (mention.segmentId === null ? "" : ` (segment #${mention.segmentId})`),
    );
  }

  const now = deps.now ?? (() => new Date().toISOString());

  if (reject) {
    await rejectMention(db, id, now());
    return json
      ? JSON.stringify({ id, state: "rejected" })
      : `rejected #${id} "${mention.text}"`;
  }

  if (rename !== null) {
    if (trip.destinationId === null) {
      throw new Error(`trip "${trip.name}" has no destination to geocode against`);
    }
    const dest = await getDestination(db, trip.destinationId);
    if (!dest) throw new Error(`destination #${trip.destinationId} is missing`);

    const geocode = deps.geocode ?? ((q, c) => geocodePoi(q, c));
    // Geocode BEFORE writing anything. If the lookup throws, the mention must
    // come out of this exactly as it went in — old name, old candidates —
    // rather than landing with the new name written but the OLD name's
    // candidates still beside it: the exact mismatch --rename exists to
    // prevent (a later --pick=N would silently mean a different place than
    // the list the reader last saw). Mirrors ingestMentions' geocode-then-
    // commit ordering in src/watch/ingest.ts.
    const candidates = await geocode(rename, dest);

    await renameMention(db, id, rename);
    // Replaces, never appends: leaving the old name's candidates alongside the
    // new name's would make --pick=2 mean a different place than the list the
    // reader just saw.
    await setCandidates(db, id, candidates.map((c, i) => ({ ...c, rank: i + 1 })));

    // The mention's OWN kind, so a corrected name is held to the same standard
    // as the original. `--rename` re-geocodes, which makes it exactly the path
    // a wrong unique result can re-enter through; passing null here would make
    // it a documented bypass.
    const verdict = classify(candidates, mention.kind);
    if (verdict.kind === "queued") {
      await queueMention(db, id, verdict.reason);
      return json
        ? JSON.stringify({ id, state: "pending", reason: verdict.reason,
                           candidates: candidates.length })
        : `#${id} renamed to "${rename}" - still ${verdict.reason}. ` +
          `run: trip review ls`;
    }
    const segmentId = await createSegmentFrom(db, trip.id, mention, rename, verdict.candidate);
    return json
      ? JSON.stringify({ id, state: "resolved", segmentId })
      : `resolved #${id} as "${rename}" -> segment #${segmentId} ` +
        `(${verdict.candidate.localName ?? verdict.candidate.displayName})`;
  }

  const n = Number(pick);
  if (!Number.isInteger(n) || n < 1 || n > mention.candidates.length) {
    throw new Error(
      mention.candidates.length === 0
        ? `mention #${id} has no candidates - use --rename or --reject`
        : `--pick=${pick} is out of range (1..${mention.candidates.length})`,
    );
  }
  const chosen = mention.candidates[n - 1]!;
  const segmentId = await createSegmentFrom(db, trip.id, mention, mention.name, chosen);
  return json
    ? JSON.stringify({ id, state: "resolved", segmentId })
    : `resolved #${id} -> segment #${segmentId} ` +
      `(${chosen.localName ?? chosen.displayName})`;
}

/** One place that turns a chosen candidate into a segment, so --pick and
 *  --rename cannot drift on what a resolved mention produces. */
async function createSegmentFrom(
  db: Client,
  tripId: number,
  mention: Mention,
  name: string,
  candidate: { localName: string | null; latitude: number; longitude: number },
): Promise<number> {
  const segmentId = await addSegment(db, tripId, {
    name,
    localName: candidate.localName,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    dwellMinutes: mention.dwellMinutes ?? DEFAULT_DWELL_MINUTES,
    dwellIsDefault: mention.dwellMinutes === null,
    freeDays: [],
    tags: mention.tags,
    opensMin: null,
    closesMin: null,
    closedDays: [],
    sourceId: mention.sourceId,
    sourceAtSeconds: mention.atSeconds,
  });
  // The video's stated prices follow the mention through the queue. Without
  // this, a place that had to be reviewed would silently lose the price the
  // video gave it, while an identical place that resolved confidently kept
  // it -- two paths to the same segment disagreeing about what is known.
  if (mention.price.length > 0) {
    await setPriceRules(
      db, "segment", segmentId, mention.price.map(parsePriceRule));
  }
  await resolveMention(db, mention.id, segmentId);
  return segmentId;
}

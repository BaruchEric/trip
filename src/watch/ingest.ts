import type { Client } from "@libsql/client";
import { parseDuration } from "@/parse";
import { parseStamp } from "@/watch/parse-report";
import {
  createMention, setCandidates, resolveMention, queueMention,
} from "@/mentions";
import { addSegment } from "@/segments";
import {
  geocodePoi, NOMINATIM_MIN_INTERVAL_MS, type Centre, type PoiCandidate,
} from "@/geo/poi";
import {
  isKind, KINDS, plausibilityReason, type Kind,
} from "@/geo/plausibility";

/** Applied when the extractor proposed no dwell. It is a guess, so every
 *  segment carrying it is flagged `dwellIsDefault` and rendered [default]. */
export const DEFAULT_DWELL_MINUTES = 60;

export interface MentionSpec {
  text: string;
  atSeconds: number | null;
  dwellMinutes: number | null;
  tags: string[];
  /** What the extractor says this place is, for the plausibility check.
   *  NULL means it declared none — the denylist applies instead. */
  kind: Kind | null;
}

export interface ParsedMentions {
  specs: MentionSpec[];
  /** One line per rejected entry, naming its index. */
  errors: string[];
}

function readTags(raw: unknown, index: number): string[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new Error(`[${index}] tags must be an array`);
  return raw.map((t) => {
    if (typeof t !== "string" || t.trim() === "") {
      throw new Error(`[${index}] tags must be non-empty strings`);
    }
    // Tags share one comma-separated storage column (src/validate.ts's
    // joinList). Rejected here, at parse time, so the bad entry is skipped
    // like any other malformed one — rather than parsing clean and throwing
    // deep inside createMention -> joinList mid-ingest, which would abort
    // every mention after it in the same batch.
    if (t.includes(",")) {
      throw new Error(`[${index}] a tag may not contain a comma`);
    }
    return t.trim();
  });
}

function readKind(raw: unknown, index: number): Kind | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string" || !isKind(raw)) {
    // Rejected, not ignored: a typo that silently disabled the plausibility
    // check would be a NULL standing in for a value, which is what "absence
    // is loud" forbids. Skipped like any other malformed entry, so its
    // neighbours in the same file still ingest.
    // Names the offending value, not just the allowed set: the reader wrote
    // it, and "cave is not a kind" is a fixable message where "kind must be
    // one of ..." leaves them diffing thirteen strings by eye.
    throw new Error(
      `[${index}] unknown kind ${JSON.stringify(raw)}` +
      ` (one of: ${KINDS.join(", ")})`,
    );
  }
  return raw;
}

/** Parse the agent's mentions file.
 *
 *  A malformed ENTRY is reported and skipped; the rest of the file still
 *  ingests, because losing thirteen good mentions to one bad one is the wrong
 *  trade. A malformed FILE throws — there is nothing to salvage. */
export function parseMentionsFile(raw: string): ParsedMentions {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(`mentions file is not valid JSON: ${(err as Error).message}`);
  }
  if (!Array.isArray(json)) {
    throw new Error("mentions file must be a JSON array of objects");
  }

  const specs: MentionSpec[] = [];
  const errors: string[] = [];

  json.forEach((entry, i) => {
    try {
      if (typeof entry !== "object" || entry === null) {
        throw new Error(`[${i}] each mention must be an object`);
      }
      const e = entry as Record<string, unknown>;
      const text = typeof e.text === "string" ? e.text.trim() : "";
      if (text === "") throw new Error(`[${i}] text is required`);

      // Absent stays NULL. The extractor not knowing when something was said
      // is a fact worth keeping; second 0 is the first frame of the video.
      const atSeconds = e.at === undefined || e.at === null
        ? null
        : parseStamp(String(e.at));

      const dwellMinutes = e.dwell === undefined || e.dwell === null
        ? null
        : parseDuration(String(e.dwell));

      specs.push({
        text, atSeconds, dwellMinutes,
        tags: readTags(e.tags, i),
        kind: readKind(e.kind, i),
      });
    } catch (err) {
      const msg = (err as Error).message;
      errors.push(msg.startsWith("[") ? msg : `[${i}] ${msg}`);
    }
  });

  return { specs, errors };
}

export type Verdict =
  | { kind: "confident"; candidate: PoiCandidate }
  | { kind: "queued"; reason: string };

/** The confidence rule, in full: exactly one result inside the box is
 *  confident; anything else is queued.
 *
 *  Importance is deliberately NOT thresholded. Measured against the real API
 *  on 2026-07-27, every Chongqing restaurant returns importance 0.0001 while
 *  Hongya Cave returns 0.3408 — OSM importance tracks Wikipedia rank, so any
 *  floor would queue every food segment and the queue would become the whole
 *  video. Name similarity is out for the same kind of reason: OSM answers
 *  "Hongya Cave" with 洪崖洞, so cross-script similarity is ~0 and would queue
 *  a correct match.
 *
 *  M4 adds the plausibility gate, and adds it ONLY on the single-result path.
 *  Zero and two-plus are already queued by uniqueness, so a contradiction
 *  there would change no outcome; confining it here keeps the new logic to
 *  the one case that can produce a wrong segment, and leaves M3's measured
 *  behaviour intact everywhere else.
 *
 *  `declaredKind` is the MENTION's kind. It is NOT `Verdict.kind`, which
 *  discriminates confident from queued — hence the longer name. */
export function classify(
  candidates: PoiCandidate[],
  declaredKind: Kind | null,
): Verdict {
  if (candidates.length === 1) {
    const candidate = candidates[0]!;
    const reason = plausibilityReason(declaredKind, candidate);
    if (reason !== null) return { kind: "queued", reason };
    return { kind: "confident", candidate };
  }
  if (candidates.length === 0) {
    return { kind: "queued", reason: "no match" };
  }
  return { kind: "queued", reason: `${candidates.length} candidates` };
}

export interface IngestDeps {
  geocode?: (query: string, centre: Centre) => Promise<PoiCandidate[]>;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface IngestResult {
  total: number;
  /** Became segments. */
  geocoded: number;
  /** Queued because the answer was ambiguous or absent. */
  queued: number;
  /** Queued because the lookup itself failed. Counted apart from `queued` so
   *  a network outage does not read as a video full of vague places. */
  failed: number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Joins every pure piece Task 9 built to storage: geocode each mention,
 *  record its candidates, and either create a real segment (confident) or
 *  queue it for review (ambiguous, absent, or the lookup itself failed). */
export async function ingestMentions(
  db: Client,
  tripId: number,
  sourceId: number,
  specs: MentionSpec[],
  centre: Centre,
  deps: IngestDeps = {},
): Promise<IngestResult> {
  const geocode = deps.geocode ?? ((q, c) => geocodePoi(q, c));
  const sleepFn = deps.sleepFn ?? sleep;

  const result: IngestResult = {
    total: specs.length, geocoded: 0, queued: 0, failed: 0,
  };

  for (const [i, spec] of specs.entries()) {
    const mentionId = await createMention(db, tripId, sourceId, spec);

    // Spaced, not batched: Nominatim's policy is 1 request/second. The wait
    // goes BEFORE each lookup except the first, so a single-mention ingest
    // does not pay a second of latency for nothing.
    if (i > 0) await sleepFn(NOMINATIM_MIN_INTERVAL_MS);

    let candidates: PoiCandidate[];
    try {
      candidates = await geocode(spec.text, centre);
    } catch (err) {
      // One bad lookup queues one mention. Thirteen good mentions do not die
      // because the sixth got a 429.
      await queueMention(db, mentionId, `geocode failed: ${(err as Error).message}`);
      result.failed += 1;
      continue;
    }

    // The mention row already exists by this point, so anything below —
    // storing candidates, classifying, or writing the segment — can be
    // queued honestly instead of thrown. A malformed candidate (parsePoiResponse
    // only checks lat/lon are finite, not in range) or a spec that fails
    // segment validation would otherwise abort the whole batch after earlier
    // mentions were already committed. Kept as a SEPARATE reason from
    // "geocode failed" — the two say different things to whoever reads the
    // queue, and merging them would be the same mistake as merging `failed`
    // into `queued`.
    try {
      await setCandidates(db, mentionId, candidates.map((c, idx) => ({
        ...c, rank: idx + 1,
      })));

      // `setCandidates` above already stored the result, so a demotion here
      // leaves a rank-1 candidate the reviewer can accept with --pick=1.
      const verdict = classify(candidates, spec.kind);
      if (verdict.kind === "queued") {
        await queueMention(db, mentionId, verdict.reason);
        result.queued += 1;
        continue;
      }

      const c = verdict.candidate;
      const segmentId = await addSegment(db, tripId, {
        // The video's own words. `local_name` keeps OSM's, which comes back in
        // local script and is the string to show a taxi driver.
        name: spec.text,
        localName: c.localName,
        latitude: c.latitude,
        longitude: c.longitude,
        dwellMinutes: spec.dwellMinutes ?? DEFAULT_DWELL_MINUTES,
        dwellIsDefault: spec.dwellMinutes === null,
        cost: null,
        tags: spec.tags,
        // A geocoder does not know opening hours. NULL is UNKNOWN, and the
        // scheduler already reports these with a "?" rather than assuming a
        // window (M2-2).
        opensMin: null,
        closesMin: null,
        closedDays: [],
        sourceId,
        sourceAtSeconds: spec.atSeconds,
      });
      await resolveMention(db, mentionId, segmentId);
      result.geocoded += 1;
    } catch (err) {
      await queueMention(db, mentionId, `could not create segment: ${(err as Error).message}`);
      result.failed += 1;
      continue;
    }
  }

  return result;
}

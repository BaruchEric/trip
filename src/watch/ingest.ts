import { parseDuration } from "@/parse";
import { parseStamp } from "@/watch/parse-report";
import type { PoiCandidate } from "@/geo/poi";

/** Applied when the extractor proposed no dwell. It is a guess, so every
 *  segment carrying it is flagged `dwellIsDefault` and rendered [default]. */
export const DEFAULT_DWELL_MINUTES = 60;

export interface MentionSpec {
  text: string;
  atSeconds: number | null;
  dwellMinutes: number | null;
  tags: string[];
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
    return t.trim();
  });
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

      specs.push({ text, atSeconds, dwellMinutes, tags: readTags(e.tags, i) });
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
 *  a correct match. */
export function classify(candidates: PoiCandidate[]): Verdict {
  if (candidates.length === 1) {
    return { kind: "confident", candidate: candidates[0]! };
  }
  if (candidates.length === 0) {
    return { kind: "queued", reason: "no match" };
  }
  return { kind: "queued", reason: `${candidates.length} candidates` };
}

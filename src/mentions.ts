import type { Client, Row } from "@libsql/client";
import { joinList } from "@/validate";
import type { Kind } from "@/geo/plausibility";

export type MentionState = "pending" | "resolved" | "rejected";

export interface MentionCandidate {
  id: number;
  mentionId: number;
  /** 1-based, exactly as `review resolve --pick=N` takes it. */
  rank: number;
  displayName: string;
  localName: string | null;
  latitude: number;
  longitude: number;
  category: string | null;
  type: string | null;
  importance: number | null;
  osmType: string | null;
  osmId: number | null;
  kmFromCentre: number;
}

export type CandidateInput = Omit<MentionCandidate, "id" | "mentionId">;

export interface Mention {
  id: number;
  tripId: number;
  sourceId: number;
  /** What the video called it. Written once at creation, never updated. */
  text: string;
  /** NULL until someone renames. */
  resolvedName: string | null;
  atSeconds: number | null;
  dwellMinutes: number | null;
  tags: string[];
  /** What the extractor said this place is, for the plausibility check.
   *  NULL means it declared none — the denylist applies instead.
   *
   *  NOT `tags`: `tags` is user-facing categorisation that flows into
   *  `segments.tags` and is read by the planner. This is a geocode
   *  verification input, consumed by `classify` and never rendered. */
  kind: Kind | null;
  /** The price rules the video stated, as the raw grammar strings. Empty means
   *  the extractor said nothing about price, which is UNKNOWN — never free.
   *
   *  Raw strings rather than parsed rules because these belong to the mention,
   *  which has no segment to own price_rules rows until it resolves. */
  price: string[];
  reason: string | null;
  segmentId: number | null;
  rejectedAt: string | null;
  /** DERIVED, never stored. A stored state column would be written by both
   *  `ingest` and `review resolve` and could read "resolved" while segmentId
   *  was NULL — a mention claiming to be a place while pointing at nothing.
   *  That is exactly the class of bug migration 5 had to fix in placements. */
  state: MentionState;
  /** The name a segment made from this mention gets. */
  name: string;
  candidates: MentionCandidate[];
}

export interface MentionInput {
  text: string;
  atSeconds: number | null;
  dwellMinutes: number | null;
  tags: string[];
  /** Required, not optional: an optional field would let a future writer
   *  forget it and silently store NULL, disabling the plausibility check for
   *  that path with no signal. The compiler names every writer instead. */
  kind: Kind | null;
  /** Required for the same reason `kind` is: an optional field lets a future
   *  writer forget it and silently store nothing, with no signal. */
  price: string[];
}

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function splitList(raw: unknown): string[] {
  const s = typeof raw === "string" ? raw : "";
  return s === "" ? [] : s.split(",");
}

export function mentionState(m: {
  rejectedAt: string | null; segmentId: number | null;
}): MentionState {
  // Order matters: a rejected mention that once had a segment is still
  // rejected. Rejection is the terminal decision.
  if (m.rejectedAt !== null) return "rejected";
  if (m.segmentId !== null) return "resolved";
  return "pending";
}

function toCandidate(row: Row): MentionCandidate {
  return {
    id: Number(row.id),
    mentionId: Number(row.mention_id),
    rank: Number(row.rank),
    displayName: String(row.display_name),
    localName: strOrNull(row.local_name),
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    category: strOrNull(row.category),
    type: strOrNull(row.type),
    importance: numOrNull(row.importance),
    osmType: strOrNull(row.osm_type),
    osmId: numOrNull(row.osm_id),
    kmFromCentre: Number(row.km_from_centre),
  };
}

const SELECT = `SELECT id, trip_id, source_id, text, resolved_name, at_seconds,
                       dwell_minutes, tags, kind, price, reason, segment_id,
                       rejected_at
                FROM mentions`;

function toMention(row: Row, candidates: MentionCandidate[]): Mention {
  const text = String(row.text);
  const resolvedName = strOrNull(row.resolved_name);
  const base = {
    id: Number(row.id),
    tripId: Number(row.trip_id),
    sourceId: Number(row.source_id),
    text,
    resolvedName,
    atSeconds: numOrNull(row.at_seconds),
    dwellMinutes: numOrNull(row.dwell_minutes),
    tags: splitList(row.tags),
    // The cast is honest here and nowhere else: this column is only ever
    // written through `MentionInput.kind`, which is `Kind | null` at the type
    // level, and the mentions-file parser rejects anything outside the closed
    // vocabulary before it can be stored.
    kind: strOrNull(row.kind) as Kind | null,
    price: splitList(row.price),
    reason: strOrNull(row.reason),
    segmentId: numOrNull(row.segment_id),
    rejectedAt: strOrNull(row.rejected_at),
  };
  return {
    ...base,
    state: mentionState(base),
    name: resolvedName ?? text,
    candidates,
  };
}

export async function createMention(
  db: Client, tripId: number, sourceId: number, input: MentionInput,
): Promise<number> {
  if (input.text.trim() === "") throw new Error("mention text may not be blank");
  // Same checks the segments table gets, from the same place — Task 1 pulled
  // them into @/validate precisely so both storage modules can share them
  // without depending on each other.
  const tags = joinList(input.tags, "tag");
  // The grammar never produces a comma, which is exactly why the guard is
  // cheap: it costs nothing today and catches the day someone widens it.
  const price = joinList(input.price, "price rule");
  const r = await db.execute({
    sql: `INSERT INTO mentions
            (trip_id, source_id, text, at_seconds, dwell_minutes, tags, kind,
             price)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          RETURNING id`,
    args: [tripId, sourceId, input.text.trim(), input.atSeconds,
           input.dwellMinutes, tags, input.kind, price],
  });
  return Number(r.rows[0]!.id);
}

/** Replace this mention's candidate list wholesale. `--rename` re-geocodes,
 *  and appending would leave the old name's candidates alongside the new
 *  name's, where --pick=2 would silently mean a different place than the
 *  list the user just read. */
export async function setCandidates(
  db: Client, mentionId: number, candidates: CandidateInput[],
): Promise<void> {
  await db.execute({
    sql: `DELETE FROM mention_candidates WHERE mention_id = ?`,
    args: [mentionId],
  });
  for (const c of candidates) {
    await db.execute({
      sql: `INSERT INTO mention_candidates
              (mention_id, rank, display_name, local_name, latitude, longitude,
               category, type, importance, osm_type, osm_id, km_from_centre)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      args: [mentionId, c.rank, c.displayName, c.localName, c.latitude,
             c.longitude, c.category, c.type, c.importance, c.osmType,
             c.osmId, c.kmFromCentre],
    });
  }
}

async function candidatesFor(
  db: Client, mentionIds: number[],
): Promise<Map<number, MentionCandidate[]>> {
  const byMention = new Map<number, MentionCandidate[]>();
  if (mentionIds.length === 0) return byMention;
  const placeholders = mentionIds.map(() => "?").join(",");
  const r = await db.execute({
    sql: `SELECT id, mention_id, rank, display_name, local_name, latitude,
                 longitude, category, type, importance, osm_type, osm_id,
                 km_from_centre
          FROM mention_candidates
          WHERE mention_id IN (${placeholders})
          ORDER BY mention_id, rank`,
    args: mentionIds,
  });
  for (const row of r.rows) {
    const c = toCandidate(row);
    const list = byMention.get(c.mentionId) ?? [];
    list.push(c);
    byMention.set(c.mentionId, list);
  }
  return byMention;
}

export async function listMentions(
  db: Client,
  tripId: number,
  opts: { sourceId?: number; state?: MentionState } = {},
): Promise<Mention[]> {
  const args: (number | string)[] = [tripId];
  let sql = `${SELECT} WHERE trip_id = ?`;
  if (opts.sourceId !== undefined) {
    sql += ` AND source_id = ?`;
    args.push(opts.sourceId);
  }
  sql += ` ORDER BY id`;
  const r = await db.execute({ sql, args });

  const ids = r.rows.map((row) => Number(row.id));
  const cands = await candidatesFor(db, ids);
  const all = r.rows.map((row) => toMention(row, cands.get(Number(row.id)) ?? []));
  // State is derived, so it is filtered in TypeScript rather than SQL. Writing
  // the derivation twice — once here as a WHERE clause, once in mentionState —
  // is how the two copies would drift apart.
  return opts.state === undefined ? all : all.filter((m) => m.state === opts.state);
}

export async function getMention(
  db: Client, tripId: number, id: number,
): Promise<Mention | null> {
  const r = await db.execute({
    sql: `${SELECT} WHERE id = ? AND trip_id = ?`,
    args: [id, tripId],
  });
  if (r.rows.length === 0) return null;
  const cands = await candidatesFor(db, [id]);
  return toMention(r.rows[0]!, cands.get(id) ?? []);
}

/** segment_id and reason are always written TOGETHER. Writing one without the
 *  other is what lets a mention claim two contradictory things at once. */
export async function resolveMention(
  db: Client, mentionId: number, segmentId: number,
): Promise<void> {
  await db.execute({
    sql: `UPDATE mentions SET segment_id = ?, reason = NULL WHERE id = ?`,
    args: [segmentId, mentionId],
  });
}

export async function queueMention(
  db: Client, mentionId: number, reason: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE mentions SET segment_id = NULL, reason = ? WHERE id = ?`,
    args: [reason, mentionId],
  });
}

export async function rejectMention(
  db: Client, mentionId: number, at: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE mentions SET rejected_at = ? WHERE id = ?`,
    args: [at, mentionId],
  });
}

export async function renameMention(
  db: Client, mentionId: number, name: string,
): Promise<void> {
  if (name.trim() === "") throw new Error("--rename needs a name");
  await db.execute({
    sql: `UPDATE mentions SET resolved_name = ? WHERE id = ?`,
    args: [name.trim(), mentionId],
  });
}

/** Called when a segment is deleted. The mention returns to the queue rather
 *  than dangling at a row that no longer exists — a place the video mentioned
 *  does not stop having been mentioned. */
export async function unlinkSegment(
  db: Client, segmentId: number, reason: string,
): Promise<void> {
  await db.execute({
    sql: `UPDATE mentions SET segment_id = NULL, reason = ?
          WHERE segment_id = ?`,
    args: [reason, segmentId],
  });
}

/** Drop this source's pending and rejected mentions, with their candidates.
 *  Resolved mentions are LEFT ALONE — deleting one would orphan a real segment
 *  that may already be pinned into a plan. `ingest --replace` refuses when any
 *  resolved mention exists, so reaching here with one is not expected; leaving
 *  them is still the safe behaviour if it happens. */
export async function deleteUnresolvedMentions(
  db: Client, tripId: number, sourceId: number,
): Promise<number> {
  const doomed = await db.execute({
    sql: `SELECT id FROM mentions
          WHERE trip_id = ? AND source_id = ? AND segment_id IS NULL`,
    args: [tripId, sourceId],
  });
  const ids = doomed.rows.map((r) => Number(r.id));
  if (ids.length === 0) return 0;

  const placeholders = ids.map(() => "?").join(",");
  // Children first: mention_candidates references mentions.
  await db.execute({
    sql: `DELETE FROM mention_candidates WHERE mention_id IN (${placeholders})`,
    args: ids,
  });
  await db.execute({
    sql: `DELETE FROM mentions WHERE id IN (${placeholders})`,
    args: ids,
  });
  return ids.length;
}

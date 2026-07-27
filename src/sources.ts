import type { Client, Row } from "@libsql/client";

export interface Source {
  id: number;
  tripId: number;
  url: string;
  /** NULL means yt-dlp did not report it. Never "". */
  title: string | null;
  uploader: string | null;
  durationSeconds: number | null;
  /** NULL means NO transcript was obtained. An empty transcript and an absent
   *  one are different facts: ingest can proceed with the first and cannot
   *  with the second. */
  transcript: string | null;
  transcriptSource: string | null;
  fetchedAt: string;
}

export type SourceInput = Omit<Source, "id" | "tripId">;

const SELECT = `SELECT id, trip_id, url, title, uploader, duration_seconds,
                       transcript, transcript_source, fetched_at
                FROM sources`;

function strOrNull(v: unknown): string | null {
  return v === null || v === undefined ? null : String(v);
}

function numOrNull(v: unknown): number | null {
  return v === null || v === undefined ? null : Number(v);
}

function toSource(row: Row): Source {
  return {
    id: Number(row.id),
    tripId: Number(row.trip_id),
    url: String(row.url),
    title: strOrNull(row.title),
    uploader: strOrNull(row.uploader),
    durationSeconds: numOrNull(row.duration_seconds),
    transcript: strOrNull(row.transcript),
    transcriptSource: strOrNull(row.transcript_source),
    fetchedAt: String(row.fetched_at),
  };
}

/** Insert, or overwrite the existing row for this (trip, url).
 *
 *  ON CONFLICT rather than delete-and-insert: a source's id is referenced by
 *  mentions.source_id, so re-fetching a video with --refresh must keep the
 *  same id or every mention extracted from it would be orphaned. */
export async function upsertSource(
  db: Client,
  tripId: number,
  input: SourceInput,
): Promise<number> {
  const r = await db.execute({
    sql: `INSERT INTO sources
            (trip_id, url, title, uploader, duration_seconds,
             transcript, transcript_source, fetched_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT (trip_id, url) DO UPDATE SET
            title = excluded.title,
            uploader = excluded.uploader,
            duration_seconds = excluded.duration_seconds,
            transcript = excluded.transcript,
            transcript_source = excluded.transcript_source,
            fetched_at = excluded.fetched_at
          RETURNING id`,
    args: [tripId, input.url, input.title, input.uploader, input.durationSeconds,
           input.transcript, input.transcriptSource, input.fetchedAt],
  });
  return Number(r.rows[0]!.id);
}

export async function getSource(
  db: Client, tripId: number, id: number,
): Promise<Source | null> {
  const r = await db.execute({
    sql: `${SELECT} WHERE id = ? AND trip_id = ?`,
    args: [id, tripId],
  });
  return r.rows.length === 0 ? null : toSource(r.rows[0]!);
}

export async function getSourceByUrl(
  db: Client, tripId: number, url: string,
): Promise<Source | null> {
  const r = await db.execute({
    sql: `${SELECT} WHERE trip_id = ? AND url = ?`,
    args: [tripId, url],
  });
  return r.rows.length === 0 ? null : toSource(r.rows[0]!);
}

export async function latestSource(
  db: Client, tripId: number,
): Promise<Source | null> {
  const r = await db.execute({
    sql: `${SELECT} WHERE trip_id = ? ORDER BY fetched_at DESC, id DESC LIMIT 1`,
    args: [tripId],
  });
  return r.rows.length === 0 ? null : toSource(r.rows[0]!);
}

export async function listSources(db: Client, tripId: number): Promise<Source[]> {
  const r = await db.execute({
    sql: `${SELECT} WHERE trip_id = ? ORDER BY id`,
    args: [tripId],
  });
  return r.rows.map(toSource);
}

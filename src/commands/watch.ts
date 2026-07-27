import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { getActiveTrip, type Trip } from "@/trips";
import { getDestination } from "@/climate/cache";
import { upsertSource, getSourceByUrl, latestSource, getSource } from "@/sources";
import { listMentions, deleteUnresolvedMentions } from "@/mentions";
import { runWatch } from "@/watch/run";
import { parseMentionsFile, ingestMentions, type IngestDeps } from "@/watch/ingest";
import { SEARCH_RADIUS_KM } from "@/geo/poi";
import {
  formatStamp, parseTranscriptLines, type WatchReport,
} from "@/watch/parse-report";

const USAGE =
  "usage: trip watch <url> [--refresh] [--whisper]\n" +
  "       trip watch ingest --mentions=<file.json> [--source=<id>] [--replace]";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

export interface WatchCommandDeps {
  watchFn?: (url: string, opts: { whisper: boolean }) => Promise<WatchReport>;
  now?: () => string;
  readFile?: (path: string) => string;
  ingestDeps?: IngestDeps;
}

export async function runWatchCommand(
  db: Client,
  argv: string[],
  json: boolean,
  deps: WatchCommandDeps = {},
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

  if (argv[0] === "ingest") return ingestCmd(db, trip, argv.slice(1), json, deps);

  const url = argv.find((a) => !a.startsWith("--"));
  if (url === undefined) throw new Error(USAGE);

  // Checked BEFORE the download. A video takes minutes to fetch; discovering
  // afterwards that nothing can be geocoded against it is the expensive order
  // to find out in.
  if (trip.destinationId === null) {
    throw new Error(
      `trip "${trip.name}" has no destination - run \`trip when <city>\` first, ` +
      `so mentions have a city to geocode against`,
    );
  }
  const dest = await getDestination(db, trip.destinationId);
  if (!dest) throw new Error(`destination #${trip.destinationId} is missing`);

  const cached = await getSourceByUrl(db, trip.id, url);
  const refresh = argv.includes("--refresh");

  let report: WatchReport;
  let fromCache = false;
  if (cached !== null && !refresh) {
    fromCache = true;
    report = {
      title: cached.title,
      uploader: cached.uploader,
      durationSeconds: cached.durationSeconds,
      transcriptSource: cached.transcriptSource,
      transcript: cached.transcript,
      // A cached source with NO transcript is still a cache hit: the download
      // really happened, and repeating it to rediscover the same absence is
      // the cost this cache exists to avoid. Nothing to parse, so lines is
      // empty rather than parsed — do not call parseTranscriptLines(null).
      lines: cached.transcript === null ? [] : parseTranscriptLines(cached.transcript),
    };
  } else {
    const watchFn = deps.watchFn ??
      ((u, o) => runWatch(u, { whisper: o.whisper }));
    report = await watchFn(url, { whisper: argv.includes("--whisper") });
  }

  // A --refresh whose fetch came back WITHOUT a transcript must not destroy the
  // one already cached. `upsertSource` overwrites unconditionally, so the choice
  // belongs here: captions can disappear from a video, or a Whisper key can stop
  // working, and neither is a reason to forget a transcript we already have.
  // Nulling it would also be "absence is loud" inverted — writing UNKNOWN over a
  // known fact.
  const keptTranscript = report.transcript === null && cached?.transcript != null;
  const now = deps.now ?? (() => new Date().toISOString());
  const sourceId = await upsertSource(db, trip.id, {
    url,
    title: report.title,
    uploader: report.uploader,
    durationSeconds: report.durationSeconds,
    transcript: keptTranscript ? cached!.transcript : report.transcript,
    transcriptSource: keptTranscript ? cached!.transcriptSource : report.transcriptSource,
    fetchedAt: fromCache ? cached!.fetchedAt : now(),
  });

  // Report the refresh honestly: the metadata is new, the transcript is the old
  // one, and the command did not do what was asked.
  if (keptTranscript) {
    throw new Error(
      `refresh of ${url} returned no transcript; the previously cached one was ` +
      `kept (source #${sourceId}). Retry with --whisper if a Groq or OpenAI key ` +
      `is set, or run without --refresh to use the cached transcript.`,
    );
  }

  if (report.transcript === null) {
    // The source row is saved first, on purpose: the download really happened,
    // and a re-run should not repeat it only to learn the same thing. But this
    // is still a failure — `ingest` has nothing to work from.
    throw new Error(
      `no transcript available for ${url} (source #${sourceId}` +
      `${fromCache ? ", from cache" : ""}). ` +
      `The video has no captions; retry with --refresh --whisper if a Groq or ` +
      `OpenAI key is set.`,
    );
  }

  if (json) {
    return JSON.stringify({
      sourceId,
      url,
      title: report.title,
      uploader: report.uploader,
      durationSeconds: report.durationSeconds,
      transcriptSource: report.transcriptSource,
      cached: fromCache,
      destination: dest.name,
      lines: report.lines.map((l) => ({
        at: formatStamp(l.atSeconds), text: l.text,
      })),
    });
  }

  const head = [
    `source #${sourceId}${fromCache ? " (cached)" : ""}: ${report.title ?? url}`,
    report.uploader === null ? null : `uploader: ${report.uploader}`,
    `${report.lines.length} lines via ${report.transcriptSource ?? "unknown"}`,
    `destination: ${dest.name}`,
    "",
  ].filter((l): l is string => l !== null);

  const body = report.lines.map(
    (l) => `[${formatStamp(l.atSeconds)}] ${l.text}`,
  );
  return [...head, ...body].join("\n");
}

async function ingestCmd(
  db: Client,
  trip: Trip,
  argv: string[],
  json: boolean,
  deps: WatchCommandDeps,
): Promise<string> {
  const path = flag(argv, "--mentions");
  if (path === null) throw new Error("--mentions=<file.json> is required");

  if (trip.destinationId === null) {
    throw new Error(
      `trip "${trip.name}" has no destination - run \`trip when <city>\` first`,
    );
  }
  const dest = await getDestination(db, trip.destinationId);
  if (!dest) throw new Error(`destination #${trip.destinationId} is missing`);

  const sourceRaw = flag(argv, "--source");
  const source = sourceRaw === null
    ? await latestSource(db, trip.id)
    : await getSource(db, trip.id, Number(sourceRaw));
  if (source === null) {
    throw new Error(
      sourceRaw === null
        ? "no video has been watched for this trip - run `trip watch <url>` first"
        : `no source #${sourceRaw} in this trip`,
    );
  }

  const existing = await listMentions(db, trip.id, { sourceId: source.id });
  if (existing.length > 0) {
    const resolved = existing.filter((m) => m.state === "resolved");
    if (!argv.includes("--replace")) {
      throw new Error(
        `source #${source.id} already has ${existing.length} mention(s). ` +
        `Pass --replace to discard the unresolved ones and ingest again.`,
      );
    }
    if (resolved.length > 0) {
      // Deleting a resolved mention would orphan a real segment that may
      // already be pinned into a plan. Refuse rather than cascade.
      throw new Error(
        `source #${source.id} has ${resolved.length} resolved mention(s) ` +
        `(segments ${resolved.map((m) => `#${m.segmentId}`).join(", ")}). ` +
        `--replace will not delete them. Remove those segments with ` +
        `\`trip seg rm\` first if you really mean to start over.`,
      );
    }
    await deleteUnresolvedMentions(db, trip.id, source.id);
  }

  const readFile = deps.readFile ?? ((p: string) => readFileSync(p, "utf8"));
  let raw: string;
  try {
    raw = readFile(path);
  } catch (err) {
    throw new Error(`cannot read ${path}: ${(err as Error).message}`);
  }

  const { specs, errors } = parseMentionsFile(raw);
  const result = await ingestMentions(
    db, trip.id, source.id, specs, dest, deps.ingestDeps ?? {},
  );

  if (json) {
    return JSON.stringify({
      sourceId: source.id,
      ...result,
      skipped: errors.length,
      errors,
      searchRadiusKm: SEARCH_RADIUS_KM,
      destination: dest.name,
    });
  }

  const lines = [
    `${result.total} mention${result.total === 1 ? "" : "s"} - ` +
    `${result.geocoded} geocoded, ${result.queued} queued for review` +
    (result.failed > 0 ? `, ${result.failed} lookup failure(s)` : ""),
    `searched a ${SEARCH_RADIUS_KM} km box around ${dest.name}`,
  ];
  if (errors.length > 0) {
    lines.push(
      "",
      `${errors.length} entr${errors.length === 1 ? "y" : "ies"} skipped:`,
      ...errors.map((e) => `  ${e}`),
    );
  }
  if (result.queued + result.failed > 0) lines.push("", "run: trip review ls");
  return lines.join("\n");
}

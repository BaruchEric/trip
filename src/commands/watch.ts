import type { Client } from "@libsql/client";
import { getActiveTrip } from "@/trips";
import { getDestination } from "@/climate/cache";
import { upsertSource, getSourceByUrl } from "@/sources";
import { runWatch } from "@/watch/run";
import {
  formatStamp, parseTranscriptLines, type WatchReport,
} from "@/watch/parse-report";

const USAGE =
  "usage: trip watch <url> [--refresh] [--whisper]\n" +
  "       trip watch ingest --mentions=<file.json> [--source=<id>] [--replace]";

export interface WatchCommandDeps {
  watchFn?: (url: string, opts: { whisper: boolean }) => Promise<WatchReport>;
  now?: () => string;
}

export async function runWatchCommand(
  db: Client,
  argv: string[],
  json: boolean,
  deps: WatchCommandDeps = {},
): Promise<string> {
  const trip = await getActiveTrip(db);
  if (!trip) throw new Error("no active trip - run `trip use <name>` first");

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

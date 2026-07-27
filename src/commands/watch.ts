import type { Client } from "@libsql/client";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { DEFAULT_DB_PATH } from "@/db";
import { getActiveTrip, type Trip } from "@/trips";
import { getDestination } from "@/climate/cache";
import { upsertSource, getSourceByUrl, latestSource, getSource } from "@/sources";
import { listMentions, deleteUnresolvedMentions } from "@/mentions";
import { runWatch, runFrames, type FramesResult } from "@/watch/run";
import { parseMentionsFile, ingestMentions, type IngestDeps } from "@/watch/ingest";
import { SEARCH_RADIUS_KM } from "@/geo/poi";
import {
  formatStamp, parseStamp, parseTranscriptLines, type WatchReport,
} from "@/watch/parse-report";

const USAGE =
  "usage: trip watch <url> [--refresh] [--whisper]\n" +
  "       trip watch ingest --mentions=<file.json> [--source=<id>] [--replace]\n" +
  "       trip watch frames <source-id> --from=MM:SS --to=MM:SS";

function flag(argv: string[], name: string): string | null {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
}

export interface WatchCommandDeps {
  watchFn?: (url: string, opts: { whisper: boolean }) => Promise<WatchReport>;
  now?: () => string;
  readFile?: (path: string) => string;
  ingestDeps?: IngestDeps;
  /** Injected so tests never spawn python3. Mirrors runFrames with the
   *  options already applied. */
  framesFn?: (
    url: string, outDir: string, from: string, to: string,
    opts: { maxFrames: number; width: number },
  ) => Promise<FramesResult>;
  /** Where frame directories live. Defaults to `<db dir>/frames`, threaded
   *  from cli.ts — NOT hardcoded to ~/.trip, or every test and every scratch
   *  run writes frames into the user's real home. */
  framesRoot?: string;
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
  if (argv[0] === "frames") return framesCmd(db, trip, argv.slice(1), json, deps);

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
    // A fetch that yielded nothing is not a fetch: `keptTranscript` must keep
    // `cached!.fetchedAt` exactly as the cache-hit path does. Advancing it
    // here (as this line only checked `fromCache`, which is FALSE on this
    // branch) let `latestSource`'s `ORDER BY fetched_at DESC` treat a failed
    // refresh as the newest source in the trip — so `ingest` without
    // `--source` would silently attach a DIFFERENT video's mentions to this
    // one's row.
    fetchedAt: (fromCache || keptTranscript) ? cached!.fetchedAt : now(),
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
  // How many mentions --replace discarded. Left at 0 for a first ingest
  // (nothing existed to discard) so that count is the only thing that
  // distinguishes the two in the output below — a --replace that destroyed
  // twelve mentions must not look identical to a first ingest.
  let replaced = 0;
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
    replaced = await deleteUnresolvedMentions(db, trip.id, source.id);
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
      replaced,
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
  if (replaced > 0) {
    lines.push(`--replace discarded ${replaced} unresolved mention${replaced === 1 ? "" : "s"}`);
  }
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


/** `19:25` -> `19-25`. A colon is legal in a POSIX filename but breaks on
 *  Windows and reads badly inside a path; the window still round-trips by
 *  eye, which is what makes the directory name a usable cache key. */
function windowSlug(from: string, to: string): string {
  return `${from}_${to}`.replace(/:/g, "-");
}

function framesHint(): string[] {
  return [
    "",
    "read them, then feed what you learn back with:",
    "  trip watch ingest --mentions=<file.json>       (places, prices)",
    "  trip costs add <label> --amount= --currency=   (an on-screen budget)",
  ];
}

async function framesCmd(
  db: Client, trip: Trip, argv: string[], json: boolean, deps: WatchCommandDeps,
): Promise<string> {
  const idRaw = argv.find((a) => !a.startsWith("--"));
  if (!idRaw || !/^\d+$/.test(idRaw)) {
    throw new Error(
      "usage: trip watch frames <source-id> --from=MM:SS --to=MM:SS " +
      "[--max=12] [--width=900] [--refresh]",
    );
  }
  const from = flag(argv, "--from");
  const to = flag(argv, "--to");
  // BOTH required. A frames call with no window is the blanket pass the
  // design rejected, and the cost stops being a deliberate choice.
  if (from === null) throw new Error("--from is required (e.g. --from=19:25)");
  if (to === null) throw new Error("--to is required (e.g. --to=20:20)");
  // Parsed only to validate -- watch.py takes the strings. parseStamp throws
  // naming the offending value, which is exactly the message wanted here.
  parseStamp(from);
  parseStamp(to);

  const id = Number(idRaw);
  const source = await getSource(db, trip.id, id);
  // Checked BEFORE extraction, the same reasoning as the destination check
  // on the watch path: minutes of download is the expensive place to find out.
  if (!source) throw new Error(`no source #${id} on this trip`);

  const root = deps.framesRoot ?? join(dirname(DEFAULT_DB_PATH), "frames");
  const dir = join(root, String(id), windowSlug(from, to));
  const frameDir = join(dir, "frames");

  if (!argv.includes("--refresh") && existsSync(frameDir)) {
    const cached = readdirSync(frameDir).filter((f) => f.endsWith(".jpg")).sort();
    if (cached.length > 0) {
      const files = cached.map((f) => join(frameDir, f));
      if (json) return JSON.stringify({ dir: frameDir, files, cached: true });
      return [
        `${files.length} frame${files.length === 1 ? "" : "s"} already extracted ` +
        `for ${from}-${to}:`,
        ...files.map((f) => `  ${f}`),
        ...framesHint(),
        "",
        "re-extract with --refresh",
      ].join("\n");
    }
  }

  const maxRaw = flag(argv, "--max");
  const widthRaw = flag(argv, "--width");
  const maxFrames = maxRaw === null ? 12 : Number(maxRaw);
  const width = widthRaw === null ? 900 : Number(widthRaw);
  if (!Number.isInteger(maxFrames) || maxFrames < 1) {
    throw new Error(`invalid --max "${maxRaw}" (expected a whole number >= 1)`);
  }
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`invalid --width "${widthRaw}" (expected a whole number >= 1)`);
  }

  const run = deps.framesFn ??
    ((url, outDir, f, t, o) => runFrames(url, outDir, f, t, o));
  const result = await run(source.url, dir, from, to, { maxFrames, width });

  if (json) {
    return JSON.stringify({ dir: result.dir, files: result.files, cached: false });
  }
  return [
    `${result.files.length} frame${result.files.length === 1 ? "" : "s"} ` +
    `for ${from}-${to}:`,
    ...result.files.map((f) => `  ${f}`),
    ...framesHint(),
  ].join("\n");
}

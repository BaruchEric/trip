/** Pure parser for the markdown report `watch.py` writes to stdout.
 *
 *  Kept separate from the subprocess call so its tests need no network, no
 *  yt-dlp, and no ffmpeg — the report format is the contract, and a captured
 *  string is enough to test all of it. */

export interface TranscriptLine {
  atSeconds: number;
  text: string;
}

export interface WatchReport {
  title: string | null;
  uploader: string | null;
  durationSeconds: number | null;
  transcriptSource: string | null;
  /** The raw transcript block. NULL means none was obtained — never "". */
  transcript: string | null;
  lines: TranscriptLine[];
}

/** `MM:SS` or `HH:MM:SS`, where MM is NOT bounded at 59.
 *
 *  watch.py's format_transcript emits `f"[{start // 60:02d}:{start % 60:02d}]"`,
 *  so a 102-minute video produces `[102:15]`. Treating the first field as hours
 *  or capping it at 59 silently mangles timestamps on exactly the long videos
 *  the two-field format exists for. */
export function parseStamp(stamp: string): number {
  const parts = stamp.trim().split(":");
  if (parts.length < 2 || parts.length > 3) {
    throw new Error(`invalid timestamp "${stamp}"`);
  }
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) throw new Error(`invalid timestamp "${stamp}"`);
    return Number(p);
  });
  return nums.length === 3
    ? nums[0]! * 3600 + nums[1]! * 60 + nums[2]!
    : nums[0]! * 60 + nums[1]!;
}

/** Inverse of parseStamp, in watch.py's own MM:SS form where minutes are
 *  unbounded — 6135 seconds renders as 102:15, not 01:42:15. */
export function formatStamp(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

/** The line grammar on its own, so a transcript read back out of the database
 *  parses exactly as it did coming out of watch.py. */
export function parseTranscriptLines(transcript: string): TranscriptLine[] {
  const lines: TranscriptLine[] = [];
  for (const raw of transcript.split("\n")) {
    // A line without a leading stamp is a continuation or a blank; it has no
    // timestamp of its own, and inventing one would put a mention at a minute
    // mark nothing was said at.
    const m = /^\[(\d+:\d{2}(?::\d{2})?)\]\s?(.*)$/.exec(raw);
    if (!m) continue;
    lines.push({ atSeconds: parseStamp(m[1]!), text: m[2]!.trim() });
  }
  return lines;
}

function field(report: string, label: string): string | null {
  const re = new RegExp(`^- \\*\\*${label}:\\*\\* (.+)$`, "m");
  const m = re.exec(report);
  const value = m?.[1]?.trim();
  // An empty value is absence, not a value. watch.py omits the line entirely
  // when yt-dlp reported nothing, but a blank one must read the same way.
  return value === undefined || value === "" ? null : value;
}

export function parseWatchReport(stdout: string): WatchReport {
  const title = field(stdout, "Title");
  const uploader = field(stdout, "Uploader");

  // "- **Duration:** 28:14 (1694.0s)". The parenthesised seconds are the
  // precise figure; the clock in front of it is a rounded human rendering.
  const durRaw = field(stdout, "Duration");
  const durMatch = durRaw === null ? null : /\(([\d.]+)s\)/.exec(durRaw);
  const durationSeconds = durMatch ? Math.round(Number(durMatch[1])) : null;

  // "- **Transcript:** 412 segments (via captions)" or "none available".
  // watch.py's Whisper path sets transcript_source to "whisper (groq)" or
  // "whisper (openai)", so this parenthetical can itself contain parens:
  // "(via whisper (groq))". A non-greedy `[^)]+` would stop at the first `)`
  // and truncate the backend name, so anchor on the end of the line instead —
  // the "(via ...)" is always the last thing watch.py prints on it.
  const transcriptField = field(stdout, "Transcript");
  const viaMatch = transcriptField === null
    ? null
    : /\(via (.+)\)$/.exec(transcriptField);
  const transcriptSource = viaMatch?.[1]?.trim() ?? null;

  // The transcript is the first fenced block AFTER the "## Transcript"
  // heading. Anchoring on the heading matters: the "## Frames" section above
  // it lists paths with their own (t=MM:SS) stamps, and a document-wide scan
  // for timestamps would pull those in as transcript lines.
  const headingIdx = stdout.indexOf("\n## Transcript");
  let transcript: string | null = null;
  if (headingIdx !== -1) {
    const after = stdout.slice(headingIdx);
    const fence = /```\n([\s\S]*?)```/.exec(after);
    const body = fence?.[1];
    if (body !== undefined && body.trim() !== "") transcript = body.replace(/\n$/, "");
  }

  const lines: TranscriptLine[] = transcript === null ? [] : parseTranscriptLines(transcript);

  return {
    title,
    uploader,
    durationSeconds,
    // No body means no source either: a report with no fenced transcript
    // never trustworthily has a "(via ...)" to go with it, so we null out
    // transcriptSource rather than report a source for a transcript that
    // doesn't exist. (The other direction can't arise from watch.py's own
    // output — the source line and the fenced body are written together.)
    transcript: transcript,
    transcriptSource: transcript === null ? null : transcriptSource,
    lines,
  };
}

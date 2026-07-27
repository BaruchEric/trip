/** Locates and runs `watch.py`, handing its stdout to the pure parser.
 *
 *  Kept separate from parse-report.ts so the subprocess concerns (finding the
 *  script, building argv, spawning, distinguishing failure from an empty
 *  transcript) live in one place and the parser's tests stay network-free. */

import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { parseWatchReport, type WatchReport } from "@/watch/parse-report";

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type WatchRunner = (argv: string[]) => Promise<RunResult>;

export interface WatchOptions {
  /** Allow the Whisper fallback. Off by default: it spends against a Groq or
   *  OpenAI key, while captions are free and deterministic. */
  whisper?: boolean;
  runner?: WatchRunner;
  scriptPath?: string;
  home?: string;
}

export const WATCH_PLUGIN_GLOB =
  ".claude/plugins/cache/claude-video/watch/<version>/scripts/watch.py";

const PLUGIN_DIR = ".claude/plugins/cache/claude-video/watch";

/** Compare "0.10.0" against "0.2.0" component by component. String ordering
 *  puts 0.10.0 first, which would keep running an old script after an upgrade. */
function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (Number.isNaN(x) || Number.isNaN(y)) return a.localeCompare(b);
    if (x !== y) return x - y;
  }
  return 0;
}

/** The version directory is globbed, never hardcoded — 0.1.2 is only today's. */
export function resolveWatchScript(home: string = homedir()): string {
  const base = join(home, PLUGIN_DIR);
  const versions = existsSync(base)
    ? readdirSync(base, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort(compareVersions)
        .reverse()
    : [];

  for (const v of versions) {
    const candidate = join(base, v, "scripts", "watch.py");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    `watch.py not found. Looked for ${WATCH_PLUGIN_GLOB} under ${home}. ` +
    `Install the claude-video watch plugin, then retry.`,
  );
}

export function watchArgv(
  script: string, url: string, outDir: string, whisper: boolean,
): string[] {
  // --max-frames 1, NOT 0. Verified 2026-07-27: with 0, fps computes to 0 and
  // ffmpeg dies with "the encoder timebase is not set", watch.py exits 1, and
  // stdout is empty. There is no --no-frames flag, so one throwaway frame at
  // the smallest resolution is the cheapest transcript-only run available.
  const argv = [
    script, url,
    "--max-frames", "1",
    "--resolution", "64",
    "--out-dir", outDir,
  ];
  if (!whisper) argv.push("--no-whisper");
  return argv;
}

export interface FramesOptions {
  scriptPath?: string;
  home?: string;
  runner?: WatchRunner;
  maxFrames?: number;
  width?: number;
}

export interface FramesResult {
  /** Where the frames landed. Printed for the agent to read from. */
  dir: string;
  /** Absolute paths, sorted, so the caller's output is stable across runs. */
  files: string[];
}

/** argv for a WINDOWED frame pass.
 *
 *  Distinct from `watchArgv` on purpose. That one pins `--max-frames 1`
 *  because the ordinary watch wants a transcript and frames are the cost
 *  dial; this command exists precisely because one frame is sometimes not
 *  what you want. Inheriting the pin would make the whole command a no-op
 *  that looks like it worked.
 *
 *  `--no-whisper` is unconditional here, where `watchArgv` makes it a flag:
 *  this pass wants pictures, and the transcript it would produce is already
 *  in the database. Same space-separated style as `watchArgv` — one
 *  convention per script. */
export function framesArgv(
  script: string,
  url: string,
  outDir: string,
  from: string,
  to: string,
  maxFrames: number,
  width: number,
): string[] {
  return [
    script, url,
    "--max-frames", String(maxFrames),
    "--resolution", String(width),
    "--start", from,
    "--end", to,
    "--out-dir", outDir,
    "--no-whisper",
  ];
}

/** Extract frames for one window into `outDir`, and LEAVE THEM THERE.
 *
 *  `runWatch` deletes its working directory on success because its
 *  deliverable is the parsed report. Here the files ARE the deliverable, so
 *  the directory is kept and its path returned. */
export async function runFrames(
  url: string,
  outDir: string,
  from: string,
  to: string,
  opts: FramesOptions = {},
): Promise<FramesResult> {
  const script = opts.scriptPath ?? resolveWatchScript(opts.home);
  const runner = opts.runner ?? defaultRunner;
  mkdirSync(outDir, { recursive: true });

  let result: RunResult;
  try {
    result = await runner(framesArgv(
      script, url, outDir, from, to, opts.maxFrames ?? 12, opts.width ?? 900,
    ));
  } catch (err) {
    throw new Error(
      `watch.py could not be run: ${(err as Error).message}\n` +
      `Working directory kept at ${outDir}`,
    );
  }
  if (result.code !== 0) {
    throw new Error(
      `watch.py failed (exit ${result.code})` +
      `${result.stderr.trim() ? `:\n${tail(result.stderr)}` : ""}\n` +
      `Working directory kept at ${outDir}`,
    );
  }

  const dir = join(outDir, "frames");
  // `.jpg` only: watch.py leaves its own working files beside the frames, and
  // counting one as a frame would make an empty window look populated —
  // exactly what the guard below exists to prevent.
  const files = existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".jpg")).sort()
        .map((f) => join(dir, f))
    : [];
  if (files.length === 0) {
    // Absence is loud: an empty result here would tell the agent the window
    // genuinely showed nothing, which is a different fact from extraction
    // having produced nothing.
    throw new Error(
      `watch.py exited 0 but wrote no frames for ${from}-${to}. ` +
      `Working directory kept at ${outDir}`,
    );
  }
  return { dir, files };
}

const defaultRunner: WatchRunner = async (argv) => {
  const proc = Bun.spawn(["python3", ...argv], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
};

function tail(text: string, lines = 5): string {
  return text.trim().split("\n").slice(-lines).join("\n");
}

export async function runWatch(
  url: string, opts: WatchOptions = {},
): Promise<WatchReport> {
  const script = opts.scriptPath ?? resolveWatchScript(opts.home);
  const runner = opts.runner ?? defaultRunner;
  const outDir = mkdtempSync(join(tmpdir(), "trip-watch-"));

  let result: RunResult;
  try {
    result = await runner(watchArgv(script, url, outDir, opts.whisper ?? false));
  } catch (err) {
    // The work dir is KEPT on failure so a broken run can be inspected. The
    // other two failure paths below say where; this one must too, or a
    // spawn failure leaves a directory nobody can find.
    throw new Error(
      `watch.py could not be run: ${(err as Error).message}\n` +
      `Working directory kept at ${outDir}`,
    );
  }

  if (result.code !== 0) {
    throw new Error(
      `watch.py failed (exit ${result.code})` +
      `${result.stderr.trim() ? `:\n${tail(result.stderr)}` : ""}\n` +
      `Working directory kept at ${outDir}`,
    );
  }
  if (result.stdout.trim() === "") {
    // Exit 0 with nothing on stdout is not an empty video, it is a broken run.
    // Returning an empty report here would cache a NULL transcript as though
    // the video genuinely had none.
    throw new Error(
      `watch.py exited 0 but produced no output. Working directory kept at ${outDir}`,
    );
  }

  const report = parseWatchReport(result.stdout);
  rmSync(outDir, { recursive: true, force: true });
  return report;
}

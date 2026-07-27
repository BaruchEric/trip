import { expect, test, describe } from "bun:test";
import { resolveWatchScript, watchArgv, runWatch } from "@/watch/run";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Build a fake plugin cache with the given version directories. */
function fakeHome(versions: string[]): string {
  const home = mkdtempSync(join(tmpdir(), "trip-watch-home-"));
  for (const v of versions) {
    const dir = join(home, ".claude/plugins/cache/claude-video/watch", v, "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "watch.py"), "# stub");
  }
  return home;
}

const REPORT = `
# watch: video report

- **Title:** Test
- **Duration:** 00:10 (10.0s)
- **Transcript:** 1 segments (via captions)

## Transcript

\`\`\`
[00:01] hello
\`\`\`
`;

describe("resolveWatchScript", () => {
  test("finds the script under the plugin cache", () => {
    const home = fakeHome(["0.1.2"]);
    expect(resolveWatchScript(home)).toBe(
      join(home, ".claude/plugins/cache/claude-video/watch/0.1.2/scripts/watch.py"),
    );
    rmSync(home, { recursive: true, force: true });
  });

  test("picks the highest version numerically, not lexically", () => {
    // "0.10.0" sorts BEFORE "0.2.0" as a string. Version directories must be
    // compared component by component or an upgrade silently keeps running
    // the old script.
    const home = fakeHome(["0.1.2", "0.2.0", "0.10.0"]);
    expect(resolveWatchScript(home)).toContain("/0.10.0/");
    rmSync(home, { recursive: true, force: true });
  });

  test("names the path it looked in when the plugin is missing", () => {
    const home = mkdtempSync(join(tmpdir(), "trip-watch-empty-"));
    expect(() => resolveWatchScript(home)).toThrow(/claude-video\/watch/);
    rmSync(home, { recursive: true, force: true });
  });
});

describe("watchArgv", () => {
  test("requests exactly one frame and disables whisper by default", () => {
    const argv = watchArgv("/w.py", "https://x", "/tmp/out", false);
    expect(argv).toContain("--max-frames");
    expect(argv[argv.indexOf("--max-frames") + 1]).toBe("1");
    expect(argv).toContain("--no-whisper");
  });

  test("--whisper opts in by omitting --no-whisper", () => {
    expect(watchArgv("/w.py", "https://x", "/tmp/out", true)).not.toContain("--no-whisper");
  });

  test("never passes --max-frames 0, which makes ffmpeg fail", () => {
    const argv = watchArgv("/w.py", "https://x", "/tmp/out", false);
    expect(argv[argv.indexOf("--max-frames") + 1]).not.toBe("0");
  });
});

/** Pull the work dir out of a failure message, and assert it was named at
 *  all. A failure that keeps a directory but does not say where it is leaves
 *  the user with nothing to inspect, which is the whole point of keeping it. */
function keptWorkDir(message: string): string {
  const m = /Working directory kept at (\S+)/.exec(message);
  if (!m) throw new Error(`error did not name a work dir: ${message}`);
  return m[1]!;
}

async function failureOf(opts: Parameters<typeof runWatch>[1]): Promise<Error> {
  try {
    await runWatch("https://x", opts);
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected runWatch to reject, but it resolved");
}

describe("runWatch", () => {
  test("parses the report from a successful run", async () => {
    const report = await runWatch("https://x", {
      scriptPath: "/w.py",
      runner: async () => ({ stdout: REPORT, stderr: "", code: 0 }),
    });
    expect(report.title).toBe("Test");
    expect(report.lines.length).toBe(1);
  });

  test("a non-zero exit throws with the stderr tail", async () => {
    const err = await failureOf({
      scriptPath: "/w.py",
      runner: async () => ({ stdout: "", stderr: "yt-dlp: video unavailable", code: 1 }),
    });
    expect(err.message).toMatch(/video unavailable/);
    rmSync(keptWorkDir(err.message), { recursive: true, force: true });
  });

  test("an exit 0 with empty stdout is still a failure, not an empty report", async () => {
    const err = await failureOf({
      scriptPath: "/w.py",
      runner: async () => ({ stdout: "   ", stderr: "", code: 0 }),
    });
    expect(err.message).toMatch(/no output/i);
    rmSync(keptWorkDir(err.message), { recursive: true, force: true });
  });

  test("a runner that throws keeps the work dir and names it", async () => {
    const err = await failureOf({
      scriptPath: "/w.py",
      runner: async () => { throw new Error("spawn python3 ENOENT"); },
    });
    expect(err.message).toContain("ENOENT");
    const dir = keptWorkDir(err.message);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("a non-zero exit keeps the work dir and names it", async () => {
    const err = await failureOf({
      scriptPath: "/w.py",
      runner: async () => ({ stdout: "", stderr: "yt-dlp: video unavailable", code: 1 }),
    });
    const dir = keptWorkDir(err.message);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  test("an empty stdout keeps the work dir and names it", async () => {
    const err = await failureOf({
      scriptPath: "/w.py",
      runner: async () => ({ stdout: "   ", stderr: "", code: 0 }),
    });
    const dir = keptWorkDir(err.message);
    expect(existsSync(dir)).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

import { test, expect, describe } from "bun:test";
import { framesArgv, runFrames } from "@/watch/run";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = "/fake/watch.py";

describe("framesArgv", () => {
  test("passes the window, the caps, and --no-whisper", () => {
    const a = framesArgv(SCRIPT, "https://x", "/out", "19:25", "20:20", 12, 900);
    expect(a[0]).toBe(SCRIPT);
    expect(a).toContain("https://x");
    expect(a.join(" ")).toContain("19:25");
    expect(a.join(" ")).toContain("20:20");
    expect(a.join(" ")).toContain("12");
    expect(a.join(" ")).toContain("900");
    // The transcript is already stored; this pass wants pictures. Paying for
    // a whisper transcription here would be minutes of compute for a string
    // the database already has.
    expect(a).toContain("--no-whisper");
  });

  test("never passes --max-frames 1, which is the transcript-only path", () => {
    // watchArgv pins 1 to make frames as cheap as possible. This command
    // exists BECAUSE that is not always what you want, so inheriting it
    // would make the whole command a no-op that looks like it worked.
    const a = framesArgv(SCRIPT, "https://x", "/out", "0:00", "1:00", 12, 512);
    const i = a.indexOf("--max-frames");
    expect(i).toBeGreaterThan(-1);
    expect(a[i + 1]).not.toBe("1");
  });

  test("uses the same space-separated style as watchArgv", () => {
    // One convention per script. A second spelling here would work today and
    // diverge the moment either builder gains a flag.
    const a = framesArgv(SCRIPT, "https://x", "/out", "0:00", "1:00", 12, 512);
    expect(a).toContain("--out-dir");
    expect(a[a.indexOf("--out-dir") + 1]).toBe("/out");
    expect(a.some((x) => x.includes("="))).toBe(false);
  });
});

describe("runFrames", () => {
  function fakeRunner(files: string[]) {
    return async (argv: string[]) => {
      const out = argv[argv.indexOf("--out-dir") + 1]!;
      mkdirSync(join(out, "frames"), { recursive: true });
      for (const f of files) writeFileSync(join(out, "frames", f), "jpeg");
      return { stdout: "ok", stderr: "", code: 0 };
    };
  }

  test("returns the frame directory and its files, sorted", async () => {
    const out = mkdtempSync(join(tmpdir(), "trip-frames-test-"));
    const r = await runFrames("https://x", out, "0:00", "1:00", {
      scriptPath: SCRIPT,
      runner: fakeRunner(["frame_0002.jpg", "frame_0001.jpg"]),
    });
    expect(r.dir).toBe(join(out, "frames"));
    expect(r.files.map((f) => f.split("/").pop())).toEqual([
      "frame_0001.jpg", "frame_0002.jpg",
    ]);
    rmSync(out, { recursive: true, force: true });
  });

  test("KEEPS the output directory -- runWatch deletes its own, this must not", async () => {
    // The whole point of this command is that the files survive for the
    // agent to read. runWatch rmSync's its temp dir on success; copying that
    // here would delete the deliverable.
    const out = mkdtempSync(join(tmpdir(), "trip-frames-keep-"));
    await runFrames("https://x", out, "0:00", "1:00", {
      scriptPath: SCRIPT, runner: fakeRunner(["frame_0001.jpg"]),
    });
    expect(existsSync(join(out, "frames", "frame_0001.jpg"))).toBe(true);
    rmSync(out, { recursive: true, force: true });
  });

  test("a non-zero exit is an error naming the kept directory", async () => {
    const out = mkdtempSync(join(tmpdir(), "trip-frames-fail-"));
    await expect(runFrames("https://x", out, "0:00", "1:00", {
      scriptPath: SCRIPT,
      runner: async () => ({ stdout: "", stderr: "boom", code: 1 }),
    })).rejects.toThrow(/boom/);
    rmSync(out, { recursive: true, force: true });
  });

  test("exit 0 with no frames written is an error, not an empty success", async () => {
    // Absence is loud. Returning { files: [] } here would tell the agent the
    // window genuinely had nothing in it, which is a different fact from
    // extraction having silently produced nothing.
    const out = mkdtempSync(join(tmpdir(), "trip-frames-empty-"));
    await expect(runFrames("https://x", out, "0:00", "1:00", {
      scriptPath: SCRIPT,
      runner: async () => ({ stdout: "ok", stderr: "", code: 0 }),
    })).rejects.toThrow(/no frames/i);
    rmSync(out, { recursive: true, force: true });
  });

  test("a spawn failure names the kept directory too", async () => {
    const out = mkdtempSync(join(tmpdir(), "trip-frames-spawn-"));
    await expect(runFrames("https://x", out, "0:00", "1:00", {
      scriptPath: SCRIPT,
      runner: async () => { throw new Error("ENOENT"); },
    })).rejects.toThrow(/kept at/);
    rmSync(out, { recursive: true, force: true });
  });

  test("only .jpg files count as frames", async () => {
    // watch.py leaves its own working files beside the frames; a stray
    // metadata file counted as a frame would make an empty window look
    // populated, which is the one thing the guard above exists to prevent.
    const out = mkdtempSync(join(tmpdir(), "trip-frames-jpgonly-"));
    const r = await runFrames("https://x", out, "0:00", "1:00", {
      scriptPath: SCRIPT,
      runner: fakeRunner(["frame_0001.jpg", "notes.txt"]),
    });
    expect(r.files).toHaveLength(1);
    rmSync(out, { recursive: true, force: true });
  });
});

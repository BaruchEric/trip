import { expect, test, describe } from "bun:test";
import { parseWatchReport, parseStamp, formatStamp } from "@/watch/parse-report";

const REPORT = `
# watch: video report

- **Source:** https://www.youtube.com/watch?v=KHHlcCUTwZA
- **Title:** 4 Days in Chongqing, China 2026
- **Uploader:** Some Traveller
- **Duration:** 28:14 (1694.0s)
- **Resolution:** 1920x1080 (h264)
- **Frames:** 1 @ 0.001 fps, full mode (budget 1, max 1)
- **Frame size:** 64px wide
- **Transcript:** 412 segments (via captions)

## Frames

Frames live at: \`/tmp/watch-abc/frames\`

- \`/tmp/watch-abc/frames/f0001.jpg\` (t=00:00)

## Transcript

_Source: captions._

\`\`\`
[00:42] welcome to Chongqing the largest
[04:32] we went to this hot pot place
[102:15] and that is the end of a very long video
\`\`\`

---
_Work dir: \`/tmp/watch-abc\` — delete when done._
`;

const NO_TRANSCRIPT = `
# watch: video report

- **Source:** /tmp/tiny.mp4
- **Duration:** 00:05 (5.0s)
- **Frames:** 1 @ 0.200 fps, full mode (budget 1, max 1)
- **Transcript:** none available

## Transcript

_No transcript available — proceed with frames only._
`;

describe("parseStamp", () => {
  test("parses MM:SS", () => {
    expect(parseStamp("04:32")).toBe(272);
  });

  test("parses minutes beyond 59, which is what watch.py emits", () => {
    // format_transcript uses start // 60, so a 102-minute video yields 102:15.
    expect(parseStamp("102:15")).toBe(6135);
  });

  test("parses HH:MM:SS", () => {
    expect(parseStamp("01:02:03")).toBe(3723);
  });

  test("rejects nonsense", () => {
    expect(() => parseStamp("banana")).toThrow(/timestamp/i);
  });
});

describe("formatStamp", () => {
  test("round-trips through parseStamp", () => {
    expect(formatStamp(272)).toBe("04:32");
    expect(parseStamp(formatStamp(6135))).toBe(6135);
  });

  test("keeps minutes unbounded rather than rolling into hours", () => {
    expect(formatStamp(6135)).toBe("102:15");
  });
});

describe("parseWatchReport", () => {
  test("reads the metadata", () => {
    const r = parseWatchReport(REPORT);
    expect(r.title).toBe("4 Days in Chongqing, China 2026");
    expect(r.uploader).toBe("Some Traveller");
    expect(r.durationSeconds).toBe(1694);
    expect(r.transcriptSource).toBe("captions");
  });

  test("reads the transcript lines with absolute seconds", () => {
    const r = parseWatchReport(REPORT);
    expect(r.lines.length).toBe(3);
    expect(r.lines[1]).toEqual({ atSeconds: 272, text: "we went to this hot pot place" });
    expect(r.lines[2]!.atSeconds).toBe(6135);
  });

  test("does not mistake a frame timestamp for a transcript line", () => {
    const r = parseWatchReport(REPORT);
    expect(r.lines.some((l) => l.text.includes("frames/f0001.jpg"))).toBe(false);
  });

  test("an absent transcript is null, not an empty string", () => {
    const r = parseWatchReport(NO_TRANSCRIPT);
    expect(r.transcript).toBeNull();
    expect(r.transcriptSource).toBeNull();
    expect(r.lines).toEqual([]);
  });

  test("missing title and uploader are null, not empty strings", () => {
    const r = parseWatchReport(NO_TRANSCRIPT);
    expect(r.title).toBeNull();
    expect(r.uploader).toBeNull();
  });

  test("duration comes from the parenthesised seconds, not the clock", () => {
    const r = parseWatchReport(NO_TRANSCRIPT);
    expect(r.durationSeconds).toBe(5);
  });

  test("reads a whisper source, whose own parens must not truncate the match", () => {
    // watch.py sets transcript_source to "whisper (groq)" or "whisper (openai)"
    // when captions are absent, so the report line reads
    // "(via whisper (groq))" — a paren nested inside the one the regex anchors
    // on. A non-greedy `[^)]+` stops at the first `)` and truncates the backend
    // name; the parser must anchor on the end of the line instead.
    const WHISPER_REPORT = REPORT.replace(
      "- **Transcript:** 412 segments (via captions)",
      "- **Transcript:** 412 segments (via whisper (groq))",
    );
    const r = parseWatchReport(WHISPER_REPORT);
    expect(r.transcriptSource).toBe("whisper (groq)");
  });
});

# M3 — `trip watch` and the review queue

*Brainstormed with Eric, 2026-07-27. Scoped to M3 only. Design decision 5 in `~/Arik/dev/notes/travel-assistant-design.md` fixes the pipeline; this spec fixes who executes each stage, where uncertainty lives, and how it is tested.*

## Objective

A travel video goes in. Places the geocoder is sure about land as segments the day compiler can already schedule. Places it is not sure about land in a review queue with their candidates ranked, and wait for a human or an agent to resolve them.

The milestone is done when `trip watch` on a real YouTube travel video produces segments that `trip plan` schedules, and every mention that did not become a segment is listed with a reason.

## Governing principle

**Absence is loud.** A NULL means *unknown*, never a value. An ambiguous geocode becomes a queued mention with its candidates, never a confident-looking segment. A dwell time nobody supplied is reported as a default, with a marker, everywhere it is shown. This is the principle M1 and M2 were built on and it is not negotiable in M3.

## Decisions

### 1. Extraction runs agent-side. `trip` gains no LLM dependency.

Decision 5 says "transcript → LLM extracts candidate mentions". That stage executes in the calling agent, not inside the binary.

- `trip watch <url>` downloads, caches the transcript in `sources`, and prints it.
- The agent reads the transcript and writes a mentions file.
- `trip watch ingest --mentions=<file>` geocodes, creates segments, queues the rest, and reports counts.

Rationale: it is the same split as decision 3 — the deterministic part is testable and reproducible, the judgement part is Claude's. It keeps the test suite network-free and adds no API key as a runtime dependency. The single-command report from decision 5 (`14 mentions, 9 geocoded confidently, 5 queued`) is preserved — it is `ingest`'s output.

### 2. Unresolved mentions live in their own tables, not in `segments`.

A mention is not a segment. It has no dwell, may have no coordinates, and may have five competing ones. `segments` holds only real, placeable places.

This makes "an unresolved thing reached the itinerary" **structurally impossible** rather than filter-dependent. The alternative — `segments.status = 'review'` — requires every reader to remember a filter. Today `segments.status` is written by its schema default and read by nothing, so that reading would have silently planned review items on day one.

`segments.status` remains in the schema (it is in frozen migration 4) but is confirmed dead. Migration 6 records that in a comment rather than leaving it to look meaningful.

### 3. Confidence is uniqueness, with no tunable threshold.

Measured against real Nominatim responses for Chongqing (appendix):

| Query | Results | Outcome |
|---|---|---|
| `Hongya Cave` | 1 (importance 0.34) | segment |
| `Liziba Station` | 1 (importance 0.31) | segment |
| `hot pot` | 5 (importance 0.0001 each) | queued, 5 candidates |
| `that ramen spot` | 0 | queued, reason `no match` |

**Exactly one result inside the city box = confident. Zero or two-plus = queued.**

Importance is stored on every candidate for the reviewer to read, but is **not** thresholded. OSM `importance` is derived largely from Wikipedia rank and sits at 0.0001 for essentially every restaurant and shop, so any floor would queue every food segment and the queue would become the whole video. Name similarity is likewise rejected: OSM returns 洪崖洞 for "Hongya Cave", so cross-script similarity is near zero and would queue a correct match.

### 4. Segment names keep the video's words; the local name is kept beside them.

`name` is what the video called it — the string Eric will recognise — or the corrected name if the mention was renamed during review (`COALESCE(resolved_name, text)`). `local_name` holds OSM's, rendered in parentheses when it differs:

```
10:00  Hongya Cave (洪崖洞)     90m
```

Nothing is discarded and nothing is translated. The local name is also the single most useful string to have on the ground in a country whose script you do not read.

Nominatim is queried without `accept-language`, so results come back in local script by design.

### 5. Dwell comes from the extractor, defaults to 60m, and says so.

`dwell_minutes` is NOT NULL in the frozen schema, so a video-sourced segment must carry a number. The agent reading the transcript proposes one — it is already reading the text, and travel videos routinely state duration outright. When it cannot tell, the segment gets 60 minutes with `dwell_is_default` set, and is marked `[default]` wherever dwell is shown.

**The marker is `[default]`, not `?`.** A bare `?` already means *unknown opening hours* in this codebase (`render-plan.ts:14`), and both marks appear on the same rendered line, so `60m?` would overload an established convention into ambiguity.

Dwell is currently rendered in exactly two places, both in scope: `render-plan.ts:11` (the segment list) and `render-plan.ts:78` (the day view). `trip seg ls` gains it too, since `seg ls --from` exists to show what a video produced.

`trip seg set <id> --dur=90m` corrects one without delete-and-re-add.

### 6. City bounds are a 25 km box around the destination, not OSM's admin boundary.

The confidence rule is only as good as the box it searches. Chongqing's OSM administrative boundary covers ~82,000 km²; a lone match 200 km outside the city would satisfy "exactly one result" and become a confident, wrong segment.

The box extends 25 km north, south, east and west of the trip destination's coordinates, **read from the `destinations` row**, where `latitude` and `longitude` are already `NOT NULL`. No live geocode at ingest time: calling `geocodeCity` here would give `ingest` a hard second-service dependency whose failure kills the entire run — the opposite of the per-mention survivability designed below. No new city-geocoding path, no `destinations` schema change. The extent is stated in the command's output — it is a search parameter, never silent.

It is a **box, not a circle**: its corners reach ~35 km. That is accepted rather than hidden, which is why the output says "25 km box" and never "within 25 km", and why every candidate carries `km_from_centre` so an edge case is visible as one.

Longitude degrees shrink with latitude, so the half-widths are `25/111` degrees of latitude and `25/(111·cos(lat))` degrees of longitude. A flat degree offset covers less ground the further from the equator: 21.7 km instead of 25 at Chongqing's 29.6°N, and 12.5 km by 59.9°N. This gets a test at two latitudes.

Each candidate also stores `km_from_centre`, computed with the existing haversine in `src/plan/geo.ts`, so a reviewer can see a far-flung candidate for what it is.

## Data model — migration 6

```sql
CREATE TABLE sources (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id           INTEGER NOT NULL REFERENCES trips(id),
  url               TEXT NOT NULL,
  -- NULL means yt-dlp did not report it. Not "".
  title             TEXT,
  uploader          TEXT,
  duration_seconds  INTEGER,
  -- NULL means NO transcript was obtained. Never "" — an empty transcript and
  -- an absent one are different facts and `ingest` treats them differently.
  transcript        TEXT,
  transcript_source TEXT,          -- 'captions' | 'whisper (groq)' | NULL
  fetched_at        TEXT NOT NULL,
  UNIQUE(trip_id, url)             -- re-watching reuses; only --refresh re-downloads
);

CREATE TABLE mentions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id       INTEGER NOT NULL REFERENCES trips(id),
  source_id     INTEGER NOT NULL REFERENCES sources(id),
  text          TEXT NOT NULL,     -- what the video called it. Never overwritten.
  -- NULL until someone renames. `--rename` must not overwrite `text`: decision 7
  -- requires every segment to trace back to what was said at its minute mark,
  -- and a mention gets renamed precisely because `text` was useless ("that ramen
  -- spot"). The segment's name is COALESCE(resolved_name, text) — both facts kept.
  resolved_name TEXT,
  -- NULL means the extractor gave no timestamp. Not 0, which is the first frame.
  at_seconds    INTEGER,
  -- NULL means the extractor proposed no dwell; 60 is applied at segment creation
  -- and flagged there. Storing 60 here would erase the fact that nobody said so.
  dwell_minutes INTEGER,
  tags          TEXT NOT NULL DEFAULT '',
  -- Why it is queued. NULL once resolved.
  reason        TEXT,
  segment_id    INTEGER REFERENCES segments(id),
  rejected_at   TEXT
);

CREATE TABLE mention_candidates (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  mention_id     INTEGER NOT NULL REFERENCES mentions(id),
  rank           INTEGER NOT NULL,   -- 1-based, as --pick takes it
  display_name   TEXT NOT NULL,
  local_name     TEXT,
  latitude       REAL NOT NULL,
  longitude      REAL NOT NULL,
  category       TEXT,
  type           TEXT,
  importance     REAL,
  osm_type       TEXT,
  osm_id         INTEGER,
  km_from_centre REAL NOT NULL
);

ALTER TABLE segments ADD COLUMN local_name       TEXT;
ALTER TABLE segments ADD COLUMN source_id        INTEGER REFERENCES sources(id);
ALTER TABLE segments ADD COLUMN source_at_seconds INTEGER;
ALTER TABLE segments ADD COLUMN dwell_is_default INTEGER NOT NULL DEFAULT 0;
```

`BASE_SCHEMA` is frozen. This is migration 6, appended to `MIGRATIONS`, guarded by a `hasColumn`/`hasTable` check like 4 and 5. Eric's live DB is at v5; back it up before running.

## The seam

M2's three worst bugs lived in one boundary where two writers touched the same state, and all three were found by running two commands that described the same state and disagreeing — not by unit tests. M3 adds the same shape: a mention's extraction outcome versus its resolution.

**A mention therefore has no `state` column.** State is derived and cannot contradict itself:

```
rejected_at IS NOT NULL  -> rejected
segment_id  IS NOT NULL  -> resolved
otherwise                -> pending, and `reason` says why
```

Writer ownership is exclusive:

| Column | Written by |
|---|---|
| `mention_candidates.*` | `ingest`, and `review resolve --rename` (which re-geocodes, replacing the row's candidates wholesale) |
| `mentions.reason` | `ingest`, `review resolve --rename`, and `removeSegment` (`'segment deleted'`) |
| `mentions.segment_id` | `ingest` and `review resolve --pick` set it; `removeSegment` clears it |
| `mentions.rejected_at` | `review resolve --reject` |
| `mentions.resolved_name` | `review resolve --rename` only |
| `mentions.text` | `ingest` only, at creation. Never updated. |

`reason` and `segment_id` are always written together, in one transaction, by whichever command owns the transition — never independently. A mention with both set, or with `reason` set and `segment_id` set, is the contradiction this table exists to forbid; a test asserts it never occurs.

If `state` existed, `ingest` and `review resolve` would both write it, and it could read `resolved` while `segment_id` was NULL — a mention claiming to be a place while pointing at nothing. That is the M2 bug in new clothes.

**The compiler cannot see a pending mention.** It reads `segments`; a pending mention has no segment row. There is no filter to forget.

**Deleting a video-sourced segment.** `mentions.segment_id` carries an enforced foreign key to `segments(id)`, so `trip seg rm` on a segment a resolved mention points at does not dangle — it FAILS with an opaque constraint error. `removeSegment` NULLs the reference and sets `reason = 'segment deleted'` first, returning the mention to the queue. A place does not silently disappear from the record of what the video said. This is a cross-command consistency test, not a comment.

## Command surface

Flag values are `--name=value`, never space-separated. A space-separated value lands among the positionals, which is the bug that once made `trip when New York` answer about Patna, India.

```
trip watch <url> [--refresh] [--whisper] [--timeout=<s>]
trip watch ingest --mentions=<file.json> [--source=<id>] [--replace]
trip review ls [--json] [--source=<id>]
trip review resolve <id> --pick=2 | --reject | --rename="Actual Name"
trip seg ls [--from=<source-id>]
trip seg set <id> --dur=90m
```

Every command takes `--json`. Commands return strings; only `cli.ts` prints or exits.

**`trip watch <url>`** requires an active trip with a destination. Prints title, uploader, duration, transcript line count, and the transcript itself. A URL already in `sources` for this trip is served from cache — the video is not re-downloaded — unless `--refresh` is passed, following `trip when`'s convention.

**`trip watch ingest`** attaches mentions to a source. `--source=<id>` names it explicitly; omitted, it uses the most recently fetched source **for the active trip**, and errors plainly if the trip has none.

**Ingesting twice is defined, because it is the normal path.** The agent's loop is extract → ingest → read the results → re-extract, so a second ingest against one source is routine, not an edge case. Plain `ingest` **refuses** when the source already has mentions, reports how many, and names `--replace`. `--replace` deletes that source's pending and rejected mentions with their candidates, then ingests fresh. It **refuses outright if any mention on that source is resolved**, naming them — deleting those would orphan real segments that may already be pinned into a plan. Clear those with `seg rm` first if you truly mean it.

**`trip review resolve`** is non-interactive and never reads stdin. `--rename` re-runs the geocode against the new name, so a corrected mention can resolve *or* return to the queue with fresh candidates. Exactly one of `--pick` / `--reject` / `--rename` is required.

Resolving a mention that is **already resolved or rejected** is an error that names its current state and, where one exists, its segment id. It is never a silent second segment.

**`trip review ls`** output shape:

```
3 mentions pending review · searched a 25 km box around Chongqing

#4  "hot pot"  (source 1, 04:32) — 5 candidates
    1. 夜福火锅 — restaurant, 1.4 km      2. 地下之城老火锅 — restaurant, 3.8 km
    ...
#7  "that ramen spot"  (source 1, 11:07) — no match
    trip review resolve 7 --rename="..."  or  --reject
```

## The agent contract

`ingest` reads a JSON array. One required field, three optional:

```json
[
  {"text": "Hongya Cave", "at": "04:32", "dwell": "90m", "tags": ["sight"]},
  {"text": "hot pot", "at": "11:07"}
]
```

- `text` — required, the name as the video said it.
- `at` — `MM:SS` or `HH:MM:SS`, with **minutes unbounded** (`102:15` is valid), matching the transcript format the agent copied it from. Absent → `at_seconds` NULL.
- `dwell` — same duration grammar as `seg add --dur`. Absent → 60m, flagged default.
- `tags` — absent → empty, which is already how `seg add` behaves.

Malformed entries are rejected individually with their index and reason; the rest of the file still ingests. A file that is not a JSON array at all is a hard error.

**Corrected 2026-07-27 by M7.** `text` is described above as "the name as the video said it", and decision 4 repeats that. Two milestones have since changed what it holds:

- **M6** told the extractor to correct ASR errors before ingesting, because ten of eleven caption names in the measured video were wrong. `text` has held the *corrected* name ever since.
- **M7** adds `query` for the string to look a place up by, so `text` is now unambiguously **the display name** — what you want to read in the plan — and nothing else.

The video's literal words are still recoverable: `text` is written once and never updated, and a rename lands in `resolved_name` beside it. What changed is which of the two `text` is.

**Added 2026-07-27 by M6, both measured against the real Chongqing video:**

- **Auto-captions corrupt proper nouns, and correcting them is the extractor's job.** Ten of the eleven place names in that video's captions were wrong — `Arat Temple` for Luohan Temple, `Hongadong` for Hongya Cave, `Ji Fang Bay` for Jiefangbei. Ingesting them as spoken geocoded **1 of 11**; correcting them first geocoded **4 of 11**. Nothing in this contract had ever said to, and the cost of the omission is the difference between 9% and 36%.
- **Rolling captions repeat.** Each line carries the tail of the one before it, so every sentence appears roughly twice in the stored transcript. An extractor that does not expect this reads the video twice over.

## `watch.py` integration

Resolved at runtime by globbing `~/.claude/plugins/cache/claude-video/watch/*/scripts/watch.py` and taking the highest version. Never hardcoded — `0.1.2` is today's.

**Verified empirically 2026-07-27, correcting the design record's open question:**

- **`--max-frames 0` fails.** ffmpeg exits with `The encoder timebase is not set` / `Error while opening encoder`, `watch.py` returns 1, and stdout is empty. The guess recorded at line 148 of the decision record is wrong.
- **`--max-frames 1` is the transcript-only setting.** Exit 0, full report, one throwaway frame.

Invocation, as an argv array (no shell):

```
python3 <resolved>/scripts/watch.py <url>
        --max-frames 1 --resolution 64
        --out-dir <temp>
        [--no-whisper unless `trip watch --whisper`]
```

`--no-whisper` is the **default**. Captions are free and deterministic; the Whisper fallback silently spends money against a Groq or OpenAI key. `trip watch --whisper` opts in. The Chongqing test video has English auto-captions and `download.py` already passes `--write-auto-subs`, so the fallback is not needed for it.

The temp working directory is deleted after a successful parse and **kept on failure**, so a broken run can be inspected.

### Report parsing

`watch.py` writes a markdown report to stdout. The parser is pure and takes a string — `src/watch/parse-report.ts` — so its tests need no network, no ffmpeg, and no yt-dlp.

It reads `- **Title:**`, `- **Uploader:**`, `- **Duration:**`, `- **Transcript:**`, and the fenced block following `## Transcript`. Transcript lines are `[MM:SS] text`.

**`MM` is total minutes and is not bounded at 59.** `format_transcript` emits `start // 60`, so a 102-minute video yields `[102:15]`. A parser that assumes `HH:MM` or two digits breaks on exactly the long videos the format is for. This gets a test.

`- **Transcript:** none available` is a real outcome, not a parse failure: the source row is saved with `transcript` NULL, the command reports it plainly, and exits non-zero, because `ingest` has nothing to work from.

## Geocoding

New `src/geo/poi.ts`, following the existing `geocodeCity(name, fetchFn?, timeoutMs?)` seam so tests inject a fetch.

```
https://nominatim.openstreetmap.org/search
  ?q=<mention>&format=jsonv2&viewbox=<l,t,r,b>&bounded=1
  &limit=5&addressdetails=1
```

Nominatim's usage policy requires a genuine `User-Agent` and permits at most 1 request/second. The agent string carries the project URL — `trip/0.1 (+https://github.com/BaruchEric/trip)` — not a personal email, since the repo is public. Requests are serialized with ~1.1 s spacing through an injectable sleep, so tests do not wait. Fourteen mentions take about fifteen seconds; that is acceptable for a command run once per video.

**A failed query never kills the run.** An HTTP error, timeout, or unparseable body queues that one mention with `reason = 'geocode failed: <status>'` and ingest continues. Aborting thirteen good mentions because the sixth got a 429 would be the wrong trade every time.

## Testing

Fixtures are captured real output, not invented strings: the four Nominatim responses in the appendix, and the actual `watch.py` report for the Chongqing video.

**Unit**
- Report parser: full report, no-transcript report, `[102:15]` minutes over 59, missing title/uploader.
- Nominatim response parser against the four captured fixtures.
- Confidence rule: 0 / 1 / 5 results.
- Viewbox math at two latitudes — the longitude half-width must widen as latitude falls.
- Mentions-file parser: valid, malformed entry among valid ones, non-array input, `at` with minutes over 59.
- Duration grammar reused from `seg add`, not reimplemented.

**Cross-command consistency** — the M2 lesson, the tests that actually find the seam bugs:
- After `ingest`, `seg ls --from=<id>` count + `review ls` count + rejected count = mention count. Nothing vanishes.
- A pending mention never appears in `trip plan` output, in any pace or mode.
- `seg rm` of a video-sourced segment returns its mention to `review ls` with `reason = 'segment deleted'`.
- `review resolve --pick` twice on the same mention errors on the second call and leaves exactly one segment.
- No mention ever holds both a `segment_id` and a `reason`, or both a `segment_id` and a `rejected_at` — asserted after every command in the acceptance run.
- `--rename` leaves `text` untouched: the segment is named the corrected name, and the mention still reports the video's original words and timestamp.
- A second plain `ingest` on a source refuses and creates nothing; `--replace` clears pending and rejected but refuses while any mention is resolved.
- `review resolve --rename` on a mention that then geocodes uniquely produces exactly one segment and empties its candidates.

**Mutation sweep** on the confidence rule and the report parser. On M2, four of five mutations to the ordering search survived 335 green tests and 300-case fuzzing, including deleting the meal-window pull outright. Every fix in this repo carries a regression test that fails when the fix is reverted; M3 holds that line.

**Acceptance**: the real Chongqing video, end to end, against a scratch DB — watch, extract, ingest, review, resolve, plan.

## Carried debt paid here

Both items are paid because M3 reopens them, not as unrelated cleanup.

- **Validation moves to the storage boundary.** Cross-midnight opening hours, `closedDays` case normalisation, and empty-string tags are currently unreachable *only because* input flows through the CLI parsers. M3 writes segments programmatically and reopens every one. `addSegment` validates them, following the precedent its own `joinList` comma rejection already sets.

**Known wrinkle, surfaced while doing the above — midnight has two spellings.** The CLI maps `--hours=…-24:00` to `1439`, while direct callers and the existing test suite write `1440`, and `formatClock` renders them `23:59` and `24:00` respectively. `addSegment`'s bound therefore accepts `closesMin` up to 1440 deliberately; narrowing it to 1439 breaks a passing M2 test. Harmless in M3 — every video-sourced segment gets NULL hours, because a geocoder does not know them — but it will bite whoever touches opening hours next, so it is recorded here rather than only in the build ledger.
- **Per-command flag validation.** `cli.ts` allowlists flags globally, so `trip plan --day=2` is accepted and silently ignored, against the file's own stated policy. M3 adds eight flags to that list; it fixes the mechanism while doing so.

## Note for the implementation plan

**Sequence the storage-boundary validation first**, ahead of anything that writes segments. If `ingest` lands before `addSegment` validates, every segment-writing task is built against the unvalidated function and reworked afterwards.

Expect **12–14 tasks**, not eight: migration 6, `sources` storage, `mentions` storage, the POI geocoder, the `watch.py` runner, the report parser, two `watch` subcommands, two `review` subcommands, `seg set`, `seg ls --from`, and the two debt items. This is M2-scale or larger.

## Out of scope

`cost_bands`, `trip budget`, `trip export`, routing (OSRM/GTFS), Turso sync, and frame-based visual identification of unnamed places. Frames stay the opt-in cost dial decision 5 made them; M3 ships transcript-only.

## Appendix — captured evidence, 2026-07-27

`watch.py` flags, run against a generated 5-second test video:

```
--max-frames 0  -> exit 1, empty stdout, ffmpeg "encoder timebase is not set"
--max-frames 1  -> exit 0, full report, 1 frame
```

Nominatim, `viewbox=106.35,29.65,106.65,29.45&bounded=1&limit=5`:

```
"hot pot"         n=5  all importance 0.0001, place_rank 30, amenity/restaurant
"Hongya Cave"     n=1  洪崖洞, building/yes, importance 0.3408
"that ramen spot" n=0
"Liziba Station"  n=1  李子坝, railway/station, importance 0.3072
```

Chongqing test video `KHHlcCUTwZA`: English auto-captions present; no Whisper key required.

## Appendix — measured results from the first real acceptance run, 2026-07-27

Decision 3's Testing note asks for a **measured** confident/ambiguous/wrong rate rather than an asserted one. This is that measurement, from the real video, the real `watch.py`, and the live Nominatim API.

Thirteen mentions were extracted by hand from the transcript:

| Outcome | Count |
|---|---|
| Confident (became segments) | 4 |
| Ambiguous (queued with candidates) | 1 |
| No match (queued, reason `no match`) | 8 |

**One of the four confident matches was wrong.** `Jiefangbei Pedestrian Street` returned exactly one result inside the 25 km box — `你好酒店(重庆解放碑步行街店)`, a `tourism=hotel` whose *name merely contains* the street's name. Being unique, it bypassed the review queue and became a confident segment. The other three (Luohan Temple, Hongya Cave, Ring Shopping Park) were correct.

**The rule is sound as specified and is not sufficient.** It queued every genuinely ambiguous case, and decision 3's evidence against the alternatives still holds — an importance floor would queue every Chongqing restaurant (all score 0.0001), and name similarity would queue correct cross-script matches. Nothing here argues for changing it.

What it argues is narrower: **uniqueness is not sufficiency.** A place with one match can still be the wrong place, and the confidence rule cannot see the difference.

Two routes reach that same failure, and they belong in the M4 brief together:

1. **A wrong single result**, as above.
2. **A right but truncated result set.** `parsePoiResponse` drops results missing coordinates or a name, and `classify` counts what survives — so a two-result response with one unusable entry presents as confident. Found by the final review; fixed in M3 by making the drop count visible to the verdict, but the class remains.

The shape of the M4 answer is a **category plausibility check**, orthogonal to uniqueness rather than a replacement for it: a query naming a street, park or temple that matches `tourism=hotel` is a type mismatch worth queueing even when unique.

**One mitigation already in place:** segments render as `name (localName)`, so the bad match appears as `Jiefangbei Pedestrian Street (你好酒店(重庆解放碑步行街店))` in both `seg ls` and the compiled plan. A reader can see it. It is not invisible — only unqueued.

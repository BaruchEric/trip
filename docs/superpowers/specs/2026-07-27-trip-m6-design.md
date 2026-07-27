# M6 — what the first real run found, and the frame dial

*Brainstormed with Eric, 2026-07-27. Scoped to M6 only. M4 and M5 both closed naming the same gap: no real video had ever been through the whole pipeline. This milestone starts by doing that, and is shaped entirely by what it found.*

## Objective

The pipeline is measured end to end on a real video, and the two things that measurement proved worth having are built.

The milestone is done when the Chongqing run replays as an acceptance test at its measured numbers, when a video's on-screen budget can be read and recorded, and when the review queue stops showing a name it no longer holds.

## Governing principle

**Absence is loud** and **a check that cannot be sure says nothing**, both unchanged. M6 adds no new principle. It adds a *method*, which M4 stated and M6 had to learn again the hard way:

**Evidence gathered with a query that differs from the production query is evidence about a different question — and one corrected parameter is not the same as a matching query.** M4 caught its appendix sending the wrong `addressdetails` and fixed the record. The same four lines also sent the wrong `viewbox`, and that second discrepancy is what produced M4's conclusion that one of M3's four data points could not be reproduced. It reproduces.

## What the first real run measured

`youtube.com/watch?v=KHHlcCUTwZA` — "4 Days in Chongqing, China 2026", the video bookmarked in this repo's root, and the source of the three places M3's acceptance run used. Captions, not whisper: 175 lines. Live Nominatim, scratch database, 2026-07-27.

**Eleven mentions extracted from the transcript. One geocoded.**

Ten queued, every one of them `no match` rather than a wrong match — the safe failure direction M3 and M4 designed for, holding on real data for the first time.

**Correcting every name by hand took it to four.**

| Caption said | Actually | Outcome |
|---|---|---|
| Arat Temple | Luohan Temple | segment, 罗汉寺 1000 лет |
| Longman how old street | Longmenhao Old Street | no match |
| Wulong casts | Wulong Karst | no match |
| Tienfu Post House | Tianfu Inn | no match |
| Fisher Gorge | Longshuixia Fissure Gorge | no match |
| Don Shan Cafe | Dongshan Cafe | no match |
| Shabbati | Shibati | 2 candidates |
| Hongadong | Hongya Cave | segment, 洪崖洞 |
| Test Bed Creative Park | Testbed 2 | segment, 贰厂文创园 |
| Ring Shopping Park | (correct as spoken) | segment, 光环购物中心 |
| Ji Fang Bay Pedestrian Street | Jiefangbei Pedestrian Street | type mismatch |

Five things fell out of this, and they are what M6 is:

**The auto-captions mangle nearly every proper noun.** Ten of eleven. Geocoding raw extractor output is a 9% proposition; correcting names first makes it 36%. That correction is the *extractor's* job under M3's design, and nothing in the contract had ever told it so.

**M4's plausibility check fired correctly in production, for the first time.** `Jiefangbei Pedestrian Street` → `type mismatch: expected street, got tourism/hotel`, reached through `--rename` — a different code path than the one M4 measured. The mechanism is confirmed on live data.

**The review queue lies after a rename.** See decision 6.

**The budget exists only on screen.** The transcript's final line is `[19:29] As promised, here is a budget breakdown on my four days in Chongqing.` and then it stops. Every price in this video is invisible to a transcript-only pipeline — which is precisely the gap M5's ledger named as its largest, and it turns out to be structural rather than incidental.

**M4's evidence base was misrecorded.** See the governing principle, and the appendix.

## Decisions

### 1. Frames are a targeted second pass, never a blanket one.

`trip watch` stays exactly as cheap as it is. When the agent reads a line claiming something is on screen, it asks for frames of *that window*:

```
trip watch frames <source-id> --from=19:25 --to=20:20 [--max=12] [--width=900]
```

Measured: that window yielded two frames, and the second carried the entire budget card. A blanket pass over the twenty-minute video at the default 80-frame budget samples once every fifteen seconds and would likely have missed a card that is only up for a few.

`--from` and `--to` are **required**. A frames command with no window is the blanket pass by another name, and making the window mandatory keeps the cost a deliberate choice every time. Decision 5 of the original design record called frames "the opt-in cost dial"; this keeps the dial and gives it a handle.

The source must already exist from a prior `trip watch`, so frames are always tied to a video the database knows and can never be pulled for an unrelated URL.

### 2. The tool never looks at a frame.

`trip` extracts frames, prints where they are, and stops. No OCR, no vision, no image handling of any kind enters the binary.

This is design decision 1 — agent-native CLI, no LLM dependency — applied to a case that looks like it needs one and does not. The agent reads the images directly. **Verified before this spec was written**, not assumed: the budget card above was read from `frame_0002.jpg` with no tooling whatsoever.

It also means the expensive, fragile part (recognising things in pictures) stays where it can improve without a release, and the tool's part is a subprocess call it already makes.

### 3. Frames cache by window, on the filesystem, with no table.

`<dir of the database file>/frames/<source-id>/<from>-<to>/frame_NNNN.jpg`. The window is the cache key and the directory name carries it. A repeat call reports the existing frames and re-extracts nothing; `--refresh` forces it, mirroring how `watch` treats a cached transcript.

**Beside the database, not hardcoded to `~/.trip`.** The database path is already overridable — `openDb` takes one and `TRIP_TEST_DB` sets it — so a hardcoded home directory would make every test and every scratch run write frames into the user's real `~/.trip`. Deriving the location from the open database means a scratch database gets scratch frames, and frames always sit next to the rows that reference their source.

**No `frames` table.** It would be a second copy of what the filesystem already knows and could disagree with it — the reasoning migration 4 used to keep a `days` table out of the schema, applied again.

### 4. Frames produce nothing on their own.

What the agent learns from a frame goes back through the existing `watch ingest --mentions=<file>` contract, unchanged, or through `trip costs add`. There is no frame-to-segment path.

One write path into `segments` rather than two. A second one would need its own validation, its own dedupe against existing mentions, and its own answer to what happens when a frame contradicts the transcript — three questions that buy nothing here.

### 5. An observation records what it covered, not a "basis".

A cost observation is a fact about **someone else's trip**. Using it for yours needs three things, and each one's absence has to stay visible:

- `currency` **NOT NULL** — M5 already established that a bare number is a number of unknown denomination, and these arrive in whatever the video used.
- `covers_days` and `covers_people`, both nullable, both meaning UNKNOWN.

Per-person-per-day is **derived at render time and stored nowhere**, computed only when both are known and non-zero, and rendered `?` otherwise. The same shape as M5's `PartyPrice`, for the same reason.

A `basis` enum (`trip` / `day` / `person`) was rejected: it collapses two independent facts into one and cannot express the case actually measured — *$401, four days, one person*. Whether that is one traveller or two changes the figure by half, and an enum forces that to be guessed or dropped.

### 6. The review queue shows both names.

`render-review.ts:25` renders `m.text`. After a `--rename` that still fails, the queue displays the name you just replaced, so you cannot see what is stored or what was queried — and a second attempt looks like it is operating on the original.

Both facts are kept, the way `displayName` already keeps a segment's name beside its local name:

```
#2  "Longmenhao Old Street" (said: "Longman how old street")  - no match
```

The parenthetical appears only when the two differ, so a mention nobody has renamed renders exactly as it does today.

### 7. M4's appendix is corrected in place, not quietly.

The M4 spec and ledger both record `Ring Shopping Park` as `n=0` and conclude M3's four-point evidence base has three reproducible points. Re-run four ways, the cause is the **viewbox**, not `addressdetails`:

| viewbox | `addressdetails` | result |
|---|---|---|
| M4's appendix box | off | n=0 |
| M4's appendix box | on | n=0 |
| production box | off | n=1, `shop/mall` way/1295738129 光环购物中心 |
| production box | on | n=1, same object |

M4's appendix hand-types `106.35,29.65,106.65,29.45` — half-widths of roughly 11.1 km of latitude and 14.5 km of longitude. `viewbox(centre, 25)` computes 25 km on both axes. The mall lies between the two boxes.

Corrected in place, the way M4 corrected its own Hongya Cave evidence, because a spec that quietly stops being wrong teaches nobody anything.

### 8. Correcting ASR is the extractor's job, and the contract now says so.

Nothing in `SUBCOMMAND_HELP["watch ingest"]` or the M3 agent contract had ever mentioned that auto-captions corrupt proper nouns. The measured cost of not saying so is 9% versus 36%.

The contract also gains one line about rolling captions repeating the previous line's tail, because every extractor reads this transcript's sentences roughly twice and nothing warned it.

## Data model — migration 10

```sql
CREATE TABLE cost_observations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id       INTEGER NOT NULL REFERENCES trips(id),
  -- NULL for a hand-entered figure. NOT NULL would force a fake source row
  -- for anything the user simply knows.
  source_id     INTEGER REFERENCES sources(id),
  -- Where in the video it was stated. NULL means the source did not say.
  at_seconds    INTEGER,
  label         TEXT NOT NULL,
  amount        REAL NOT NULL,
  -- NOT NULL: an amount with no unit cannot be compared to anything.
  currency      TEXT NOT NULL,
  -- NULL is UNKNOWN on either axis. Both are needed to normalise, and an
  -- unknown either side makes the normalisation UNAVAILABLE, not approximate.
  covers_days   INTEGER,
  covers_people INTEGER
);
```

No other schema change. `price_rules`, `travellers` and `passes` are untouched; `lodging_tier` and `food_tier` stay parked for `cost_bands` exactly as M5 left them.

## Command surface

```
trip watch frames <source-id> --from=19:25 --to=20:20 [--max=12] [--width=900] [--refresh]
```

`--max` and `--width` map onto `watch.py`'s `--max-frames` and `--resolution`; `--from`/`--to` onto its `--start`/`--end`. The shorter spellings match this CLI's existing vocabulary (`--dur`, `--at`, `--from`) rather than importing the script's. `--no-whisper` is always passed: this pass wants pictures and the transcript is already stored.

```
trip costs add <label> --amount=230 --currency=USD
                       [--days=4] [--people=1] [--source=1] [--at=19:29]
trip costs ls
trip costs rm <id>
```

```
$ trip costs ls
  #1  Transportation      USD 40    4d × 1p    USD 10.00 pppd
  #2  Accommodation       USD 230   4d × 1p    USD 57.50 pppd
  #3  Activities & food   USD 131   4d × 1p    USD 32.75 pppd
  #4  Total               USD 401   4d × 1p    USD 100.25 pppd
      all from source 1 at 19:29
```

**The tool never sums observations.** This video states three components *and* their total; adding them double-counts. Rows are reported, never aggregated.

**Observations are never shown beside the plan's own total.** One is what a stranger spent, the other is what your plan costs, and they are in different currencies with no conversion available. A single line holding both would be a fabricated comparison.

Every new flag is declared per-subcommand in `COMMAND_FLAGS` and every new subcommand gets a `SUBCOMMAND_HELP` entry — M4's machinery, used as intended.

## The agent contract

Unchanged in shape. Two facts added to its documentation, both measured:

- **Auto-captions corrupt proper nouns.** Correct them before ingesting. Ten of eleven names in the measured run were wrong, and correcting them moved the geocode rate from 9% to 36%.
- **Rolling captions repeat.** Each line carries the tail of the one before it, so every sentence appears roughly twice.

## Carried debt paid here

**`review ls` showing a stale name** — decision 6. Not previously known, because nothing had ever renamed a mention outside a test.

**M4's misrecorded evidence base** — decision 7.

## Testing

**`test/m6-acceptance.test.ts`, replaying the real run.** The eleven mentions, captured Nominatim responses run through `parsePoiResponse`, and assertions on both measured numbers: 1 of 11 raw, 4 of 11 corrected. This is the whole point of M4's lesson — the measurement above currently exists only in a scratch database and in this document's prose, and prose cannot be replayed. Capturing the raw response bodies is its own task; the parsed candidates were kept but the bodies were not.

**The rename display, both directions.** A mention that has been renamed shows both names; one that has not shows exactly what it shows today. The second half matters more — it is what stops the fix becoming a churn of every existing review test.

**Frame extraction, without the network.** The `run.ts` seam is already injectable; the tests drive a fake runner and assert argv, the cache-hit path, the `--refresh` path, and that a missing source is refused.

**`cost_observations` normalisation.** Per-person-per-day is computed when both axes are known and is `?` when either is missing — asserted in all four combinations, because three of them are the unknown case and only one is the arithmetic.

**A mutation sweep**, reported as a table of mutation → tests killed, including: *frames are extracted without a window*; *a missing `covers_people` is treated as 1*; *the renamed name replaces the original instead of joining it*; *observations are summed*.

## Out of scope

**`cost_bands` and `trip budget`.** Still parked, and M6 deliberately stops short of them. `cost_observations` records what a source *said*; `cost_bands` would be reference data estimating what a city *costs*, and building that from a single video is the thin-evidence trap M5's ledger warns about. The observations table is what a future `cost_bands` gets built from, not a substitute for it.

**Comparing observations to the plan's total** — see the command surface. Needs currency conversion, which needs a rate source, which is its own dependency question.

**Frame-driven segment creation.** Decision 4.

**Sanitising OSM's `name` field.** Luohan Temple returns `罗汉寺 1000 лет` — Russian, mid-field — and it renders verbatim. Deciding which parts of a name are junk means guessing, and a wrong guess silently renames a place. Recorded as measured, left alone.

**Dwell and opening hours from video.** Neither has ever come from a source; all four segments in the run landed `[default]` dwell and `?` hours. The contract already accepts `dwell` and nothing produced one. Inventing them is worse than the marks that currently say so.

**Places the transcript describes but never names.** Five of them in this video: the skywalk, the Line 2 metro through a residential building, the square that is street level and the 22nd floor at once, an evening riverfront viewpoint, and the hot pot restaurant inside a wartime air raid shelter. Frames make these *readable* by the agent — which is what decision 2 buys — but nothing in M6 automates recognising them, and no claim is made that it works.

Unchanged from M3–M5: `trip export`, routing (OSRM/GTFS), Turso sync.

## Appendix — captured evidence, 2026-07-27

**The run.** Video `KHHlcCUTwZA`, captions, 175 lines, 12,670 chars. Destination geocoded to Chongqing 29.56026, 106.55771. Eleven mentions; 1 geocoded raw, 4 after hand correction. Fixtures — the mentions file, the resolved rows, and the budget frame — captured before the scratch database was deleted.

**The budget card**, read from `frame_0002.jpg` of the 19:25–20:20 window at 900px, with no OCR:

```
Budget Breakdown
Transportation:      $40
Accommodation:      $230
Activities & food:   $131

Total (USD):         $401
```

Four days in Chongqing, $401, one traveller.

**The viewbox discrepancy**, four ways — see decision 7.

**What is still not established.** The 36% figure is one video, one city, one language pair, and the corrections were made by an agent that already knew what the places were. Nothing here measures an extractor working blind, and nothing measures a second city. The honest summary is that M6 replaces two milestones' worth of assumption with one video's worth of measurement — which is a large improvement over zero and is not the same as a rate.

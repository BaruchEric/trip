# M7 — the string you search by is not the string you call it

*Brainstormed with Eric, 2026-07-27. Scoped to M7 only. Picked as "frames for the five places the transcript describes but never names", flagged during scoping as possibly too thin to be a milestone, and reshaped entirely by what the frames actually showed.*

## Objective

A place can be looked up by one name and displayed by another.

The milestone is done when `龙门浩老街` geocodes a segment that still reads `Longmenhao Old Street` in the plan, when the review queue says which string it searched, and when the measurement behind all of this replays as a test.

## Governing principle

**Absence is loud** and **a check that cannot be sure says nothing**, both unchanged. M7 adds one, and it is a restatement of the repo's oldest instinct in a place nobody had looked:

**Two facts that happen to be equal are still two facts.** A search key and a display name were the same string for six milestones, so one field carried both. That worked until a rename crossed scripts, at which point the tool silently traded the name Eric can read for the name OSM can find — and nothing in the schema, the renderers or the tests noticed, because at every earlier moment the two strings had been identical.

## What the frames measured

The frame dial M6 shipped, pointed at four windows of the same Chongqing video.

**Frames produce evidence of wildly varying confidence.** The Line 2 monorail leaving the Liziba block is near-unique on earth and recognisable outright. A plaza flush with the ground and 22 storeys above the street is recognisable only if you already know Chongqing — the frame confirms the *phenomenon* the transcript described and carries no name. A curved cliffside skywalk is a guess. Only the hot pot frame carries a name at all, and it carries it in Chinese: **防空洞老火锅**.

That last one is what turned the milestone. M6 had measured five *correct English* names still missing, and filed it as OSM coverage. M3 records that Nominatim is queried without `accept-language`, so results come back in local script. The signage suggested the misses might be a **script** problem instead.

Tested against the production query:

| English | n | local script | n |
|---|---|---|---|
| Longmenhao Old Street | **0** | 龙门浩老街 | **1** `landuse/commercial` |
| Kuixinglou | **0** | 魁星楼 | **1** `place/square` 大唐广场 |
| Dongshan Cafe | 0 | 东山咖啡 | 0 |
| air raid shelter old hot pot | 0 | 防空洞老火锅 | 0 |
| Shibati | 2 candidates | 十八梯 | **5 candidates** |
| Liziba | 3 | 李子坝 | 3 `railway/station` |

**Local script recovers two of the five.** M6's "coverage" finding was half right and half a script artefact, and neither half was distinguishable before this.

**It is not uniformly better.** 十八梯 goes from 2 candidates to 5 — *more* ambiguous, so *more* likely to stay queued. A rule of "always query in local script" would be wrong.

**A place the video never names becomes findable once a frame lets you name it.** 李子坝 returns a `railway/station`. That is the original premise of this milestone, confirmed, and it is the smaller half of what was found.

## The defect this uncovered

`trip review resolve 1 --rename="龙门浩老街"` **already worked**. No code was needed to recover the place. What it also did:

```
SEGMENT: name=龙门浩老街  local_name=龙门浩老街
MENTION: text="Longman how old street"  resolved_name=龙门浩老街
```

`seg ls` shows `龙门浩老街` and nothing else, because `displayName` renders `localName` in parentheses only when it **differs** from `name`.

M3 decision 4 is explicit that `name` is "the string Eric will recognise" and `local_name` is "what you show a taxi driver in a country whose script you do not read". Follow this technique across a video and the compiled plan is entirely in a script Eric cannot read — the exact failure decision 4 exists to prevent, reached by the route that makes geocoding work.

**Confirmed on both resolution paths**, `--rename` and `--pick`, so the fix belongs below the flag.

**The trigger is string equality, not script.** `displayName`'s condition is `localName !== name`. All four of M6's segments differ from OSM's local name and render both halves correctly; M7's two collapse only because the string typed is the string OSM answers with. **A fix keyed on detecting Chinese would be a magic rule guessing at the real cause.**

## Decisions

### 1. The search key and the display name are separate fields.

A mention gains `query`. `text` is what you read; `query` is what gets looked up. The geocode uses `query ?? name`; the segment's `name` remains `resolvedName ?? text` and `localName` remains OSM's.

The collapse cannot recur because the two strings are never forced through one field again. The schema already modelled four distinct facts — what it is called, the corrected name, the display name, OSM's name — and was missing the fifth: what to look it up by. `--rename` had been doing double duty as both correction and lookup key.

### 2. `query` is optional, and absent means "search by the name".

Purely additive. Every existing mentions file, every existing test and every existing call behaves exactly as it does today. A milestone that changed the default lookup would be re-measuring M6's numbers by accident.

### 3. The tool never infers a local-script name, and never queries twice.

No script detection, no transliteration, no "try English then try Chinese and merge". 十八梯 returns 5 candidates where `Shibati` returns 2 — trying both and merging makes a mention *more* ambiguous and *more* likely to queue, so the obvious clever version is measurably worse than doing nothing.

The agent decides what to search by. The tool records it and says what it did. This is decision 1 of the original design record — agent-native, no inference in the binary — applied to a case where the inference looks easy.

### 4. `--query` is a resolution action, so the mutual-exclusion rule grows.

`review resolve` enforces *exactly one of* `--pick` / `--reject` / `--rename`. `--query` re-geocodes, so it belongs in that set, and it must also combine with `--rename`.

The rule becomes: **exactly one of `--pick`, `--reject`, or (`--rename` and/or `--query`)**.

`--query` alongside `--pick` is an error. Picking a candidate performs no lookup, so a query there would be silently ignored — the anti-pattern M4 built the flag validator for and M6 found again in the `watch` fallback key. Twice is enough to check for it deliberately.

### 5. The review queue says what it searched.

M6 made the queue show `"name" (said: "text")` because a reader could not otherwise see what had been renamed. A `query` reintroduces that gap in a new place, and `no match` against a name that plainly exists is mysterious in exactly the same way:

```
#2  "Longmenhao Old Street" (searched: 龙门浩老街)  (source 1, 02:58) - no match
```

Shown only when a query is present and differs from the name, so nothing changes for a mention without one.

### 6. `--query=` empty is rejected.

`Number("")` is not the trap here, but the shape is identical: an empty query would search for the empty string and return whatever the box happens to contain. F5's fourth appearance across the project, and by this point it should be assumed rather than rediscovered.

## Data model — migration 11

```sql
ALTER TABLE mentions ADD COLUMN query TEXT;
```

NULL means "search by the name", which is what every existing row means. No default of `''`: an empty string and an absent one are different facts here, and `''` is a value this column must never hold.

No change to `segments`. The fix is that two strings stop sharing one field, not that a new one is stored on the result.

## Command surface

```
trip watch ingest --mentions=<file.json>      # entries may carry "query"
trip review resolve <id> --rename="Longmenhao Old Street" --query="龙门浩老街"
trip review resolve <id> --query="李子坝"      # re-search, keep the name
```

```json
{"text": "Longmenhao Old Street", "query": "龙门浩老街", "at": "02:58", "kind": "street"}
```

`--rename` keeps the meaning it already has — the readable name — and `--query` is the new concept, mapping one-to-one onto the file's field. The alternative considered and rejected was `--rename=<search> --as=<display>`, which makes `--rename` mean different things depending on whether a sibling flag is present. A flag that changes meaning based on its neighbours is what M4's per-subcommand validation exists to eliminate.

Declared per-subcommand in `COMMAND_FLAGS` under `review resolve`, with its own `SUBCOMMAND_HELP` entry.

## The agent contract

One optional field, `query`, documented alongside `kind` and `price`:

> **`query`** — the string to look the place up by, when that differs from what you want to call it. Chinese place names frequently geocode where their English names do not: `龙门浩老街` returns a result and `Longmenhao Old Street` returns nothing. Absent means look it up by its name.
>
> Do not reach for it reflexively. `十八梯` returns five candidates where `Shibati` returns two, so a local-script query can make a place *more* ambiguous and *more* likely to queue.

M6's contract note already tells the extractor to correct ASR errors in `text`. That instruction quietly redefined `text` from M3's "the name as the video said it" to "the corrected, readable name", and M7 depends on that reading. **The M3 wording is corrected in place** rather than left to contradict two later milestones.

## Carried debt paid here

**The rename collapse** — the defect above. Not previously known because nothing had ever renamed across scripts.

**M3's `text` definition**, now three milestones stale.

## Testing

**The recovery, end to end.** A mention carrying `query: "龙门浩老街"` and `text: "Longmenhao Old Street"` produces a segment named `Longmenhao Old Street` with `localName` from OSM — asserted against a captured response, so it replays.

**The collapse cannot recur**, asserted on **both** resolution paths. A rename whose string equals OSM's local name still leaves a readable display name.

**Absent `query` changes nothing.** The M6 acceptance numbers — 1 of 11 raw, 4 of 11 corrected — must be untouched. This is the test that proves decision 2, and it is the one most likely to be skipped because it asserts an absence.

**`--query` with `--pick` is refused**, and `--query` with `--rename` is accepted. The mutual-exclusion rule has four shapes and all four are asserted.

**The queue shows the query**, and shows nothing extra when there is none.

**A mutation sweep**, reported as mutation → tests killed, including: *the geocode ignores `query`*; *`query` overwrites the display name*; *the empty query is accepted*; *`--query` is silently ignored beside `--pick`*. Each mutation must be proven to have landed before its kill count is recorded — M6's sweep produced a false zero from a substitution that never applied, and a zero meaning "never ran" is indistinguishable from a zero meaning "unguarded".

## Out of scope

**Identifying places from frames automatically.** M7 measured that frames carry evidence of very different confidence — near-certain for Liziba, a guess for the skywalk, a name only for the hot pot. Nothing here automates the recognition and no claim is made that it works. That was the milestone's original premise and it is the smaller half of what was found.

**Querying in both scripts and merging.** Decision 3, rejected on measurement rather than deferred.

**Inferring the local-script name.** Same.

**`cost_bands` and `trip budget`** — parked since M2, and now holding exactly one real data point.

**`trip export`** — still never scoped. The plan cannot leave the terminal, which becomes more pointed once its names are readable again.

**Routing, Turso sync** — unchanged from M3–M6.

## Appendix — captured evidence, 2026-07-27

The local-script table above, run against `viewbox(centre, 25)` around 29.56026, 106.55771 with `bounded=1&limit=5&addressdetails=1` — identical to `geocodePoi`, per M6's governing principle.

Two frames kept as evidence in `test/fixtures/m7-chongqing/`: the Liziba monorail, and the air-raid-shelter signage that carries 防空洞老火锅 and started this.

**What is not established.** One video, one city, one language pair, and every local-script name was supplied by an agent that already knew the place. Nothing here measures an extractor working blind, and the two-of-five recovery rate is a count, not a rate.

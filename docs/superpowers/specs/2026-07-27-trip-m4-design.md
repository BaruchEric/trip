# M4 — plausibility, and the last of M3's debt

*Brainstormed with Eric, 2026-07-27. Scoped to M4 only. M3 shipped the review queue; this milestone answers the one failure M3 measured and could not catch.*

## Objective

A geocode result that is unique but *wrong* stops becoming a confident segment.

The milestone is done when `Jiefangbei Pedestrian Street` — the single wrong match in M3's acceptance run — lands in the review queue with its reason stated, while all three correct matches from that same run still bypass review.

## Governing principle

**Absence is loud**, unchanged from M1–M3. M4 adds a second principle that governs every choice below:

**A check that cannot be sure says nothing.** Where this design lacks knowledge — an OSM type it has no family for, a mention with no declared kind — it passes the result through rather than guessing. Incompleteness must degrade to M3's behaviour, never to a queued correct match. A false positive spends a human's attention and teaches them to distrust the queue; a false negative leaves them exactly where M3 already left them.

## What M3 measured

Decision 3 of the M3 record set confidence as uniqueness: exactly one result inside the 25 km box becomes a segment. The acceptance run produced four confident matches and **one of them was wrong** — `Jiefangbei Pedestrian Street` returned one result, `你好酒店(重庆解放碑步行街店)`, a `tourism=hotel` whose name merely *contains* the street's name.

Re-queried 2026-07-27 while scoping this milestone (full output in the appendix):

| Query | OSM result | M3 verdict |
|---|---|---|
| `Luohan Temple` | `amenity/place_of_worship` | correct |
| `Hongya Cave` | `building/yes` — **see the correction below** | correct |
| `Ring Shopping Park` | **0 results** | ~~recorded correct; does not reproduce~~ — **wrong, see the appendix correction** |
| `Jiefangbei Pedestrian Street` | `tourism/hotel` | **wrong** |

**Correction, made during implementation.** That scoping query omitted `addressdetails=1`, which `geocodePoi` sends. With it, Nominatim reports **the same OSM object** — `way/939578294` — as **`tourism/attraction`**, not `building/yes`. Verified both ways against the live API and captured in `test/fixtures/nominatim-hongya-cave.json`.

The argument below is unchanged and in fact strengthened: `tourism/attraction` is a catch-all in exactly the way `building/yes` is, and it is what `trip` *actually* sees for a correct match. Filing it under `culture` — which the first draft of the family map did — would have mis-flagged a real result in live use rather than only in theory.

Two things follow, and both shaped the design.

**The obvious mechanism is a false-positive machine.** The M3 appendix sketched M4's answer as "a query naming a street, park or temple that matches `tourism=hotel` is a type mismatch." Read as *expect the category to match the noun*, that rule queues **Hongya Cave** — `building/yes` is OSM's catch-all for "a building is here and we know nothing more", and no cave-shaped expectation matches it. One of the three correct results would have been flagged. The rule had to be rebuilt around positive contradiction only, and that is decision 3 below.

**The evidence base is three points, not four.** *(Corrected 2026-07-27 by M6: it is four. The paragraph below is left standing because being wrong in a recorded way is the point. See the appendix.)*

 `Ring Shopping Park` appears nowhere in this repository but one sentence of M3 prose — no fixture, no ledger entry, no captured response — and returns nothing today. M3's testing section states that fixtures are captured real output; the acceptance run's per-query responses were never among them. That gap is closed in this milestone's testing section. The remaining evidence is thin and is *stated as thin*: one true failure out of three reproducible points is enough to justify a conservative check and not enough to justify a clever one.

## Decisions

### 1. Uniqueness stands. Plausibility only demotes.

Decision 3 of M3 is not replaced, re-tuned, or thresholded. M4 adds one demotion on top of it:

```
n == 1  and  a positive contradiction is found  ->  queued
n == 1  otherwise                               ->  confident, as today
n == 0  or  n >= 2                              ->  queued, as today
```

**The check runs only on the single-result path.** Two-plus results are already queued by uniqueness, so a contradiction there changes no outcome; zero results are already queued. Confining it to n == 1 keeps the new logic to the one case that can produce a wrong segment, and leaves M3's measured behaviour intact everywhere else.

The evidence against the alternatives still holds and is not revisited: an importance floor would queue every Chongqing restaurant (all score 0.0001), and name similarity would queue correct cross-script matches (洪崖洞 for "Hongya Cave").

### 2. The extractor declares the expected type. `trip` does not infer it.

The mentions contract gains an optional `kind`. `trip` compares it against the result's OSM tagging; it never parses the mention text to guess what kind of place it is.

This is decision 1 of M3 applied unchanged — the judgement is Claude's, the deterministic comparison is the binary's. The alternative, a keyword table inside `trip` mapping English nouns to categories, was rejected on three counts: it is a hand-maintained English list in a tool built for videos about places whose names are not English; it fails on any bare proper noun (`Hongya Cave` names no type, `Jiefangbei` alone names none either); and it puts a judgement call in the one part of the system whose whole purpose is to be deterministic and testable.

The agent is already reading the transcript and already proposing `dwell` and `tags`. Declaring "this is a street" is strictly less work than estimating how long you would spend there.

### 3. Comparison is by family, and an unmapped type is uninformative.

This is the decision the measured evidence forced, and the one that keeps Hongya Cave confident.

```
OSM category/type  ->  family          (one of eleven, below)
kind               ->  acceptable families
```

**A contradiction requires the result's family to be known and outside the kind's acceptable set.** An OSM type absent from the family map has no family, and a result with no family never contradicts anything.

The rejected alternative is a per-kind allow-list of OSM *types*. Every type it failed to list would read as a contradiction, so its errors would be false positives — the exact failure the governing principle forbids. Under the family map the arithmetic runs the other way: an unmapped type is silently compatible with everything, so an incomplete map yields false negatives, which is M3's status quo. **The direction of the failure is the whole reason for the family layer.**

It also makes `building/yes` structural rather than special. It is not on an exemption list; it simply has no family, along with `place/*` and every other OSM catch-all.

**The family map.** Eleven families, and any `category/type` not named here is uninformative:

| Family | OSM `category/type` |
|---|---|
| `lodging` | `tourism/hotel`, `tourism/hostel`, `tourism/guest_house`, `tourism/motel`, `tourism/apartment` |
| `food` | `amenity/restaurant`, `amenity/cafe`, `amenity/fast_food`, `amenity/bar`, `amenity/pub`, `amenity/food_court`, `amenity/ice_cream` |
| `retail` | every `shop/*`, `amenity/marketplace` |
| `worship` | `amenity/place_of_worship`, `historic/wayside_shrine` |
| `transport` | `railway/station`, `railway/halt`, `railway/subway_entrance`, `amenity/bus_station`, `amenity/ferry_terminal`, `aeroway/aerodrome`, every `public_transport/*` |
| `greenspace` | `leisure/park`, `leisure/garden`, `leisure/nature_reserve` |
| `culture` | `tourism/museum`, `tourism/gallery`, `tourism/artwork`, `historic/monument`, `historic/memorial`, `historic/castle`, `amenity/theatre`, `amenity/arts_centre` |
| `road` | every `highway/*`, `place/square` |
| `water` | `natural/water`, `natural/bay`, `waterway/river` |
| `natural` | `natural/peak`, `natural/cave_entrance`, `natural/cliff`, `natural/beach`, `natural/volcano` |
| `civic` | `amenity/university`, `amenity/hospital`, `amenity/townhall`, `amenity/library` |

**`tourism/attraction` is deliberately absent from that map.** It is the same trap as `building/yes` wearing a more specific-looking name: it records *that* a place draws visitors, not *what kind* of place it is. OSM applies it to scenic areas, pedestrian streets, temples and stations alike — Liziba Station, from M3's own evidence, is exactly the sort of place tagged this way. Filed under `culture` it would contradict `park`, `street`, `station`, `nature`, `viewpoint` and `neighbourhood`, flagging correct matches in six of thirteen kinds. Unmapped, it contradicts nothing. Any OSM type whose meaning is "notable" rather than "of this type" belongs outside the map for the same reason.

**The kind vocabulary is closed**, so the compatibility table is finite and fully testable:

| `kind` | Acceptable families |
|---|---|
| `street` | `road` |
| `temple` | `worship`, `culture` |
| `park` | `greenspace`, `natural` |
| `museum` | `culture` |
| `station` | `transport` |
| `restaurant` | `food` |
| `market` | `retail`, `food` |
| `shop` | `retail` |
| `hotel` | `lodging` |
| `viewpoint` | `natural`, `greenspace`, `culture` |
| `nature` | `natural`, `greenspace`, `water` |
| `neighbourhood` | `road` |
| `landmark` | everything **except** `lodging`, `food`, `retail` |

`landmark` is the deliberate escape hatch for a place whose type the extractor cannot name — the Hongya Cave case. It excludes exactly the three commercial families, because those are where a lone name-containment match is most often wrong. Note that it would have caught Jiefangbei too: had the extractor said `landmark` rather than `street`, `lodging` is still excluded. The check does not depend on the agent choosing the single most precise kind.

**A precise kind is checked more strictly than a vague one, and that is the intended asymmetry.** `park` accepts two families; `landmark` accepts eight. So an extractor that declared `landmark` for everything would weaken the check toward silence. This is accepted rather than engineered around, for the same reason the family map defaults to permissive: a precise declaration is a stronger claim, and a stronger claim can be contradicted by more evidence. Under-declaring costs coverage, never correctness.

Two things bound the downside. Omitting `kind` altogether is **not** the cheaper dodge — the denylist then covers `lodging` and `retail` anyway, so `landmark` is in fact *stricter* than silence, catching `food` on top. And the extractor is a cooperating agent reading a transcript in good faith, not an adversary optimising to avoid the queue. The contract therefore asks for the most precise kind the extractor is confident in, and says plainly that a vaguer one is safe but buys less.

**An unrecognised `kind` is a malformed entry**, rejected with its index and reason while the rest of the file ingests, exactly as the contract already handles a bad `at` or `dwell`. Silently ignoring it would let one typo disable the check with no signal — against "absence is loud".

### 4. The denylist fires only when no `kind` was declared.

A second, independent trigger covers mentions the extractor left unlabelled: a lone result in family `lodging` or `retail` is queued with no kind to compare against.

**Precedence is explicit.** A declared, compatible kind wins outright. `{"text": "Hello Hotel", "kind": "hotel"}` matching `tourism/hotel` stays confident — otherwise the denylist would flag a video that genuinely recommends a hotel, rebuilding the weakness that argued against a denylist-only design in the first place.

The list is `lodging` and `retail` only. `food` is excluded deliberately: a travel video recommending one specific restaurant by name is the ordinary case, not a suspicious one.

### 5. A demoted result keeps its candidate. The reviewer can accept it.

The demoted result is written to `mention_candidates` as rank 1, exactly as an ambiguous mention's candidates are. `trip review resolve <id> --pick=1` accepts it and creates the segment.

This is not a detail. A check with a false-positive rate above zero — which this one has, by construction — must leave the human a one-command path to say "no, that is right". Without it, every false positive costs a `--rename` and a re-geocode, and the check becomes a tax rather than a safeguard.

**The renderer already handles this and needs no change — verified, not assumed.** M4 creates a mention state M3 never produced: a `reason` *and* a candidate. In M3 those were disjoint, candidates meaning ambiguous and a reason meaning no match, so a renderer that branched on `reason` would print the reason and hide the candidate, leaving `--pick=1` technically available and invisible. `src/render-review.ts:27` branches on `candidates.length`, so a demoted mention renders its reason on the header line and its rank-1 candidate with the `--pick=1` hint beneath. Recorded here so the plan does not add a task for work that is already correct — and covered by a test below, since nothing currently forces it to stay that way.

The reason strings state which gate fired:

```
type mismatch: expected street, got tourism/hotel
unverified type: tourism/hotel, no kind declared
```

### 6. `kind` persists on the mention, and `--rename` re-runs the check.

`review resolve --rename` re-geocodes against the corrected name. The plausibility check runs on that new result too, using the kind already on the mention row.

Were `kind` merely an ingest-time parameter, `--rename` would be a documented bypass: every corrected mention would skip the check and resolve on uniqueness alone. That is why this is a schema column rather than a value threaded through a function call.

### 7. Midnight canonicalizes on 1440.

`--hours=10:00-24:00` stores 1439 at the CLI while direct callers and the test suite pass 1440, and both mean "closes at midnight". The dual spelling is resolved in favour of **1440**.

The codebase's own arithmetic already agrees: `plan/order.ts:18` calls a day 1440 minutes, `commands/plan.ts:160` tests day overflow at `>= 1440`, and `segments.ts:93` already bounds `closesMin` at 1440. The CLI's `commands/segments.ts:78` is the lone dissenter, and it is the line that moves:

```diff
-  closesMin = to === "24:00" ? 1439 : parseClock(to);
+  closesMin = to === "24:00" ? 1440 : parseClock(to);
```

This direction is chosen because it is the one that **keeps a passing M2 test passing**. `test/segments.test.ts:155` already asserts 1440 is accepted; the M3 record identified narrowing the bound to 1439 as the move that breaks it. Exactly one test changes: `test/commands-segments.test.ts:39`, 1439 → 1440.

It also closes a real defect. `plan/schedule.ts:53` rejects a placement when `start + dwell > closesMin`, so a segment ending exactly at midnight is currently refused by one minute at a place the user said closes at midnight. And `10:00-24:00` now renders back as `10:00-24:00` rather than `10:00-23:59` — the CLI stops restating the user's input as something they did not type.

`parseClock` continues to reject `24:00` (it bounds hours at 23); the special case in the CLI is why that has never surfaced, and it remains the single place the string is understood.

## Data model — migration 7

```sql
-- NULL means the extractor declared no kind. Not ''. A mention with no declared
-- kind is checked by the denylist (decision 4) instead, and the two cases are
-- distinguishable only if this stays NULL.
ALTER TABLE mentions ADD COLUMN kind TEXT;
```

One column. `BASE_SCHEMA` is frozen; this is migration 7, appended to `MIGRATIONS` and guarded by a `hasColumn` check like 4, 5 and 6. **Eric's live DB is at v6; back it up before running**, as M3 said of v5.

**`kind` is not `tags`.** `tags` is user-facing categorisation that flows into `segments.tags` and is read by the planner. `kind` is a geocode-verification input: consumed by the classifier, never rendered, never copied to a segment. Two fields, two consumers, no overlap. They are adjacent enough in the contract that this is stated here rather than left for a reviewer to work out.

## Where the check lives

`classify` gains the declared kind as a **parameter** and returns a verdict, as it already does. `geocodePoi`'s return type does not change.

This is stated as a decision because the M3 ledger records a session lost to the opposite instinct: threading a new signal through `geocodePoi`'s return type cascaded into sixteen injected test fakes across three files and was abandoned. The rule that came out of it — when a change needs to cross a typed seam into many call sites, look first for a place the existing machinery already handles the case — applies directly here. `classify` already owns the verdict; the family map is a pure function beside it in `src/geo/`.

## The agent contract

Unchanged except for one optional field. **Every existing mentions file still ingests**, and that is asserted by a test.

```json
[
  {"text": "Jiefangbei Pedestrian Street", "at": "04:32", "kind": "street"},
  {"text": "Hongya Cave", "at": "07:15", "kind": "landmark", "dwell": "90m"},
  {"text": "hot pot", "at": "11:07"}
]
```

- `kind` — optional, one of the thirteen values in decision 3. Absent → no kind comparison; the denylist applies instead. Unrecognised → that entry is rejected with its index; the rest of the file ingests.

## Carried debt paid here

All three items are paid because M4 reopens them, following M3's precedent that debt is paid where the milestone lands and not as roving cleanup.

- **Per-subcommand flag validation.** `cli.ts:40-45` documents its own gap honestly: validation is keyed per top-level command, so `trip review ls --reject` passes and is silently ignored. The allowlist is re-keyed on `command + subcommand`. M4 reopens this because its contract change lands in `watch ingest` and `review resolve` — the two subcommand families that carry the gap.
- **Per-subcommand `--help`.** Falls out of the same re-keying: once the allowlist is subcommand-scoped, the help text can be too. Building the key and not using it would be the odd choice.
- **`review resolve --rename` against a malformed geocode result.** The M3 ledger deferred this as honest but untested: the call site has no try/catch, so the command aborts rather than queueing, and the mention comes out exactly as it went in. M4 stands on that call site (decision 6), so it gets its test.

## Testing

Every fix carries a regression test that fails when the fix is reverted. M3 held that line; M4 holds it.

**Unit**
- Family map, one test per gate: an unmapped type passes (`building/yes`, the Hongya Cave case); a compatible family passes (`amenity/place_of_worship` against `temple`); an incompatible informative family contradicts (`tourism/hotel` against `street`).
- `tourism/attraction` passes against `park`, `street` and `station`. It is unmapped for a stated reason, and a later contributor who "completes" the map by filing it under `culture` reintroduces false positives in six kinds — this test is what stops them.
- The check does not run at n == 0 or n >= 2 — asserted, not assumed.
- `landmark` accepts every family except `lodging`, `food`, `retail`.
- Denylist precedence: `kind: "hotel"` + `tourism/hotel` stays confident; no kind + `tourism/hotel` queues. This is the one requirement in this spec that could be read two ways, so it is tested rather than commented.
- Contract: unknown `kind` rejected with its index while its neighbours ingest; absent `kind` behaves exactly as M3 (backward compatibility, asserted directly).
- Midnight: `--hours=10:00-24:00` stores 1440, renders `10:00-24:00`, and permits a placement ending at 1440.

**Cross-command consistency** — the tests that actually find seam bugs, per the M2 and M3 lessons
- A demoted mention appears in `review ls` with its reason **and its rank-1 candidate on a visible line**, and `review resolve --pick=1` on it produces exactly one segment. The false-positive escape hatch is load-bearing (decision 5) and gets a cross-command test, not a unit test. Asserting the candidate is rendered is the point: a reason-first renderer would leave `--pick=1` working and unreachable, and that combination is one M3 could not produce.
- `--rename` on a mention with a `kind` re-runs the plausibility check: a corrected name whose result still contradicts returns to the queue rather than resolving.
- The M3 accounting identity still holds after a demotion: `seg ls --from` + `review ls` + rejected = mention count.
- `trip review ls --reject` now errors.

**Acceptance, and its fixtures**

The three reproducible Chongqing queries are captured as real Nominatim responses **committed to the tree**, and the acceptance assertion is that Jiefangbei queues while Luohan Temple and Hongya Cave do not. M3's acceptance run recorded its results in prose only, which is why one of its four data points cannot be replayed today; capturing them is a direct correction of that.

**The kinds must be assigned before any geocode result is consulted, and that ordering is part of the test.** M3's acceptance run predates `kind`, so every kind in this milestone's fixtures is assigned now, after the fact. Labelling Jiefangbei `street` *because it is known to be the failure case* would prove only that a table flags the case it was written for. The honest procedure is to assign kinds to all thirteen mentions from the transcript alone, record them, and only then run the geocoder. Anything less makes the fixture decoration rather than evidence — which is the same failure as M3's sixth wrong-reason test, where a passing assertion covered the one input size at which the bug could not appear.

`Ring Shopping Park` is recorded as unreproducible rather than restated as evidence.

**Mutation sweep** on the family map and the precedence rule. M2 saw four of five mutations survive 335 green tests, including deleting a whole scheduling pull; a lookup table with a defaulting branch is precisely the shape that hides a surviving mutant.

## Out of scope

**Traveller profile and concession pricing — the next milestone.** A trip carries its travellers' ages and concession eligibility, and costs across the compiled plan reflect them (senior and child admission, transport passes, free days). This is the useful version of "senior perks" and it is genuinely its own design: it touches `trips`, the `cost` field, and every renderer that shows a price, and it is the natural home for `cost_bands` and `trip budget`, which M3 also parked. It gets its own spec.

**`cost` finiteness in `validate()`.** Real, still unpaid, and deliberately not paid here: M4 never writes `cost`. Recorded rather than dropped.

Also unchanged from M3's out-of-scope list: `trip export`, routing (OSRM/GTFS), Turso sync, and frame-based visual identification of unnamed places.

**The truncated-result route is already closed** and is not reopened. The M3 appendix named two routes to a wrong confident match; route 2 — `parsePoiResponse` dropping an unreadable result so a two-result response presents as unique — was fixed in M3's final wave by making the parser throw and letting `ingest`'s existing per-mention catch queue it. M4 covers route 1 only. This is stated so the implementation plan does not grow a task for work already shipped.

## Appendix — captured evidence, 2026-07-27

Nominatim, `viewbox=106.35,29.65,106.65,29.45&bounded=1&limit=5&format=jsonv2`, re-run while scoping this milestone:

```
"Luohan Temple"                n=1  amenity/place_of_worship  rank 30  imp 0.0001  罗汉寺
"Hongya Cave"                  n=1  building/yes              rank 30  imp 0.3408  洪崖洞
"Ring Shopping Park"           n=0
"Jiefangbei Pedestrian Street" n=1  tourism/hotel             rank 30  imp 0.0001  你好酒店(重庆解放碑步行街店)
```

**This query is not the one the code makes.** It omits `addressdetails=1`. Re-run with it, as `geocodePoi` does:

```
"Hongya Cave"  without addressdetails  ->  building/yes       way/939578294  洪崖洞
"Hongya Cave"  with addressdetails=1   ->  tourism/attraction way/939578294  洪崖洞
```

Same object, different reported primary tag. The lesson generalises past this one place: **evidence gathered with a query that differs from the production query is evidence about a different question.** M3's acceptance appendix has the same shape of gap — results recorded in prose rather than captured — and M4's fixtures are captured through `parsePoiResponse` for exactly this reason.

Two findings recorded at the top of this document come from exactly this output: `building/yes` on a correct match, which killed the naive form of the check, and `Ring Shopping Park` returning nothing, which reduced M3's four-point evidence base to three.

### Corrected 2026-07-27 by M6

**This appendix has a SECOND query discrepancy, and it is the one that produced the "three of four reproduce" conclusion above.**

`Ring Shopping Park`, re-run four ways:

| viewbox | `addressdetails` | result |
|---|---|---|
| the box above | off | n=0 |
| the box above | on | n=0 |
| `viewbox(centre, 25)` | off | **n=1**, `shop/mall` way/1295738129 光环购物中心 |
| `viewbox(centre, 25)` | on | **n=1**, same object |

So it is not `addressdetails`. It is the **viewbox**. The box hand-typed above spans roughly 11.1 km of latitude and 14.5 km of longitude in half-width; `viewbox(centre, 25)` computes 25 km on both axes. The mall lies between the two.

**All four of M3's points reproduce** through the query the code actually makes. The place is real, it is in the video at 17:20, and M6's first end-to-end run geocoded it on the first attempt with no rename.

The lesson this appendix drew is right and was applied too narrowly. Corrected: **one fixed parameter is not the same as a query that matches production.** Checking `addressdetails` and leaving the viewbox hand-written reproduced the very error the paragraph above was written to warn about.

Both `Luohan Temple` and `Jiefangbei Pedestrian Street` score `importance` 0.0001 — one correct, one wrong. A further reminder, if one were needed, that decision 3 of M3 was right to refuse an importance threshold.

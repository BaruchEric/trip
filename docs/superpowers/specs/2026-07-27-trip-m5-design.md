# M5 — the traveller profile, and the price of the plan

*Brainstormed with Eric, 2026-07-27. Scoped to M5 only. M4 parked "senior perks" as needing its own milestone; this is that milestone, and it turns out to be the one where `cost` stops being write-only.*

## Objective

The plan knows who is travelling, and says what it costs them.

The milestone is done when a trip carrying three travellers of different ages compiles a plan whose days state a party total, whose `trip day` states what each traveller pays, and where every place with no stated price is counted as **unknown** rather than as free.

## Governing principle

**Absence is loud**, unchanged from M1–M4, and this milestone is where it is easiest to violate: an unpriced segment reads as `0` under any implementation that is not deliberate about it, and a total that quietly omits four unknown places is indistinguishable from a total that knows everything.

**A check that cannot be sure says nothing**, M4's addition, governs the rule matcher directly. Where a segment's rules do not cover a traveller, the answer is *unknown*, never the nearest available number.

Both converge on one sentence that the implementation should be read against: **no arithmetic in this milestone may produce a number that is more confident than its inputs.**

## What the code does today

Two findings from reading the code before designing, both of which shaped the scope.

**`cost` is write-only.** `segments.cost REAL` is written by `seg add --cost=25`, round-tripped through `Segment.cost`, and rendered **nowhere** — not in `renderSegmentList`, not in `renderDay`, not in `render-review.ts`. The only way to read a price back out of `trip` today is `--json`. Both programmatic writers, `watch/ingest.ts:251` and `commands/review.ts:211`, hardcode `cost: null`. So no price has ever entered the system except by hand, and none has ever been displayed.

This is why concession pricing could not be built alone. A second price band on a field nothing renders is a second floor over a missing first one.

**Two trip columns are unwritable, and two others are parked, and they are not the same case.**

- `mode` and `pace` are read as fallbacks by `commands/plan.ts:97-98`, but no command writes them. They are defaults nobody can change.
- `lodging_tier` and `food_tier` are printed by `trip show` and read nowhere else. The temptation is to call them dead and drop them. They are not dead: `mid`/`casual` are exactly the inputs `cost_bands` would consume, and `cost_bands` is parked, not abandoned. **M5 leaves them alone.** Debt is paid because the milestone reopens it; this milestone reopens `trips`, but it does not reopen lodging or food.

## Decisions

### 1. A traveller is a label and a birth date. Age is derived, never stored.

`travellers` rows carry `birth_date TEXT NOT NULL`. Age is computed as completed years between that date and the date of the day the plan visits.

`birth_date` is NOT NULL because a nullable one would have to mean something at match time, and the only available meaning is "adult" — a guess wearing the costume of a fact, which is the shape of defect this repo has now hit three times (the zero-filled climate month, the 0,0 coordinate, the null-as-midnight opening hour). A traveller whose birth date is unknown is not a traveller this feature can price, and the honest response is to refuse the row, not to invent an age for it.

Storing an age instead was considered and rejected: an age is a claim about a date nobody recorded. A `64` written while planning is a `65` by the trip, and the row cannot tell you which.

### 2. Prices belong to the venue, expressed as age ranges.

A price rule is `(min_age, max_age, price)`. The grammar has three forms and no shell metacharacters:

```
--price=30            unbounded base: min NULL, max NULL
--price=60-64:15      bounded both ways
--price=65+:0         min 65, no max
```

Under-six-free is `0-5:0`. Ages are non-negative, so the existing `N-M` form already expresses it; a `<6` spelling was rejected because `<` is a zsh metacharacter anywhere in an unquoted word, so `--price=<6:0` would need quoting to survive the shell at all.

**The unbounded rule is a fallback, not a peer.** A bounded rule wins over it; the base applies only where no bounded rule matches. At most one unbounded rule is permitted per owner, and a second is an error.

This carve-out is load-bearing and was very nearly missed. Overlap rejection (below) compares *bounded* rules only — an unbounded rule overlaps every possible age by definition, so a uniform overlap check would reject `--price=30 --price=65+:0`, which is the most common rule set the grammar has and the one used in every example in this document. Among bounded rules there is no precedence and no most-specific-wins: two rules that both match some age are an error, because that is genuine ambiguity rather than a stated default.

The alternative — three fixed bands (`--adult`, `--senior`, `--child`) with thresholds stored on the trip — was rejected on a concrete case. Chinese sites routinely charge half price at 60 and nothing at 65; that is two senior bands and the fixed model has one. More fundamentally it puts the threshold on the traveller's trip when the threshold belongs to the venue: senior is 60 in China, 65 across much of Europe, 62 for US national parks, and the next museum in the same city sets its own. A trip-level threshold would be a claim the trip has no way to check.

### 3. Unknown is the absence of a row. A traveller who matches no rule is unknown.

`price REAL NOT NULL`. There is no NULL price, because a NULL price is a row asserting that a price exists while refusing to say what it is. Unknown is expressed by there being no row.

The consequence that matters: **a segment carrying only `65+:0` says seniors are free and says nothing whatsoever about anyone else.** An adult at that segment is unknown, not 30, not 0, not the base rate from some other segment. This is decision 3 of M4 applied to arithmetic — where the mechanism lacks knowledge it must pass through rather than guess, so incompleteness degrades to false negatives, never to confidently wrong money.

`0` is a real price, and it renders as the word `free` **on a line item**. A *total* of zero renders as the numeral: `Day 2 total  free + 2 unknown` reads as a contradiction, and a total is an arithmetic result rather than a statement about what a venue charges. `free` and `?` are different words on purpose, and no renderer may print one where it means the other.

**A segment's party total is known only if *every* traveller matched a rule.** One unmatched traveller makes the whole segment unknown, and it is counted once in the day's `+ N unknown` — as one place whose price nobody knows, not as N missing traveller-prices.

The alternative, summing the travellers who did match and quietly dropping the one who did not, produces a party total that is more confident than its inputs, which is the one thing the governing principle forbids. It is also the more tempting implementation, because it falls out of `filter(Boolean).reduce(sum)` without anyone deciding it. That makes it a mutation in the sweep, not merely a note here.

### 4. One rule table, two owners.

`price_rules` carries `owner_kind IN ('segment','pass')` and `owner_id`. A transport pass is a priced thing with age rules and a validity window; it differs from a segment in what owns it and when it is counted, not in how it is priced. Senior transit discounts then fall out of the mechanism already built for admission, and no second pricing concept enters the codebase.

### 5. A pass is counted once per eligible traveller, on its own line, and is never amortised.

Slicing a ¥45 three-day pass into ¥15 per day makes every day read as one self-contained number, which is genuinely nicer to look at and is a lie: no day costs ¥15 of pass. It is an average wearing the costume of a fact — the same shape as the zero-filled climate month that migration 3 chose to **delete rows over** rather than invent a denominator for.

So the plan reports passes beneath the day totals, one line per pass carrying its own party total, and the trip footer separates `Admission` from `Passes` before combining them into `Trip total`. Three lines rather than one, because a reader who wants to know whether the pass was worth buying needs the two figures apart.

A pass whose rules leave any traveller unmatched is unknown by the same rule as a segment, and says so rather than contributing a partial sum.

The pass's `from_day`/`to_day` are not decorative. They are validated against the trip's day count at entry — a pass naming days 8–10 on a five-day trip is rejected, naming the actual count — and `trip day N` notes which passes cover day N, without adding money to that day. When the trip has no dates and therefore no day count, the range is stored unvalidated: a check that cannot be sure says nothing.

### 6. Free days ride on the `closed_days` vocabulary.

`segments.free_days TEXT NOT NULL DEFAULT ''`, mirroring `closed_days` exactly and reusing `normalizeWeekday` — including its case folding, which exists because M3 writes segments programmatically and `"Mon"` would otherwise silently never match.

On a matching weekday every traveller pays 0 at that segment, overriding all age rules. A segment with free days and no price rules is still **unknown** on every other day: knowing a place is free on Tuesday tells you nothing about Wednesday.

A weekday listed in both `closed_days` and `free_days` is **allowed and inert**, not an error. The scheduler already refuses to place a segment on a day it is closed, so the free rule simply never fires — and a venue's own listing can genuinely say both. Rejecting the combination would refuse to record data that is real.

"First Sunday of the month" is **not** expressible and is deliberately not built. It needs a recurrence grammar, and a half-built one that silently accepts the string and matches nothing is worse than an honest refusal.

### 7. The party total is the default. `trip day` breaks it down.

`trip plan` prints a **party** price per placed segment, a party total per day, a trip total, and a passes line. `trip day N` prints the same lines and then the per-traveller breakdown, which must sum to the party total it sits under.

Every number on a `trip plan` line is a whole-party figure. Saying so explicitly is not pedantry: the first draft of the worked example below had a per-traveller breakdown that summed to ¥70 under a ¥50 day total, which is exactly the defect the headline test in this spec exists to catch, committed in the document that specifies the test.

**The breakdown and the day total must drop the same segments.** A segment whose party total is unknown is excluded wholesale — from the day total *and* from every traveller's row — and counted once in a single shared `+ N unknown`. The breakdown is then a sum, per traveller, over the segments that remain.

The alternative, propagating unknown per traveller, is the more natural-sounding rule and it breaks the milestone's headline invariant: on a day with two priced places and one unpriced one, every traveller is unknown at the unpriced place, so every row renders `?` while the day total still reads a number. The two sums agree only if both exclude the same things.

A consequence worth stating because it looks wrong at a glance: at a segment carrying only `65+:0`, the party total is unknown, so that segment leaves **Mom's** row too — even though her free admission there is perfectly well known. A row that kept it would not sum to a day total that dropped it.

Per-traveller numbers are the entire reason the profile exists, so they must be visible somewhere without a flag — otherwise a wrong birth date or a missed senior rate never announces itself. But breaking every line of a seven-day, three-traveller plan into four currency columns destroys the itinerary, which is what the command is actually for. The overview stays scannable; the detail view earns its name.

### 8. A segment's price is not knowable until it is placed.

Rules resolve against a traveller's age *on the visit date*, and an unplaced segment has no date. `seg ls` therefore shows a segment's **rules**, not a resolved party total. This is not a limitation to work around; it is the same shape as M2-2 marking segments placed blind on unknown hours.

### 9. Currency is a trip-level label, and NULL renders bare.

`trips.currency TEXT`, nullable. `Trip total 310` is a number of unknown denomination, and this milestone is the first to sum across segments. NULL renders exactly as today — bare numbers, no symbol — so nothing is invented for existing trips; set it and totals carry it. A trip has one destination, so one currency is the right cardinality.

### 10. No price is ever persisted, so nothing is ever stale.

Every displayed number is derived at render time from birth dates, rules and the day's date. Adding a traveller, removing one, correcting a birth date, or re-dating the trip changes every total on the next command and invalidates nothing. `trip who rm` needs no cascade and does not touch the plan.

A trip with **no** travellers has an unknown party, so no total can be computed. `trip plan` says so and names the fix — `add one with: trip who add <label> --born=…` — rather than printing zeros.

## Data model — migration 8

```sql
CREATE TABLE travellers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id    INTEGER NOT NULL REFERENCES trips(id),
  label      TEXT NOT NULL,
  -- YYYY-MM-DD. NOT NULL: see decision 1. A nullable birth date would have
  -- to mean "adult" at match time, and that is a guess.
  birth_date TEXT NOT NULL,
  UNIQUE (trip_id, label)
);

CREATE TABLE passes (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  trip_id  INTEGER NOT NULL REFERENCES trips(id),
  name     TEXT NOT NULL,
  from_day INTEGER NOT NULL,
  to_day   INTEGER NOT NULL
);

CREATE TABLE price_rules (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_kind TEXT NOT NULL CHECK (owner_kind IN ('segment','pass')),
  owner_id   INTEGER NOT NULL,
  -- NULL is unbounded on that side. Both NULL is the base rule.
  min_age    INTEGER,
  max_age    INTEGER,
  -- NOT NULL. 0 is a real price meaning free. UNKNOWN is the ABSENCE OF A
  -- ROW; there is deliberately no NULL price. See decision 3.
  price      REAL NOT NULL
);

ALTER TABLE segments ADD COLUMN free_days TEXT NOT NULL DEFAULT '';
ALTER TABLE trips    ADD COLUMN currency TEXT;

-- segments.cost migrates into price_rules as the unbounded rule, then goes.
INSERT INTO price_rules (owner_kind, owner_id, min_age, max_age, price)
  SELECT 'segment', id, NULL, NULL, cost FROM segments WHERE cost IS NOT NULL;
ALTER TABLE segments DROP COLUMN cost;
```

`segments.cost` is dropped rather than kept alongside, because two sources of truth for one number is how they come to disagree. `BASE_SCHEMA` is frozen and `segments` is created in migration 4, so a fresh database and an upgraded one both run 1→8 and converge on no `cost` column — which is exactly the invariant `test/db.test.ts` already asserts by comparing an upgraded database's table shapes against a fresh one.

Every step is guarded in the repo's established style (`hasColumn`), so re-running is a no-op rather than a `duplicate column name` throw. The guard is not ceremony: it is the bug migration 2's comment exists to record.

### Migration 9 — the agent contract's column

```sql
ALTER TABLE mentions ADD COLUMN price TEXT NOT NULL DEFAULT '';
```

Separate from 8 on purpose, and not merely for ordering. A mention is a record of what the *video* said; its rules have no owner until the mention resolves to a segment, and `price_rules.owner_id` is NOT NULL. So the raw rule strings live on the mention, comma-joined through `joinList` like `tags`, and become `price_rules` rows at the moment a segment exists to own them — on confident ingest, or on `review resolve --pick`.

This was missed in the first draft of this document, which specified the agent contract's `price` field and then gave a schema with nowhere to put it.

### Both migrations

`ALTER TABLE … DROP COLUMN` was **verified against this project's installed `@libsql/client`** rather than assumed — SQLite only gained it in 3.35, and the whole migration hinges on it. It works. If a future libsql downgrade breaks it, the fallback is SQLite's twelve-step table rebuild, which is a materially larger task and should be re-estimated rather than absorbed.

## Command surface

```
trip who add <label> --born=YYYY-MM-DD
trip who ls
trip who rm <label>

trip seg add <name> … --price=30 --price=65+:0 --free-days=tue
trip seg price <id> --price=…          replace a segment's rule set
trip seg ls                            shows rules, never a resolved total

trip pass add <name> --days=2-4 --price=45 --price=65+:0
trip pass ls
trip pass rm <id>

trip set --currency=CNY [--mode=transit] [--pace=relaxed]
```

`--cost=25` survives as an exact alias for a bare `--price=25`. It is documented in `USAGE`, carries its own tests including the `--cost=` empty-value rejection, and breaking it buys nothing. A test asserts both spellings produce the identical rule row.

`trip set` also gains `--mode` and `--pace`, which `plan` has read as fallbacks since M2 with nothing able to write them. This milestone adds a trip-level setter for `--currency`; shipping one that pointedly refuses to set the two settable-looking fields beside it would be worse than not having it.

Every new flag is declared per-subcommand in `COMMAND_FLAGS`, and every new subcommand gets a `SUBCOMMAND_HELP` entry — M4's machinery, used as intended.

Rendered shape:

Travellers: Eric b.1971 (55), Mom b.1949 (76), Kid b.2015 (11).
Luohan Temple `--price=10 --price=65+:0 --price=0-11:0`.
Hongya Cave `--price=20 --price=65+:0 --price=0-11:10`.
Jiefangbei has no rules.

```
$ trip plan
  Day 2  Sat 3 Oct
    09:30  Luohan Temple       90m    ¥10
    11:30  Hongya Cave         90m    ¥30
    14:00  Jiefangbei          60m      ?
    Day 2 total                       ¥40 + 1 unknown

  Admission    ¥310 + 4 unknown
  Passes       ¥90    Chongqing Metro 3-day, days 2-4
  Trip total   ¥400 + 4 unknown

$ trip day 2
  …the same lines, then:
    Eric   b.1971  age 55     ¥30
    Mom    b.1949  age 76     free
    Kid    b.2015  age 11     ¥10
                              + 1 unknown
```

The arithmetic is worked through so the example is checkable rather than decorative. Luohan is ¥10 + free + free = ¥10 for the party; Hongya is ¥20 + free + ¥10 = ¥30. Down the columns: Eric ¥30, Mom nothing, Kid ¥10 — ¥40, the day total, from both directions. Jiefangbei contributes to neither and is counted once as unknown.

## The agent contract

The mentions file gains one optional field, `price`, carrying the same grammar as the flag:

```json
{"text": "Hongya Cave", "at": "04:32", "dwell": "90m",
 "kind": "cave", "price": ["30", "65+:0"]}
```

Travel videos state admission constantly — "it's 30 yuan, free over 65" is the kind of line the transcript already carries, and the agent is already reading the text to propose `dwell` and `kind`. Without this, every price in the system is hand-typed and the mechanism idles.

Absent → no rules, which is unknown, which is correct. Malformed entries are rejected individually with their index and reason, and the rest of the file still ingests, exactly as `dwell` and `kind` behave today.

## Carried debt paid here

**`cost` finiteness in the storage-layer `validate()`.** Cut from M4 on the grounds that M4 never wrote `cost`; M5 writes prices from four paths (`seg add`, `seg price`, `pass add`, `ingest`), so it stops being theoretical. `price` must be finite and ≥ 0, enforced in `segments.ts`-adjacent storage validation rather than at the CLI, because M4's lesson is that programmatic writers bypass CLI checks entirely.

**Overlapping *bounded* rules are rejected at entry**, naming both offending rules, and a second unbounded rule is rejected likewise — same layer, same reason. Resolving an overlap between two bounded rules by precedence would make the stored rule set and the rendered price disagree, which is the M2/M3 bug shape. The unbounded base is exempt by decision 2, and that exemption is the part most likely to be "simplified" away by someone who reads only this line.

## Testing

Weighted toward what has actually caught bugs in this repo.

**Cross-command consistency, first and heaviest.** `trip day N`'s per-traveller breakdown must sum to `trip plan`'s day-N total. The trip total must equal the sum of the day totals, plus passes. Every one of M2's and M3's worst defects was found by two commands describing the same state and disagreeing, and this milestone gives them money to disagree about.

**A birthday inside the trip window.** A traveller who turns 65 on day 4 pays the adult rate on day 2 and nothing on day 6, in one compiled plan. This test fails the instant anyone caches an age anywhere in the pipeline, which is the single most likely regression in the milestone.

**Unknown never becomes zero**, asserted separately at the segment, the day, the trip total and the pass. Including the decision-3 case: a segment carrying only `65+:0` leaves the adults unknown, and the day total says `+ 2 unknown` rather than counting them free.

**`free` is not `?`.** A `0` line item renders as `free`; a missing rule renders as `?`; a `0` **total** renders as the numeral. A test asserts none of the three is ever swapped for another, because `free` and `?` are one careless `??` apart in any renderer, and a zero total is one shared helper away from claiming a whole day is free.

**The breakdown drops the same segments as the day total.** Asserted on a day holding two priced places and one unpriced one — the case where propagating unknown per traveller renders three `?` rows under a numeric day total. This is the concrete failure the invariant exists to catch, and it survived into the first draft of the implementation plan.

**Overlap rejection called programmatically**, not through the CLI — the path M4 proved is the one that bypasses validation.

**A weekday in both `closed_days` and `free_days` is accepted and changes nothing**, because the scheduler never places the segment there. The test exists so that a later contributor who "fixes the contradiction" by rejecting it discovers that the combination was deliberate.

**Migration**: a v7 database holding `segments.cost = 25` lands with exactly one unbounded rule for that segment and no `cost` column; the existing fresh-vs-upgraded shape comparison still passes; re-running migration 8 is a no-op.

**A mutation sweep**, as M4 ran, reported as a table of mutation → tests killed. Mutations must include: *unknown resolves to the base rule*; *free days do not override age rules*; *the pass is amortised*; *age is computed from today rather than the visit date*. Any of these surviving means the corresponding decision above is unguarded.

## Out of scope

**`cost_bands`.** Parked since M2, still parked, and it is a data-sourcing problem rather than a pricing-model one: where per-city cost references come from is its own design question with no evidence base yet. `lodging_tier` and `food_tier` remain in the schema untouched as its future inputs.

**`trip budget`.** A budget is a constraint loop on top of a pricing model. Building both in one milestone means tuning the loop against numbers that were themselves invented the same week.

**Non-age concessions** — student, disabled, resident, veteran. Cut by Eric during scoping. They would give the rule matcher a second match axis, and "absence is loud" would make an unset flag *unknown eligibility* rather than "no", which is a real design question deserving its own answer. Ages alone cover senior and child, which is the case that prompted the milestone.

**Recurrence grammars for free days** — see decision 6.

**Per-day pass amortisation** — see decision 5, where it is rejected on principle rather than deferred.

Unchanged from M3 and M4's lists: `trip export`, routing (OSRM/GTFS), Turso sync, and frame-based visual identification of unnamed places.

## What is not measured

Stated plainly, because M4's ledger was right that the honest summary matters more than the confident one.

M4 closed a failure that had been **measured**, against captured Nominatim responses. M5 has no equivalent. No price has ever been entered into this system, no video in the repo's evidence base has had its stated prices extracted, and the three reproducible places from M3's acceptance run carry no admission data at all.

So the acceptance criterion for this milestone is *internal consistency* — the totals agree with each other and with their inputs, and unknowns propagate — not *accuracy against a real Chongqing itinerary*. Anyone tuning the rule grammar later should gather that evidence first, the way M4 gathered fixtures before touching the family map, and should expect the same lesson: evidence gathered a different way is evidence about a different question.

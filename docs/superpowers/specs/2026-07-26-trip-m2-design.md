# trip M2 — Segments and the Day Compiler

*Brainstormed with Eric, 2026-07-26. Extends `~/Arik/dev/notes/travel-assistant-design.md`; every decision there still holds unless this document says otherwise.*

## Scope

**Plan a real trip by hand.** A segment library, trip dates, and a compiler that turns them into a day-by-day itinerary with clock times.

The milestone's test, per the design record: *prove the compiler before automating its input.* Video ingestion (M3) lands on a compiler that already works, so bad extractions have somewhere safe to fall.

**Out of scope:** `trip watch` and the review queue (M3); real routing, `cost_bands`, and `trip budget` (M4); `trip export`; Turso sync.

## What the design record already fixed

These are not re-opened here. They are listed so the compiler's shape is traceable.

| | Decision |
|---|---|
| 3 | Objective is **elapsed travel time**, never distance and never discomfort. The scorer does physics; Claude does taste. |
| 2 | Walking volume is not a penalty. Heat picks the season only — the day plan never reasons about sun. |
| 7 | Segments are durable, placements disposable. `replan` discards placements, never touches the segment library, never overrides pins. |
| 9 | `--mode walking|transit` is per trip. |
| 10 | `--pace easy|normal|packed` sets the segments-per-day ceiling (≈3/5/7) and does **not** cap walking distance. |

## Decisions made in this session

### M2-1. `trip plan` produces one itinerary, and pins steer it

`plan` writes a single best plan to `placements`. Taste enters through `pin` + `replan`, not by choosing among candidates.

Rejected: emitting top-N candidate day shapes for Claude to select. It is the more literal reading of decision 3, but it doubles the command surface and introduces a candidate-id noun nothing else in the CLI has. `replan` already exists to make steering safe, and it was designed to be run twenty times.

### M2-2. Unknown opening hours never block scheduling, and are always reported

A segment with no hours is scheduled freely and marked in the output. The plan states how many segments were placed without hours data.

Rejected: defaulting a window by tag (museum 10–18, food 12–22). A guessed window is indistinguishable from a verified one, which is exactly how a zero-filled climate month scored 79 and outranked real destinations. Also rejected: requiring `--hours` at `seg add`, which turns adding a segment into a research task and will hurt most when M3 starts adding fourteen at a time.

**This is the milestone's governing principle:** absence is explicit and loud; the compiler never invents a fact to make output look complete.

### M2-3. Day budgets come from a trip-wide window with explicit ends

One `--day-window` per trip, default `09:00-19:00`. `dates set` optionally takes `--arrive` and `--depart`, which shorten the first and last day. Without them, every day is treated as full and the plan says so.

Rejected: an automatic half-day heuristic on both ends. It is right more often than not, but it guesses at real flights and a wrong guess is invisible — the same failure mode as M2-2. Also rejected: per-day windows, which add a configuration surface most days never need.

### M2-4. Global geographic clustering; pins provide stability

Segments are clustered into N groups for N days. Adding a segment can rebalance every day. That is accepted: the compiler is a pure function of its inputs, so the same inputs always give the same plan, and pins hold anything that must not move.

Rejected: greedy day-by-day filling, which is stable under edits but turns the last day into a leftover bin of whatever is geographically scattered. Also rejected: stickiness biased toward the previous plan — it reads the compiler's own prior output, so `plan` stops being a pure function of the segment library.

### M2-5. Meal spacing is a soft pull, not a reserved gap

Ordering prefers to land `food`-tagged segments near 12:30 and 19:30. If no food segments exist, nothing is reserved and the day packs normally.

The two meal windows are fixed constants in M2, not configurable. They earn a flag when Eric wants different ones, not before.

Rejected: always holding meal gaps open, which spends ~2h of every day on something Eric may prefer to handle ad hoc. Also rejected: dropping meal spacing entirely, which leaves decision 3's scorer list unimplemented when a soft penalty costs almost nothing.

### M2-6. `trip when <city>` attaches the destination to the active trip

`trips.destination_id` has been null since M1 because nothing made the relationship meaningful. `dates set` does: the compiler needs coordinates to plan against. When a trip is active, `when` sets it.

### M2-7. Coordinates are optional at `seg add`, required for placement

A segment without `--at` is accepted and lands unplaced, visible via `seg ls --unplaced`. Forcing a lat/lon lookup at add time is the same research-tax rejected in M2-2.

### M2-8. No `days` table

Decision 7 lists `days` + `placements`. This spec stores only `placements`, carrying `day_number`.

A day's window is fully derived from trip dates, arrival/departure, and the day window. Storing it creates a second copy that can disagree with the first. If per-day overrides ever land, `days` becomes a table then — cheap, now that numbered migrations work.

## Command surface

```
trip dates set 2027-05-08..05-16 [--arrive 15:30] [--depart 11:00]
                                 [--day-window 09:00-19:00]

trip seg add "Time Out Market" --dur 90m [--cost 25] [--tag food]
                               [--at 38.707,-9.145]
                               [--hours 10:00-24:00] [--closed mon]
trip seg ls [--tag food] [--unplaced]
trip seg rm <id>

trip plan [--mode walking|transit] [--pace easy|normal|packed]
trip day <n>
trip pin <seg> --day 2 --at 13:00
trip unpin <seg>
trip move <seg> --to day4
trip replan
```

`plan` and `replan` are the same operation; `plan` is simply the first run.

**`move` pins.** Moving a segment to another day and leaving it unpinned would mean the next `replan` silently undoes the move — a baffling result. `move <seg> --to day4` is therefore `pin <seg> --day 4` without a time: the day is fixed, the time is still the compiler's to choose. `unpin` is how you hand a segment back.

Every command takes `--json`. Every command returns a string — `cli.ts` remains the only file that prints or exits, and the only file that knows about exit codes.

## The compiler

A pure function. No I/O, no DB, no network, no LLM:

```
compile(segments, days, opts) -> { placements, unplaced }
```

**Deterministic throughout — no RNG anywhere.** `Math.random` in the clustering seed would make plans unreproducible and the determinism test unwritable.

### Stages

1. **Anchor pins.** Pinned segments are placed at their fixed day and time. Everything else routes around them.
2. **Cluster.** Remaining segments into N geographic groups, N = number of days. Farthest-point seeding (deterministic, unlike k-means++), nearest-centroid assignment, then rebalance any over-capacity group into its nearest under-capacity neighbour.
3. **Assign clusters to days.** Sort clusters by time required and days by time available, then match largest to largest. This is what stops a 3h30 arrival day from receiving the Sintra day trip.
4. **Order within each day.** Objective is elapsed transit time. At `--pace packed` a day holds 7 segments, so brute force is 5040 permutations: **exact optimal for n ≤ 8**, nearest-neighbour + 2-opt above that. Food-tagged segments carry a soft penalty proportional to distance from the nearest meal window.
5. **Lay down clock times.** Walk the order from the day's start, accumulating dwell + travel. A segment with known hours landing outside them shifts later within the day; if it still does not fit, it drops to unplaced with a reason.

### Capacity

Two independent limits, whichever binds first:

- **Pace ceiling** — exactly 3 (`easy`), 5 (`normal`), 7 (`packed`) segments per day. Pinned segments count against it.
- **Time budget** — the day's window. A packed day of three four-hour segments is full at three.

### Travel time

Straight-line distance times a mode factor, per decision 9:

- **walking** — 4.5 km/h, 1.3 detour factor
- **transit** — 18 km/h, 1.2 detour factor, plus a fixed 6-minute access penalty per hop

These are placeholder constants. M4 replaces them wholesale with OSRM / GTFS-Transitland. They live in one file that says so.

### Nothing is silently dropped

Every unplaced segment carries a reason: `no coordinates`, `no day had room`, `closed during every available window`. `plan` reports the count; `seg ls --unplaced` lists them.

Being absent from the output is never how a segment's absence is discovered.

## Schema — migration 4

`BASE_SCHEMA` stays frozen. This is a numbered migration step, per the convention established when schema versioning landed.

- **`segments`** — `id`, `trip_id`, `name`, `latitude`, `longitude`, `dwell_minutes`, `cost`, `tags`, `opens`, `closes`, `closed_days`, `status` (default `'confirmed'`)
  - `tags` and `closed_days` are comma-separated strings, not a join table. Free-form, single-user, and never queried relationally in M2 — `--tag food` is a substring match. A join table is the right call the moment tags need their own attributes; they do not yet.
  - `latitude`/`longitude` are nullable (M2-7). `opens`/`closes` are nullable, and NULL means *unknown*, never *always open* — the distinction M2-2 rests on.
- **`placements`** — `segment_id`, `day_number`, `ordinal`, `start_time`, `pinned`
- **`trips`** gains `arrival_time`, `departure_time`, `day_start`, `day_end`

`status` exists now because M3 needs `review` and `rejected`; hand-added segments are `confirmed`. Provenance columns (`source_id`, `confidence`) are deferred to M3, when there is something to store in them.

## Error handling

Every failure travels the existing `{"error": …}` envelope and names the missing prerequisite:

- `plan` with no dates set
- `plan` with no destination attached
- `plan` with zero placeable segments
- `pin` to a day outside the trip's range
- `seg add` with an unparseable duration, time, or coordinate pair

## Testing

The compiler is pure, so this is where correctness lives.

- **Fixture in, day shapes out.** No network, no DB.
- **Determinism** — compile the same input twice, assert identical output. A reintroduced RNG fails here.
- **Partition property** — every input segment is either placed exactly once or unplaced with a reason. Never both, never neither. This is the same property that caught the vanishing-month trap in M1, and it is the single test most likely to catch a real compiler bug.
- **Pins are inviolable** — a pinned segment survives `replan` at its exact day and time across added segments, changed pace, and changed mode.
- **Capacity** — both limits bind independently: a day fills on segment count at `easy` pace, and on time with three four-hour segments.
- **Arrival day** — a short first day receives a small cluster, not the largest one.

Every fix carries a mutation-verified regression test: revert the fix, and exactly that test fails. This is the convention that made M1 trustworthy, and it is the reason seven real bugs were found in green test suites.

## Open questions

- **`cost_bands` seeding** — hand-seed a few cities Eric actually plans to visit, or source a dataset? Not blocking: `cost_bands` is M4.
- **Tag vocabulary** — free-form strings, or a fixed set? Free-form for M2; M3's extraction may argue for a controlled list.

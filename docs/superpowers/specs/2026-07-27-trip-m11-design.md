# M11 — a budget that says what it cannot tell you

*Brainstormed with Eric, 2026-07-27. Scoped to M11 only. Third of the four he
asked for with "all of it". He chose to skip `cost_bands`.*

## Objective

`trip budget` states what the trip costs from what is actually known, projects
daily costs only from an observation the user names, and is explicit about
every reason it cannot give a single number.

Done when it answers what it can, refuses what it must, says which of the two
it is doing and why, and when the two fields that have looked like settings
since M2 stop pretending to be settings.

## Governing principle

Unchanged, all of them — particularly **no arithmetic may produce a number more
confident than its inputs**, which this milestone is almost entirely about.

M11 adds one:

**A refusal must be as specific as an answer.** "Cannot compute" is not
honesty, it is a shrug. The useful form names each missing input, and — this is
the part that is easy to get backwards — **still answers whatever part it can**.
A tool that refuses wholesale when it could answer partially is making the same
error as one that guesses: both replace a precise statement with a vague one.

## M2's open question, answered after nine milestones

The M2 spec left this open: *"`cost_bands` seeding — hand-seed a few cities
Eric actually plans to visit, or source a dataset?"* It was parked at every
milestone since.

**The answer is neither, and the reasons are now measured rather than assumed:**

- **There is no free, keyless, structured source.** Numbeo returns
  `{"error":"invalid api_key= null"}`. REST Countries' relevant endpoint is
  version-broken. World Bank PPP is a price-level index, not "a hotel costs X".
  Wikivoyage has the data as **prose**, which an agent can read and this binary
  may not parse — design decision 1 keeps LLM work outside the CLI.
- **The value is already reachable.** `cost_observations` holds the Chongqing
  budget card, and `perPersonPerDay` already derives 100.25 USD from it. A
  per-destination band would duplicate most of that for one trip in one city,
  which is speculation about reuse.

So M11 builds the consumer, not the second store.

## What the data actually looks like

The only price data this project has ever held, read off a video frame in M6:

| id | label | amount | covers | per person per day |
|---|---|---|---|---|
| 1 | Transportation | 40 USD | 4d × 1p | 10.00 |
| 2 | Accommodation | 230 USD | 4d × 1p | 57.50 |
| 3 | Activities & food | 131 USD | 4d × 1p | 32.75 |
| 4 | **Total** | **401 USD** | 4d × 1p | **100.25** |

Two facts about this table drive the whole design. **Rows 1–3 and row 4
describe the same money**, so adding them double-counts by exactly the total —
M6's rule that the renderer never sums. And **it is in USD**, while a Chongqing
trip's admissions are in CNY.

## Decisions

**D1 — currencies are never added, and never converted.** No exchange rate is a
fact this tool has; rates change daily and a stale one is worse than none. When
admissions are CNY and the observation is USD, the report shows both and says
plainly that it will not combine them.

**D2 — the tool never picks which observation is the daily cost.**
`--daily=<observation-id>` names it. Without the flag the report lists every
observation with its per-person-per-day figure and selects none, stating that
they are not additive. Guessing by the label `Total` would be reading a source's
wording as a computed fact, which is exactly what M6 refused.

**D3 — a projection is labelled as one source's claim about a different trip.**
Not a "rate", not "the daily cost". The number came from someone else's four
days in the same city, and the report says so on the same line as the figure.

**D4 — partial answers are given, not withheld.** The refusal logic is per
component. If admissions are fully known, the report compares them against
`--limit` and separately says daily costs are unaccounted for. It refuses only
the specific combination it cannot do. This is the principle above, and it is
the failure mode most likely to be introduced by someone tightening the code.

**D5 — `--daily` pointing at an observation with unknown coverage is an error.**
`perPersonPerDay` returns null when either axis is unknown, and a projection
from null must not silently become nothing. It names the reason and the fix.

**D6 — the traveller multiplication is an assumption, and is stated.** Reporting
`100.25 × 3 days × 2 travellers` assumes both travellers cost the same per day.
The observation covered one person and says nothing about a second. That is
arithmetic reaching past its input in the M5 sense, so the line carries the
assumption rather than letting the multiplication imply it was derived.

**D7 — `lodging_tier` and `food_tier` are dropped.** They have been in
`BASE_SCHEMA` since M2 with defaults `mid` and `casual`, are displayed by
`trip show` under headings `Lodging:` and `Food:`, cannot be set by any command,
and are read by no computation. They are the placeholder for the `cost_bands`
that is now formally not being built.

**Shown as configuration, changeable by nothing, affecting nothing** — a small
lie the tool has told since M2, and this is the milestone that decides their
fate. Migration 13 drops them; `src/trips.ts` and `src/commands/trips.ts` change
in the same commit, because the SELECT list names both columns and breaks the
moment they are gone.

`ALTER TABLE trips DROP COLUMN` was verified against a real v12 database with
trip and segment rows before this was written: it succeeds, and the rows
survive. `BASE_SCHEMA` stays frozen and still creates them, so a v0 database
creates-then-drops, which is ordinary migration history.

## Command surface

```
trip budget                  What the trip costs, and what is unknown
    --limit=<amount>         Compare against a budget, in the trip's currency
    --daily=<observation-id> Project daily costs from one recorded observation
```

With nothing selected:

```
chongqing - 3 days, 2 travellers, CNY

ADMISSIONS (from your plan)
  known                    10 CNY
  unknown                  4 segments have no price recorded

DAILY COSTS
  Not selected. 4 observations recorded:
    1  Transportation        40 USD  4d x 1p    10.00 per person per day
    2  Accommodation        230 USD  4d x 1p    57.50 per person per day
    3  Activities & food    131 USD  4d x 1p    32.75 per person per day
    4  Total                401 USD  4d x 1p   100.25 per person per day
  Choose one with --daily=<id>. They are NOT added together: rows 1-3 and
  row 4 describe the same money.

Nothing to compare against. Set a budget with --limit=<amount>.
```

With `--limit=500 --daily=4`:

```
DAILY COSTS
  From observation 4 "Total", source 1 at 19:29: 100.25 USD per person per day
  Projected  100.25 x 3 days x 2 travellers = 601.50 USD
  This is one source's claim about a DIFFERENT trip - four days, one person -
  and assumes your second traveller costs the same per day. It is not a rate.

AGAINST YOUR LIMIT (500 CNY)
  Admissions      10 CNY of 500     4 segments unpriced
  Daily costs     601.50 USD        NOT added: this trip is in CNY and no
                                    exchange rate is a fact this tool has.
```

Both halves are answered. Neither is combined.

## Testing

- **Never sums observations.** Asserted directly: the output must not contain
  the sum of rows 1–3, nor 401 + anything.
- **Never adds across currencies**, and says why.
- **Answers the part it can** — admissions against `--limit` even with no
  `--daily`, and with unknown segments present.
- **`--daily` on an unknown-coverage observation errors**, naming the reason.
- **The projection line carries the assumption** about the second traveller.
- **Unknown is never rendered as zero**, as everywhere else.
- **Migration 13**: a fresh database reaches v13 without the columns; a v12
  database carrying a real trip row survives the drop with its data intact;
  `trip show` no longer prints `Lodging:` or `Food:`.
- **A mutation sweep**, each proving its anchor landed, including one that sums
  the observations and one that converts currencies at a hardcoded rate.

## Out of scope

- **`cost_bands`** (answered above).
- **Currency conversion**, now and permanently, without a rate source and a
  timestamp on it.
- **Optimising a plan to fit a budget.** `trip budget` reports; it does not
  drop segments to make a number fit. That would be the tool choosing what to
  cut, which is the user's decision.
- **Lodging as a segment.** Where you sleep is not a place you visit.
- Transit (M12).

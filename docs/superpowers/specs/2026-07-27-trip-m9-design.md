# M9 — the model is not wrong everywhere, and the tool should say where

*Brainstormed with Eric, 2026-07-27. Scoped to M9 only. He asked for all four
remaining options; M9 is the first because it is pure measurement and its
results reshape the other three. The measurement is in
`2026-07-27-trip-m9-recon.md` and was run before this design, as in M6–M8.*

## Objective

The tool can say **how wrong its own travel model is in this particular city**,
from data it already has.

Done when `trip calibrate` reports the model's error against measured legs by
distance band, when it says nothing at all until legs exist, and when the
four-city measurement replays as a test from captured responses.

## Governing principle

Unchanged, all of them. M9 adds one, and it is aimed at this project's own
past conclusions rather than at its code:

**A measurement's scope is part of the measurement.** M7 and M8 each produced a
real number from a real query and then stated it as a property of the world.
Both are now known to be properties of Chongqing. Neither was wrong; both were
unbounded. A finding recorded without its scope is a finding that will be
generalised by whoever reads it next — including the person who wrote it.

## What the recon overturned

1. **M7's local-script recovery does not generalise.** Bangkok: 0 of 7 English
   names miss. Amsterdam: 0 of 7. Chongqing: 5 of 11. Local script is *more*
   ambiguous as often as less.
2. **M8's optimistic model does not generalise — it reverses.** Below both
   routers in 18 of 21 Chongqing pairs; *above* both in the majority of pairs
   in all three new cities. Decision 6's refusal to recalibrate is vindicated
   not because a tuned constant would be worse everywhere, but because **the
   sign of the error changes by city**.
3. **Directedness does generalise, and tracks terrain.** Valhalla's asymmetry
   runs 6.8 → 2.1 → 1.0 → 0.5 median minutes as terrain flattens. OSRM foot is
   exactly symmetric in all four cities.

## Decisions

**D1 — M9 changes no planning behaviour.** No constant is retuned, no schema
column added, no ordering affected. The milestone's product is a report and a
corrected record. Padding it with a behaviour change would be inventing work to
match M8's size.

**D2 — calibration compares against the router MIDPOINT, not the slower one.**
This differs deliberately from what the schedule reads. M8 decision 2 makes the
clock use the **maximum** across sources, and that is a *scheduling policy* —
it buys safety margin. Calibration asks a different question: how far is the
model from what the routers actually measured? The midpoint answers that; the
maximum would fold the safety policy into the measurement and report the model
as more wrong than it is. Where only one source has a leg, that one is used.

**The two numbers therefore differ on purpose, and the report says so**, because
a user comparing `trip calibrate` against a schedule and finding a mismatch
must not conclude one of them is broken.

**D3 — banded by straight-line distance, under and over 2 km.** The band is the
finding: the model's error concentrates on short hops, which is what a day is
made of. Banding by measured time would band by the quantity being measured.

**D4 — no verdict, no recommendation, no threshold.** The report states the
numbers and the sample size. It does not say "the model is fine here" or
"you should run `trip route`". Four cities is not enough to calibrate a
threshold, and a tool that asserts a verdict from six legs is exactly the
false confidence this project keeps removing.

**D5 — `trip calibrate` is read-only and offline.** It derives from
`route_legs` and `geo.ts` and touches no network. That is what makes it
testable without stubs and cheap to run repeatedly.

## Command surface

```
trip calibrate               How wrong the travel model is, here [--json]
```

Reads every stored leg for the active trip's mode, recomputes what `geo.ts`
would have said for the same two points, and reports:

```
Model vs measured, from 12 legs (6 pairs, both directions)

  under 2 km    n=4    model 73% of measured   (median)
  2 km and over n=8    model 92% of measured   (median)

  worst: Testbed 2 -> Liziba   model 6 min, measured 22   27%

Measured legs come from 2 routers; this compares against their midpoint.
The schedule reads the SLOWER of the two, so its numbers will differ.
```

**With no legs stored it says so and names the fix** — `trip route` — rather
than printing an empty table or a zero. Absence is loud: no legs is not
"the model is perfect here".

**A band with no legs prints `-`, not `100%`.** An empty band is unknown, and
100 % would read as a measurement of agreement.

## What it computes

For each stored leg, the model's own answer for the same directed pair comes
from `travelMinutes`, unchanged. The ratio is `model ÷ measured`, so:

- **below 100 %** means the model is optimistic — it under-estimates, and a
  plan built on it runs late. Chongqing.
- **above 100 %** means the model is pessimistic. Amsterdam.

The report gives the **median** per band, never the mean: one 4.64-detour
outlier would drag a mean and misdescribe the typical hop.

It also names the **single worst leg** by ratio, because that is the one the
user will actually feel, and because "27 %" is abstract until it is
"6 minutes when it is really 22".

## Testing

**Fixtures.** `test/fixtures/m9-cities/` holds the raw body of every response —
21 geocode pairs (English and local, 42 queries) and 126 directed router legs
across Bangkok, Lisbon and Amsterdam — with `capture.ts` beside them carrying
both production queries in full.

`places.json` records, per place, **which name form was used and how many
candidates it returned**. The whole evidence base rests on those picks being
right, and a future reader cannot tell a 1-candidate point from a 5-candidate
one without it. M8's `places.json` did not need this because its points came
from already-resolved segments.

**The acceptance test** asserts, against those captured responses:

1. **The sign flip.** Chongqing's model is below both routers in 18 of 21
   pairs; Bangkok's, Lisbon's and Amsterdam's are above both in the majority.
   This is the finding, and it is the assertion that will fail if anyone ever
   "fixes" the constants.
2. **English names succeed in Bangkok and Amsterdam** — 0 of 7 missing — where
   Chongqing lost 5 of 11.
3. **Local script is not uniformly better**, in a second and third city.
4. **OSRM is symmetric in all four cities**, and Valhalla's asymmetry is
   largest in Chongqing and smallest in Amsterdam.
5. `trip calibrate` reproduces the Chongqing ratios from stored legs, and says
   nothing when there are none.

**A mutation sweep**, each mutation proving its anchor landed. Specifically
including a mutation that swaps the midpoint for the maximum, since D2 is a
decision a reader could reasonably reverse.

## Out of scope

- **Retuning any constant** (D1). The recon is the argument against it.
- **A verdict or threshold** (D4).
- **Explaining finding 1.** The mechanism is unmeasured and stated as such.
- **Elevation.** Still untested since M8, and the terrain labels in the recon
  are assertions about four cities, not derived data.
- **Transit** — M12.
- `trip export` (M10), `cost_bands` and `trip budget` (M11).

# M8 — a measured leg beats a straight line

*Brainstormed with Eric, 2026-07-27. Scoped to M8 only. Picked from four
options as "measure the travel model". The measurement is in
`2026-07-27-trip-m8-recon.md` and was run before this design, as in M6 and M7.*

## Objective

Travel time between two places can be **measured** instead of assumed, and the
planner uses the measurement when it has one.

The milestone is done when `trip route` has stored real pedestrian legs for the
Chongqing segments, when the plan schedules **22 minutes** from Testbed 2 to
Liziba instead of 6, when the plan says which legs are measured and which are
guessed, and when the whole measurement replays as a test from captured
responses.

## Governing principle

Unchanged: **absence is loud**, **a check that cannot be sure says nothing**,
**no arithmetic may produce a number more confident than its inputs**, and
**two facts that happen to be equal are still two facts**.

M8 adds one, and like M7's it is an old instinct found somewhere nobody looked:

**A placeholder that is never replaced is an assertion.** `geo.ts` announced
itself as temporary in M2 and named the milestone that would replace it. Six
milestones later the comment still says "M4 replaces this whole file", the
constants have never been checked, and every arrival time this project has ever
printed was derived from them to the minute. Labelling a number provisional
does not make the plan built on it provisional. The label decays; the number
ships.

## What the measurement decided

Three findings from the recon shape the whole design:

1. **The model is optimistic and never pessimistic** — below both routers in 18
   of 21 pairs, above both in none. Short hops are 27 % under.
2. **Legs are directed.** OSRM foot is exactly symmetric; Valhalla pedestrian
   is not, by up to 8.7 min, tracking elevation. One row per unordered pair
   would silently corrupt the uphill leg.
3. **The two routers disagree by a median 4.7 and a maximum 25.1 minutes**, and
   the disagreement is structured — Valhalla models grade, OSRM returns longer
   distances. Merging them at write time would destroy the finding.

## Decisions

**D1 — measured legs feed ordering AND the clock.** Eric's call, against the
smaller-blast-radius option. `order.ts` picks the next segment by
`travelMinutes`, so a measured leg changes which day a segment lands on and in
what sequence, not merely its printed arrival. Testbed 2 and Liziba stop
looking like neighbours. The cost is accepted: a trip can reshuffle after
`trip route`, and that is the point of running it.

**D2 — where both sources have a leg, the schedule reads the SLOWER.** Eric's
call. A plan that runs early is a good day; a plan that runs late cascades
through every segment after it. Both numbers stay on disk; this decides only
what the clock reads.

**D3 — both sources are stored, never merged.** One row per
`(from, to, mode, source)`. Storing a midpoint would erase the 25-minute spread
permanently and make the recon's third finding unrecoverable from the database.

**D4 — legs are keyed on coordinates, not on segment ids.** A leg is a fact
about two points in a city, not about a trip, and it is shared across trips.
Keying on coordinates also means a segment moved by M7's `--query` or
`--rename` **misses** and falls back to the model, instead of silently reusing
a leg measured from where it used to be. Coordinates are rounded to 5 decimal
places (~1.1 m) so the key is stable against float formatting.

**D5 — the network stays out of `trip plan`.** `trip route` is the only
planning command that touches the network. It writes legs; `trip plan` loads
them into a lookup table before compiling and stays a pure function, offline
and synchronous. This is the existing contract in `compile.ts` — *"a pure
function: no DB, no network, no clock, no RNG"* — and M8 does not break it.

**D6 — the constants are NOT recalibrated.** The obvious move is to set the
walking detour to the measured 1.43. Rejected: the sample is one city, and a
famously vertical one, so a global constant tuned on Chongqing is overfitting.
The model stays exactly as it is and becomes what it always should have been —
the answer when nothing has been measured. This is the same rejection M7 made
of "always query in local script", on the same grounds.

**D7 — transit is untouched and says so.** Nothing in M8 measures transit.
`--mode=transit` keeps 18 km/h, 1.20 and 6 min per hop with no evidence behind
them. `trip route` fetches pedestrian legs only, stores them with
`mode='walking'`, and a transit plan therefore finds no legs and uses the model
for every hop. The spec records this as a non-claim rather than leaving it as a
silent omission.

## Data model

Migration 12 adds one table:

```sql
CREATE TABLE route_legs (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  from_lat   REAL NOT NULL,
  from_lon   REAL NOT NULL,
  to_lat     REAL NOT NULL,
  to_lon     REAL NOT NULL,
  mode       TEXT NOT NULL,
  source     TEXT NOT NULL,
  minutes    REAL NOT NULL,
  meters     REAL NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE UNIQUE INDEX route_legs_key
  ON route_legs (from_lat, from_lon, to_lat, to_lon, mode, source);
```

No `trip_id` (D4). No nullable columns: a leg either measured or it does not
exist. `minutes` and `meters` are REAL because the routers return seconds and
metres and rounding at write time would discard the spread the design exists to
preserve; rounding happens at the point of use, where the existing rule that
travel times are whole minutes still applies.

`source` is `'osrm-foot'` or `'valhalla-pedestrian'`. It is a free TEXT column
rather than a CHECK constraint: a third router should be an insert, not a
migration.

## Command surface

```
trip route                   Measure real walking legs between placed segments
    --refresh                Refetch legs already stored
    --json
```

Fetches every **ordered** pair of the active trip's plannable segments — both
directions, both routers — skipping pairs already stored unless `--refresh`.
Rate-limited to one request per 1.2 s against the shared FOSSGIS instances.

For *n* segments that is *n(n−1)* directed pairs × 2 sources. Seven segments is
84 requests, about 100 seconds. `trip route` prints the size of the job before
starting it, so the agent is never surprised by a two-minute command.

**A failed fetch stores nothing.** No zero, no fallback value, no partial row.
If OSRM answers and Valhalla times out, the OSRM leg is stored alone and the
report says so — one source is a measurement, and D2's "slower of the two"
degrades correctly to "the only one there is".

The report names the widest disagreements, because a 25-minute spread is a fact
about the city worth reading.

## How the planner consumes legs

A new `src/plan/travel.ts` owns the decision and nothing else:

```ts
export interface TravelEstimate { minutes: number; measured: boolean; }

export interface TravelModel {
  minutes(a: Point, b: Point, mode: Mode): number;
  estimate(a: Point, b: Point, mode: Mode): TravelEstimate;
}

export function modelOnly(): TravelModel;
export function withLegs(legs: MeasuredLeg[]): TravelModel;
```

`estimate` looks for legs at the rounded directed key. Present → the **maximum**
minutes across sources (D2), `measured: true`. Absent → `travelMinutes` from
`geo.ts`, `measured: false`.

`geo.ts` itself is unchanged except for its header comment, which is corrected:
it is no longer a placeholder awaiting M4, it is the fallback for an unmeasured
leg, and the constants are documented as unevidenced with a pointer to the
recon.

`compile`, `orderDay` and `layoutDay` take a `TravelModel` instead of importing
`travelMinutes` directly. `compile` stays pure — the model is data passed in.
Callers that do not care pass `modelOnly()`.

## Rendering

The plan already prints travel between consecutive segments. Each hop gains a
marker:

```
09:00  Hongya Cave                    2h00
       → 24 min walk (measured)
11:24  Luohan Temple                  1h00
       → 6 min walk (estimated)
```

`(estimated)` is the loud absence: it is not a hedge on a measured number, it
says no leg exists for this hop. `--json` carries `measured` as a boolean per
hop, never a string.

`trip route --json` emits the stored legs including **both** sources per
directed pair, so the disagreement is machine-readable and D3 survives export.

## Testing

**Fixtures.** `test/fixtures/m8-chongqing/` holds the raw body of every router
response — 21 pairs × 2 directions × 2 sources, plus the elevation response —
with `capture.ts` beside them carrying the production query in full, including
the fact that OSRM's `/route/v1/driving/` path segment is ignored by the
`routed-foot` instance. The slug is `\p{L}\p{N}`-based and asserts no collision
before writing, because M7's sweep inherited an ASCII-only slug and silently
overwrote every Chinese fixture.

**The acceptance test** asserts, against those captured responses:

1. Testbed 2 → Liziba schedules **22 minutes, not 6** — the whole milestone.
2. The **reverse** leg is the uphill one and differs — the finding that made
   legs directed. A test that only checks one direction would pass under the
   unordered-pair design this replaces.
3. A segment whose coordinates changed falls back to the model rather than
   reusing its old leg.
4. A hop with no leg renders `(estimated)` and schedules the model's number,
   unchanged from M7 — the control, and the assertion most likely to be skipped
   because it asserts that nothing happened.
5. `--mode=transit` finds no legs and is bit-for-bit identical to M7's output.
   D7 as an executable claim rather than a paragraph.

**Cross-command consistency**, as every milestone since M4: `trip route` and
`trip plan` must not disagree about how many legs are known.

**A mutation sweep**, each mutation asserting its anchor landed before running,
because M6's sweep produced a false zero from a substitution that never
applied.

## Out of scope

- **Recalibrating the model's constants** (D6) — rejected on evidence, not
  deferred.
- **An elevation penalty.** The recon could not settle whether elevation
  explains the detour outliers at n=21; building on it would be building on
  noise.
- **Transit legs** (D7). No free GTFS ground truth for Chongqing was found.
- **Routing inside `trip plan`** (D5), now and permanently.
- **Turning stored legs into a route the user can follow** — M8 stores
  durations and distances, not geometry. `overview=false` on every request is
  deliberate: geometry is a different milestone with a different data model.
- `cost_bands`, `trip budget`, `trip export` — parked, unchanged.

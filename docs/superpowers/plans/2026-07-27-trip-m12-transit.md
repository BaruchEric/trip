# M12 transit station graph — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans.
> Eric's standing instruction on this project is to implement directly, inline,
> without SDD subagents.

**Goal:** Replace the unevidenced 18 km/h transit constant with a model built
from OSM station geometry, which can say "walk instead" and is loud that its
minute count is modelled rather than measured.

**Architecture:** `trip transit` fetches rail relations from Overpass and
stores stations and directed edges per destination. `compile()` stays pure and
offline: it reads a `TransitGraph` passed in as data, exactly as it already
reads measured legs. The graph decides direction and ordering; three named,
unevidenced constants turn that into minutes, and every output says so.

**Tech Stack:** TypeScript strict, Bun, `bun:test`, `@libsql/client`, `@/` alias.

## Global Constraints

- `BASE_SCHEMA` is frozen. Migration 14 is a new numbered entry with a
  `hasColumn`-style guard.
- `compile()` stays pure: no DB, no network, no clock, no RNG.
- Mode set is exactly `subway|monorail|light_rail|tram`, written out in full in
  the source with the Chongqing monorail reason attached (M12-11).
- No router costing string may appear anywhere under `src/transit/` (M12-10).
- Absence is loud: NULL is unknown, `0` is a value, never interchangeable.
- No arithmetic may produce a number more confident than its inputs (M5).
- Every output change lands in BOTH `trip plan` and `trip day` (M12-13).
- Commit per task. Never push.

---

### Task 1: Migration 14 and the transit store

**Files:**
- Modify: `src/db.ts` (append migration 14 to `MIGRATIONS`)
- Create: `src/transit/store.ts`
- Test: `test/transit-store.test.ts`

**Interfaces:**
- Produces: `TransitStation {destinationId, name, latitude, longitude}`,
  `TransitEdge {destinationId, fromName, toName, line, km}`,
  `saveNetwork(db, destinationId, stations, edges)`,
  `loadNetwork(db, destinationId): Promise<{stations, edges}>`,
  `clearNetwork(db, destinationId)`.

- [ ] **Step 1:** Write `test/transit-store.test.ts`: a round-trip saving two
  stations and one edge, asserting `loadNetwork` returns them; a second save
  for the same destination REPLACES rather than appends; two destinations do
  not see each other's stations.
- [ ] **Step 2:** Run `bun test test/transit-store.test.ts` — expect failure.
- [ ] **Step 3:** Add migration 14 creating `transit_stations` and
  `transit_edges`, both with `destination_id`, guarded on
  `hasColumn(db,"transit_stations","name")`. Table comments carry M12-2 (why
  destination-scoped) and M12-3 (name identity merges same-named stations).
- [ ] **Step 4:** Implement `src/transit/store.ts`.
- [ ] **Step 5:** Run `bun test test/transit-store.test.ts test/db.test.ts` — expect PASS.
- [ ] **Step 6:** Commit.

---

### Task 2: The pure station graph

**Files:**
- Create: `src/transit/graph.ts`
- Test: `test/transit-graph.test.ts`

**Interfaces:**
- Consumes: `TransitStation`, `TransitEdge` from Task 1.
- Produces:
```ts
export interface TransitRoute {
  fromStation: string; toStation: string;
  accessKm: number; egressKm: number;
  stops: number; transfers: number; rideMinutes: number;
}
export interface TransitGraph {
  stationCount: number;
  route(a: Point, b: Point): TransitRoute | null;
}
export function buildGraph(stations: TransitStation[], edges: TransitEdge[]): TransitGraph;
export const RAIL_KMH = 30, TRANSFER_MINUTES = 4, BOARDING_MINUTES = 4,
             STOP_MINUTES = 0.5, MAX_ACCESS_KM = 3.0;
```
  `route` returns null when either endpoint has no station within
  `MAX_ACCESS_KM`, or the two stations are not connected.

- [ ] **Step 1:** Write `test/transit-graph.test.ts` on a hand-built network:
  a straight 3-station line; a 2-line network needing one transfer (asserting
  `transfers === 1`); both endpoints nearest the same station (asserting
  `stops === 0`); an endpoint 5 km from any station (asserting `null`); two
  disconnected components (asserting `null`).
- [ ] **Step 2:** Run — expect failure.
- [ ] **Step 3:** Implement Dijkstra over station names, cost in minutes,
  charging `TRANSFER_MINUTES` on a change of `line` and `STOP_MINUTES` per
  edge. Header records that the four constants are unevidenced, cites the
  recon's sweep, and states the graph is evidence about direction, not duration.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit.

---

### Task 3: Overpass fetch and parse

**Files:**
- Create: `src/transit/fetch.ts`
- Test: `test/transit-fetch.test.ts`

**Interfaces:**
- Produces: `RAIL_MODES = ["subway","monorail","light_rail","tram"]`,
  `overpassQuery(bbox): string`, `parseNetwork(relationsJson, nodesJson,
  destinationId): {stations, edges, modes, relationCount}`,
  `fetchNetwork(bbox, deps?): Promise<{relations, nodes}>`.

- [ ] **Step 1:** Write `test/transit-fetch.test.ts` parsing the CAPTURED
  Chongqing fixtures (`test/fixtures/m12-transit/rail-chongqing-*.json`) and
  asserting: Liziba (`李子坝`) is among the stations; the `modes` include
  `monorail`; station count is > 250; a stop sequence produces consecutive
  edges. Plus a guard test asserting the source of `src/transit/` contains no
  routing costing string (`bus`, `multimodal`, `costing`) and that
  `overpassQuery` names exactly the four rail modes.
- [ ] **Step 2:** Run — expect failure.
- [ ] **Step 3:** Implement. The Overpass query is written out in full with the
  M12-11 comment. `parseNetwork` groups stops by name and emits consecutive
  stop-role members as directed edges.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit.

---

### Task 4: `TravelEstimate.basis` and the transit branch

**Files:**
- Modify: `src/plan/travel.ts`, `src/render-plan.ts` (call site only)
- Test: `test/travel-transit.test.ts`, existing `test/travel*.test.ts`

**Interfaces:**
- Produces:
```ts
export type TravelBasis = "measured" | "osm-graph" | "model";
export interface TravelEstimate {
  minutes: number;
  basis: TravelBasis;
  transit?: { fromStation: string; toStation: string;
              stops: number; transfers: number; walkWins: boolean };
}
export function withLegsAndTransit(legs: MeasuredLeg[], graph: TransitGraph | null): TravelModel;
```

- [ ] **Step 1:** Write `test/travel-transit.test.ts`: a transit estimate on a
  graph returns `basis: "osm-graph"` with stop and transfer counts; **a transit
  estimate NEVER exceeds the walking estimate for the same pair** (M12-6), and
  when it would, `walkWins` is true and `minutes` equals the walk; a
  same-station pair yields `walkWins: true`; a null graph yields
  `basis: "model"`; a measured walking leg still beats everything for walking.
- [ ] **Step 2:** Run — expect failure.
- [ ] **Step 3:** Replace `measured: boolean` with `basis`. Implement
  `withLegsAndTransit`. Update the `render-plan.ts` call site.
- [ ] **Step 4:** Run the full suite — expect PASS.
- [ ] **Step 5:** Commit.

---

### Task 5: Renderers, both of them

**Files:**
- Modify: `src/render-plan.ts`
- Test: `test/render-transit.test.ts`

- [ ] **Step 1:** Write `test/render-transit.test.ts`: a hop on the graph
  prints stations, stop count and change count and the word `modelled`; a
  `walkWins` hop prints `walk instead` and does NOT claim transit; a `model`
  basis hop prints `estimated`; a footer appears when any hop used the graph,
  naming that OSM carries no timetable so waiting is assumed not measured; and
  a CROSS-COMMAND assertion that `trip plan` and `trip day` render the same hop
  line for the same input (M12-13).
- [ ] **Step 2:** Run — expect failure.
- [ ] **Step 3:** Implement in `hopLine` and the plan footer.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit.

---

### Task 6: `trip transit` command and CLI wiring

**Files:**
- Create: `src/commands/transit.ts`
- Modify: `src/cli.ts` (`COMMAND_FLAGS`, dispatch, help), `src/commands/plan.ts`
- Test: `test/transit-command.test.ts`

- [ ] **Step 1:** Write `test/transit-command.test.ts` with an injected fetch
  dep returning the captured fixtures: asserts stations stored, report names
  the modes found and how many trip segments have a station in reach; a second
  run without `--refresh` reports cached; `--refresh` refetches; no active trip
  errors; a destination with no coordinates errors specifically. Plus a
  `COMMAND_FLAGS` test that `trip transit --format=x` is rejected.
- [ ] **Step 2:** Run — expect failure.
- [ ] **Step 3:** Implement the command; wire `transit: { bool: ["--refresh"] }`
  into `COMMAND_FLAGS` with the comment explaining it is networked; add help
  text; make `plan`/`replan`/`day`/`export` load the graph and pass it to
  `withLegsAndTransit`.
- [ ] **Step 4:** Run the full suite — expect PASS.
- [ ] **Step 5:** Commit.

---

### Task 7: `trip calibrate` refuses specifically on transit

**Files:**
- Modify: `src/calibrate.ts` or `src/render-calibrate.ts`
- Test: `test/calibrate-transit.test.ts`

- [ ] **Step 1:** Write the test: on a transit-mode trip, output names that no
  router measures transit for this city, that the graph's own output is not
  evidence about the graph, and points at `trip transit`; it must NOT print a
  zero-leg table that reads as agreement.
- [ ] **Step 2:** Run — expect failure.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5:** Commit.

---

### Task 8: Correct `geo.ts`, which now documents a measured wrong

**Files:**
- Modify: `src/plan/geo.ts`
- Test: `test/geo.test.ts` (unchanged behaviour; constants do NOT move)

- [ ] **Step 1:** Rewrite the transit paragraph of the header: the constants
  are no longer merely unevidenced, they are measured wrong in a known
  direction in four cities, and the reason they are NOT recalibrated is that
  the graph replaces them where it exists and a global constant tuned on four
  cities would repeat M8's overfitting error.
- [ ] **Step 2:** Rewrite the `perHopMinutes` comment, which currently claims
  six minutes "correctly makes transit lose to walking over short distances" —
  measured, it does not, in 36–42 of every 42 pairs.
- [ ] **Step 3:** Run the full suite — expect PASS, no behaviour change.
- [ ] **Step 4:** Commit.

---

### Task 9: Mutation sweep

**Files:** none committed; `cp -R src /tmp/m12-src-backup` first.

**Never `git checkout` to revert a mutation** — M5 lost a task's uncommitted
work that way. **Each mutation must assert its anchor landed** before running
the suite — M6 produced a false zero from a substitution that silently failed.

- [ ] **M1:** transit estimate is allowed to exceed the walk (delete the
  `min` rule). Expect the M12-6 test to die.
- [ ] **M2:** transfers cost 0 instead of `TRANSFER_MINUTES`.
- [ ] **M3:** `MAX_ACCESS_KM` ignored — any station counts however far.
- [ ] **M4:** `basis` reports `"measured"` for a graph result.
- [ ] **M5:** the mode set narrows to `subway` only. Expect the Liziba
  fixture test to die.
- [ ] **M6:** edges built unordered (sort the two station names).
- [ ] **M7:** `BOARDING_MINUTES` dropped from the total.
- [ ] **M8:** the renderer's timetable footer is suppressed.
- [ ] **M9:** migration 14 keeps stations globally rather than per destination.

Any mutation killing zero gets a test written for it before the milestone
closes. A mutation killing zero is never "fine".

---

### Task 10: Ledger

**Files:** Create `.superpowers/sdd/2026-07-27-trip-m12/progress.md` (gitignored).

Record: what was built, the mutation table, defects the tests caught, what is
still NOT established, and the real run against a scratch `TRIP_TEST_DB`.

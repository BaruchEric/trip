# M12 design — a transit model that knows where the stations are

Spec for the twelfth milestone. The measurement is
`docs/superpowers/specs/2026-07-27-trip-m12-recon.md` and every decision below
cites it. Read it first; this document assumes its findings.

## What is being fixed

`--mode=transit` is reachable from `trip set`, `trip plan` and `trip replan`,
and compiles on `haversine × 1.20 ÷ 18 km/h + 6 min`. The recon measured that
constant against a station graph built from OSM in four cities:

- it **under-states** door-to-door transit time in all four, median +8 to
  +24 min, and unlike M8's walking result **the sign does not reverse**;
- it recommends riding over walking in **36–42 of every 42 pairs**, and
  measured walking actually wins 4 to 11 of those, by up to 70 minutes.

The second is the real defect. A constant with no idea where a station is
cannot ever say "walk instead", and `perHopMinutes: 6` — whose comment claims
it "correctly makes transit lose to walking over short distances" — does not.

## What the data can and cannot support

| OSM gives | OSM does not give |
|---|---|
| station positions | any timetable (0 `interval`/`headway` tags in 126 relations) |
| ordered stop sequences | line frequency, so waiting time |
| line membership, interchanges | line-haul speed |
| which stops share a name | transfer cost |

**The graph is evidence about direction and ordering, not duration.** Every
decision below follows from that split.

---

## M12-1 — the graph is fetched by a command and read by the compiler

`trip transit` is networked; `compile()` stays pure, offline and synchronous,
the contract it has carried since M2. Same shape as `trip route`.

## M12-2 — migration 14: `transit_stations` and `transit_edges`

Both keyed by `destination_id`, following `climate_months` rather than
`route_legs`.

`route_legs` deliberately has no trip or city key, because a leg is a fact
about two coordinates and coordinates are globally unique. **A station graph is
not**: its node identity is a NAME, and "Central" is a station in many cities.
Storing stations globally would let two cities' networks share a node and
produce an edge between them. Scoping to the destination makes that
impossible rather than unlikely.

## M12-3 — a station is a NAME within a destination

A route relation carries one stop node per platform per direction, so Line 1
and Line 6 at one interchange are different nodes with the same name.
Grouping by name is what makes a transfer possible in the graph at all.

**Recorded limitation, not fixed:** two genuinely distinct stations sharing a
name inside one city merge into one node, and the graph would then offer a
free transfer between places that are not connected. Nothing in the recon
checked for this. It is written into the table comment so the next person
meets it.

## M12-4 — edges are directed, one row per ordered consecutive pair

Directed for the same reason `route_legs` is, and a stronger one: a
`route=subway` relation IS one direction of one line, so the ordering is the
source's own. Each edge carries its line `ref` because a change of `ref`
between consecutive edges is what a transfer IS in this model.

## M12-5 — the constants OSM cannot supply live in one named place

```
RAIL_KMH            30    line-haul speed
TRANSFER_MINUTES     4    per change of line
BOARDING_MINUTES     4    initial wait and getting to the platform
STOP_MINUTES         0.5  dwell per intermediate station
```

None is measured. They live in `src/transit/graph.ts` under a header
recording the recon's sweep, and **they are the reason no absolute claim is
made about a transit minute count anywhere in the output.**

**BOARDING_MINUTES is included in the number rather than omitted**, which
differs from the mock shown when this milestone was scoped. Omitting it would
make the model optimistic in exactly the direction that is being fixed — a
traveller does not teleport onto a train. Including an assumed figure and
labelling it is honest; excluding a real cost silently is not. The output says
which it is, and says that actual waiting depends on frequency, which OSM does
not carry.

## M12-6 — when the graph says walking is faster, the estimate IS the walk

The defect fix, stated as one rule: **a transit estimate never exceeds the
walking estimate for the same pair.** Where riding loses, the model returns
the walk and reports that it did.

The walking number it compares against is the ordinary one — a measured leg
from `route_legs` if `trip route` stored one, otherwise the walking model. So
the comparison improves automatically wherever real walking has been measured.

The degenerate case falls out of this rather than being special-cased: when
both endpoints' nearest station is the same station, the ride is zero stops
and all access walk, so walking always wins. That is 4/42 pairs in Chongqing
and 6/42 in Bangkok.

## M12-7 — `TravelEstimate.measured` becomes `basis`

```ts
type TravelBasis = "measured" | "osm-graph" | "model";
```

`measured: boolean` is **replaced**, not supplemented. Keeping both would put
`measured` and `basis === "measured"` in the same object — two facts that are
always equal, which M7 established is still two facts and one of them will
eventually be wrong.

Three bases, because there are now three genuinely different provenances, and
the renderer must not print the third as though it were the second:

- `measured` — a router measured this leg.
- `osm-graph` — computed from real station geometry and three assumed constants.
- `model` — the straight-line constant, unevidenced, and now known wrong.

## M12-8 — no station within reach means transit is not available here

`MAX_ACCESS_KM = 3.0`. Past that the endpoint has no usable station and the
estimate falls back to walking, reported as such.

This is a guard against cross-destination contamination and absurd access
walks, not a modelling claim. Bangkok's worst real access walk was 1431 m,
comfortably inside it.

**Distinct from "no graph stored at all"**, which is the case where nobody has
run `trip transit`. That falls back to the `model` basis — the old constant —
and the renderer says so, because a plan compiled on the constant must not
look like one compiled on the graph.

## M12-9 — `trip transit`, one networked command

`trip transit` fetches the rail network for the active trip's destination and
stores it. `--refresh` refetches. It reports what it got: relations, stations,
edges, modes present, and **how many of the trip's own segments have a station
within reach** — the number that decides whether the graph will do anything.

The Overpass query is written out in full in the source, per M6.

## M12-10 — `costing: "bus"` must be unreachable, and a test says so

M12 ships no router call at all, only Overpass. The guard is therefore that it
stays that way: a test asserts `src/transit/` contains no routing-costing
string and that the mode set is exactly the four rail modes.

The recon captured Valhalla's `bus` response returning HTTP 200 with a 13-min
answer for a trip pedestrian routing puts at 77. A comment is not a guard.

## M12-11 — the mode set is `subway|monorail|light_rail|tram`, and the reason travels with it

Written where anyone adding a city will read it. `route=subway` alone loses
Chongqing's Lines 2 and 3 — monorails — including Liziba, which is one of this
project's own resolved places. It also loses Bangkok's BTS (`light_rail`) and
Amsterdam's trams. The narrow query was wrong in three of four cities.

## M12-12 — `trip calibrate` says what it cannot say about transit

`calibrate` compares the model to stored legs. There are no transit legs and
there can be none: no free router covers these cities, and the graph's own
output is not evidence about the graph. On a transit-mode trip it now refuses
specifically — naming the reason and pointing at `trip transit` for what CAN
be inspected — instead of reporting zero legs.

## M12-13 — both renderers change together

`trip plan` and `trip day` both render hop lines. M8 shipped hop lines in one
and not the other and it took until M10 to notice. Every output change here
lands in both, and a cross-command test asserts they agree.

---

## Testing

- **Graph unit tests** on a hand-built fixture network: ordering, transfers,
  same-station degeneracy, unreachable pairs, the access cutoff.
- **Golden fixture test** on the captured Chongqing data, asserting the
  monorail lines and Liziba are present — the regression guard for Finding 0.
- **The walk-never-loses rule** as its own test, since it is the defect fix.
- **Migration 14** applied to a v13 database carrying rows.
- **Cross-command** assertion that `plan` and `day` render the same hop.
- **Mutation sweep** at the end, as every milestone since M5.

## Out of scope

- **Route geometry.** Still `overview=false` everywhere. A followable route is
  a different data model (parked since M8).
- **Frequency from any source.** No free keyless one exists for these cities.
  This is the largest missing term and it stays missing, loudly.
- **Recalibrating the walking constants.** M9 settled that: the sign of the
  walking error changes by city.
- **Bus networks.** Rail only. Bus route relations exist in OSM but are far
  less completely mapped, and the recon measured nothing about them.

# M8 recon — measuring the travel model against two routers

*Run 2026-07-27, before the design, as in M6 and M7. Every number below comes
from a raw response captured to `test/fixtures/m8-chongqing/`, with
`capture.ts` beside it carrying the production query written out in full.*

## Why this was measured at all

`src/plan/geo.ts` has computed every travel time in this project since M2:

```
walking: haversine × 1.30 ÷ 4.5 km/h
transit: haversine × 1.20 ÷ 18 km/h + 6 min per hop
```

Nothing has ever checked those five constants. The file's own header has said
since M2 that *"M4 replaces this whole file with OSRM walking routes and
GTFS-Transitland transit legs"* — M4 shipped the plausibility check instead,
and the sentence has been false for four milestones.

## The ground truth, and the mistake I nearly made

The first probe hit `router.project-osrm.org` and got **identical results for
`foot`, `walking`, `driving`, `bike` and `cycling`** — 4.51 km, 5 min, i.e.
54 km/h. That server serves the car profile and ignores the profile string. I
was about to record "there is no free walking router" from that one probe.

There are two, both keyless, both FOSSGIS-hosted:

| source | endpoint | note |
|---|---|---|
| OSRM `routed-foot` | `routing.openstreetmap.de/routed-foot/route/v1/driving/…` | the profile is the *instance*; the path segment after `/v1/` is ignored |
| Valhalla `pedestrian` | `POST valhalla1.openstreetmap.de/route`, `costing: "pedestrian"` | |

Elevation came from Open-Meteo's `/v1/elevation`, already this project's
climate vendor, keyless, ~90 m DEM.

## The sample

**Seven places: every one this project has actually resolved to a segment.**
M6's four (`chongqing-resolved-state.json`) plus M7's three recoveries.

This is a correction to a first pass that took the top Nominatim hit from every
city-core fixture and got ten points — a set that included a hotel
(`你好酒店`, top hit for "Jiefangbei Pedestrian Street") and candidates M6 had
rejected or left queued. Describing that as "the real Chongqing segments"
would have been M4's paraphrased-query error in a new place.

21 unordered pairs, both routers, raw bodies kept.

## Result 1 — the model is optimistic, and never the other way

| | n | model ÷ router midpoint | median detour vs assumed 1.30 |
|---|---|---|---|
| under 2 km | 6 | **73 %** | **1.71** |
| 2 km and over | 15 | 92 % | 1.42 |

**Below both routers in 18 of 21 pairs. Inside the two-router range in 3.
Above both in 0.**

The error concentrates where day-planning happens. A day chains short hops;
the long pairs the model handles well are the ones a planner rarely walks.

Worst case, and it is not marginal:

| pair | straight | model | OSRM | Valhalla | detour |
|---|---|---|---|---|---|
| **Testbed 2 → Liziba** | **0.36 km** | **6 min** | **22 min** | **23 min** | **4.64** |
| Luohan Temple → Longmenhao | 1.36 km | 24 min | 36 | 38 | 1.97 |
| Hongya Cave → Longmenhao | 1.68 km | 29 min | 38 | 41 | 1.71 |

Testbed 2 and Liziba are 360 m apart in a straight line and there is no direct
pedestrian path. The model calls them neighbours.

## Result 2 — legs are DIRECTED, and this was nearly missed

The obvious storage design is one row per unordered pair. Four pairs, measured
in both directions:

| pair | OSRM A→B | OSRM B→A | Valhalla A→B | Valhalla B→A | Δ elevation |
|---|---|---|---|---|---|
| Testbed 2 → Liziba | 22.2 | 22.2 | 23.4 | **32.1** | 133 m |
| Hongya → Longmenhao | 38.4 | 38.4 | 41.2 | 43.5 | 45 m |
| Luohan → Kuixinglou | 15.3 | 15.3 | 18.8 | 18.3 | 2 m |
| Ring → Hongya | 205.4 | 205.4 | 191.5 | 200.2 | 225 m |

**OSRM foot is exactly symmetric in all four — identical to 0.1 min.** It
applies a flat 5 km/h and models no grade at all.

**Valhalla pedestrian is not**, and the gap tracks the elevation delta:
2 m → 0.5 min, 45 m → 2.3 min, 133 m → 8.7 min.

Storing one row per unordered pair would have made the uphill return leg 9
minutes wrong with no signal anywhere.

## Result 3 — the disagreement is structured, not noise

Median gap between the two routers: **4.7 min. Maximum: 25.1 min.**

The direction of the gap flips with distance. Under 2 km Valhalla is slower on
every pair; over 8 km OSRM is slower on every pair. Valhalla models grade,
which dominates short hops in this city; OSRM returns consistently longer
*distances* (median detour 1.42 against Valhalla's), which dominates once the
hop is long enough for distance to outweigh terrain.

So "the truth" has a width, and the width means something.

## What was NOT established

**Elevation as the cause of the detour outliers.** Tempting — Testbed 2 →
Liziba has both the worst detour (4.64) and a 133 m delta. But Luohan →
Kuixinglou has a **2 m** delta and still detours 1.49, and Longmenhao → Liziba
has 12 m and detours 1.47. At n=21 from one city this cannot be settled, and
recording it as *measured and rejected* would foreclose a future milestone on
noise. It is untested, not refuted.

**Anything at all about `--mode=transit`.** Neither router was asked for
transit; FOSSGIS Valhalla carries no GTFS feed for Chongqing. The transit
constants — 18 km/h, 1.20 detour, 6 min per hop — remain exactly as
unevidenced after M8 as before it. M8 must not imply otherwise.

**That any of this generalises.** One city, and a famously vertical one. The
finding is "the model is 27 % optimistic on short hops *in Chongqing*". A
global recalibration of the constants from this sample would be overfitting to
a single city — the same error as M7's rejected "always query in local script".

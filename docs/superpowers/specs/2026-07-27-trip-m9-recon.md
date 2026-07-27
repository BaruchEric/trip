# M9 recon — three more cities, and two findings that did not survive

*Run 2026-07-27, before the design, as in M6–M8. Every number comes from a raw
response captured to `test/fixtures/m9-cities/`, with `capture.ts` beside it
carrying the production queries written out in full.*

## The experiment

M7 and M8 both close with the same unestablished claim: **one city**. Chongqing
confounds two variables at once — a CJK script and extreme verticality — so a
second city alone could not separate them. Three were measured:

| city | script | terrain | isolates |
|---|---|---|---|
| Chongqing | CJK | extreme hills | the control, already measured in M7/M8 |
| Bangkok | Thai | very flat | non-CJK script *and* no hills |
| Lisbon | Latin | hilly | terrain, with script held to Latin |
| Amsterdam | Latin | flat | neither — the null case |

Seven places per city. Each name queried twice, in English and in the local
form, through the **production geocode query**: `format=jsonv2`, a 25 km
`viewbox`, `bounded=1`, `limit=5`, `addressdetails=1`, and **no
`accept-language`**. Then every ordered pair through both pedestrian routers —
126 directed legs, 0 errors — with Chongqing replayed from M8's committed
fixtures on identical terms.

## Finding 1 — M7's local-script recovery does NOT generalise

| city | English names returning 0 candidates |
|---|---|
| **Chongqing** (M7) | **5 of 11** |
| Bangkok | **0 of 7** |
| Lisbon | 1 of 7 |
| Amsterdam | **0 of 7** |

Bangkok is the decisive case: Thai is as far from Latin as Chinese is, the city
is flat, and **every English name found its place**. `Grand Palace` returns
พระบรมมหาราชวัง. `Wat Arun` returns วัดอรุณ. Nominatim matched an English query
against a Thai-named feature, which is precisely what it could not do for
`Longmenhao Old Street`.

Lisbon's single miss is `Saint George Castle` → 0, recovered by
`Castelo de São Jorge` → 4. That is a **translation**, not a script: both
strings are Latin. It belongs to a different phenomenon than M7 described.

**And querying in the local form is often worse.** Across the 21 new pairs it
was *more* ambiguous in 4 cases and less in 2 — `Dam Square` → 1 but `Dam` → 5,
`Rossio Square` → 1 but `Praça do Rossio` → 5. This matches Chongqing's
十八梯 going 2 → 5 and confirms across four cities that "always query in local
script" would be wrong.

**What this means for M7.** The feature M7 shipped is still correct and still
useful: `--query` separates the string you search by from the string you call
it. What does not survive is the *generalisation* — "local script recovers
names" is not a property of non-Latin scripts. It is a property of Chongqing,
or of Chinese OSM data, or of those five particular places. This recon cannot
say which.

**The mechanism is NOT established.** The obvious explanation is that OSM in
some regions carries an English or romanised name variant for a feature and in
others does not. Consistent with everything above, and untested here: an
attempt to measure `name:en` coverage per city was abandoned because it is
confounded — a Latin-script city has no need of `name:en`, so the comparison
is not like-for-like — and because two of the four queries timed out. No
number from it is reported, because a confounded number in a record gets cited
later as though it were clean.

## Finding 2 — M8's headline does not merely fail to generalise, it REVERSES

| city | terrain | n | model **below** both routers | model **above** both | ratio <2 km | ratio 2 km+ | detour |
|---|---|---|---|---|---|---|---|
| Chongqing | extreme hills | 21 | **18** | **0** | 73 % | 92 % | 1.45 |
| Lisbon | hilly | 21 | 4 | **15** | 87 % | **116 %** | 1.16 |
| Bangkok | flat | 21 | 7 | **12** | 94 % | **114 %** | 1.31 |
| Amsterdam | flat | 21 | 2 | **10** | **105 %** | 109 % | 1.29 |

M8's finding was that the model is optimistic — below both routers in 18 of 21
pairs and above both in none — and that this is dangerous because a plan built
on it runs late.

**In all three new cities the sign flips.** The model is *pessimistic* in the
majority of pairs: 15, 12 and 10 of 21 respectively. In Amsterdam it
over-estimates even the short hops, at 105 %.

**This is the strongest possible vindication of M8 decision 6**, which refused
to recalibrate the constants from Chongqing. The reason is not that a tuned
constant would have been slightly worse elsewhere — it is that **the sign of
the error is different in different cities**, and no single constant can be
right about a quantity that changes direction. The measured detours bracket the
model's assumed 1.30 from both sides: 1.45, 1.31, 1.29, 1.16.

**M8's number was never wrong; its scope was.** The M8 ledger's own closing
section says "one city, and a famously vertical one". That was correct, and
this recon is what turns a caveat into a measurement.

## Finding 3 — directedness DOES generalise, and tracks terrain

The M8 schema decision that legs are directed, tested in four cities:

| city | terrain | median Valhalla \|A→B − B→A\| | max | median OSRM gap |
|---|---|---|---|---|
| Chongqing | extreme hills | **6.8 min** | **30.1** | 0.00 |
| Lisbon | hilly | 2.1 | 4.7 | 0.00 |
| Bangkok | flat | 1.0 | 4.7 | 0.00 |
| Amsterdam | flat | **0.5** | 1.3 | 0.00 |

**Monotonic in terrain, across four cities.** Valhalla's asymmetry is grade,
and it shrinks to almost nothing where there are no hills. **OSRM foot is
exactly symmetric in all four cities** — a median gap of 0.00 minutes, 126
directed legs, no exceptions.

So the directed schema is right everywhere and *matters* only somewhere. In
Amsterdam storing one row per unordered pair would have cost half a minute; in
Chongqing it would have cost half an hour.

## What this leaves the tool unable to do

The model is excellent in Amsterdam and catastrophic in Chongqing, and
**nothing in the tool knows which city it is in**. `trip route` exists and is
worth its two minutes in one of these places and not in the others, and a user
has no way to tell which.

That is the gap M9 fills, and it is small: after `trip route` runs, the
database already holds both the model's estimate and the measured value for
every leg. The comparison is a derivation, not a new measurement.

## What is still NOT established

- **The mechanism behind finding 1.** Stated above and deliberately unmeasured.
- **Four cities is four cities.** All are major, well-mapped, tourist-heavy
  places. Nothing here measures a small city, a poorly mapped one, or a
  non-Latin script other than Chinese and Thai.
- **Seven places per city, chosen for being famous.** They geocode more easily
  than a name pulled off a video transcript, which is M6's actual input.
- **Terrain is a label, not a measurement.** "Hilly" and "flat" are assertions
  about these four cities, not derived from elevation data. The asymmetry
  gradient is consistent with grade and does not prove it.

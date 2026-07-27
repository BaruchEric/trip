# M10 — the plan leaves the terminal, and takes its doubts with it

*Brainstormed with Eric, 2026-07-27. Scoped to M10 only. Second of the four
milestones he asked for with "all of it". He chose all three formats.*

## Objective

`trip export` writes the plan as iCalendar, Markdown and GeoJSON, and none of
the three claims to know something the plan does not.

Done when the Chongqing plan opens in a calendar with its five unknown-hours
segments marked tentative, when the segment that could not be placed is still
visible in every format, and when the export and the terminal cannot disagree.

## Governing principle

Unchanged, all of them. M10 adds:

**A format's confidence is not the same as the plan's confidence.** A terminal
can print `?`. A calendar event cannot — it says "be here at 10:36" in the same
voice whether the hours are known, guessed, or unknown. Exporting is where a
carefully-hedged plan becomes an assertion, unless the exporter works to stop
it.

## What the pitch got wrong

This milestone was pitched three times as "a lossy format cannot represent
absence". Having read both specifications, that is mostly false:

- **iCalendar has `STATUS:TENTATIVE`** — RFC 5545, *"Indicates event is
  tentative"* — a standard field for exactly the project's `?`. Plus `GEO`,
  `LOCATION`, `DESCRIPTION`, and legal `x-prop` extensions on a VEVENT.
- **GeoJSON has `"geometry": null`** — RFC 7946, *"in the case that the Feature
  is unlocated, a JSON null value"*. A first-class representation of a place
  whose location is unknown, which is precisely Wulong Karst.
- **Markdown loses nothing**, being prose.

Two standards already solved most of this. **The milestone is the residue**:
the facts that genuinely have no home, named below rather than discovered
during implementation.

## What a real plan actually knows

Measured on a realistic Chongqing trip — 7 segments, 3 days, 2 travellers:

| fact | count |
|---|---|
| placed segments | 6 |
| **opening hours UNKNOWN** | **5 of 6** |
| **price UNKNOWN** | **4 of 6** |
| price known and zero (free ≠ unknown) | 1 |
| hops | 3, **0 measured** |
| **not placed at all** | **1** — Wulong Karst, no coordinates |
| trip total | `10 + 4 unknown`, not `10` |

A naive calendar export would emit six confident events and drop every one of
those qualifications.

## Decisions

**D1 — export reads STORED placements, and never re-plans.**

`trip plan` compiles fresh and saves; `trip day` reads what was saved. They can
already differ, if pins or segments changed since the last plan. Export follows
`trip day`: **the user exports the itinerary they approved, not a new one
computed on the way out.** With nothing stored it errors and names `trip plan`,
exactly as `trip day` does.

**D2 — one shared build, three renderers.** Export uses the same placements,
the same `withLegs` travel model and the same `buildPricing` as the plan
commands. This is not tidiness: M8 shipped `trip day` rendering no hop lines
while `trip plan` rendered them, because a second call site was missed. Export
is the command whose entire job is faithful reproduction, so a divergence here
is the same defect in the worst possible place. **A cross-command test asserts
export and `trip day --json` agree on every start time and every
measured/estimated flag.**

**D3 — unknown hours become `STATUS:TENTATIVE`; known hours become
`STATUS:CONFIRMED`.** The one place a calendar can natively say "this might be
wrong". Five of six Chongqing segments are tentative, and that is the honest
number.

**D4 — an unplaced segment appears in all three formats, and this costs
something in ICS.**

- **GeoJSON**: a Feature with `"geometry": null`. Exact, standard, free.
- **Markdown**: its own section, with the reason.
- **iCalendar**: an **all-day `VEVENT` on the trip's start date**, titled
  `Not planned: Wulong Karst - no coordinates`.

**The ICS case is a compromise and the spec records it as one.** A VEVENT needs
a date, and this segment has no day — so the exporter picks one, which is the
tool inventing a fact it explicitly could not determine. The mitigation is that
the SUMMARY leads with `Not planned:` and carries the reason, so the date reads
as a placeholder rather than a claim.

`VTODO` is the semantically correct choice and is **rejected**: Google Calendar
ignores VTODO components entirely, so the item would vanish silently. A
silently dropped "could not place this" is the exact failure this project
exists to prevent. Visible and slightly wrong beats correct and invisible.

**D5 — the unknown-count trailers are carried in all three, visible in one.**

`{"total": 10, "unknown": 4}` is the most load-bearing fact the plan produces
and neither ICS nor GeoJSON has a natural slot:

- **Markdown**: rendered in full, including the per-traveller breakdown.
- **iCalendar**: `X-TRIP-PRICE-TOTAL` and `X-TRIP-PRICE-UNKNOWN` on the
  VCALENDAR.
- **GeoJSON**: a top-level foreign member `"trip"` on the FeatureCollection,
  which RFC 7946 permits.

Carried as data in all three; **visible to a human only in Markdown**, because
calendar and map clients ignore extension fields. So the ICS `X-WR-CALDESC` and
the GeoJSON `trip` member each state that the Markdown export is the complete
record. That is the honest arrangement: nothing is dropped, and nothing
pretends the calendar shows everything.

**D6 — the per-traveller price breakdown is Markdown-only, and said so.** It
has no home in either other format and inventing one would be worse than
pointing at the file that has it.

## Command surface

```
trip export --format=ics|md|geojson   Write the plan out [--out=<path>]
```

`--format` is required — no default. A default would silently pick one of three
files a user asked for by name.

Without `--out` it writes to **stdout**, so the export composes with a pipe and
an agent can read it without touching disk. With `--out` it writes the file and
prints one line saying what it wrote and how many events, features or sections
it contains — never silently.

`--out` refuses to overwrite an existing file unless `--force` is given. An
export that silently replaces a file the user edited is data loss.

## Format details

**iCalendar.** `VERSION:2.0`, a `PRODID` naming trip, one `VEVENT` per
placement, plus one per unplaced segment. Per event: `UID` derived from trip
and segment id so re-importing updates rather than duplicates; `DTSTART`/`DTEND`
in the trip's local dates as floating times, because the trip has no timezone
field and inventing one would be a fact the tool does not have; `SUMMARY` from
the display name; `GEO`; `LOCATION` carrying the local-script name where it
differs; `STATUS` per D3; and a `DESCRIPTION` carrying the travel line
(`22 min walk (measured)` / `6 min walk (estimated)`) and the price
(`10 CNY`, `free`, or `price unknown`). Machine-readable duplicates ride as
`X-TRIP-PRICE`, `X-TRIP-TRAVEL-MINUTES`, `X-TRIP-TRAVEL-MEASURED`,
`X-TRIP-HOURS-KNOWN`.

Lines are folded at 75 octets per RFC 5545, and `,` `;` `\` and newlines are
escaped in TEXT values. Chinese names make the octet-vs-character distinction
real: folding by character would split a multi-byte sequence.

**GeoJSON.** A `FeatureCollection`. One `Point` Feature per placed segment,
coordinates in **longitude, latitude** order per RFC 7946 — the order that
silently puts Chongqing in the Indian Ocean when reversed. One Feature with
`"geometry": null` per unplaced segment. One `LineString` Feature per hop,
carrying `measured` as a boolean, so the map shows what M8 measured: Testbed 2
and Liziba look 360 m apart and are 22 minutes apart on foot. Properties use
`null` for unknown throughout, never 0 and never omission.

**Markdown.** Day headings, a table per day, the travel lines with their
measured/estimated marker, the per-traveller breakdown, the unknown-count
trailers, the unplaced section with reasons, and — where legs exist — the
calibration figures from M9. The complete record, and the one the other two
point at.

## Testing

- **Every format renders the same Chongqing plan** from a fixture database, and
  each is asserted to contain the unplaced segment.
- **`STATUS:TENTATIVE` appears exactly five times** and `CONFIRMED` once, which
  is the measured shape of that trip.
- **The GeoJSON validates structurally**: every Feature has `type`, `geometry`
  (object or `null`) and `properties`; no `coordinates` member on a Feature.
- **Unknown is `null`, free is `0`**, asserted separately in GeoJSON — the M5
  distinction, in a new place.
- **Line folding is by OCTET**, asserted with a Chinese name long enough to
  cross the boundary mid-character.
- **Cross-command:** export and `trip day --json` agree on every start time and
  every `measured` flag (D2).
- **A mutation sweep**, each proving its anchor landed.

## Out of scope

- **HTML and PDF.** Markdown is the document format; converting it is somebody
  else's tool.
- **Timezones.** The trip has no timezone field, so ICS times are floating.
  Adding one is a schema change and a different milestone.
- **Round-tripping.** Export writes; nothing reads it back.
- **`RRULE`, alarms, attendees.** A plan is not a meeting.
- `cost_bands` and `trip budget` (M11), transit (M12).

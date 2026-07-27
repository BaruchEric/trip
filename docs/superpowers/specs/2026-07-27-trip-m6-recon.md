# M6 reconnaissance — the first real end-to-end run

**Measured 2026-07-27** against `youtube.com/watch?v=KHHlcCUTwZA`
("4 Days in Chongqing, China 2026", uploader Lais), the video bookmarked in
the repo root. Captions, not whisper: 175 lines, 12,670 chars.

Trip: `chongqing`, destination geocoded, `trip when` returned a full climate
table (Jan/Feb best, Jun–Aug oppressive). Scratch DB, live Nominatim.

## THE MEASUREMENT

**Raw ASR names, as the captions actually said them: 1 of 11 geocoded.**
Ten queued, every one of them `no match` — not a wrong match. The safe
failure direction M3 and M4 designed for, holding on real data.

**After correcting every name by hand via `--rename`: 4 of 11.**

| # | Caption said | Actually | Outcome |
|---|---|---|---|
| 1 | Arat Temple | Luohan Temple | **segment** 罗汉寺 1000 лет |
| 2 | Longman how old street | Longmenhao Old Street | no match |
| 3 | Wulong casts | Wulong Karst | no match |
| 4 | Tienfu Post House | Tianfu Inn | no match |
| 5 | Fisher Gorge | Longshuixia Fissure Gorge | no match |
| 6 | Don Shan Cafe | Dongshan Cafe | no match |
| 7 | Shabbati | Shibati | 2 candidates |
| 8 | Hongadong | Hongya Cave | **segment** 洪崖洞 |
| 9 | Test Bed Creative Park | Testbed 2 | **segment** 贰厂文创园 |
| 10 | Ring Shopping Park | (correct as spoken) | **segment** 光环购物中心 |
| 11 | Ji Fang Bay Pedestrian Street | Jiefangbei Pedestrian Street | type mismatch |

## Findings, ranked by how much they should shape M6

**1. ASR mangles nearly every proper noun.** Ten of eleven place names in the
captions are corrupted. Geocoding raw extractor output is a 9% proposition.
The correction has to happen agent-side, during extraction — which the M3
design says is the agent's job and which nothing has ever tested.

**2. The budget breakdown exists only on screen.** The transcript's last line
is `[19:29] As promised, here is a budget breakdown on my four days in
Chongqing.` and then it ends. Every price in this video is invisible to a
transcript-only pipeline. This is exactly the gap M5's ledger named as its
largest, and it turns out to be structural rather than incidental.

**3. `review ls` shows the PRE-RENAME text.** `render-review.ts:25` renders
`m.text`, not `m.name` (which is `resolvedName ?? text`). After a `--rename`
that still fails, the queue displays the original mangled name, so you cannot
see what is actually stored or what was queried. A second attempt looks like
it is operating on the original. **Real defect, found only by running this.**

**4. M4's plausibility check fired correctly in production, for the first
time.** `Jiefangbei Pedestrian Street` → `type mismatch: expected street, got
tourism/hotel`, reached through `--rename` — a different code path than the
one M4 measured. M4's mechanism is now confirmed on live data.

**5. `Ring Shopping Park` geocodes fine — and M4's appendix has a SECOND
query discrepancy it never caught.** Verified four ways rather than one:

| viewbox | `addressdetails` | result |
|---|---|---|
| M4's appendix box | off | n=0 |
| M4's appendix box | on | n=0 |
| production box | off | **n=1** shop/mall way/1295738129 光环购物中心 |
| production box | on | **n=1** same object |

So it is **not** `addressdetails` — that was my first hypothesis and it was
wrong. It is the **viewbox**. M4's appendix hand-types
`106.35,29.65,106.65,29.45`, whose half-widths are ~11.1 km of latitude and
~14.5 km of longitude. `viewbox(centre, 25)` computes 25 km on both axes.
光环购物中心 lies between the two boxes.

M4 found the `addressdetails` discrepancy in that same appendix and corrected
Hongya Cave in place. A second discrepancy in the same four lines went
unnoticed — and it is the one that produced M4's conclusion that "M3's
evidence base was four points; three reproduce". That conclusion is wrong:
all four reproduce through the query the code actually makes.

The M4 lesson holds harder than M4 stated it. One corrected parameter is not
the same as a query that matches production.

**6. OSM's name field can carry foreign-script junk.** Luohan Temple's
`localName` is `罗汉寺 1000 лет` — Russian, mid-field. It renders verbatim
into the segment name, so `seg ls` shows `Luohan Temple (罗汉寺 1000 лет)`.

**7. Five places are described but never named.** The skywalk with panoramic
views; the Line 2 metro passing through a residential building (Liziba); the
square that is street level and the 22nd floor at once (Kuixinglou); an
evening riverfront viewpoint; the hot pot restaurant in a wartime air raid
shelter. A transcript-only pipeline cannot name any of them.

**8. Correct names still miss.** Longmenhao Old Street, Dongshan Cafe, Wulong
Karst, Tianfu Inn and Longshuixia Fissure Gorge return nothing — and Wulong
Karst returns nothing **unbounded**, so this is OSM coverage under English
names, not the 25 km box. Worth stating precisely: the box is not the culprit.

**9. Every segment landed `[default]` dwell and `?` hours.** No dwell and no
opening hours have ever come from a video. The compiler is scheduling four
segments blind, and `trip plan` says so.

**10. Rolling captions duplicate text.** Each line repeats the tail of the
previous one. The stored transcript keeps this, so any extractor reads every
sentence roughly twice.

## What this says about M6's shape

The run itself was the cheap part. The findings split cleanly:

- **Defects to fix** — #3 is a straightforward, real bug.
- **Contradicted record** — #5 means the M4 spec needs correcting, the way M4
  corrected its own Hongya Cave evidence in place.
- **Capability gaps** — #1, #2, #7 are not bugs. They are the boundary of what
  a transcript-only pipeline can do, now measured rather than assumed.
- **Data quality** — #6, #8 are OSM's, not ours.

## PROVEN, not hypothesised: the budget is readable in two frames

`watch.py` already supports `--max-frames`, `--resolution`, `--start`, `--end`
and writes to `<work>/frames`. `trip`'s `watchArgv` pins `--max-frames 1`
purely to avoid the cost — there is no missing capability, only a closed dial.

Run directly over 19:25–20:20 at 900px, 12-frame cap: two frames extracted,
and the second one carries the whole thing.

```
Budget Breakdown
Transportation:      $40
Accommodation:      $230
Activities & food:  $131

Total (USD):        $401
```

Four days in Chongqing, $401. **No OCR dependency was needed** — the frame was
read by the agent, which is design decision 1 (agent-native CLI, no LLM inside
the binary) working exactly as intended. The tool's whole job is to put frames
where the agent can see them.

That shape — transportation / accommodation / activities+food per trip — is
`cost_bands`' shape. The parked schema M5 deliberately left untouched
(`lodging_tier`, `food_tier`) now has its first real data point.

Frame saved at `m6-fixtures/budget-breakdown-frame.jpg`.

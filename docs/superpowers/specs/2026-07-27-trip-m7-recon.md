# M7 reconnaissance — what frames actually buy

**Measured 2026-07-27**, same video (`KHHlcCUTwZA`), using the frame dial M6
shipped. The milestone was picked as "frames for the five places the
transcript describes but never names", and was flagged during scoping as
possibly too thin to be a milestone. It is not thin. The frames led somewhere
else entirely.

## What the frames showed

Four windows pulled through the shipped `trip watch frames`.

| window | what the frame carries | confidence |
|---|---|---|
| 04:35–05:05 | a curved cliffside skywalk over the city | a guess |
| 04:35–05:05 | **the Line 2 monorail leaving the Liziba block** | near-certain |
| 13:50–14:10 | a plaza flush with the ground, 22 storeys above the street | recognised, not read |
| 18:10–18:30 | **signage: 防空洞老火锅** | read off the image |

**Frames produce evidence of wildly varying confidence, and the difference is
not a detail.** Liziba is near-unique on earth and recognisable outright. The
22nd-floor plaza is recognisable only if you already know Chongqing — the
frame confirms the *phenomenon* the transcript described and carries no name.
The skywalk is a guess. Only the hot pot frame carries a NAME, and it carries
it in Chinese.

## THE FINDING, which is not about frames at all

M6 measured that five *correct English* names still missed. M3 records that
Nominatim is queried without `accept-language`, so results come back in local
script. Putting those together: the frames' Chinese signage suggested the
misses might be a **script** problem rather than a coverage problem.

Tested against the production query:

| English | n | local script | n |
|---|---|---|---|
| Longmenhao Old Street | **0** | 龙门浩老街 | **1** `landuse/commercial` |
| Kuixinglou | **0** | 魁星楼 | **1** `place/square 大唐广场` |
| Dongshan Cafe | 0 | 东山咖啡 | 0 |
| air raid shelter old hot pot | 0 | 防空洞老火锅 | 0 |
| Shibati | 2 candidates | 十八梯 | **5 candidates** |
| Liziba | 3 | 李子坝 | 3 `railway/station` |
| Testbed 2 | 1 | 贰厂文创园 | 1 |

**Local script recovers two of the five English misses.** It does not recover
the other two — OSM genuinely lacks 东山咖啡 and 防空洞老火锅, so M6's
"coverage" finding was half right and half a script artefact, and neither half
was distinguishable before this.

**It is not uniformly better.** 十八梯 goes from 2 candidates to 5 — more
ambiguous, so more likely to stay queued. A rule of "always query in local
script" would be wrong.

**A place the video never NAMES becomes findable once a frame lets you name
it.** 李子坝 returns a `railway/station`. That is the original M7 premise,
confirmed — but it is the smaller half of what was found.

## The mechanism already exists, and nothing said so

`trip review resolve 1 --rename="龙门浩老街"` **works today** and resolves the
segment. No code was needed. This is the same shape as M6's ASR finding: the
workflow supported the fix all along and the contract never mentioned it.

## AND IT BREAKS M3 DECISION 4

Renaming to local script to make the geocode work **destroys the name the
traveller can read**:

```
SEGMENT: name=龙门浩老街  local_name=龙门浩老街
MENTION: text="Longman how old street"  resolved_name=龙门浩老街
```

`seg ls` now shows `龙门浩老街` and nothing else, because `displayName` only
renders `localName` in parentheses when it *differs* from `name`.

M3 decision 4 is explicit:

> `name` is what the video called it — **the string Eric will recognise** — or
> the corrected name if the mention was renamed during review. `local_name`
> holds OSM's, rendered in parentheses when it differs.

The design assumed a rename is a **spelling correction**. A rename is now also
a **script switch**, and the two need opposite handling: one should replace
the name, the other must not. Follow this technique across a whole video and
the compiled plan is entirely in a script Eric cannot read — which is the
exact failure decision 4 was written to prevent, reached by the route that
makes geocoding work.

The video's words survive on the mention, so nothing is lost from the record.
They are simply not what the plan shows any more.

## What this suggests M7 is

Not "frames identify places". That is the small half and it is only sometimes
true. The milestone is:

**The string you SEARCH by is not the string you CALL it.** The schema already
half-knows this — `mentions.text`, `mentions.resolved_name`, `segments.name`,
`segments.local_name` are four distinct fields — but `--rename` collapses the
search string and the display name into one, and that collapse is invisible
until you rename across scripts.

Open question for the design: whether that is a new flag (`--query=` beside
`--rename=`), or whether `--rename` should stop overwriting the display name
when the new string is a different script, or something else. Deciding that by
guessing is how you get a magic rule; it needs to be chosen deliberately.

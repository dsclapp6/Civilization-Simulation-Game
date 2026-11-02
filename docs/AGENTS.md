# Agents: the living detail zone (`src/agents`)

Entry point: `installAgents(sim, { economy, social }): Zone` (a `ZoneApi`). It registers the `agents.zone`
per-step system (order 60), feeds the view sources `characters` and `animals`, chains `sim.hostileNear`
(hostile animal within `FAST_SPEED_HOSTILE_RADIUS`) and sets the social module's `awakeHook`. Dev page:
`?mode=village` (`src/agents/dev/villageViewer.ts`); screenshots: `node tools/village-shots.mjs` → `docs/agents/`.

The zone is a pure observer: it writes nothing to the simulation state and uses no random stream (visual
variation comes from `hash01`), so saves are unaffected (tested: state hash equal with and without it,
and across save → load → continue). That includes what it *reads*: asking for prices (`economy.holding`, for the livestock) no
longer creates a market's record (`market.ts marketStocks`), which is what used to make the hashes differ in the first game hours.

## Schedules and whereabouts (`schedule.ts`, `places.ts`)

`whereabouts(person, absDay)` is a deterministic function of person, calendar day, season daylight and weather.
The day hangs on sunrise/sunset with a per-person jitter: rise, chores at the door, work, the midday meal, work,
evening, bed. Holy day: dress, walk to church, Mass (indoors), the churchyard, then leisure (men and youths 14–60
at the archery butts, else a handful on the green lane; the alehouse; gossip; play; elders sit). Market day: sellers
at the stalls, shoppers drift about the square, and about one adult in six from villages whose market town it is
walks in (appearing at the gate, leaving at noon). Night: indoors asleep, except the watch (garrison and some
burgesses, torch in hand) and a few revellers. Bad weather sends outdoor workers home / indoors. The sick are in bed.

**A day is ten minutes** and people *walk* between the stretches of it, at the speed of people (see *Walking and running* below). A
stretch has a `from` and an `until`; the schedule gives the walk to the next place a window by distance, pace and ground (`tripDays`:
the path is 12 % longer than the straight line, each person walks at their own pace — `pace.ts` `walkSpeed` — over the ground they
cross — marsh, woodland floor and slopes take longer, `groundTime` — and a long way is walked briskly, up to `MAX_HURRY` times that;
6 s at least, 204 s (`TRAVEL_MAX` 0.34 of a day, 260 m at a brisk pace) at most) and sets the person off that long before the next
stretch begins, so they are there when it does (`Intent.leave`, `travel` < 1, `prevX/prevZ` the origin, `arrive` the time the walk
is due to end). A walk is over before the stretch it leads to is; someone who goes indoors stays at least a few seconds (they are
not seen going in and coming out at once). A long way after a short stretch spills into the next one — and a walk that began two
stretches back, when the stretch between is a stay at the same place (a packed meal), is still on (the walk's tail). While a walk is
on the intent *is the place being walked to* (activity, building, indoors), `leaving` marks a walk to the edge of the settlement to go
away (a market trip); `away` means gone. The morning chores are 0.045 of a day long. Nobody goes home for the midday meal unless home is
within 25 m of where they are: a packed meal where they work (field, bench, well, market…).

`economy.workSpot` wins when it returns a spot. Otherwise career defaults: farmers to their household's strips
(serfs two days in three to the demesne), smiths/carpenters/bakers/millers/… to the door of their workshop with
the right animation and tools, alewives to the brewhouse/alehouse, shepherds to a pasture point (their flock
follows them), priests to the church, soldiers to gate/walls/drill, monks and nuns keep the hours, servants run
errands for their own household, children play, fetch water, mind animals or go to the priest for lessons, butchers to the
slaughterhouse and woodwards to the lumber camp when the settlement has one. **Anyone the construction module puts to work on a site
goes to the site instead** (see *Construction sites*).

## Zone (`zone.ts`)

Focus = the attached player's draw item, else `sim.view.focus()`. People outdoors per their whereabouts within
250 m become agents (leave at 280 m), nearest first, cap 300, spawned by a time-sliced scan (≤ 1 ms). Agents spawn
where the schedule says now, mid-walk if travelling. `resync()` runs on skip end, character switch, run start,
leaving map/travel; no agents in `map`/`travel` mode. Summoned people/animals (`summon`, `summonAnimal`) and
claimed horses are exempt from cap and hysteresis. Agents **walk** their trips (`behaviour.ts`, *Walking and running* below). Only what
no one can see is skipped (`SEEN_RADIUS` 190 m): a trip that starts and ends beyond it is finished instantly, a trip into view starts
at the edge of it, one out of view ends there (a destination beyond the zone's reach: the person just leaves it); nothing within sight
is carried across the street — a walker held up by a crowd is satisfied with being near enough, or waits and looks again, and is only
put at their goal when nobody can see. A person who goes in at a door (or out of the settlement) ahead of the schedule is kept out of
the scan until the schedule has them arrive too (`Zone.hide`), so they are not put back on the street; one who is scheduled to leave
again at once does not go in.

### Nameplates and names (`plates.ts`; place names in `src/sim/placenames.ts`, re-exported as `names.ts`)

Every agent's draw item carries `label` (the full name), `sublabel` (relation · role from `social.relationLabel` and the career or
office: "your father · farmer", "the reeve", "Lord of Dromore", "Siobhan's apprentice", "tenant · from Slievecairn"), `labelTone`
(player, kin, household, friend, rival, enemy, lord, clergy, stranger), `labelRange` (kin, household, people with a task for the
player and the tracked person 40 m, rivals and enemies 30 m, everyone else 15 m) and `mark` (`'quest'`, a gold "!", for anyone who
has something for the player; `'turnin'`, a silver "?", for the person a finished task can be handed in to; `'track'` for the tracked
person — a hand-in outranks a task outranks being looked for). A spoken line (`say`) takes the place of the plate while it lasts. The plate is worked
out when an agent spawns and every ~4 s after. Optional hooks on the `ZoneApi`: `setQuestMarks(marks)` (civilization pass: the
objectives module passes every mark, `{ person, kind: 'quest' | 'turnin' }`, replacing the previous set; open happenings requests
are always "!"), `setQuestGivers(ids)` (the older form: "!" marks only, replacing everything), `setTrackedPerson(id)` (0 clears) and
`markedPeople()` (who is marked and where — an agent where they stand, anyone else by their schedule, indoors or not — for the compass
and the minimap; the objectives' `marks()` says what each is about). `interactables` labels things with real names (the objectives module names buildings and strips through the same functions, so the
tracker, the journal and the tooltip agree): "Your home", "Wat's smithy", "St Mary's church", "The Bell (alehouse)"
(saint and inn sign by a hash of the settlement and building), "Your family's east strip · barley, ripe", "The lord's north-east
strip · stubble", "Common pasture", "Oak".

## Walking and running (`pace.ts`, `behaviour.ts`, `config.ts`; docs/CIV.md §3)

* **Paces** (`pace.ts`): a person walks at their own `walkSpeed` — 1.3 m/s for an adult of average agility, 1.1–1.5 m/s by build,
  agility and age, the old, the young and the hurt (or lame) slower — slowed by what they carry (`loadFactor`) and the ground, which
  speeds a walker up by 8 % at most (a road). They hurry up to `MAX_HURRY` (1.3×, a brisk 1.9 m/s at the very most: nothing between a
  walk and a run is ever asked for, `gaitSpeed`) when they would otherwise be late, and **jog at 2.8–3.6 m/s (`runSpeed`) only when
  badly late** (they would be more than `JOG_START` 45 s late even hurrying; they stop at `JOG_END` 10 s) **and able** (`canJog`: the
  young and quick, soldiers, pages, squires, servants and peddlers; not the old, the hurt, clergy or the great, and not most grown
  villagers, who just arrive late) — or in danger (the `flee` order), or as children at play (short bursts).
* **Setting off and arriving**: the schedule sets a person off early enough for their own pace (above), so most walk their own pace and
  arrive a little early. While a scheduled walk lasts the pace is looked at again once a second (`paceFor`): the way left against the
  time left, hurrying or jogging as needed, back to a walk when they have caught up. Walkers ease into a stride and into a stop
  (`ACCEL` 1.9, `DECEL` 3.2 m/s²), step aside for others without ever going faster than a walk, and are slowed near the end of the way.
* **The clip follows the ground speed**: the renderer's gait (`assets/characters/human/locomotion.ts`) takes its cycle frequency and
  stride from `draw.moveSpeed` (m/s of real time = ground speed × the clock's speed); the zone feeds it the ground speed smoothed over
  a fraction of a second (no stutter from a nudge), and chooses the clip from it: `walk` (`carry_walk` with a load) up to 2.0 m/s, `run`
  above, with hysteresis (on at 2.0, off at 1.8) so the clip does not flicker. A person at a door, at a spot or in a bout has speed 0.
* **No speed-ups or warps in sight**: walkers are hurried along (`WARP_MAX` 1.8×) only beyond `SEEN_RADIUS`, where they are a few pixels
  high. A path that ends short of the goal (the goal is beyond the map the navigation knows, or beyond a search box) goes on from where
  it ends (`Agent.cont`), and the unseen end of a long walk is finished off-screen.
* **Measuring**: `npx tsx tools/walk-check.ts` plays a day of a village (the player at the green and among the strips), the same village
  on the holy day, a market town on market day and a castle at 1×, and tells the distribution of the ground speeds of everyone in sight
  by clip, who runs, how well people keep the schedule and the rhythm of the day. Acceptance (CIV §3), checked in
  `tests/agents/walkcheck.test.ts`: at least 98 % of the walking movement at 2.0 m/s or slower, every faster movement on the run clip, no
  jump above 1 m in sight. `src/agents/dev/walkMeter.ts` is the measuring.

  | the five scenes, 1× | before | after |
  |---|---|---|
  | walk-clip movement at 2.0 m/s or slower | 55–93 % (67 % overall) | 100 % |
  | walk clip, median / 98th percentile / fastest (village) | 1.97 / 3.36 / 5.05 m/s | 1.33 / 1.80 / 1.97 m/s |
  | movement faster than 2.0 m/s that was not on the run clip | 409 456 samples | 0 |
  | steps of more than 1 m in sight | 15 (up to 12.6 m) | 0 |
  | share of the movement that is a run | 34–38 % (village, fields, holy day, town) | 0.7–8.4 % (children at play, a few jogging youths and servants) |

* **What it costs the day**: a ten-minute day is 144 times shorter than a real one and people now walk at real speeds, so a field 300 m
  away is a four-minute walk: farmers whose strips lie 230–430 m from the village are on the road for about 70 % of the day (measured
  53–79 %; `tests/agents/schedule.test.ts` guards it) — out at dawn, back at dusk — and the long ways are walked briskly (up to
  `MAX_HURRY`). A walk is given at most `TRAVEL_MAX` (0.34 of a day, 204 s); whoever is still on the road when the schedule says they
  have arrived is late (seconds late in the village: median 0.3, 90th percentile 13.5). That is the day's real shape on this scale; a
  nearer field system, a longer day or (for the player) a faster clock are the ways to change it, not faster people.

## Construction sites and buildings raised in play (`sites.ts`; docs/CIV.md §5)

* **Workers at a site**: `SiteWork` asks `sim.services.construction` (lazily and guarded: no module, no sites or a failing module change
  nothing) for the sites and `workersAt(site)`, once an hour and whenever `version()` changes, and for the members of a household whose
  plan task (`economy.householdPlan`) is `'build'`, who go to that household's first site. The schedule sends them there in work hours
  (any age from 12) instead of their usual work; on the holy day, in the evening and at night they keep to their own day, and in heavy
  rain they wait at home. Where they stand (a place on the ring round a solid footprint, 1.7–2.7 m out; inside an open one such as a
  quarry) and what they do follows the stage and the material (`siteSpot`): footings are dug and the first stone or timber fetched
  (progress < 0.2); then timber is sawn, framed and hauled from the pile, or stone dressed with a chisel, laid and carried; then the roof
  is nailed, thatch and timber carried up and doors fitted; repairs hammer or saw; demolition picks and hammers and carries off the rubble.
  Haulers walk back and forth between the pile in front of the site and the work with the load in their arms (`Mode.Errand`), hammering
  between trips. The same person does the same work all day (by a hash of person, site and day).
* **Buildings raised in play** (`plot` −1) are used by the zone like the others: the navigation sees them put up or pulled down —
  footprints are compared by a hash when the revision *or the number of buildings* changes — a site is solid from the first stake,
  `Places` (homes, workshops, alehouses, the church, stalls…) lists a building only when it is finished (`construction` 1; an upgrade of
  a building from the world keeps working), a home is wherever the household's `home` points, and the building index of the interaction
  finder follows the count; a building still going up is called "…(being built)". The doors of the five new kinds: the slaughterhouse
  has the tannery's (`geometry.ts` `DOOR_X`), the clay pit and the salt pans (the quarry's model) none, the lumber camp (the sawpit's) and the gaol (the granary's) in the middle;
  re-measure them when the real models come (wave B).

## Led animals (`lead.ts`, `animals.ts`; docs/CIV.md §8)

* **Lead / Let go** are actions on `sim.actions` (provider `agents.lead`) on a tame animal of the player's own household (horse, ox, cow,
  sheep, goat, pig — not birds, dogs, cats or other people's): *Lead the pig* (`lead.start`, instant, range 3.2 m), *Let go of the pig*
  (`lead.letgo`), and on the player *Let go of the animals* (`lead.letgo.all`). Up to `MAX_LED` (4) follow; the fifth is refused with a
  reason. API for others: `ZoneApi.leadAnimal(id, person)`, `releaseLed(id)`, `ledBy(person)`, `ZoneAnimal.leader`.
* A led animal walks to a place behind its leader (alternately to either side, further back for each) at the leader's pace — trotting
  when it has to keep up or catch up — and stands by when the leader does (a pig does nothing; the others crop the grass). When the
  leader is out of sight (in at a door, left the zone) it waits where it is, and is let go after 90 s; if it is left more than 30 m
  behind for 10 s the halter slips (a notice). A released animal stays about where it is and goes back to its routine (and home at dusk).
  A led horse that the player mounts is released.
* **The herd follows the household's stock**: `livestockOf` keeps the day's list of a household's beasts unless its stock of animals
  changes (`animalSignature`, a cheap look at the stores), and `reconcile()` — every 1.5 s — compares each household's drawn beasts of a
  kind with what it keeps and lets the surplus go (the led one first, then the farthest from the player); those that left are not put
  back that day. Ids are stable by kind (`1 000 000 + household × 64 + KIND_BASE + index`) so one kind changing does not renumber the
  others. Slaughter and sale (economy) therefore need only change the household's stores.

## Navigation (`nav/`)

Torus window of 256×256 cells of 2 m (512 m) built in 32 m tiles, incrementally (≤ 1.8 ms/frame, at most one cold
scatter chunk per call) and on demand when a query needs a tile. Terrain cost bytes from `walkCostAt` (yards and
cobbles treated as trodden), solids from building footprints (oriented boxes, diffed by geometry so the sim's hourly
building-flag changes cost nothing), tree trunks and large rocks from scatter (minus felled). A* (weighted, 9000
expansions max) with thick line-of-sight string pulling; exact circle-vs-box/circle sliding `move()` (large steps
sub-stepped); bridge decks follow the renderer's deck profile; `doorOf` uses the door offsets measured from the
building recipes. Path requests are queued, nearest-to-focus first, ≤ 1 ms/frame.

## Behaviour, animals, interaction

Agents follow paths with separation (lower ranks and the player's inferiors yield), queue at doors, work in bouts
with breaks, sit, chat in facing groups, run and chase (children), shoot at the butts, kneel to lords, wave to kin,
look at the player, greet through `social.bark` (null = silent). Livestock come from `economy.holding` else defaults
by career; day pasture/yard, night folded away (sheep, dogs, cats stay); flocks follow shepherds, dogs follow owners.
Wildlife per 64 m chunk (deer, boar, fox, hare; wolves at night/winter in remote woods circle at 50 m+ and are
hostile). `interactables` scores by distance and facing; strips/parcels via point-in-polygon, trees/rocks with scatter ids.

## Budgets (measured, shared 4-core machine)

300 agents + 150 animals: ≈ 1.1 ms per sub-step at 1× (agents 0.5, paths 0.3, animals 0.1, scan 0.1; up to
≈ 2.4 ms under heavy machine load), ≈ 3–5 ms/frame at 8×; path search ≈ 0.15 ms avg; nav tile ≈ 0.3 ms.
A village of ~110 agents through a whole ten-minute day: 0.36 ms per sub-step on average, 2.7 ms at the 99th percentile, ~4800 path
searches (walking everything in sight needs more of them than the old instant trips did; they stay well inside the 1 ms/frame
budget).
Tests: `tests/agents/` (schedule, nav, zone, perf).

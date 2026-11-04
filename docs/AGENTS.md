# Agents: the living detail zone (`src/agents`)

Entry point: `installAgents(sim, { economy, social }): Zone` (a `ZoneApi`). It registers the `agents.zone`
per-step system (order 60), feeds the view sources `characters` and `animals`, chains `sim.hostileNear`
(hostile animal within `FAST_SPEED_HOSTILE_RADIUS`) and sets the social module's `awakeHook`. Dev page:
`?mode=village` (`src/agents/dev/villageViewer.ts`); screenshots: `node tools/village-shots.mjs` → `docs/agents/` (the village scenes) and
`node tools/village-law-shots.mjs` → `docs/agents/law-*.png` (the law, the watch, the riders and the called horse in the whole game; docs/LAW.md).

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

**A day is thirty minutes** and people *walk* between the stretches of it, at the speed of people (see *Walking and running* below). A
stretch has a `from` and an `until`; the schedule gives the walk to the next place a window by distance, pace and ground (`tripDays`:
the path is 12 % longer than the straight line, each person walks at their own pace — `pace.ts` `walkSpeed` — over the ground they
cross — marsh, woodland floor and slopes take longer, `groundTime` — and a long way is walked briskly, up to `MAX_HURRY` times that;
6 s at least, 600 s (`TRAVEL_MAX`, kept in real seconds — a third of a thirty-minute day — about 850 m for an average adult at a brisk pace) at most) and sets the person off that long before the next
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

* **What it costs the day**: a thirty-minute day is 48 times shorter than a real one and people walk at real speeds, so a field 300 m
  away is a four-minute walk, a fifth of an hour of the game day. Farmers' strips lie 100–500 m from their doors (a few villages
  with little land near, up to 800 m). Setting the person off early enough for the way out (`travelAhead`, `tripDays`) and letting
  the work run to its hour and the walk home follow it into the evening (the *homeward* rule in `tripBetween`: someone who works
  out of doors and goes home for the evening sets out when the work stretch ends, not a walk before it) keeps them at their places
  for most of the daylight: measured over the farming people of every village in four seasons (`schedule.intent` sampled every 0.004
  of a day from sunrise to sunset), they are on the road for 30 % of the daylight and at work for 57 % (before: 39 % and 39 %; on the
  ten-minute day 76 % of it was walking). A walk is given at most `TRAVEL_MAX` (600 s); whoever is still on the road when the
  schedule says they have arrived is late (seconds late in the village scene of `walk-check`: median 0.4, 90th percentile 34, longest
  89). The walks, the dwell indoors and the slack before a stretch ends are all in real seconds (`TRAVEL_MIN`, `DWELL_IN`, `DWELL_OUT`,
  `WALK_SLACK`), so a longer or shorter day changes how much of the day they are, not how they look. Faster people are not the way to
  change this; a nearer field system or a longer day are.

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
* **Yards and homes raised in play**: the ground within 7 m of the walls of a finished home raised in play (`plot` −1, a household living
  in it) is that household's own, as a croft garden is: `territory.landAt` reports `kind: 'garden'` and its `household`, so
  `construction/check.ts ownLand` lets the household build a shed or a fence there (`tests/agents/yard.test.ts`). A home still going up is
  nobody's to move into: `succession.pickHome` and `family.HomeAllocator` skip buildings with `construction < 1` (the construction
  module no longer holds the unfinished home in its payer's name to keep families out; `economy/obligations.ts` checks it too).
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
* **Across a zone change** (the player set down elsewhere — a move, the Go-to skip, a load — which re-places everyone, `Zone.resync`): the
  animals on a halter are kept (`AnimalSystem.clear` keeps those with a leader as it keeps summoned and claimed ones, and the leave radius
  does not drop them) and `bringLed()` puts each behind its leader in its place in the line (the player's body as drawn, a nearby
  walkable spot), so Go-to needs no hook of its own; tested in `tests/agents/lead.test.ts` (a few kilometres off, still led, follows on).
* **The herd follows the household's stock**: `livestockOf` keeps the day's list of a household's beasts unless its stock of animals
  changes (`animalSignature`, a cheap look at the stores), and `reconcile()` — every 1.5 s — compares each household's drawn beasts of a
  kind with what it keeps and lets the surplus go (the led one first, then the farthest from the player); those that left are not put
  back that day. Ids are stable by kind (`1 000 000 + household × 64 + KIND_BASE + index`) so one kind changing does not renumber the
  others. Slaughter and sale (economy) therefore need only change the household's stores.

## Riders, orders and the patrol (`pace.ts`, `behaviour.ts`, `agent.ts`; docs/CIV.md §3–4; the law's side in docs/LAW.md)

* **Riders**: `summon(person, x, z, yaw, { mounted, coat, main, off, torch })` makes the person an agent drawn on a horse
  (`CharacterDrawItem.mount` = coat + clip; the body that collides is the horse's, `RIDER_RADIUS` 0.42 m: under the 0.46 m the path planner keeps clear, or a rider clips the corners of his path). A horse **walks 1.7, trots 3.5,
  canters 6, gallops 10 m/s** (`HORSE_*`; the player's horse uses the same numbers, `src/player/movement.ts`). The ground slows a horse and
  never quickens it (a road does not make a gallop faster than 10 m/s); it gathers itself up at 4.2 m/s² and slows at 7; a shove from a
  neighbour adds at most 5 % and 0.2 m/s to a step. Clips follow the ground speed (`rideClips`): `ride_idle` under 0.15 m/s, `ride_walk` to
  2.6, `ride_trot` to 4.8, `ride_gallop` above (the canter is drawn with the gallop clip; the cycle follows `moveSpeed`).
* **Orders** (`ZoneApi.command`; an order stays until another order or `dismiss`): `goto {x, z, run?, gait?}`; `follow {leader, distance}` (a man
  at the leader's pace; a rider at his speed ×1.05 plus 0.6 per metre he lags, never above a canter, standing when he stands);
  `approach {target, distance, gait, side}` goes up to a person who may be moving, tracking him, as fast as ordered when far and slowing
  as he closes (a horse: gallop beyond 70 m, canter beyond 28, trot beyond 12, then a walk; a man: a jog beyond 14 m, then a walk), and
  halts `distance` metres off to one side (−1, 0, 1), facing him; `face`, `perform`, `flee`, `resume`.
* **No warps in sight**: a patrol is summoned at 168 m from the player (inside `SEEN_RADIUS`), so nothing is carried and nobody is hurried.
  Tested in `tests/agents/patrol.test.ts` (gaits, ride up and halt, follow a walker at his pace, ride off and be dismissed) and, with the
  real law and territory, `tests/agents/lawzone.test.ts` (the fastest rider step in a patrol is a gallop; no step above 0.85 m).
* **Sight**: `NavApi.lineClear(x0, z0, x1, z1)` is whether one point can see the other — buildings, walls and trunks only, a metre and a
  half at each end being the standing place; two people within 3.5 m always see one another. (The path planner's own `finder.lineClear`
  keeps a margin for bodies and is for smoothing paths, not for seeing.) The law's watch uses it for who sees a trespasser.

## Towns on alert (`stations.ts`, `schedule.ts`, `zone.ts`, `nav/obstacles.ts`; docs/CIV.md §9)

* **Posts**: `ZoneApi.wallStations(settlement)` lists where the watch stands on a place's finished, standing fortifications — two to a wall
  section along the wall-walk (7 m above the ground, 9 m at level 2), two at the rim of each tower (11 m / 14 m), two over each gatehouse
  (11.5 m; 6.6 m for the timber gate of level 1), two behind the stakes of a palisade (a 1.95 m platform at level 2; none at level 1, the
  men stand on the ground) — facing out. The heights are the building recipes' (`src/assets/buildings/recipes/defence.ts`), as the door
  offsets are. The list is made once per settlement and kept until its buildings change.
* **Levels** (`military.alertOf?(settlement)`, looked at once a second; absent = peace): `'watch'` doubles the night watch (torches in the
  streets); `'alarm'` puts the garrison (soldiers, men-at-arms, archers, knights, squires) on the posts, day and night — archers and
  crossbowmen on the towers and over the gate, the rest along the walls, spear and shield — with the militia beside them (about 45 % of the
  fit men of 16–55 and rank 3 or less, chosen by a hash per day; 30 % of the garrison rests at night); `'assault'`: 70 % of those men are
  militia and everyone else is indoors, "Sheltering from the assault". An unwalled place keeps its ordinary guards. A change of level
  reaches the people of the place within the second. Men go up the way they would: to the foot of the wall, in, and out on the top a few
  seconds later (the scan shows them on their posts, at the height of the walk); coming off alert they go down the same way. Nobody is
  carried up in sight (`tests/agents/alert.test.ts`).
* **Gates and breaches** (`FortView` from `view.forts()`/`fortsVersion()`, applied by `Obstacles.applyForts`): a shut gate is solid; a
  broken gate and a breach of half the wall or more are passable; a lesser breach is not. People standing in a gate that shuts are pushed
  out of the solid (never into it), and the navigation tiles round the change are rebuilt at once.

## Prisoners and the called horse (`schedule.ts`, `animals.ts`)

* A person the law holds (`ScheduleDeps.held` = `law.captivity`) neither works nor travels nor goes to church: he is indoors at the door of his
  cell at every hour of every day, or away (not in the zone) if he is held in another place; with no cell yet (he is being led) the schedule
  only keeps him from his day while the law's walk (the leader's `goto`) takes him there. `tests/agents/prisoner.test.ts`.
* **Hold F** (`ZoneApi.callHorse(person)`): the household's horse — any `horse…` in its stores, including the quality-tagged `horse#1`, which the
  herd signature (`animalSignature`) used not to see — trots to its owner from where it stands in the zone; if it is stabled for the night
  or outside the zone it comes in from the edge of sight (`CALL_EDGE` 170 m) after the time its ride takes, and stands by him. Refused,
  with the reason, when the household keeps no horse or it is beyond the whistle (`CALL_REACH` 900 m). `eta` goes to the HUD. A horse the
  player mounts is claimed and stops answering; a horse bought at a market is the household's already (its stores) and is rideable.
  `tests/agents/horse.test.ts`.
* **Led animals** carry their leader: `AnimalDrawItem.ledBy` is the leader's draw item id (the halter rope; the renderer draws it).

## Navigation (`nav/`)

Torus window of 256×256 cells of 2 m (512 m) built in 32 m tiles, incrementally (≤ 1.8 ms/frame, at most one cold
scatter chunk per call) and on demand when a query needs a tile. Terrain cost bytes from `walkCostAt` (yards and
cobbles treated as trodden), solids from building footprints (oriented boxes, diffed by geometry so the sim's hourly
building-flag changes cost nothing), tree trunks and large rocks from scatter (minus felled). A* (weighted, 9000
expansions max) with thick line-of-sight string pulling; exact circle-vs-box/circle sliding `move()` (large steps
sub-stepped); bridge decks follow the renderer's deck profile; `doorOf` uses the door offsets measured from the
building recipes. Path requests are queued, nearest-to-focus first, ≤ 1 ms/frame.

**Interiors** (docs/INTERIORS.md, `nav/interiors.ts`, `doors.ts`, `indoors.ts`): with a source of plans (the app gives the building
recipes' interior plans) the buildings within 42 m are not boxes to a moving body that knows its height but walls with doorways,
doors, furniture, floors, stairs and steps; `doorOf` is the real main door (placed as the model is), else `doorTable.ts`. The door book
opens and shuts every door's leaf (people passing, the habit of the place, the player), locks homes and shut-up places at night; the
people whose day has them inside the rooms drawn near the player are there at their places (`Zone.indoors`, drawn with the agents).
They climb as the player does: paths through the plan join the levels at the stairs and ladders, a flight is walked at the pace of the
height climbed with the feet on its surface (`indoorPath.ts flightY`, the `climb` animation on a ladder), they get up and walk to the
new place when the day changes inside a room (bed → table, the loom upstairs), and a place is offered only if a path leads to it from
an outer door (`pathExists`): nobody is put on a floor they could not reach (docs/INTERIORS.md, People inside; `tests/agents/stairs.test.ts`).
Corner towers: `agents/nav/walls.ts` puts the stair foot where the model's door is, turned off the ends of the curtain walls
(`placement.ts towerTurn`).

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
A village of ~110 agents through a whole day (measured when the day was ten minutes; a thirty-minute day is the same sub-steps, three times as many of them): 0.36 ms per sub-step on average, 2.7 ms at the 99th percentile, ~4800 path
searches (walking everything in sight needs more of them than the old instant trips did; they stay well inside the 1 ms/frame
budget).
Civilization pass (walking at the speed of people, sites, led animals), four runs each, the old and the new code side by side on the same
machine: 300 agents + 150 animals 1.0–1.4 ms per sub-step at 1× (before: 1.1–1.8) and 2.7–3.8 ms/frame at 8× (before: 2.6–3.2).
Wave B (riders, alert, prisoners, the called horse), on a machine shared with five other builders (load average 10–20: read the medians, not
the means, and compare only what ran side by side). The biggest town (300 agents + 150 animals), the base commit and this one run
alternately, 4 × 4 windows of 600 sub-steps: median whole step **1.43 ms against 1.44**, the zone's agents + scan **1.10 ms against 1.13**
— no change in the peaceful scene. A walled city (Schwarzburg, 304 agents, 458 posts): median 0.91 ms at peace, 0.87 on alarm (the
garrison and the militia on the walls and towers), 0.96 under assault (everyone else indoors). Four riders galloping through the crowd, in
and out of the same windows: +0.03 to +0.05 ms per sub-step (1.50 → 1.53, 1.51 → 1.53, 0.97 → 1.02 ms). The sight test of the watch is a
walk of 0.6 m steps along the line against the building boxes and trunks, for at most ten candidates twice a second while someone
trespasses. `tests/agents/agents.perf.test.ts` (run with `PERF=1`) prints these.
Tests: `tests/agents/` (schedule, nav, zone, pace, walking, walkcheck, sites, lead, plates, patrol, alert, horse, prisoner, lawzone, perf, stairs, yard, interiors, doorTable). Live: `node tools/interiors-live.mjs` (docs/INTERIORS.md).

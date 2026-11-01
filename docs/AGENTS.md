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

**A day is ten minutes** and people *walk* between the stretches of it. A stretch has a `from` and an `until`; the schedule gives the
walk to the next place a length by distance (`tripDays`: an easy 1.7 m/s over the first hundred metres, a brisker pace on the long
ways to the fields, 7 s to 3 game hours) and sets the person off that long before the next stretch begins, so they are there
when it does (`Intent.leave`, `travel` < 1, `prevX/prevZ` the origin). A long way after a short stretch spills into the next one
(the walk's tail). While a walk is on the intent *is the place being walked to* (activity, building, indoors), `leaving` marks a walk
to the edge of the settlement to go away (a market trip); `away` means gone. The morning chores are 0.045 of a day long and nobody
goes home for the midday meal unless home is within 25 m.

`economy.workSpot` wins when it returns a spot. Otherwise career defaults: farmers to their household's strips
(serfs two days in three to the demesne), smiths/carpenters/bakers/millers/… to the door of their workshop with
the right animation and tools, alewives to the brewhouse/alehouse, shepherds to a pasture point (their flock
follows them), priests to the church, soldiers to gate/walls/drill, monks and nuns keep the hours, servants run
errands for their own household, children play, fetch water, mind animals or go to the priest for lessons.
Nobody walks home for dinner unless work is within ~25 m: a packed meal at the workplace.

## Zone (`zone.ts`)

Focus = the attached player's draw item, else `sim.view.focus()`. People outdoors per their whereabouts within
250 m become agents (leave at 280 m), nearest first, cap 300, spawned by a time-sliced scan (≤ 1 ms). Agents spawn
where the schedule says now, mid-walk if travelling. `resync()` runs on skip end, character switch, run start,
leaving map/travel; no agents in `map`/`travel` mode. Summoned people/animals (`summon`, `summonAnimal`) and
claimed horses are exempt from cap and hysteresis. Agents **walk** their trips (`behaviour.ts`): they pace themselves to arrive when
the schedule says (`arrivalPace`: an easy walk when there is time, up to `MAX_HURRY` 1.7× when behind, a little faster still
far from the player, `config.ts`). Only what no one can see is skipped (`SEEN_RADIUS` 190 m): a trip that starts and ends
beyond it is finished instantly, a trip into view starts at the edge of it, one out of view ends there; nothing within sight
is carried across the street. A person who goes in at a door (or out of the settlement) ahead of the schedule is kept out of the
scan until the schedule has them arrive too (`Zone.hide`), so they are not put back on the street.

### Nameplates and names (`plates.ts`, `names.ts`)

Every agent's draw item carries `label` (the full name), `sublabel` (relation · role from `social.relationLabel` and the career or
office: "your father · farmer", "the reeve", "Lord of Dromore", "Siobhan's apprentice", "tenant · from Slievecairn"), `labelTone`
(player, kin, household, friend, rival, enemy, lord, clergy, stranger), `labelRange` (kin, household, people with a task for the
player and the tracked person 40 m, rivals and enemies 30 m, everyone else 15 m) and `mark` (`'quest'` for the askers of open
requests, `'track'` for the tracked person). A spoken line (`say`) takes the place of the plate while it lasts. The plate is worked
out when an agent spawns and every ~4 s after. Two optional hooks on the `ZoneApi`: `setQuestGivers(ids)` (the objectives module
passes the people who have a task for the player; open happenings requests are always included) and `setTrackedPerson(id)` (0
clears). `interactables` labels things with real names: "Your home", "Wat's smithy", "St Mary's church", "The Bell (alehouse)"
(saint and inn sign by a hash of the settlement and building), "Your family's east strip · barley, ripe", "The lord's north-east
strip · stubble", "Common pasture", "Oak".

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

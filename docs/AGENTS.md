# Agents: the living detail zone (`src/agents`)

Entry point: `installAgents(sim, { economy, social }): Zone` (a `ZoneApi`). It registers the `agents.zone`
per-step system (order 60), feeds the view sources `characters` and `animals`, chains `sim.hostileNear`
(hostile animal within `FAST_SPEED_HOSTILE_RADIUS`) and sets the social module's `awakeHook`. Dev page:
`?mode=village` (`src/agents/dev/villageViewer.ts`); screenshots: `node tools/village-shots.mjs` → `docs/agents/`.

The zone is a pure observer: it writes nothing to the simulation state and uses no random stream (visual
variation comes from `hash01`), so saves are unaffected (tested: state hash equal with and without it,
and across save → load → continue).

## Schedules and whereabouts (`schedule.ts`, `places.ts`)

`whereabouts(person, absDay)` is a deterministic function of person, calendar day, season daylight and weather.
The day hangs on sunrise/sunset with a per-person jitter: rise, chores at the door, work, the midday meal, work,
evening, bed. Holy day: dress, walk to church, Mass (indoors), the churchyard, then leisure (men and youths 14–60
at the archery butts, else a handful on the green lane; the alehouse; gossip; play; elders sit). Market day: sellers
at the stalls, shoppers drift about the square, and about one adult in six from villages whose market town it is
walks in (appearing at the gate, leaving at noon). Night: indoors asleep, except the watch (garrison and some
burgesses, torch in hand) and a few revellers. Bad weather sends outdoor workers home / indoors. The sick are in bed.

`economy.workSpot` wins when it returns a spot. Otherwise career defaults: farmers to their household's strips
(serfs two days in three to the demesne), smiths/carpenters/bakers/millers/… to the door of their workshop with
the right animation and tools, alewives to the brewhouse/alehouse, shepherds to a pasture point (their flock
follows them), priests to the church, soldiers to gate/walls/drill, monks and nuns keep the hours, servants run
errands for their own household, children play, fetch water, mind animals or go to the priest for lessons.
Because the day is only 60 s, nobody walks home for dinner unless work is within ~40 m: a packed meal at the workplace.

## Zone (`zone.ts`)

Focus = the attached player's draw item, else `sim.view.focus()`. People outdoors per their whereabouts within
250 m become agents (leave at 280 m), nearest first, cap 300, spawned by a time-sliced scan (≤ 1 ms). Agents spawn
where the schedule says now, mid-walk if travelling. `resync()` runs on skip end, character switch, run start,
leaving map/travel; no agents in `map`/`travel` mode. Summoned people/animals (`summon`, `summonAnimal`) and
claimed horses are exempt from cap and hysteresis. Trips are walked only where they can be seen (within 80 m of the
focus): unseen trips are finished instantly, trips into view start at the edge, trips out of view end there
(a 60 s day cannot be walked in real time).

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
Tests: `tests/agents/` (schedule, nav, zone, perf).

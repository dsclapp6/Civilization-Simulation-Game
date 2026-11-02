# Construction (`src/sim/construction`, civilization pass)

Raising, improving, mending and pulling down buildings in play, for the player and the AI rulers alike (`docs/CIV.md` §5). The
module implements the `ConstructionApi` of `src/sim/construction/types.ts` and registers itself as `sim.services.construction`
(`installConstruction(sim, deps)`; the `ConstructionInstall` it returns adds `core`, the runtime, for tests and tools). It works
headless: the territory, economy (`procure`), realm and advancement services are looked up lazily on `sim.services` / `deps` and
any may be missing.

Files: `data.ts` (the content, typed) · `scope.ts` (who may build where) · `check.ts` (is this a valid site, where to put it) ·
`geometry.ts` (footprints, overlap tests, the cell index) · `catalogue.ts` · `sites.ts` (place/upgrade/repair/demolish/cancel,
views) · `progress.ts` (materials, labour, the morning plan, completion) · `actions.ts` (the player's own bouts) · `save.ts` ·
`core.ts` (shared runtime) · `index.ts` (wiring). Content: `src/content/construction.json`. Tests: `tests/sim/construction/`.

## 1. Content (`src/content/construction.json`)

Every one of the 63 building kinds, every level. Per kind: `cat` (the builder's group: home, farm, craft, food, religion, civic,
defence, resource, military), `rank` (least rank tier, SPEC §4, of a builder with authority over the land), `own` (least rank of a
household head building it on their own household's land; 0 = never on own land), `max` (most per settlement: a number, or by
settlement kind with a `default`), `tech` (an advancement id the builder's House must command), `terrain` (`river`, `rise`,
`coast`, `deposit`, `forest`) and `deposits` (the deposit kinds a `deposit` site needs: a mine takes iron, silver or gold),
`wild` (may found an outpost), `slope` (steepest ground), `skill` (what a player learns building it), `does` (one line) and
`levels`: `levels[0]` is the cost of raising it new, `levels[n]` the cost of upgrading it to level n+1, each as
`{ goods, labour, pence }` — materials by good id, **worker-days** of an able adult, and cash fees (a mason, a millwright, carting)
paid as the work goes. The table also holds the wage of a day's labour (2 d; 3½ d for masonry), the working hours (07:00–17:00),
the crew size rule (`ceil(labour / 4)` hands, 2–40), salvage (35 %), the refund on cancelling (70 %), the share of a building's cost
mending takes and which offices build for a lord.

The design's examples are kept (CIV §5): hovel 2 wd; cottage 8 wd + 20 planks + 30 straw; barn 14 wd; smithy 16 wd + 6 stone;
watermill 60 wd (technique); stone church 900 wd + 400 stone; palisade segment 6 wd + 30 timber; curtain wall segment 120 wd +
160 stone (technique); stone keep 2000 wd + 2500 stone (technique). In pence of the reference prices (`goods.json`), with labour at
2 d: hovel 1s 11d · cottage 6s 2d · barn 17s · smithy 18s · watermill £3 3s · church £22 9s · wall segment £4 4s · stone keep £68.
At the largest useful crew (a quarter of the worker-days, 2–40 hands) that is a hovel in a day, a house in 2–4, a mill in 4, a
church in 23 days, a keep in 50 days, a cathedral in 125: SPEC §2's "hut 1 day, house 2–3 days, mill 4 days, keep a few seasons".
Brick and clay (the new chains) appear only where a finer finish asks for them (upper levels, ovens, kilns), so the first level of
the common buildings is buildable from timber, planks, stone, straw, nails and iron alone.

## 2. Who may build what (`scope.ts`, SPEC §7)

`scope(person)` gives the settlements where the person has authority (`settlements`), the buildings of their household (`own`),
whether they may found outposts, a plain label ("the manor of Dromore", "your croft"), who pays (`household`) and owns (`house`),
and — additive — `rank`, `role` and `agentFor`.

| role | how | pays | outposts |
|---|---|---|---|
| `head` | any household head (a grown person who is not a child, a prisoner, or a non-head): the household's own land | the household | no |
| `lord` | holder (or regent) of a manor, town, abbey or see title: that place; rank of the title | the holder's household (a regent builds with the ward's money) | no |
| `baron` | holder of a barony, county, kingdom (a county's seat, a kingdom's capital) or abbey: every place held, **and** the wild | the holder's household | yes |
| `steward` | an office (steward, bailiff, castellan; the reeve for farm, civic and village works only; a mayor or alderman for civic works): that place, at the rank of the office | the lord's household for stewards, bailiffs, castellans and reeves; the person's own for a mayor | no |

A master (rank 3+) builds his workshop and its upgrades on his own plot; a serf can raise a hovel, pen or hen-house. What a
person may not build is listed and says why ("Only the lord of Dromore may raise a wall", "Needs the curtain walls technique",
"There is a church already: one is all the place can keep"). `check` puts rank, then the technique, then the count after the
ownership of the ground.

## 3. Is this a valid site? (`check.ts`)

`check(person, kind, x, z, rot)` (≤ 0.2 ms; memoised for the ghost's repeated asks; measured 25–55 µs) walks the footprint
(`BUILDINGS` w × d, door on local +z, `rot` as in the renderer) through, in order: the **ground** (the territory service's
`landAt` at the centre and the four corners — kind and holder: field, road and water are never buildable; a lord needs his own
settlement's ground or title at every corner; a head needs the garden or town ground of his own household; the wild needs a baron;
without a territory service — or while it is the placeholder that calls everything wild, even a village's own streets — the nearest settlement stands in), **permission** (rank, technique, count), **the ground's own
nature** (water at nine points, cliffs, slope — rise over the footprint's diagonal, 4–10 m, default 0.16 — a river within 25 m of
the bank for watermill, fulling mill and tannery, a rise 1.5 m over the ring 35 m round for a windmill, the right deposit
under the centre for mine, quarry, clay pit and salt pan via `territory.depositAt`, water beside a dock, woodland for a lumber
camp), and **what is in the way** (a strip of the open field, a road with a metre to spare, any building or site with 0.8 m to
spare — wall and palisade segments may touch end to end). The result carries the footprint corners, the settlement the building
would belong to (−1 = a new outpost), the cost, and for the wild the outpost's suggested name.

`suggestSpot(person, kind, settlement, near?)` tries up to 420 places on a spiral from the point (a household head starts at his
door, working buildings out at the edge of the place, resource buildings at the deposits nearest to the point) with the door turned
toward the nearest street, and returns the first valid check, or null.

## 4. A site's life (`sites.ts`, `progress.ts`)

`place` checks, then creates a **real `BuildingState`** — `plot −1`, an id from `state.nextBuildingId` (so beyond every plot id),
`construction 0`, `owner` the paying House, no household yet (a *home* is held in the payer's name while it is built, because
`succession.pickHome` and the economy's listings take any home whose `household` is 0, whatever its `construction`; the module
lets it go when the work is done) — registers it in `state.buildings` and `buildingsAt`, marks it dirty
(`touchBuilding`: the view, the renderer, the navigation and the saver all see it) and clears the trees and stones where it
stands (`view.markFelled`). A site record (`SiteRec`) holds the job: materials needed / delivered / on the way, worker-days needed
and done, cash fees, the payer, the queue priority and today's crew. `upgrade` (next level), `repair` (a share of the cost by the
damage) and `demolish` (a quarter of the labour, and 35 % of the timber, planks, stone, brick, iron and nails go to the payer's
stores) make sites on standing buildings; an upgrade or repair leaves the building working while it is done. `cancel` ends a
site (70 % of the delivered materials come back, all of them if no work was done; a build site's building is removed, and an
outpost with nothing else is dropped). `quote` says what an upgrade, repair or demolition would cost and whether the person may
order it.

Each morning (06:00) the **plan** runs (in four shards, so a hundred sites never fall on one frame), payer by payer in order of
priority:

1. **Materials.** For the share of the job the next eight days' crew can use, whatever is missing is drawn from the payer's
   stores — and, for a lord's or institution's works, from the stores of the House's other households in the place (its barns and
   warehouses) — then ordered with `economy.procure?(household, good, qty, { settlement, maxPrice })` (at most three times the
   reference price; the head's pocket tops up the purse the economy pays from, and what is not spent goes back). The site
   remembers what was ordered and when it should arrive and does not order twice; it says what it waits for ("Waiting for 12
   planks: on the way from Dromore market, 1 day" / "none in store" / "the market is short"). Without `procure` the stores are all
   it has. Goods that come in during the day are taken at once.
2. **Labour**, up to what the materials in hand allow (labour may go as far as the worth of the delivered materials is of the
   whole): the household's members on the **`'build'` task** (the economy's `householdPlan`), the manor's **week-work share**
   (`realm.worksShare(settlement)` of the serfs' days owed, on the lord's own works) and **paid labourers** — adults of the place
   who hire out by the day (labourers, cottars, servants, woodwards, then tenants), at most three in ten of them in all, each paid
   a day's wage from the purse into their own household's, as many as the job, the crew rule and the purse allow (the payer
   keeps a reserve; `PlaceOptions.hired` / `setHired` fix the number). Nobody works on a holy day.
3. The people at work are listed (`workersAt(site)`, `onSite(person)`) so the agents can draw them there.

Each working hour (07:00–16:59) the day's labour is put in, fees are paid as the work goes (the work waits if they cannot be),
and the building shows its progress in steps of 1/40 (pegs → footings → frame → roof; `SiteView.stage`) so it is not dirtied
every hour. A site with nothing to build with, or no hands, says so and after two idle days is `stalled` (event + notice). At the
end: a new building is complete (`construction 1`) and its household set — a home takes the builder's household (the default for a
head building on his own land; `occupant: 'vacant'` lets it) or stands empty for a family to rent (a lord's default), a workshop
or outbuilding is the builder's household's, a mill, church or wall belongs to nobody in particular — an upgrade is the next level,
a repair has no damage, a demolished building is gone (and, if it was one of the world's own plots, stays gone on loading).

**The player's own hands.** At a site the action wheel offers *Work on the building* (an `ActionProvider`, category work,
repeating): a bout of twelve seconds divided into visible steps by the stage of the work — dig the footings, carry stone, saw a
beam, raise the frame, cut and lay stones, lay thatch — each with its animation, tool and sound cue, adding 0.096 worker-days at
1× (the hero does twice what a capable adult does in the same hours; the same constants as the economy's other work) and teaching
carpentry or masonry (XP, a little strength), costing food and rest. On another household's site it pays a day's wage by the bout;
on the holy day, when too hungry or hurt, or with nothing to build with it says why it cannot.

**Outposts.** In the wild, a baron or greater places a *camp, mine, quarry, saltpan, lumber camp, dock, tent, tower, palisade or
motte* with a name (`PlaceOptions.outpost`; a default is made: "Dromore Quarry"). The outpost record (`OutpostView`: id, name,
parent settlement — the nearest the founder holds — position, deposit id, founded day, House) is created with the first site and
dropped if that site is cancelled. Land within 300 m of it is the founder's: anything a lord could raise at home can be raised
there, and the buildings belong to the parent settlement for the economy (`BuildingState.settlement`, so homes there are lived in
and mines worked by the parent's people).

## 5. Saved data and events

`state.ext['construction']` (created on first use): `{ v, nextSite, nextOutpost, sites[], outposts[], razed[], stats }`. Everything
else — the cell indexes, memoised checks, the morning's pools — is rebuilt from it and the state; a loaded run continues with the
same hash (tested hour by hour for 14 days, mid-work, with an outpost, an upgrade and a demolished world building). World
buildings pulled down are listed in `razed` and removed again when the module is installed on a loaded state. Finished sites stay
for three days (so `site(id)` can say `done`). Events (`construction`): `placed`, `started`, `progress` (each quarter), `stalled`,
`done`, `cancelled`, with the site, building, settlement, kind, work and House; the player is told with `notify` about their own.
Notable finished works also go to the chronicle.

## 5b. Seen in the running game

With the real renderer, the real economy and agents and a stand-in territory, a lord's cottage, barn and chapel staked out in a
town rose from footings to walls to the roof frame (the stone chapel with scaffolding) over four to six game days and stood
finished, with no browser errors; the walking agents, the view and the saver took the new buildings as they are. (The renderer's
construction stages are keyed to `BuildingView.construction`, which the module writes in steps of 1/40.)

## 6. Budgets (measured, shared machine)

`check` 25–55 µs (real generated continent, 10 kinds, territory call excluded; budget 0.2 ms). Hourly work with 50 open sites:
0.04–0.15 ms per game hour on average, the morning plan 1–6 ms in four shards (budget 0.5 ms per hour). Ten years of the whole continent (`tools/fullsim.ts`
with a planner placing ~660 works) cost 4.77 ms per game hour against 4.75 without the module; population, prosperity and the
other yearly figures stayed as they were. A placement with `suggestSpot`: 1–15 ms. `tests/sim/construction/construction.perf.test.ts` (`PERF=1`).

## 7. Contract changes (all additive)

`types.ts`: `BuildRequirement.deposits?`, `.max?`; `BuildScope.rank?`, `.role?`, `.agentFor?`; `PlaceOptions` (`outpost`, `priority`,
`occupant`, `hired`) taken by `place`; `PlacementCheck.outpost?`, `.cost?`; `SiteView.level?`, `.builder?`, `.stage?`, `.hired?`,
`.cost?`, `.materials?`; `OutpostView.house?`; `ConstructionApi.onSite?`, `.setHired?`, `.canManage?`, `.quote?` (optional, so fakes need
not implement them).

## 8. Hand-offs

* **Territory (A1):** the module asks `landAt` at a footprint's centre and corners (kind, settlement, `title`, `household` of a
  garden or town plot), `depositAt(x, z, kind)`, and reads `version()`; it reads `construction.outposts()` (now with `house`).
  Own-land building needs `landAt(...).household` set for gardens/town plots and kind `garden` or `town`.
* **Core sim (not the module's to edit; for the integrator):** `succession.pickHome` and `family.HomeAllocator` choose "an empty
  home" by `!b.household` without looking at `b.construction`; the module works round it for homes it builds (above). They should
  skip `construction < 1` buildings too, so that nothing else — a burnt-out family, a castellan — is put in a half-built house.
* **Economy (A4):** the module calls `procure?` and `householdPlan` and reads goods from `Household.stores` by plain key. Please
  (a) treat a member on `'build'` as spending the day on the household's site (the module counts them — `onSite(person)` says
  where they are), (b) refresh caches on the `construction` `done` event, (c) give vacant new homes/workshops the usual listings
  (the module leaves `household 0`, `construction 1`), (d) credit the week-work days the serfs give to `worksShare` if wanted
  (the module takes the days; it cannot write the economy's ledger).
* **Realm (A3):** reads `construction` events for news; the module reads `realm.worksShare(settlement)`.
* **Agents (A5):** `workersAt(site)` and `onSite(person)`; sites are ordinary buildings with `construction < 1` and, for an
  upgrade or repair, `SiteView.progress`. The module removes demolished buildings from `state.buildings` and `buildingsAt` (the
  same array, spliced) and bumps `buildingRevision`.
* **Wave B, builder's mode:** `catalogue(person, settlement)` for the menu (`-1` = the wild), `check` every frame for the ghost
  (the result has the footprint and the reason), `place(.., { outpost, occupant, hired, priority })`, `suggestSpot` for "place for
  me", `sites(settlement)` + `site(id)` for the queue and the site card (`status`, `note`, `missing`, `labourLeft`, `eta`,
  `stage`, `workers`), `upgrade / repair / demolish` with `quote` for their price, `cancel`, `setPriority`, `setHired`,
  `canManage`. Hours: the plan is 06:00, work 07:00–17:00.
* **Wave B, AI planners:** call `scope(ruler)`, `catalogue(ruler, settlement)` for what is open, `suggestSpot`, `place`; they pay the
  same costs from the same purse. `cost(kind, level)` prices a plan without ordering it; `sites()` shows what is already under
  way (`MAX 16` open sites per paying household).

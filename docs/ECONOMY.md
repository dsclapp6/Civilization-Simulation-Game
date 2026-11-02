# Economy (wave 2)

`installEconomy(sim, { social })` in `src/sim/economy/index.ts` adds goods, markets, farming, work, trade, jobs and
careers, obligations, household management, perks and the player's needs to a `Simulation`. It runs headless; the
UI, the player controller and the agents use the `EconomyApi` it returns (`src/sim/economy/types.ts`).

```
npx tsx tools/econ.ts --years 100 --preset tiny     # prices, prosperity and system costs over time
npx vitest run tests/sim/economy                    # the economy's tests
```

## Time and money

A game day is one *working day*: wages, prices and rations are the historical per-day figures (a farmhand earns
2d a day, a gallon of wheat costs 1d). A game year is only 16 days, so a year's flows are 16 days' worth: a
household eats about 17 gallons of grain a year, and a strip gives 30 to 40 gallons.

**The day is ten minutes of play** (`DAY_SECONDS = 600`, clarity pass): a game hour is 25 s at 1×, daylight about
seven minutes, a year 2 h 40 min. Everything the calendar runs (needs per hour, markets, households, growth, rents) simply runs
ten times slower in real time. What had to be retuned is everything counted *per bout* of the player's work, because a bout
(12 s) is now half a game hour (`BOUT_HOURS` 0.48) and a day holds fifty of them:

* **The hero works about twice as fast per game hour as a capable adult** (`HERO_FACTOR`): one bout ≈ one hour of a labourer's
  work. Piece pay is at NPC rates per unit of work: a bout pays `wage × BOUT_DAYS` (0.096 of a day's wage), week-work credit
  the same, so ten bouts are a labourer's day and a hard day's work of twenty pays about twice that.
* Strip tasks take more bouts (`TASK_BOUTS`): plough 7, harrow 3, sow 4, weed 5, reap 7, bind 5 (a strip is reaped in a minute and
  a half). Felling a tree stays three bouts.
* Experience and stat training per bout are scaled back (`XP_SCALE` 0.25, `TRAIN_SCALE` 0.5, in `sim/skills.ts`), tool wear by
  `WEAR_SCALE` (a third), the hunger and tiredness a bout costs are about half a game hour's worth on top of the hour's own
  (`needs.ts drainWork`). A youth who practises most days still has STR 10 and Archery 3 at 14 or 15 (the archer test), a
  14-year-old farmer is Farming 2 after a year on three strips.
* Anything that was a count of bouts per day (errand pay, request work counts, bark and rapport limits that read real time) was
  rescaled; things that are counts of *days* (rents, deadlines in days, the 4-day week) are as they were.

Money is pence (`formatMoney` writes it as £ s d). Texts for the player use `pd()` from `data.ts`.

## Goods (`src/content/goods.json`, ~110 goods)

Quality is part of the item key: `sickle#2` is a good sickle (tiers 0 crude, 1 common, 2 good, 3 fine, 4 master).
Tier multipliers for the price are 0.55, 1, 2.5, 6, 15 by default. Grain only has `#0` (chaffy, unwinnowed) and the
plain key. Keys starting `~` in a bag are bookkeeping (`~w:sickle#0` is tool wear). Livestock lives in the
household's stores as head counts and is never carried.

| good | base price | | good | base price |
|---|---|---|---|---|
| wheat (gallon) | 1d | | ale (gallon) | 1.2d |
| rye / barley / oats | 0.75 / 0.6 / 0.4d | | bread (loaf) | 0.45d |
| peas / beans | 0.55 / 0.5d | | cheese / meat (lb) | 0.6 / 0.5d |
| flour (lb) | 0.15d | | wool (lb) / cloth (ell) | 2d / 8d |
| firewood (bundle) | 0.4d | | iron bar / planks | 7d / 2.5d |
| sickle / scythe | 4d / 30d | | ox / horse / cow | 150d / 300d / 120d |
| clothes (set) | 24d | | longbow / sword | 36d / 96d |

Twenty-six *macro* goods have a stock at each market and a price that follows scarcity: fourteen foods and fuels (wheat,
rye, barley, oats, peas, beans, bread, ale, vegetables, cheese, eggs, meat, fish, firewood) and, since the civilization
pass, twelve building materials and raw goods (timber, planks, stone, brick, iron, nails, straw, charcoal, salt, candle,
vellum, tallow; see "Materials" below). Everything else is index-priced (base price × quality × a slow glut term from
what the player sold, or the want left by what a household bought).

## Markets (`market.ts`)

* A market's price is `base × scarcity^0.5` (clamped 0.5 to 2.6) `× season × local factor`, plus a spread: 7% at a
  market, 10% at a stall, 18% at a shop, 14% at a dealer. Merchants move stock between neighbouring markets every
  day (`marketFlowsDay`) and carriage costs rise with distance.
* Stock relaxes towards a target set from the population that buys there (`diet.ts`); perishables reset daily.
* `quote`/`trade` take any lines (positive: you receive); tolls, weight limits and opening hours apply. Markets are
  open by day and closed on the holy day; market day is weekly (`marketDayOf`).

## Households (macro, `macro.ts`)

Every household is settled every 4 days (staggered by id): rations from the stores (bread, then its own grain, then
any grain, then the cheapest ration at market), ale, fuel, animals (yearly), garden and hay, income from its
career's table, a little spending, surplus sold with a reserve of grain until the next harvest, and a purse that
drifts towards what its rank would hold. The hunger left over is tallied for the year and sets the settlement's
`prosperity` (read by `life.ts` for births and deaths). Each year the yield scale of a settlement drifts by at most
3% towards the level at which wheat sells at its usual price, so a shrinking population does not sit on a glut.

Wave 4 calibration: a unit eats 0.265 gallons of grain a day in all (staple rations plus the barley brewed at home), markets
hold half a year of grain (cover 8 days), and merchants' relief carts bring staples from the markets with the biggest surplus
to any market below 0.55 of its target (across a kingdom border only for the worst gaps). A year's yield scale answers the
hunger and the price of corn of the whole market hinterland (a dead band: more land when hungry or dear, less when the price
sags), so a bad harvest shows as a few hungry years in one kingdom, not a constant famine. Advancement bonuses are read
(`farm.yield`, `mill.speed`, `craft.quality`, `trade.margin`, `wool.price`, `cloth.value`, `market.depth`), and so is the
manor policy of politics (rent and week-work). A besieged place trades nothing. Big settlements settle their day in slices
over consecutive hours (`partsOf`). Livestock work is offered at the building that keeps the beasts (`STOCK_SITES`).

A household the player heads is not sold from behind its back: grain, wool and ale are sold only if a member has
the `market` task. The player eats at the household table (below).

## Farming (`farm.ts`, `farming.ts`, `work-farm.ts`)

A strip goes: fallow/stubble → ploughed → (harrowed) → sown → growing → ripe → cut → bound sheaves → stubble. Growth
follows the seasons (spring 0.8, summer 1.2, autumn 0.7, winter 0 of a day per day). Households work their strips
a little late and a little worse than a diligent player; the player gets 1.5 days of grace.

Yield = settlement base × crop ratio × field fertility × weather × the kingdom's harvest × care × weeding × thin seed
× lateness. The base is calibrated so that a normal year feeds the continent. A tenth goes to the parish priest
(tithe), seed corn is set aside, and a sixteenth of what is ground goes to the lord's mill.

Player bouts (12 seconds at speed 1, half a game hour; a game day is 600 seconds):

| task | bouts | notes |
|---|---|---|
| plough 7, harrow 3, sow 4 | | seed 14 gallons a strip |
| weed 5 | | unweeded crops lose 14% |
| reap 7, bind 5, carry (8 sheaves a trip) | | sickle or scythe; quality tools are faster |
| thresh (8 sheaves a bout), winnow (12 gallons a bout) | | flail; chaffy grain loses 10% on sale |
| mill (8 gallons a bout) | | at the village mill, a sixteenth to the miller |

*Expected pace*: one spring strip, harrow to winnowed grain, is about 45 bouts (nine minutes of work) spread over the
growing days (the farmer-loop test measures about ten game days for three strips); it gives about 35 gallons, worth
20 to 35d, for about 8d of labour at NPC rates. Each task shows on the strip while it is under way (`StripView.task/work`,
`stripfeed.ts`).

## Work, jobs and careers (`jobs.ts`, `work-craft.ts`, `work-misc.ts`)

* Work actions come from four providers (`farm`, `craft`, `stock`, `misc`) through `sim.actions`. Every work option
  has a duration, an animation, and gains in skill, strength/endurance and (if hired) wages.
* Job ids are `employer × 20 + kind` (institutions: `1e9 + settlement × 20 + kind`). Posts: day labour, herd boy,
  shepherd, apprentices (premium 60 to 130d, kin pay nothing), journeymen, clerks, servants, archers, men-at-arms,
  sergeants.
* An apprenticeship binds a free-born boy of 12 to 18 for 7 years: he lives in the master's house, fetches and
  strikes (skill 8 xp a bout), and at the end of the term becomes a journeyman if his skill is 3 (else another year).
  A journeyman earns a yearly wage; with skill 8, the materials twice over and the guild fee he may make a
  masterpiece (a rolled quality of good or better) and becomes a master with his own house.
* Land ladder: family strips → rented strips (3d a year each, 60d to buy) → free tenant → yeoman → gentry.
* Archery: STR 10 and Archery 3 are the archers' recruiter test; shooting at the butts builds both (a boy of 12
  with potential 11 reaches them by 14 or 15).

## Obligations (`obligations.ts`)

Rent half-yearly (free tenants pay the customary 3d a strip a year without a lease); tithe in kind; week-work for the
unfree (1 day a week, 2 at sowing and harvest, judged weekly, fines when shirked); fines come due after 4 days;
merchet when a serf's daughter marries (on the core `marriage` event); heriot (best beast) on a tenant's death;
manumission (about 12s); flight to a chartered town for a year and a day.

## Needs and household table (`needs.ts`)

Hunger falls 0.026 an hour awake; rest 0.036; warmth follows weather, clothes, shelter and fire. At hours 7 and 18
the player sits down at the household table while the household's last macro tick found the table laid (the ration is
charged to the household); away from the home village there is no table. A hungry player eats from the pack, or at
home from the stores. Hunger, tiredness and cold slow work; starvation and exposure kill.

## Perks

160 perks (`perks.json`): two to choose from at skill levels 5, 10, 15 and 20 of each of the 20 skills. Effects are
numbers (`speed`, `yield`, `quality`, `xp`, `wear`, `save`, `sell`, `buy`, `fee`, `rent`, `fertility`, `carry`, …)
summed by `perkSum`/`perkTotal`.

## What the view is fed (clarity pass)

`installEconomy` also feeds three view sources (no state is written; all are quiet when nothing is near the focus):

* `stripWork` / `stripWorkVersion` (`stripfeed.ts`): `StripView.task` and `work` for the strips near the focus. A task under
  way (the player's bouts, a half-done task) shows its saved progress exactly; the household farm lands its work in one step when
  its settlement's day is run (`farm.ts macroPlan`, the pure part of `macroStrip`), so the strips it is about to work show the
  work through the working day before, each starting a little later than the last.
* `worldProps` / `worldPropsVersion` (`propfeed.ts`): stooks (bound sheaves waiting to be carried) and lying sheaves along the
  reaped part of a strip (the strip's *start* is the middle of the short end that holds `poly[0]`, its direction the long axis:
  `stripFrame`; `StripView.work` is meant to be drawn from the same end, so the sheaves lie inside the cut band), hay cocks for two days after a meadow is mown, a woodpile (`count` 1..8 from firewood) and a heap of
  grain sacks (from grain and flour) at each home or barn, stone at quarries, a stump where a tree was felled (permanent) and its
  logs (until the woodcutter has walked off). Households the economy keeps by the day hold no stores, so they show a seasonal
  baseline; the player's household shows exactly what it keeps. A strip the household farm harvests while it is being watched
  (the feed saw it ripe or cut, then stubble) stands in five stooks for about three-quarters of a day, as if carried in by the
  next afternoon. Ids are stable (`kind × 1e9 + entity`); the version moves only when the list differs. What the work leaves is
  remembered in `Econ.notes` (not saved); each new note moves `notes.rev`, which the feed rebuilds on, so a bout shows at once
  rather than at the next game hour.
* `drainFloaters` (`floatfeed.ts`): "+8 sheaves cut", "+3d", "Farming +2" over the player for a completed action, "Farming 3!"
  for a level, "−4d" / "+2 eggs" for a trade, "♥ +3" over the person whose opinion moved; a few a second.

## Civilization pass: hands-on production, new chains, household trade

The design is `docs/CIV.md` §7–8 and §5–6 (what builders and rulers buy). Everything below is data in `recipes.json`,
`goods.json` and `careers.json` plus six modules of `src/sim/economy`: `butchery.ts`, `steps.ts`, `work-craft.ts`,
`work-dig.ts`, `supply.ts` and `trade-house.ts`. The NPC households' own path (`householdDay`) is as it was: nothing a
player does or a building raised in play adds is read there except through the markets.

### Slaughter and butchery (`butchery.ts`, the `stock` provider)

Animals are head counts in a household's stores (`pig`, `sheep`, `goat`, `chicken`, `cow`, `ox`); the zone redraws the herd from
`holding(household).livestock`, so a beast killed is a beast gone. Two steps, each its own action with visible steps:

| action | where | what |
|---|---|---|
| `stock.slaughter.<animal>` | a pig at the sty, sheep and goats at the fold, fowl at the hen-house, any of them at the home (`STOCK_SITES`); every beast, **cow and ox included, at the slaughterhouse** | the beast leaves the herd; a **carcass** hangs in the larder. A fowl is dressed in one go (meat at once) |
| `stock.butcher.<animal>` | the same places (where there is a block) | the carcass is jointed: **meat by the beast's weight**, a hide, **tallow** |

* `recipes.json` `"beasts"`: live weight, pounds of meat (chicken 1.4, goat 22, sheep 24, pig 55, cow 180, ox 260), hide
  (a cattle hide is 1; a pig 0.25, a sheep 0.15), tallow, bouts to kill and to joint. The whole beast is worth about what it
  costs alive (0.8 to 1.4 of its price) — no money machine, no loss.
* A carcass is a quality good (`pig_carcass#2`): the tier comes from the beast's condition (fattest in autumn, leanest in
  spring, thinner after a fodder shortage `~f`) and the hand's Husbandry; meat on the carcass follows the tier (×0.75 lean … ×1.4
  prime) and the cutter's skill (and the `husbandry yield` perks). A carcass hangs in the larder with a `~h:<key>` marker of the
  day and **rots after its `spoilDays` (2.5 to 3)**: joint it, and salt the meat.
* The slaughterhouse (`buildings.json`, raised in play) is used free by the household that keeps it, for a fee (¼d a small beast,
  0.8d a large one) to the keeper (the lord's household if nobody keeps it) by anyone else. Cancelling half way kills nothing.
* Salting is a recipe (`craft.salt_meat`: 12 lb meat + 2 lb salt → 11 lb `salt_meat`, which keeps 120 days) at the slaughterhouse,
  the tavern or the home; candles are dipped from tallow (`craft.dip_candles`: 1 lb → 8 candles).
* **Selling**: a butcher (`careers.json`) buys live beasts, meat, hides, tallow, salt meat and carcasses; markets buy meat and
  tallow (both stock-and-flow goods); the slaughterhouse's shop sells carcasses, tallow and salt meat. The player's own household
  does not sell its meat behind his back (`sellSurplus`) unless someone is sent to market.
* XP and floaters: Husbandry (8 base a bout); the outcomes list `gains` (meat, tallow, hide, carcass, wages/fees) so the float feed
  shows "+52 lb meat", "+9 lb tallow", "Husbandry +2".

### Crafting open to all (`work-craft.ts`)

Any recipe may be attempted at a works the person may use (`placeFor`):

| works | terms |
|---|---|
| one's own (the household's workshop, one's own hearth) | free; tools lent by a workshop but not by a home |
| the master's, as his employee | the work is his (his stores, a day's wage), with **the ladder's gates** (`stage`): an apprentice does not work a journeyman's recipe in his master's name |
| **another's workshop** | **hire the bench**: a fee of 0.3d × the recipe's bouts (×1.15 a level) to the keeper's purse; the work is one's own; the workshop lends its anvil, bench, loom, press (not needles or distaffs) |
| a works nobody keeps (kiln, saw pit, charcoal mound, bloomery) | free |
| a building still being raised (`construction < 1`) | nothing |

* **Reach and novices**: every recipe up to `REACH` (6) levels beyond one's skill is listed, the ones nearest the skill first (24 at
  a bench). Beyond one's skill by `gap` levels a batch **spoils with chance `0.08 + 0.12 gap`** (at most 0.85) — most of the material
  is lost, something is learnt (0.7 of the experience) and the outcome says so — and a batch that comes out uses `1 + 0.05 gap` of
  the material and its quality is `0.1 gap` lower. A hand fit for the recipe (gap 0) never spoils it. The preview says "beyond
  your skill: 44 % the work is spoiled". Quality otherwise as before (skill, tool, perks, `craft.quality`).
* The masterpiece, the apprentices' tasks and jobs are as they were. Option ids are unchanged (`craft.<recipe>`), so the
  advancement module's `player.actions` patterns still match.
* **Steps** (`steps.ts`, `recipes.json` `"plans"`): every craft bout carries `ActionOption.steps`, shares adding to 1: the
  forge heats the bar, draws it out, quenches and grinds (`bellows`, `hammer`, `quench`, `grind` cues); the kiln is loaded,
  fired and drawn; the tannery soaks, scrapes and stretches; the saw pit sets, pulls and stacks; the mash tun mashes, boils and
  barrels; the bakehouse, the loom, the salt pans, the charcoal mound, the bloomery, the masonry bench and the butcher's block
  have theirs. A recipe names its plan (`plan`) or takes its building's (`buildingPlans`), else a plain three steps. The digs
  (`dig_stone`, `dig_ore`, `dig_clay`, `dig_timber`) and the slaughter plans (`slaughter`, `wring`, `butcher`) are named in code.
  Cues beyond the contract's list: `grind`, `scrape`, `knead`.

### Works of the land and the new chains (`work-dig.ts`, recipes)

| works | action / recipe | yields |
|---|---|---|
| quarry | `dig.stone` | stone, as before (`quarry` + a stone deposit's richness) |
| mine | `dig.ore` / `dig.silver` / `dig.gold` | iron ore, silver ore or gold ore **by the deposit under it** (`sim.services.territory.depositAt`, gold then silver then iron); iron where nothing is known |
| clay pit | `dig.clay` | loads of clay |
| lumber camp | `dig.timber` | a log (and bundles of firewood) in three bouts' time |
| kiln | `craft.fire_bricks` (clay 4 + firewood 6 → 24 bricks), `craft.fire_pots` (now with clay) | bricks, pots |
| tannery | `craft.make_vellum` (a hide → 10 sheets; Tailoring 3) | vellum |
| salt pans | `craft.boil_salt` (firewood 5 → 10 lb; follows the salt deposit's richness) | salt |
| slaughterhouse | the butchery above, salting, candles | |

An hour (a bout's time) at the clay pit, the iron or silver or gold seam comes to the same 1.6d of goods, the lumber camp 4 to 5d, the
quarry 4.5d (its old rate). Yield per bout = base × `0.35 + 0.8 × richness` × `(1 + 0.04 × skill)` × perks. Whose works it is
decides the product: the keeper's household digs for itself; a **hired hand** (`jobs`: "Hand at the pit", "Miner", "Lumberjack",
"Salt boiler", "Slaughterman's hand", day labour for the keeper — the lord if nobody keeps it) is paid a day's wage a bout
and the product goes to the keeper's stores; anyone at a works nobody keeps gives the lord a fifth; another household's works
is closed to a stranger. A mine's prop may give way (bruise) for hands below Mining 4. Clay is dug where the clay lies: with the
territory module present, a pit on ground with no clay deposit says "There is no clay in this ground" (without it, an ordinary
bank). Day-labour posts are one for each keeper and kind of work (a quarry and a clay pit of one keeper share the pit's post).

### Materials: stock-and-flow with a local supply (`supply.ts`)

The twelve materials have a stock at every market (`goods.json` `"macro": true` + `"supply": {use, cover, relax}`). A market's
**target stock** is `cover` days of what its hinterland uses (`use` per head per day) **plus what its works make**
(`recipes.json` `"workplaces"`: saw pit 24 planks a day, lumber camp 12 logs, quarry 14 blocks, kiln 28 bricks (30 % without clay
in reach), bloomery 4 bars, charcoal mound 3 sacks, salt pans 40 lb, tannery 1.2 sheets of vellum, slaughterhouse 5 lb of tallow;
+40 % a level; the old world's smithies, carpenters and mills are not listed, its prices were struck with them). Each day the
stock closes `relax` of the gap to the target (the wider world; `relax` is also the supply's rate: a town can refill 3 to 15 percent
of its gap a day), merchants carry materials between neighbouring markets (stone and bricks lose most on the road), and
`price = base × local factor × season × scarcity^0.5 × supply factor` where the supply factor is **down to 30 % off where the works
make far more than is used** and **a fifth up for goods of the ground (stone, bricks from clay, iron, salt) when no works and no
deposit of that kind is in reach** of the market's lands (deposits from the territory module; without it, none are known).
The census of works is rebuilt when a building is added or a `construction` event (`placed`, `done`, `cancelled`) arrives — the
day a kiln is done it counts — and never otherwise (a family moving house changes no stock). A material a market is out of is not on
its board unless you hold some to sell. Price gossip ignores the materials' standing premiums (only shifts of 60 % or more).
Silver and gold ore stay index-priced (the mint's demand is unbounded; a glut sags the price as for any manufacture).

### Household trade (`trade-house.ts`; `EconomyApi.procure?`, `sell?`, `deliveries?`, `stockAt?`)

* `procure(household, good, qty, {settlement?, maxPrice?}) → {got, cost, settlement, days}` — buys at the market the household
  trades with, then the five nearest others in turn, or only at the one named. Stock-and-flow goods: the price **walks up the
  amount** as the shelves empty (`midPriceAt`), a market never sells its last tenth, plus the carter's fee
  `(2 % + distance/40 km) × (1 + weight/20 kg)` (at most 35 %). Index goods: bought as common quality at the shop price, 25 pieces
  (10 of a quality tool, 4 beasts) a market, the price rising with what was bought (a *want* that fades like a glut). The purse
  pays; the goods are **on the cart** (`E.save.carts`) for `0.3 + distance/12 km` days and arrive in the stores on the hour
  (a note to the player if it is his household). Partial when stock, purse or `maxPrice` run short; a besieged market sells nothing.
* `sell(household, good, qty, {settlement?, minPrice?}) → {sold, income, settlement}` — from the stores (the lowest quality first)
  into the market; the price sags along the amount, the carter's fee comes off, the stalls hold at most 3× their target; income to
  the purse at once.
* `deliveries(household)` lists what is on the road (good, qty, arrival day, market); `stockAt(settlement, good)` the market's stock.

### The field plan, the build order, buildings raised in play

* **Crop plan**: `sowingNow` takes the crop `sim.services.realm.cropPlan(settlement)[field]` sets for a field's next sowing when it
  fits (a winter corn in the autumn sowing, a spring crop in the spring); `'fallow'`, nothing, or a crop that does not fit leaves the
  rotation's old choice. The household farm (`macroSow`) and the player's first-offered sowing (`farm.sow`) both read it.
* **`HouseholdTask 'build'`**: `setTask(head, member, 'build')` is accepted; while the household has a live site
  (`sim.services.construction.sites(settlement)` with `household` = theirs, not done or cancelled) the member's day goes to it —
  `workSpot` is the site (hammer) — and they add nothing to the field labour; a head on the site earns nothing of his trade in
  those days. With no site the order stands in the plan but the day is as it would have been.
* **Buildings raised in play** are ordinary buildings: workplaces, jobs, recipes, barns and shops use only those with
  `construction >= 1`; the supply census listens to `construction` events; listings carry prices for the new kinds when they stand vacant.

### For the UI and the zone (wave B)

* **Playing steps back**: an option's `steps` run in order over its `seconds` by cumulative `share`; each step sets the body's
  `anim`, `mainHand` and `offHand` and, on entering, plays its `sfx` cue once (`bellows`, `hammer`, `quench`, `saw`, `chop`, `cut`,
  `dig`, `stir`, `fire`, and three new ones: `grind`, `scrape`, `knead`); the step's `label` ("Heat the bar") is the line to show
  under the progress bar. The outcome (`gains`, `message`) still arrives once, at the end. Options with steps: every `craft.*`
  (and `craft.masterpiece`), `dig.*`, `stock.slaughter.*`, `stock.butcher.*`.
* **Action ids new in the economy**: `stock.slaughter.<animal>`, `stock.butcher.<animal>`, `stock.slaughter.none`, `dig.clay`,
  `dig.silver`, `dig.gold`, `dig.timber` (and `dig.stone`, `dig.ore` as before), `craft.fire_bricks`, `craft.boil_salt`,
  `craft.make_vellum`, `craft.salt_meat`. The objectives' summary verbs (`verb.stock.slaughter`, `verb.stock.butcher`, `verb.dig.*`)
  fall back to the default wording until the text file has them.
* A craft option's `preview` says how the bench is paid for ("you hire the bench for 1d") and how risky the work is
  ("beyond your skill: 44 % the work is spoiled"); a disabled one says why (`reason`).
* Trade panels: the board of a market lists the twelve materials (the ones it has in stock); `EconomyApi.market(settlement).lines`
  carries `stock`; `stockAt`, `deliveries` and `procure` / `sell` serve the builder's and ruler's panels ("Waiting for 12 planks —
  on the way from Dromore market, 1 day" is `deliveries(household)` plus the market's name).
* The zone: a killed beast is gone from `holding(household).livestock` at once; `stock.slaughter` touches the household
  (`householdRevision`), so a redraw keyed on it sees the change.

## Links

* Social hooks (`setHooks`): `giveHook`, `itemInfoHook`, `priceTipsHook`, `dressTierHook`, `apprenticeHook`.
  Opinion reasons are the phrases `dialogue.json` words.
* `drop(person, key, qty)` and `give(person, 0, key, qty)` throw goods away.
* Save: `x:econ` (now with `carts`, the goods on the road), `x:econ.markets` (stocks of the 26 stock-and-flow goods; an older save's
  arrays are remapped by name), `x:farm` sections plus entity fields; reloading and continuing gives the same `stateHash()`
  (tested with a carcass in the larder, goods on the road, a kiln raised in play and a build order).

## Measured

Large mock world (about 12 000 people), economy systems per game hour: average 1.5 ms, 95th percentile 5 ms on a quiet
machine (the tests allow more because they share cores); one hour is one frame, so at 1x (1500 frames an hour) the
average frame pays 0.001 ms and at 8x (190 frames an hour) 0.008 ms. A hundred years of the tiny world take 5 s of the whole simulation.
Prices over 100 years: wheat 0.5 to 3.2 times base through the years (bad harvests), averaging 0.6 to 1.2.

Civilization pass (twelve more stock-and-flow goods, the supply model, household trade): the same large world, alternating runs of
the old and new code on the same machine, 1.4 and 1.5 ms against 1.4 and 1.9 ms an hour (the spread is the machine's); the
full continent for ten years (`npx tsx tools/fullsim.ts --years 10`) goes exactly as it did (the NPC households' path is
untouched): 14 477 people in year 1 and 14 036 in year 10, prosperity 1.04 to 1.07, 7 famines, 51 battles. The materials'
prices over the years (27 markets of the real world) sit at 0.7 to 1.7 of their base prices (the standing premium of the goods of
the ground and the forest factor of timber) and do not move without the works or the carts that move them.

## Known gaps

Animal-targeted work uses buildings and parcels rather than zone animals (leading a beast to the slaughterhouse is the
agents' *Lead*: the household's beasts are counted, not placed); boon-work and tolls are listed but simplified; NPC clothing is
not modelled (`dressTierHook` falls back to rank); a village without a market sells through the nearest market town only. The
macro households neither use nor make the building materials (the markets' supply model stands for them), and cull sheep and pigs
for meat and hides only (no tallow). The new works (clay pit, salt pans, lumber camp, slaughterhouse, quarry, mine) are not on any
generated plot: they come into play by building them or with the territory module's deposits.

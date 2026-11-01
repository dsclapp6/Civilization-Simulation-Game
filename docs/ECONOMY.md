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

## Goods (`src/content/goods.json`, ~95 goods)

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

Fourteen *macro* goods (wheat, rye, barley, oats, peas, beans, bread, ale, vegetables, cheese, eggs, meat, fish,
firewood) have a stock at each market and a price that follows scarcity; everything else is index-priced
(base price × quality × a slow glut term from what the player sold).

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
  reaped part of a strip, hay cocks for two days after a meadow is mown, a woodpile (`count` 1..8 from firewood) and a heap of
  grain sacks (from grain and flour) at each home or barn, stone at quarries, a stump where a tree was felled (permanent) and its
  logs (until the woodcutter has walked off). Households the economy keeps by the day hold no stores, so they show a seasonal
  baseline; the player's household shows exactly what it keeps. A strip the household farm harvests while it is being watched
  (the feed saw it ripe or cut, then stubble) stands in five stooks for about three-quarters of a day, as if carried in by the
  next afternoon. Ids are stable (`kind × 1e9 + entity`); the version moves only when the list differs. What the work leaves is
  remembered in `Econ.notes` (not saved); each new note moves `notes.rev`, which the feed rebuilds on, so a bout shows at once
  rather than at the next game hour.
* `drainFloaters` (`floatfeed.ts`): "+8 sheaves cut", "+3d", "Farming +2" over the player for a completed action, "Farming 3!"
  for a level, "−4d" / "+2 eggs" for a trade, "♥ +3" over the person whose opinion moved; a few a second.

## Links

* Social hooks (`setHooks`): `giveHook`, `itemInfoHook`, `priceTipsHook`, `dressTierHook`, `apprenticeHook`.
  Opinion reasons are the phrases `dialogue.json` words.
* `drop(person, key, qty)` and `give(person, 0, key, qty)` throw goods away.
* Save: `x:econ`, `x:econ.markets`, `x:farm` sections plus entity fields; reloading and continuing gives the same
  `stateHash()`.

## Measured

Large mock world (about 12 000 people), economy systems per game hour: average 1.5 ms, 95th percentile 5 ms on a quiet
machine (the tests allow more because they share cores); one hour is one frame, so at 1x (1500 frames an hour) the
average frame pays 0.001 ms and at 8x (190 frames an hour) 0.008 ms. A hundred years of the tiny world take 5 s of the whole simulation.
Prices over 100 years: wheat 0.5 to 3.2 times base through the years (bad harvests), averaging 0.6 to 1.2.

## Known gaps

Animal-targeted work uses buildings and parcels rather than zone animals; boon-work and tolls are listed but
simplified; NPC clothing is not modelled (`dressTierHook` falls back to rank); a village without a market sells
through the nearest market town only.

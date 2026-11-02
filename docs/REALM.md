# Realm (civilization pass, wave A: ruling, research, recruiting, trade orders, news)

`installRealm(sim, deps)` in `src/sim/realm/index.ts` implements the `RealmApi` contract (`src/sim/realm/types.ts`, design in
`docs/CIV.md` §6, §7, §10) and registers it as `sim.services.realm`. It is the simulation side of **ruler mode**: who rules a
place, what the ruler has (treasury, stores, troops), what he can commission (research, troops, knighthood, fields, labour for the
works, standing trade orders) and what he hears (news of neighbours and rivals). The player's ruler panel (wave B) and the AI's
rulers (wave B) use exactly the same calls. It works headless, and finds the other modules lazily on `sim.services` / `deps`:
advancement (research), military (forces, mercenaries), politics (stance, offices), economy (`procure` / `sell`, optional),
construction (outposts, optional). Any may be absent; the calls that need one say so in their `reason`.

```
npx vitest run tests/sim/realm tests/sim/advancement     # the module's tests
PERF=1 npx vitest run tests/sim/realm/realm.perf.test.ts # budgets (run alone)
npx tsx tools/fullsim.ts --years 10                      # whole-sim health (installs territory, construction and realm)
```

In the running game, from the browser console: `const r = __game.session.sim.services.realm, me = __game.session.sim.state.run.playerId;`
then `r.view(me)`, `r.researchOptions(me)`, `r.recruitOptions(me, settlement)`, `r.rivals(me)`, `r.news(10)`
(switch into a lord first: *Live as* a manor holder, or `__game.session.sim.switchTo(r.rulerOf(settlement))`).

## Who rules (`rule.ts`)

`rulerOf(settlement)` is the person who rules the place **now**:

* the holder of the place's **manor / town / abbey / barony** title; a **castle that is a county's seat** is ruled by the earl
  (`county` title), a kingdom's capital by the crown, and a place with no title of its own by its county's or kingdom's lord;
* when the holder cannot act (under 16, a captive, an outlaw or exile, dead) the **regent** (`Title.regent`), else the lord's
  **steward** (politics `holders('steward' | 'bailiff' | 'reeve', place)`, else a steward of the holder's House), else the holder
  himself (a captive lord is still named when no one can act for him); 0 only for a place no one holds.

`canRule(person)` is true for anyone with something to rule, and `rules(person)` says what, title by title and in what **role**:

| role | who | commands |
|---|---|---|
| `holder` | holds a manor, town, abbey, barony, county, kingdom or see title and can act | everything below, in the lands of that title |
| `regent` | rules for a minor holder | the same, from the ward's purse |
| `steward` | has the office of steward (or bailiff, when the lord cannot act) | field plans, works share and trade orders for the lord; **research, troops and knighting only while the lord cannot act** (`acting`) |
| `reeve` | the village's reeve | the field plan and works share of his village only; no treasury |

`mayCommand(R, person, scope, settlement?)` (in `rule.ts`) is the single authority check: scope `'plan'` (fields, labour), `'trade'`
(orders), `'realm'` (research, troops, knighting). A liege commands his own lands only, never his vassals' (a settlement is
under the title that governs it: `titleAtSettlement`).

`view(person)` (`RealmView`, null if the person rules nothing):

* `titles` (highest first; the first names the realm), `settlements` (held directly) and `vassalSettlements` (held from the
  person's titles, down four levels), `seat`, `markets`, `role`;
* `household` = the treasury: the **ruling household** (the holder's, also for a regent or steward) and its **purse**; `stores` = the
  stores of that household and of the other households that serve the same House in the realm's own settlements (garrison and
  staff households of the House, lord households and noble kin), merged by good (livestock too: a horse is a good);
* `population` and `prosperity` over the whole realm (direct + vassal), `strength` = the House's fighting weight (military);
* `income` / `spending` over a **rolling year (16 days)**, from the books below; `accounts(person)` gives the lines.

**The books (`books.ts`).** Once a day (23:00) each treasury is closed: what the realm entered itself (`bookIn` / `bookOut` with a
label: *Sales*, *Wages*, *Research*, *Goods bought*, *Troops: fees and gear*, *Dubbing*, *Research refunded*) is kept by label, and
whatever else moved the purse since the last close (rents and dues, the household's spending, works paid by construction) is seen as
the difference and counted as *Rents, dues and other receipts* or *Household, works and other costs*. Days nobody closed count for
nothing; buckets are overwritten after 16 days.

## Research (`research.ts`; prices in `src/content/techs.json` → `research`)

Each technique has a **price in its branch's currencies**: goods, coin (pence), days of a capable researcher's work (a game year
is 16 days) and the building kinds it is worked in (`TechDef.research`, `TechResearch` in `advancement/types.ts`).

* **Economy** — timber, planks, stone, bricks, straw · **Military** — iron, horses (destriers), stone (keeps, walls), arrows ·
  **Kinship & Diplomacy** — cloth, ale · **Knowledge & Belief** — vellum, candles (iron for the press).

`researchOptions(person)` lists the techniques the House **does not command** whose `requires` it does (a locked one is not shown),
each with `cost`, `researchers`, `places`, `ok` / `reason` and, when goods are short, `short` (good → missing), `buyCost` (pence at
the market, 20 % over), `buyable`, `days` (best researcher, best place), `slow` (the researchers who only qualify as clerks).

* **Researchers** are people of the realm's own settlements (14+) who *could work the technique out*: the careers / fields / titles /
  estates of its `learn` rules with the skill, rank and craft stage they ask (the *building* and *market* rules are the place's
  job here). Failing those, **clerks, clergy, stewards and craft masters** at half pace. A man at another work is busy.
* **Places** are finished, standing buildings of the technique's kinds in the realm's own settlements, best level first.
* **Pace** per day = `pace × (0.55 + 0.07·skill) × (0.7 + 0.03·Intellect) × (1 + 0.1·(level − 1)) × (0.7 away from the place)`,
  between 0.01 and 2.5, divided by `days`; `skill` is the technique's own skill (`letters` when it names none).
* `startResearch(person, tech, researcher, building, { buy? })` — researcher `0` = the best, building `-1` = the best place. It checks
  rank (`mayCommand 'realm'`), the House's lack of it, the prerequisites, the year gate, at most **4 works** per House, the researcher
  and the place; takes the coin from the treasury and the goods from the pool (treasury first, then the House's other households,
  best quality first). **Short of goods:** it refuses with what is missing — unless `buy: true`, when it orders the shortfall at the
  place's market through `economy.procure` (each good at once, carted; needs the treasury to hold the work *and* the goods), starts
  the work `stalled` with a note ("Waiting for 24 timber (24 on the road)") and watches the carts; the daily step takes the goods in
  as they arrive and orders again after a few days for what never came (never twice for what is on the road).
* **Daily step** (`researchDaily`, 4 shards by project id at 05:00–08:00): goods in, then `progress += rate`. Every eight days (and when
  stalled) a fuller check: the place is still standing and the House's, the researcher still fit — if not, **another man takes over**
  (the best qualified free one) or the work stands still ("No one is left to do the work"); a work that stands still for **48 days**
  is given up. `stopResearch` gives it up on order; half of the unspent coin (and goods already taken) comes back.
* **Done:** `advancement.grant(researcher, tech, 'research')` — and the ruler (and the holder when a steward or regent ruled) learns
  it too, so the House commands it; events `research` (`started` / `stalled` / `done` / `abandoned`) and news. The technique lives in
  its holders as ever (SPEC §17): it can be taught, written down, lost.

**Prices** (starting values, *tune*):

**Economy**

| technique | needs first | goods | coin | days | worked in |
|---|---|---|---|---|---|
| Heavy plough | - | 24 timber, 20 planks | 220d | 8 | carpenter, sawpit, smithy |
| Improved rotation | heavy plough | 16 timber, 30 straw | 360d | 10 | barn, tithe barn, granary, manor house |
| Watermill | - | 60 timber, 40 planks, 40 stone | 520d | 14 | carpenter, sawpit, smithy |
| Windmill | watermill | 80 timber, 60 planks, 20 stone | 640d | 18 | carpenter, sawpit, watermill |
| Fulling mill | - | 40 timber, 30 planks, 30 stone | 480d | 12 | weaver, watermill, fulling mill |
| Market charter | - | 30 timber, 20 planks | 600d | 8 | market cross, market hall, manor house, great hall |
| Fair charter | market charter | 60 timber, 100 brick | 1200d | 10 | market hall, guildhall, market cross |
| Guild charter | - | 40 timber, 60 brick | 900d | 12 | guildhall, market hall |
| Wool trade | - | 30 timber, 20 planks | 480d | 10 | warehouse, market hall, dock, guildhall |
| Letters of credit | wool trade | 10 planks, 40 brick | 1200d | 12 | guildhall, warehouse, market hall |

**Military**

| technique | needs first | goods | coin | days | worked in |
|---|---|---|---|---|---|
| Longbow drill | - | 6 iron, 120 arrows | 240d | 10 | archery butts, training yard, barracks |
| Crossbows | - | 20 iron, 20 timber | 320d | 12 | smithy, barracks, training yard |
| Coat of plates | - | 40 iron | 480d | 12 | smithy |
| Plate armour (year 6) | coat of plates | 120 iron | 1800d | 28 | smithy |
| Destriers | - | 4 horses | 600d | 18 | stable, training yard |
| Stone keep | - | 400 stone, 80 timber, 20 iron | 1500d | 32 | motte, manor house, great hall, tower |
| Curtain walls | stone keep | 900 stone, 40 iron | 4000d | 44 | stone keep, tower, gatehouse, motte, wall |
| Concentric castle (year 4) | curtain walls | 2000 stone, 120 iron | 12000d | 72 | stone keep, wall, gatehouse |
| Trebuchet | - | 120 timber, 30 iron | 900d | 22 | carpenter, sawpit, barracks, training yard |
| Paid retinues | - | 10 iron | 1200d | 10 | barracks, great hall, manor house |
| Bombards (year 10) | trebuchet | 200 iron | 4000d | 48 | smithy, bloomery |

**Kinship & Diplomacy**

| technique | needs first | goods | coin | days | worked in |
|---|---|---|---|---|---|
| Marriage pacts | - | 10 cloth, 40 ale | 300d | 8 | manor house, great hall, church |
| Wardship | - | 8 cloth, 30 ale | 300d | 8 | great hall, manor house |
| Oaths of fealty | - | 6 cloth, 30 ale | 200d | 6 | church, chapel, great hall |
| Truces | oaths | 12 cloth, 60 ale | 400d | 10 | church, abbey church, great hall |
| Heralds | oaths | 24 cloth, 40 ale | 500d | 10 | great hall, manor house |
| Tournaments | heralds | 30 cloth, 150 ale | 900d | 14 | training yard, archery butts, great hall |
| Alliance treaties | oaths, marriage pacts | 30 cloth, 100 ale | 1200d | 16 | great hall, stone keep, church |
| Council of the realm | oaths, charters | 60 cloth, 300 ale | 3000d | 28 | great hall, cathedral, stone keep |

**Knowledge & Belief**

| technique | needs first | goods | coin | days | worked in |
|---|---|---|---|---|---|
| Parish school | - | 6 vellum, 40 candles | 120d | 6 | church, chapel, school, cloister |
| Scriptorium | parish school | 30 vellum, 120 candles | 300d | 10 | cloister, abbey church, church |
| Cathedral school | scriptorium | 60 vellum, 240 candles | 600d | 18 | cathedral, abbey church, cloister |
| University (year 3) | cathedral school | 200 vellum, 600 candles | 2400d | 42 | cathedral, school |
| Herbal medicine | - | 8 vellum, 40 candles | 160d | 8 | infirmary, cloister, church |
| Infirmary and hospital | herbal medicine | 20 vellum, 100 candles | 480d | 14 | infirmary, cloister |
| Charters and records | - | 20 vellum, 60 candles | 240d | 10 | school, cloister, church, guildhall, manor house |
| Accounting | charters and records | 30 vellum, 80 candles | 420d | 12 | guildhall, school, market hall, manor house |
| Printing (year 12) | accounting | 100 vellum, 300 candles, 40 iron | 3000d | 56 | school, guildhall, cathedral |

A price is always above the technique's lesson fee, and above its parent's in coin and days (tests: `tests/sim/advancement/research-data.test.ts`).

## Recruiting and knighting (`recruit.ts`; numbers in `config.ts`)

`recruitOptions(person, settlement)` lists six kinds; `recruit(person, settlement, kind, count)` raises them at a settlement the
person **governs** (`mayCommand 'realm'`):

| kind | gear per man (from the pool, else bought at 125 % of the usual price) | fee | wage / day | needs | fit men |
|---|---|---|---|---|---|
| archer | longbow, 24 arrows | 6d | 2.5d | - | Str 9, 15-45 |
| crossbowman | crossbow, 20 bolts, padded armour | 8d | 3d | technique *Crossbows* | Str 8, Per 8, 15-45 |
| man-at-arms | sword, shield, spear, padded armour, cap | 12d | 5d | - | Str 10, End 9, 16-45 |
| mounted sergeant | horse, sword, lance, shield, padded armour, cap | 24d | 8d | - | Str 10, End 9, Agi 8, 18-45 |
| knight | good horse, good sword, lance, shield, mail, kettle hat | 120d | 12d | - | Str 10, End 10, 18-55; rank 3+ or noble-born, or one of the House's own soldiers |
| mercenary | none (the company brings its own) | 12d | 4d, under arms | - | free swords within 5.5 km (military module) |

* **Who:** men of the place who are fit, free and **not the head of a household** (a household is never broken up), not clergy,
  captive, outlaw, in an army or already serving (the House's own archers / men-at-arms / squires may be **promoted** to sergeant or
  knight). Best first by stats and skills. `available` counts them.
* **Raising:** each man joins the House's **garrison household** in that settlement (`kind 'garrison'`, `house` = the realm's House, no
  `target` so the world does not refill it for free; a barracks is its home when one stands free) so the **military module counts him
  with the castle's own men**; he is sworn to the House, given the career and rank of the post (`archer`, `man_at_arms`, `sergeant`,
  `knight`), drilled up to its skill levels, handed his gear (the horse stays in the household's stores) and paid the fee. Knights
  keep their own household. As many are taken as the treasury can pay: fees, gear to buy, and **a week's wages in hand**.
  `RecruitOption.buy` is the pence per man for gear the pool lacks, `equipped` how many the pool can arm, `affordable` how many the
  treasury can pay. Crossbowmen are given career `archer` plus a crossbow: the military module does not tell them from archers.
* **Wages:** every day (09:00) each treasury pays its men into their households; short of money the arrears grow, and after **6 days**
  of arrears each man has a 12 % chance a day to desert (back to a labourer; news and a notice). `troops(person)` lists the men,
  `discharge(person, man)` sends one home (a knight keeps his knighthood and only loses the wage). Dead men leave the roll.
* **`dub(person, candidate)`** — the accolade. The dubber must be a knight or a lord who can act; the candidate a man of 18+ who is
  **one of his men** (his House, sworn, or living in his lands), not a knight already. His horse and armour come from his own stores,
  then the lord's, else are bought, plus 60d for the vigil and the feast. He becomes a `knight` of rank 5 (noble estate), sworn to
  the House; points to the player on either side. **A ruler dubs himself only by his liege's leave**: he needs a liege (politics)
  whose opinion of him is not below −10. (The military module's own knighting for valour is private to it, so this repeats its few
  lines rather than calling it.)

## The field plan and the works share (`plans.ts`)

* **Field plan.** A field has two sowings in the three-field rotation: winter corn in the autumn of its fallow year and a spring crop
  in the spring after (`src/sim/farming.ts`). The plan stores a winter crop (wheat, rye) and a spring crop (barley, oats, peas, beans)
  per field. **`cropPlan(settlement)[field]` is the crop for the field's NEXT sowing, or `'fallow'` when none is named** ("the usual
  rotation decides"); the economy reads it when it sows. `setCropPlan(person, settlement, field, crop)` files a crop under its season;
  `'fallow'` clears the field. `cropPlanView(settlement)` gives the UI each field's role, next sowing, both plans and the choices.
  Who: holder, regent, steward or reeve of that manor.
* **Works share.** `worksShare(settlement)` is the share (0..1, in twentieths) of the manor's week-work sent to the lord's building
  sites instead of the demesne; `setWorksShare` the same authority. Construction reads it. Cheap enough to ask for every site.

## Trade orders (`trade.ts`)

`addTradeOrder(person, { settlement, good, side, limit, keep })` belongs to the **treasury** (whoever rules from the same household
sees and may remove it); `settlement` is the market (a place with a market, or −1 for the treasury's own), 24 orders at most.
Carried out **once a day** (10:00-15:00, by order number) through the economy's optional `sell` / `procure`:

* **sell:** whatever the pool holds above `keep` (at most 400 a day, and only what the treasury's own stores hold) when the market's
  price is not under `limit` (0 = any); **buy:** up to `keep` in store (counting what is on the road), when the price is not over
  `limit`, spending at most a quarter of the purse a day. `done`, `money`, `note` (what the last attempt did), `last`, `transit`.
* Without `sell` / `procure` the orders only wait ("There is no merchant").

## News and rivals (`news.ts`)

A ring of the last 160 items (`NewsItem`: kind `built | founded | research | recruited | army | war | peace | fell | grew | famine |
other`, the House, the settlement, a line of text, a **threat** 0..1) fed by the events: a neighbour's buildings (walls, towers,
barracks, mills… not homes), techniques gained, troops raised, armies raised (polled daily), wars declared and ended, sieges, raids,
outposts founded, famine and plague, heirs to great titles, alliances and truces, towns that grew a fifth in a year. Event `news` is
emitted for each.

`threatOf(house, settlement, weight)` = `clamp(weight × (0.45·stance + 0.25·proximity + 0.30·relative strength))` for the player's
House: *stance* war 1, hostile 0.85, neutral 0.5, truce 0.3, trade 0.25, vassal 0.2, kin 0.15, liege 0.1, alliance 0.05;
*proximity* `clamp(1 − distance/12 km, 0.05, 1)` from the player's nearest settlement; *relative strength* `clamp(theirs / ours / 2)`;
*weight* is how much the deed matters to safety (an army 0.9, a war 0.6, 1 on the player; a wall 0.7, a mill 0.2, a barn 0.1).
The House's own deeds threaten it not at all.

`rivals(person)` lists every other landed House within 30 km (the whole continent is 16 km across): `distance`, `strength`, this
year's `built` / `techs` / `recruited` (the year so far plus the part of last year that still falls in the last 16 days), `stance`,
`threat` (`0.45·stance + 0.25·proximity + 0.30·strength + growth`, growth up to 0.15), `head`, `seat`, `settlements`, `share` of the
continent's fighting weight; greatest threat first.

## Calendar and budgets

One hourly system `realm.hour` (order 80) and one yearly: research 05:00-08:00 (4 shards by project id), wages 09:00, trade orders
10:00-15:00 (6 shards by order id), news and outposts 16:00, books 23:00; the turn of the year rotates the counters. With nothing
in hand a call costs a few microseconds (the books, once a day, about 0.1 ms). Measured on the 11 000-person continent with an
**extreme** load (72 projects, 239 orders, 480 men on pay, every great House busy, a machine at load 15): a day costs about 3-5 ms
spread over 18 hourly calls, none above about 2 ms; with a ruler or two at work a few tenths of a ms. The calls a UI or an AI makes,
on the real continent (medians): `rulerOf` 0.1 µs, `canRule` 1 µs, `worksShare` / `cropPlan` < 0.2 µs, `view` 10-25 µs, `news` 0.2 µs,
`rivals` 0.15 ms, `recruitOptions` 0.3-0.9 ms, `researchOptions` 0.9-1.1 ms. (`tests/sim/realm/realm.perf.test.ts`; `PERF=1`.)

## Saved state — `state.ext['realm']`

`RealmSave` (`store.ts`): `projects` (with `needs`, `cart`, progress and the price paid), `orders`, `plans` (per settlement: works share
and the per-field winter / spring crops), `troops`, `arrears` / `behind` (per treasury), `gar` (the garrison households made),
`news`, `seen` / `outs` (armies and outposts already told), `ctr` (per House: built / techs / recruited, this year and last),
`books`, `pop`. Plain JSON; ids are sequential; every decision is a function of it and of the world, so save → load → continue is
hash-identical (tests: `tests/sim/realm/save.test.ts`, weeks of continuation with work, wages and orders in hand).

## Contract changes (all additive, `src/sim/realm/types.ts` unless noted)

* `RealmView`: `role`, `seat`, `markets`. New types `RealmRole`, `RealmRule`, `RealmTroop`, `CropPlanLine`, `AccountLine`.
* `ResearchOption`: `slow`, `short`, `buyCost`, `buyable`, `days`. `ResearchProject`: `started`, `rate`, `needs`, `settlement`, `paid`.
* `RecruitOption`: `buy`, `equipped`, `tech`, `affordable`. `TradeOrder`: `money`, `note`, `last`, `transit`.
  `RivalView`: `head`, `seat`, `settlements`, `share`.
* `RealmApi`: `startResearch(…, opts?: { buy? })` (extra optional argument); optional members `rules`, `troops`, `discharge`,
  `cropPlanView`, `accounts`. The doc of `cropPlan` / `setCropPlan` now says what the crop means (the next sowing).
* `installRealm` returns a `RealmRuntime` (the API plus `ctx` and `dispose()`); `realmOf(sim)` and `realmContext(sim)` are exported.
* `src/sim/advancement/types.ts`: `TechDef.research?: TechResearch`; `src/content/techs.json`: every technique has `research`;
  `Adv.grant` words `via 'research'` for the player.

## For wave B

**The ruler panel.** Everything it shows is a call: Overview `view` / `rules` / `projects` / `troops` / `news` / `rivals`; Lands &
works `view.settlements` + construction's `sites`; Fields & labour `cropPlanView` / `setCropPlan` / `worksShare` /
`setWorksShare` (plus politics' `manorPolicy`); Research `researchOptions` → `startResearch` (offer *Start* when `ok`, *Buy the
rest and start* when `buyable`), `projects`, `stopResearch`; Military `recruitOptions` → `recruit`, `troops`, `discharge`, `dub`
(and military's `forces`, `raiseArmy`, `order`); Trade `tradeOrders` / `addTradeOrder` / `removeTradeOrder`; Rivals `rivals`,
`news`. `version()` bumps on every change the panel shows (not on a rise of the purse by rents: poll `view` for that). *Rule this
town* is `sim.switchTo(realm.rulerOf(settlement))`. Use `view(person).role` to hide what a steward or reeve may not do; every call
returns a plain-words `reason` to show when it refuses.

**AI rulers.** Same calls with the ruler's id (`rulerOf(settlement)` finds him; the steward acts when the lord is held captive).
A plausible weekly round for a House: `view` for treasury and stores; `rivals` / `news` for threat; if threatened → `recruitOptions`
for the seat and `recruit` archers / men-at-arms, then `researchOptions` for the military branch and `startResearch(…, { buy: true })`
the best `ok || buyable` one the personality likes; if rich → economy or knowledge techs; `addTradeOrder` to sell surplus grain and
buy the materials its plans need; `setCropPlan` for the demesne (rye after a bad harvest); `dub` a deserving squire. The calls are
cheap, but `researchOptions` scans the realm's people (about 1 ms for a kingdom): do it a few times a year per House, not every day.

## Known gaps

* The economy's `procure` and `sell` are written by another builder; the realm was tested against a stand-in with the same
  signature (`tests/sim/realm/helpers.ts`, `MarketStub`). Goods that are not stock-and-flow goods may be thin at markets, so a
  research that wants 200 vellum is bought over several orders (the work waits for the carts).
* Crossbowmen are archers to the military module (it has no crossbow career for garrison men); knights recruited are retinue.
* Nobody uses these calls yet except the player's future panel: the AI's use is wave B. Treasuries of NPC lords are pulled by the
  economy toward a rank-size purse (`householdDay`), which shows in their books as other costs.
* A regent / steward ruler's `view().house` is the holder's House (the realm's), not their own.

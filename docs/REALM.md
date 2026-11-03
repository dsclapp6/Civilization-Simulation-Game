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
the difference and counted as *Rents, dues and other receipts* or *The household's keep and the works*. Days nobody closed count for
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

### Who can be knighted (`dubCandidates`)

`RealmApi.dubCandidates?(person, max)` lists every man of the ruler's House, those sworn to it and those of the places held directly who
could be given the accolade - a grown man (18 to 55), whole, not of the Church, not a knight yet, not a prisoner or outlaw, and with
some standing in arms (a squire, sergeant, man-at-arms, archer, soldier or sell-sword, or skill in melee, or gentle rank) - not only the
men raised through `recruit`. Best first; each with a `why` ("in your pay", "sworn to you", "of your House", "of Dromore"), his career in
words, age and melee. `dub` itself is unchanged and decides whether the treasury can pay the vigil. The ruler's Military page shows the
list as "Men fit for the accolade" with *Dub a knight*, beside "Your knights" (*Fight as him*: `docs/ui/LANDS.md` §2).

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

## The AI rulers (`ai*.ts`, wave B)

Every House that rules land is run by its ruler (`rulerOf`; the steward when the lord cannot act) with **the player's own calls, costs
and labour** (`docs/CIV.md` §10): the builder's `place` / `upgrade` / `repair` (paid from the ruler's purse and stores, built by the
same labourers, supplied by `procure` at the same markets), research through `startResearch(…, { buy: true })` (chosen among the techniques by
their own prices and places, as the panel's `researchOptions` list shows them, but without the list's scan of the realm's people),
`recruitOptions` / `recruit` / `dub`, `addTradeOrder`, `setCropPlan`, `setWorksShare`, and outposts through `place` at a wild deposit.
Nothing is given to them: the rule tables (`construction/data.ts` rank, technique and count rules), the prices and the labour pool are
the player's. The **player's own House is never run** (`R.isPlayersHouse`), and `installRealm(sim, deps, { ai: false })` leaves the
rulers out. `RealmRuntime.ai` (`RealmAi`) is the surface for tests, tools and dev pages:
`table()` (the yearly table below), `units()`, `dueAt(hourIndex)`, `sense(ruler)`, `runRound(ruler)`, `enabled`, `data`.

```
npx vitest run tests/sim/realm/ai tests/sim/politics/might   # the rulers' tests (ai.test.ts, aiSave.test.ts, might.test.ts)
PERF=1 npx vitest run tests/sim/realm/ai.perf.test.ts        # budgets (run alone)
npx tsx tools/fullsim.ts --years 10 [--no-ai]                # the yearly table of what they did; --no-ai for the same continent without them
```

In the game's console: `const ai = __game.session.sim.services.realm.ai; ai.table()` (the years so far), `ai.units()` (the rulers dealt out),
`ai.sense(ai.units()[3].ruler)` (what one sees: purse, fear, places, open works), `ai.trace = []` then play on (each ruler writes down why
he did not do what he weighed), and `__game.session.sim.services.realm.news(30)` for what the neighbours hear.

**When.** The rulers are dealt over the 96 hours of the four-day week (rank `i` of the units, by lowest settlement id, is due in hour
`i mod 96`: about one is due each hour, never more than two). Each round is cut into six shards of the hourly system `realm.ai`
(order 85), so that no call holds the two expensive things together:

| shard | stage |
|---|---|
| 0 | look round (`senseOf`), the share of labour sent to the works, the fields, the orders, and a look at the markets (prices and stock of the dear materials at the place he will look at: the market's census is recounted after any building event, and the first question pays) |
| 1 | choose the work: mend what is hurt, else the best-scoring want the purse, the markets and the ground allow (the spot search is the dear call), else an improvement |
| 2 | stake it out: `place` / `upgrade` / `repair` |
| 3 | arms: `recruit` when short of men, `dub` the worthiest |
| 4 | research (every other round) and the choice of an outpost |
| 5 | found the outpost |

**What he sees (`aiSense.ts`).** His purse and what the open works still owe (`allowance` = funds − the comfortable purse − 0.8 × committed),
the men on his pay roll, and place by place the people, the homes and how many families share one, what stands (and what is going up),
what is hurt, the siege model's multiplier for his walls (`fort`, 1..3.2: exactly what `military/siege.ts` counts, shared through
`politics/might.ts`), and **fear** (0..1): the worst of his neighbours by stance (war 1, hostile .75, neutral .25, truce .12 … alliance 0) ×
their strength beside his × their ambition, a war (.45-.95), a coalition against him, an alarm or a siege at his gates; with a floor from
his own ambition. He wants the walls to count for `1 + 2.2 × fear` (`fortWanted`).

**What he builds (`aiWorks.ts`, `aiSupply.ts`, `aiSpot.ts`).** A table of rules scores every kind for the place of the round
(score = rule × a weight by group and temper: faith by piety, defence by `0.4 + 1.1 fear`, military by ambition and fear, trade by greed):
homes when families share a home (and none stands empty), the granary / barn / mills / smith / carpenter / weaver / tannery /
bakehouse / brewhouse a place of that size lacks, a mill by a river, a lumber camp, saw pit, quarry, clay pit, kiln or mine where the
timber, planks, stone, bricks or iron he builds with run dear, markets, wells, a church for the faithful, a school, a cloister,
archery butts / barracks / a yard when afraid or ambitious, and **defence by the fear**: palisade (fear ≥ .3) → curtain wall (with
`curtain_walls`) until the walls count for what he fears (three pieces of wall already fill the sum the siege counts), then the towers (with
`stone_keep`) and the gatehouse (with `curtain_walls`) that go with the wall that stands, and a stone keep at the seat or a motte where the keep is
not yet known. A
want must also be **permitted** (rank, technique and count — the builder's own `rulesOf` / `maxPerSettlement`), affordable (`liveValue`
at today's prices against the allowance and a share of it), **supplied** (the first days' materials in his stores or at the market with a
margin, not dearer than 2.6 × the usual price; a material the market lacks makes him lay in a **standing buy order** — `stockUp`, taken
down when the store holds it or after 48 days — and start when it is in), and have a **spot** (`findSpot`: at most 32 `construction.check`
looks — a spiral round the anchor for homes, the edge of the village for farms and works, the ore for a mine, the woods for a camp, the
newest wall run or a ring toward the threat for walls — and a quarter-turn when the first try fails). A work that fails to find room,
refuses, or lacks a material is put off for 16 days, twice as long each time it fails again (up to 8×); a work that stands still for 16 days
is cancelled. The ruler keeps only a few works going (manor 2, abbey 2, barony 3, county 4, kingdom 6, × pace) and starts none while one
waits for a material. The year's **share** of works is `(0.25 + 0.35 × places) × class (1 / 1.3 / 1.8 / 2.2) × pace`, and up to 1.8 times
that when he is afraid (`1 + 1.2 × (fear − 0.3)`), the fraction decided by the House's luck of the year (a manor builds one or two works a
year; a kingdom with a dozen places, a dozen). A work that stands still at its last step for 12 days (see the hand-offs) is no longer
counted among the ones he waits on.

**What he trains and learns (`aiMilitary.ts`, `aiResearch.ts`).** Men under arms = people × (0.01 + 0.05 fear²) × (0.8 + 0.4 ambition) × pace, capped
by class (manor 14 … kingdom 140), the mix archers .45 / men-at-arms .35 / sergeants .14 / crossbowmen .06 (once the House has the
technique); one muster per 6 days at most, never while the old men are unpaid or the purse is thin (forty days of the men's wages in hand
besides the comfortable purse),
and a worthy man (melee 5, grown, whole) is knighted every 12 days or so. Research: every technique he does not have is scored by what
suits him (the military branch by fear and ambition, the mill where there is a river and grain, the charters where there is a market,
the letters by piety), weighed against its price in coin and goods and **what he can have**: goods the market keeps only a shelf of
(arrows, cloth, horses) are bought a shelf at a time, the dear materials must be in the market (a great House, with two hands or more for
research, may begin with a quarter of them there: the realm's research orders the rest again every few days and waits for the carts, which is
how the stone keep and the curtain walls come at all), and a place of the right kind must stand (else the works planner raises one). He starts one at the pace of his class (manor every 24 days, kingdom every 6; 1-3 at once).

**Trade, fields, outposts (`aiTrade.ts`, `aiOutpost.ts`).** The fields: rye after a hard year or on tired soil, pulses where the soil is
tired, wheat / barley / oats otherwise. Orders: a surplus of wool, cheese, grain or ale above what the table needs is put on sale once a
year; a thin purse takes the buying orders down. Outposts: a baron or greater (1 / 1 / 2 by class), at most one in three years, whose
lands lack stone, iron, clay, salt (on a coast) or (greedy and ambitious) silver or gold, and who finds the deposit in the wild within
6.5 km and not within 700 m of another camp, with the materials for the first days: a quarry, mine, clay pit or salt pan staked out
at the deposit with `place` (the builder claims the 600 m of wild land round it). The realm's own `outpostsDaily` tells the news.

**Difficulty** (`PACE`): Squire .6, Knight 1, Lord 1.15, King 1.3 times the works kept going, the research started and the men kept.
Prices, labour and rules are the same on every difficulty.

**The news.** The deeds the neighbours would see are reported by the realm's own feed (`built`, `techs`, `recruited`, outposts); on
top of that the rulers tell of a palisade, wall, tower, keep, motte, barracks or yard when they stake it out ("Poynings is raising a
palisade at Thornfield"), a kind of work at most once in 16 days per House, with a weight by how much it matters to safety (`NOTABLE`).

**The rival AI in politics reads what they do** (`politics/might.ts`, `politics/ai.ts`; `src/sim/politics/README.md`): the walls of a
target (`bulwark`, the macro siege's own sum over the target's demesnes), the quality its techniques add to its men (`might`), how thin
its standing force is (`thin` → `weakness`), and whether it has out-built the House this year (`outbuilt`, fed through
`politics.setGrowthSource`, which the rulers set to built + ½ techniques + ¼ recruited).

**Saved state — `state.ext['realm.ai']`** (`AiSave` v1): per House `no` (what failed and until when) / `nf` (how many times in a row) /
`said` / `at` (when a thing was last done: research, muster, accolade, orders, outpost, fields) / `outs` / `yr` (works this year); the rulers'
open works `s` (site, day, kind, work, place, House; at most 400), how far each has got and since when `g`, the research they started `r`,
the yearly table `y` (the last 40 years). Everything else is read from the world each round (stateless decisions from the world and `hash01`), so save → load → continue
is hash-identical (`tests/sim/realm/aiSave.test.ts`).

**Knobs** (`aiConfig.ts`): `AI` (retry days, the check budget of a spot search, shares of the purse a work may take, the dear price
and the supply margin, the year's share), `PACE`, `YEAR_SHARE`, `OPEN_SITES`, `RESEARCH_AT_ONCE` / `RESEARCH_GAP`, `OUTPOSTS` / `OUTPOST`,
`TROOPS_AI`, and the rule table with its numbers in `aiWorks.ts` (`RULES`). `ai.trace = []` records why a ruler did not build.

### What they did (`tools/fullsim.ts`, the real continent: 140 settlements, 102 rulers, Knight)

`npx tsx tools/fullsim.ts --years 30` prints the table below (the first ten years; the columns are in the header of the tool's output:
*works* staked out by the rulers - new buildings, improvements and mendings -, *built* of them new, *homes*, *walls* = palisade / wall /
tower / gatehouse / motte / keep pieces, *done* finished, *res* research started, *techs* worked out, *recruit*, *knights*, *orders* given,
*crops* fields planned; then the books at the end of the year: buildings standing, fortification pieces, men under arms, works open
in the world, outposts, rulers below their comfortable purse, the median purse over the comfortable one, wars declared in the year).

```
year works built homes walls upgr repair  done cancel outp  res techs recruit knights orders crops | bldgs forts  men open outp  low/all  purse wars
   1   152   133    42     3    15      4   118      0    2   77    21     213       0     44   327 |   8612  4086  204   37     2   3/102   5.1    6
   2   109    90    44     8    19      0   103      1    0   55    52      87       1     74   145 |   8695  4092  268   43     2   2/102   5.1    4
   3   109    86    41     4    15      8   102      0    0   76    60      38       9     31   134 |   8778  4098  281   51     2   3/102   5.0    2
   4   111    73    27     4    17     21   106      1    0   86    50      33      22     24   143 |   8848  4101  285   54     2   3/102   4.9    2
   5   121    79    25    16    21     21   111      0    0   48    55      48      20     23   151 |   8920  4114  297   68     2   6/103   4.5    4
   6   126    92    31     9    11     23   112      0    0   75    59      24      11     18   151 |   9000  4127  283   81     2   9/103   4.3    3
   7   125    95    32    12    10     20   121      0    0   67    46      99      16     29   157 |   9090  4133  347   86     2  10/103   4.0    8
   8   136    98    25    12    12     26   132      1    0   48    46      21      22     20   137 |   9192  4148  325   88     2  10/103   4.0    3
   9   117    82    20    15    13     22   118      0    0   66    46      34      25     10   127 |   9271  4155  329   88     2  12/101   3.9    2
  10   109    88    18     8    10     11   100      1    0   57    46      35      29      8   147 |   9352  4172  330   95     2  12/101   3.8    6
```

And by decade over thirty years (sums; the books at the end of the decade):

```
years   works built homes walls upgr repair  done cancel outp  res techs recruit knights | bldgs forts  men open
 1-10    1215   916   305    91  143    156  1123      4    2  655   481     632     155 |  9352  4172  330   95   wars 40
11-20    1012   618   160    88  181    213   942     13    0  479   448     266     133 |  9932  4253  286  155   wars 27
21-30     734   351   116    66  214    169   677     14    0  430   421     341      78 | 10254  4311  285  192   wars 25
```

**Read it so.** The first year is the rulers' catching-up (152 works, a quarter of them homes for families that shared one, and the first
muster of 213 men); the works then settle near 110-135 a year and taper (about 100 in the second decade, 65 in the thirtieth year) as the places
fill and the rules' counts are met, while mending and improving (about 20 a year each) take over; the buildings of the continent grow by a fifth in thirty
years (8 612 → 10 254), the fortification pieces by 5% (4 086 → 4 311: the rulers wall what is threatened, which is few places, and the timber and
stone for it are dear), the men under arms from 204 to about 330 and then settle near 285. The great wall techniques are slow to come: 6 Houses of 101 have
the stone keep and 1 the curtain walls after ten years, so the defence is mostly palisades (92 in ten years), with a few towers and walls. *Open* is every work of the
world still open: it grows (37 → 192) because of the builder's last-fee stall (see the hand-offs); the rulers do not count a work that has stood
still at its last step for 12 days among the ones they wait on. Outposts: only the high country is nobody's, so the great Houses find few deposits in
the wild: two founded in the first year, none after. The people and their prosperity are what they are without the rulers: population 14 495 → 14 468
with them (it dips to 13 849 in the twelfth year and recovers; drift +0.05% a year), 14 479 → 14 204 without; prosperity 1.02-1.07 with them, 1.00-1.08
without; famines 44 in thirty years against 35; wars 92 against 117; sieges 79 against 63; battles 229 against 190.

### What they cost

`realm.ai` is six shards a game hour (a ruler's round is about one call in six). Measured on the real continent (102 rulers, the two game years after
two of warm-up) as the per-call **minimum over three runs** of the same deterministic simulation (it repeats itself call for call, and a shared machine only ever
adds to a call: single runs here, at a load of 15 on four cores, showed 7 ms an hour):

| | ms per game hour | mean call | 99th percentile | longest | calls over 8 ms (of 4 608) |
|---|---|---|---|---|---|
| as shipped | 3.9 | 0.65 | 5.9 | 15.2 | 17 |
| with the economy census patch (hand-off 1) | 2.2 | 0.37 | 2.6 | 9.3 | 1 |
| and the construction fee fix (hand-off 2) | 2.2 | 0.36 | 2.6 | 11.5 | 4 |

(The third row builds more: fewer works stand stalled, so the rulers have more to do and the world 1 747 construction events in the two years against 1 467.)

**The brief's budget - 1 ms a game hour on average, no call over 8 ms - is not met as shipped.** With hand-off 1 alone one call in 4 608 is over 8 ms
(9.3) and the average is 2.2: about half of what remains is the shared caches rebuilt by whoever asks first (below). Where the time goes, by the CPU profile (shares of what `realm.ai` is charged): the economy's recount of the world's
works 41% (5% with the patch) - every `place` and every finished work makes the markets count again, and whoever asks first pays -, the AI's own code
14% (20%), the politics snapshot and personality 11-15%, the territory's hourly look and the lands index 18-20%, the builder's `check`
and `place` 8-16%, the realm's own `recruitOptions` / `research` 7-14%, the military's reading of forces 1-8%. The snapshot, the territory's look and the
military's reading are rebuilt once an hour by whoever asks first: in the headless run that is often the rulers' first round of the hour; in the game the zone, the
agents or the screens may ask before them. Against a run without the rulers the whole process takes 5-7 ms of CPU more per game hour as shipped and 2.5-3.5 with hand-off 1 (an A/B of
`--no-ai`, noisy on this machine).

What the rulers do to keep the cost down: rounds dealt out one or two to the hour and cut into six shards; the cheap fields of a place first and the pass over
its buildings only for the place of the round; a year's share of works and a few open sites per House (about 130 works a year for a hundred rulers, each
of which makes the economy recount); the markets asked once an hour for the same price; the research picks worked out once per look round; the fields planned once a
year; a spot search of at most 32 looks (the builder's `check`, 25-100 µs). `tests/sim/realm/ai.perf.test.ts` (`PERF=1`, run alone) holds the budgets on the
11 000-person mock continent.

### Hand-offs (found while measuring; none of them is in the rulers' files)

1. **`src/sim/economy/supply.ts` recounts the world's works too often and too slowly.** The census is rebuilt when a building is added,
   when a construction event says one was placed, finished or cancelled, and whenever the territory's *version* moves, which it does for
   every building raised or finished; each rebuild asks the territory `depositNear` four times for each of the 140 settlements. With
   the rulers at work that is 0.8 rebuilds an hour at about 2.4 ms each (620 in two game years, of which 336 were the territory's
   version), charged to whoever asks the markets first (`place` pays one, because the site orders its first materials at once). The
   census depends on the territory only through the deposits, which never move; a site just staked out adds no works. A patch that
   caches the deposits per deposit list, ignores a staked-out site and drops the version from the key takes `realm.ai` from 3.9 to 2.2 ms
   per game hour and the calls over 8 ms from 17 to 1 (the whole economy and construction suites pass with it). The player's own
   building hits the same census. The patch (`src/sim/economy/supply.ts`):

   ```diff
   +/** Which deposits lie in reach of each settlement, remembered per deposit list of the territory: the ground does not move. */
   +const depCache = new WeakMap<readonly object[], Map<number, SourceInfo>>();
   +function depsAround(E: Econ, s: Settlement): SourceInfo {
   +  const terr = E.sim.services.territory;
   +  const list = terr ? terr.deposits() : undefined;
   +  let m = list ? depCache.get(list) : undefined;
   +  if (list && !m) { m = new Map(); depCache.set(list, m); }
   +  let v = m?.get(s.id);
   +  if (!v) {
   +    v = { stone: depositNear(E, s.x, s.z, REACH, 'stone'), clay: depositNear(E, s.x, s.z, REACH, 'clay'), iron: depositNear(E, s.x, s.z, REACH, 'iron'), salt: depositNear(E, s.x, s.z, REACH, 'salt') };
   +    m?.set(s.id, v);
   +  }
   +  return v;
   +}
    function sourcesOf(...) {
      const has = ...;
   +  const d = depsAround(E, s);
      return {
   -    stone: has('quarry') || depositNear(E, s.x, s.z, REACH, 'stone'),   // and the same for clay, iron, salt: use d.stone, d.clay, d.iron, d.salt
   +    stone: has('quarry') || d.stone,
   ...
    function census(E: Econ): Census {
   -  const rev = E.worksRev, size = E.state.buildings.size, terrRef = E.sim.services.territory, terr = terrRef?.version() ?? 0;
   +  const rev = E.worksRev, size = E.state.buildings.size, terrRef = E.sim.services.territory, terr = 0;  // the census reads only the deposits
    ...
    export function attachConstructionEvents(E: Econ): () => void {
      return E.sim.events.on('construction', (e) => {
   -    if (e.phase !== 'done' && e.phase !== 'cancelled' && e.phase !== 'placed') return;
   +    if (e.phase === 'placed') {
   +      // a site just staked out is an unfinished building and adds no works: the census stands, with the new building counted
   +      const hit = cache.get(E);
   +      if (hit && hit.rev === E.worksRev && hit.size + 1 === E.state.buildings.size) { hit.size++; return; }
   +      if (hit && hit.rev === E.worksRev && hit.size === E.state.buildings.size) return; // an upgrade adds no building
   +    } else if (e.phase !== 'done' && e.phase !== 'cancelled') return;
        E.worksRev++;
   ```
2. **`src/sim/construction/progress.ts` `putIn` stalls a work at its last step.** The fee `pence × add / labour` of an hour's work on
   the last sliver of a job is a fraction of a farthing; `Construction.spend` returns what it paid rounded to 2 decimals (0), `putIn` reads
   `paid < fee` as "the money is short", the work *waits for the money to pay the masons* for ever and stands at 99.9% (a payer with three
   million pence, in the test). On the real continent about one work in ten ended this way and, after eight game years, 107 of the 116
   works the rulers had open stood at 99% or more. The fix is one line: `const fee = r2(rec.pence * (add / rec.labour));` (measured: the
   open works after eight years fall from 116 to 46 and none but the long church builds is older than two years). The rulers cope
   (`AiSave.g`, `deadDays`: a work that makes no progress for 12 days at 90% or more is not counted among the open ones), so the world
   builds on even if it stays as it is, but the half-built scaffolds stay for ever, and they are the player's problem too.
3. **`src/sim/realm/research.ts` `orderGoods` passes no `maxPrice` to `procure`.** The goods of a research bought with `buy: true` are
   ordered at any price; a rich abbot paid 126 663d once for goods the market keeps only a shelf of. The rulers check what
   the market holds before they start (`researchPicks`); the player's panel could pass `maxPrice: 3 × basePrice` as the builder does.
4. **Raids and ransoms drain the rulers' purses** (`RaidSystem.hour`, `payRansom`): that, not the rulers' own spending (which keeps above the
   comfortable purse), is where the rulers below their comfortable purse come from (2 in a hundred in the first year, 12 after ten, 20 after thirty).
5. `tests/sim/realm/helpers.ts` (not in the rulers' paths) gained an `ai` option that is **off** by default, so that the realm's tests, which
   count on a world nobody else acts in, stay as they were; `tests/sim/realm/aiworld.ts` is the world the rulers' tests use.

## Calendar and budgets

One hourly system `realm.hour` (order 80) and one yearly (and, apart from them, the AI rulers' `realm.ai`, order 85, six shards an hour: see "The AI rulers"): research 05:00-08:00 (4 shards by project id), wages 09:00, trade orders
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
* AI rulers (additive): `installRealm(sim, deps, opts?: RealmOptions)` with `{ ai?: boolean }` (default true); `RealmRuntime.ai?: RealmAi`
  (`table`, `units`, `dueAt`, `sense`, `runRound`, `enabled`, `data`); `PoliticsRuntime.setGrowthSource?` (`src/sim/politics`); the saved
  section `state.ext['realm.ai']`; `src/sim/politics/might.ts` (the siege model's wall weights, shared).
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

**AI rulers.** Done in wave B5: see "The AI rulers" above. They make the calls the panel makes, with the ruler's id (`rulerOf(settlement)`
finds him; the steward acts when the lord is held captive), a round a week per ruler, and none of it needs a second API. The calls are cheap,
but `researchOptions` scans the realm's people (about 1 ms for a kingdom): a few times a year per House, not every day.

## Gaps closed in wave J (J5) and the market stand-in

* The economy's `procure` and `sell` are written by another builder; the realm was tested against a stand-in with the same
  signature (`tests/sim/realm/helpers.ts`, `MarketStub`). Goods that are not stock-and-flow goods may be thin at markets, so a
  research that wants 200 vellum is bought over several orders (the work waits for the carts).
* Crossbowmen are their own kind to the military module: `crossbowman` is a career (garrison men draw it, recruits of the crossbow kind
  take it, detail fights give them the crossbow), `unitKindOf` reads it as `crossbow`, and `forces()` counts them (`crossbowmen`).
* Knights recruited are counted as knights: `forces()` has `knights` apart from `retinue`, and every list of forces in the UI shows them.
* The books name what moved the purse: other modules enter a movement with `realm.note(household, pence, label)` (army wages and
  provisions, mercenaries, plunder, ransoms paid and received, a raid's toll, tribute, relief, a rising's loot); what is left is
  *The household's keep and the works* (the economy's pull of an NPC lord's purse toward a rank-size purse shows there).
* An AI ruler whose purse is below comfort trims: every four days at most two of the dearest men go back to the plough (down to a troop
  that fits the purse, `TROOPS_AI.trimPerRound`), and no one is raised until the purse is comfortable again.
* A regent / steward ruler's `view()` names both Houses: `house`/`houseName` is the realm's (the holder's), `ownHouse`/`ownHouseName` his
  own; the ruler's window title shows both.
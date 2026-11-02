# Politics & rival AI (`src/sim/politics`)

Wave 3 module for SPEC §15 (titles, vassalage, diplomacy, claims and wars, offices and elections, revolts),
§16 (the rival AI), §7 (management by authority) and §20 (continent share). Entry point:
`installPolitics(sim, { economy, social }): PoliticsRuntime` registers `sim.services.politics`
(`PoliticsApi` of `sim/wave3.ts` plus the richer `PoliticsRuntime` of `types.ts`). Everything works
headless and without combat, military, advancement/happenings or the zone/player.
UI: `src/ui/panels/politics.ts` (opened from the action wheel on yourself, "Realm, offices and politics").
Debug: `npx tsx tools/politics.ts [years] [preset]`. Tests: `tests/sim/politics/`.

## Model

* **Houses, not persons, are the actors.** A *political House* holds a secular title (`state.titles`
  held by a living member). `core.ts` keeps an hourly **snapshot** (titles by House, lieges, vassals,
  realm leaders, strength, neighbours). It is a pure function of the persisted state, rebuilt at the hour
  of every decision (invalidated on title moves and at hook entry), so a loaded game decides exactly as the
  live one did. Sums are integers (tenths of a man): Set iteration order differs after a load.
* **Strength** = levy from the demesne's population (14%) + garrison of castles/towns + the retinue
  (knights, men-at-arms … among the House's members) + half the professional troops the military has in
  the field, plus 80% of every vassal's strength. Without a military it is the estimate only.
* **Liege** of a House = holder of the liege title of its highest title that is held from another House
  (0 if its highest title is held from no one: a king, an independent baron).
* **Stance** (`stance(a, b)`, "how a stands towards b"): `war` > `vassal` (a is b's vassal) / `liege` >
  `alliance` > `kin` (marriage links) > `trade` > `truce` > `hostile` (grievance ≥ 35) > `neutral`.
  Pacts live in `ties["low:high"]` in `state.ext.politics`; every change fires a `stance` event.

## Systems (all time-sliced; nothing runs in `perStep`)

| hook | work |
|---|---|
| hourly (even hours) | each House **thinks** once every 4 days at its own hour (`ai.ts`) |
| hourly (odd hours) | posts whose yearly review falls today are voted on or filled (`offices.ts`) |
| daily | wars progress and end (`wars.ts`), leagues march, letters lapse, a quarter of the villages are reckoned for unrest (`unrest.ts`) |
| seasonal | outlaw bands, coalitions form or dissolve, petitions are brought to the player, grievances fade, truces lapse |
| yearly | vassals' aid, vassals' opinion of their liege, kinship links recomputed, unions of crowns, housekeeping |

## Rival AI (`ai.ts`)

Personality from the head's traits, reputation and ambition (ambitious, cautious, greedy, honourable, cruel,
pious) sets a goal (expand, marry up, secure heir, enrich, avenge). A think: seek marriages through
`social.arrangeMatch`; climb the ladder (truce → trade → marriage → alliance); demand submission from weaker
independent neighbours (a refusal is remembered and answered with war); a vassal who is unhappy and strong
rises against a weak liege; make war when `desire` clears the bar. `desire` = odds (with allies and, across a
border, the defender's overlord) + **weakness of the target** (child heir or regency, famine/low prosperity,
plague/disaster via `happenings.activeAt`, winter, a war elsewhere) + claims + grievance + personality − a
peacetime baseline; scaled by the difficulty's **aggression** (Squire 0.55 … King 1.6). Greedy and cruel Houses
raid instead (stores, herds, a few lives). Coalitions form against the strongest realm (≥ 1.3–1.8× the
second, ≥ 30% of all strength; threshold and join odds scale with the difficulty's **coordination**) and
march when they can match it — the player's House included. No catch-up help: on Lord and King the rivals
start with fuller treasuries (visible, in the SPEC table), and that is all.

### What the rulers' deeds change (`might.ts`)

The AI rulers of `src/sim/realm/ai*.ts` (docs/REALM.md "The AI rulers") raise walls, work out techniques and take men on with the
player's own calls, and the rival AI weighs the results in a war decision ("they weigh the new strength", SPEC §16). All are pure
readings of the state, memoised for the hour in the snapshot's `memo`:

* **`might(h)`** (1 .. 1.35): what a House's techniques add to the weight of its men - the longbow, plate, destriers, crossbows, paid
  retinues and archers (`mightOf`). Multiplies the attacker's and the defender's (and the overlord's) weight in `desire`.
* **`bulwark(o)`** (1 .. ~2): what a siege of the target's lands would meet - the macro siege's own sum over the walls, towers, keeps
  and mottes standing in its demesnes (`fortFactor`, the weights of `military/siege.ts`), taken as a mean over the places (the besiegers
  take them one by one), 35% of the excess, made to count for more by the masonry techniques it commands (`masonryOf`). Multiplies the
  defender's weight; the besieger's engines (`siegecraftOf`: trebuchet, bombard) multiply the attacker's when the target is walled.
* **`thin(o)`** (0 .. 1): how short of its people's due a House is in standing men (retinue, garrisons and hired companies as
  `military.standing` weighs them against 4% of its residents). Adds up to 0.12 to the target's `weakness`.
* **`outbuilt(h, o)`** (-1 .. 1): `(growth(h) − growth(o)) / 12`, where the growth of a House is what the rulers report through
  `PoliticsRuntime.setGrowthSource(fn)` (built + ½ techniques + ¼ men raised this game year; 0 and neutral when nobody sets it).
  Adds 0.1 × it to `desire`: a neighbour that out-builds you grows bold, and one that does not keep up is a prize.

None of this is a bonus the rivals are given: it is what the rulers' deeds (walls, techniques, men) are worth in the same sums the
military and the siege use. The player's deeds count the same way - a walled, well-armed House is a harder prize for the rivals too.

## Wars (`wars.ts`)

Legal under realm law (`laws.privateWar` by kingdom; culture default: only the English crown forbids it); a
baron or greater for private war; one offensive war per House; truces bind unless broken (honour lost).
Sides gather vassals, allies and (across a border) the defender's liege. The score (−100..100) moves by
`reportBattle` (military), `siege` events (occupation) and — where no army is in the field — an abstract
campaign (strength decides, with luck; battles are announced, levy men and sometimes leaders die or are
ransomed). Peace by decisive score, weariness or the player's terms (`peaceOptions`/`makePeace`): white peace,
tribute, the goal title (re-homed under the conqueror's crown; the loser keeps a claim for 5 years), homage,
or freedom from an oath. Truces follow. `score.continentPct` is refreshed when titles move.

## Offices (`offices.ts`)

Reeve (yearly; elected by the village's household heads in ~55% of manors, else named by the lord), bailiff
(where the lord lives elsewhere), steward, sheriff, marshal, chancellor (appointed), guild warden, alderman,
mayor (elected by burgesses/masters), abbots and priors (elected by their monks through
`succession.setSuccessionHooks`). Votes follow `social.opinion` plus standing, the incumbent's edge, canvassed
promises and bribes (which may be found out). The player can `stand`, `campaign`, `bribe`, `petitionOffice` and,
as the lord, `appoint`.

## Unrest and management (`unrest.ts`, `management.ts`)

Unrest per village rises with famine and harsh rent/labour/justice and falls in good years; past ~60 the
villagers may rise: numbers against the retinue decide; they win a charter or are hanged / outlawed
(`flags.outlaw`, bands exposed as `bands()` for military/happenings). AI lords set policy by temperament and
ease off when frightened. The player's powers follow his titles (`authority`): manor policy, realm laws,
grants/revocation of fiefs, petitions (`resolvePetition`).

## Saved data

`state.ext['politics']` (ties, wars, history, coalitions, AI minds, laws, manor policies, unrest, oaths,
claims of the deposed, inbox, petitions, office index, candidacies, revolts, bands, stats). Compact and
bounded; see `types.ts`. RNG streams are `politics.*`.

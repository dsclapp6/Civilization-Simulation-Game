# War in the zone (`src/combat`, `src/sim/military`, `src/ui/hud/battle.ts`, `src/ui/panels/battle.ts`)

Civilization pass, wave B, builder B4 (`docs/CIV.md` §9). Before this, a battle in the detail zone was a brawl on open ground and
a siege was a number on the map. Now the walls of a place are manned and stormed in the zone, the player can lead the men he
commands, and mounted men fight like horsemen. Everything works headless (tests, `tools/fullsim.ts`) and with the real zone, the
real renderer and the real UI; whatever another module has not built yet is looked up with `?.` and has a fallback.

Files:

| Where | What |
| --- | --- |
| `src/sim/military/alert.ts` | `alertOf`, `fortState`, the `forts` / `fortsVersion` view sources |
| `src/sim/military/command.ts` | the player's command span by rank, `battleGroups` / `orderGroup`, the six macro orders as group orders |
| `src/sim/military/commandModel.ts` | pure logic of the command HUD: keys, the wheel, what a click orders, the marks, the overview circle |
| `src/sim/military/war.ts` | additive types: `SiegeSetup`, `WarEngageOpts`, `SiegeStatus`, `WarCombatApi` (the combat module's side of the bridge) |
| `src/sim/military/battle.ts` | `beginDetail` hands the detail fight its siege set-up and the player's command; `concludeDetail` |
| `src/combat/command.ts` | the groups of a fight, their orders, formations, slots, morale |
| `src/combat/commander.ts` | the AI commander: the same orders, chosen by the situation |
| `src/combat/scene.ts` | the storm: stations, gate, ram, ladders, breaches, engines, the stairs |
| `src/combat/warActions.ts` | the player's verbs in a storm (push the ram, climb a ladder, man a station) |
| `src/combat/{arena,ai,fighter,strike,projectiles,weapons}.ts` | the fight itself: orders obeyed, saddle cuts, the couched spear, horses hit and falling, subdue |
| `src/ui/hud/battle.ts` | the group bar, banners, order wheel, storm card, the keys |
| `src/ui/panels/battle.ts` | the tactical view (C in battle) |
| `tools/war-shots.mjs` | the screenshots below |

## 1. Alert and forts

`military.alertOf(settlement)` answers `peace`, `watch`, `alarm` or `assault`, derived from what is on the map (nothing is saved, so a
loaded game answers exactly as the saved one):

- **watch** — the place's lord is at war or in a feud, or a hostile army (not mustering) is within 6 km;
- **alarm** — a hostile army within 2 km, or a siege camp before the walls;
- **assault** — a storm is going on there (a battle whose siege is this place; it lasts until the detail fight is settled).

`military.fortState(building)` is the state of one fortification, or `null` when it is open and whole:

- a **gatehouse** is `shut` at night under `watch` and always from `alarm`; `broken` once its damage is ≥ 0.6 (it takes damage from the
  ram and the engines in the storm, and the damage is repaired by the daily `repairDamage`);
- a **wall** or **palisade** has a `breach` 0..1 that grows with its damage from 0.3 (≥ 0.5 can be climbed through).

The renderer reads the same through the `forts` and `fortsVersion` view sources (the list of every gate that is not open and every
breach). They are cheap: the list is rescanned only when a building is added or pulled down, and rebuilt only when a building, an army,
a siege, a war or the night changes; the version moves only when the list itself differs. The zone asks `fortState` for solid gates and
breaches as ways in; it asks `alertOf` to double the watch, muster the militia, ring the bells (B3).

## 2. Walls defended, and the assault

A storm reaches the zone when the player is in it: besieging (a soldier or the commander of the host), or a resident of the place
(he is put among the defenders even if the macro model had not listed him). `beginDetail` gives the fight a `SiegeSetup`: who attacks,
who defends, how many rams and ladders the siege record has, the engines (technology), the camp. The fight is the macro assault: its
result concludes it (the same record: gates, walls, garrison, plunder), and a fight not finished in `CFG.stormSeconds` (780 s) is
settled by the macro model.

**Stations.** The defenders stand where `zone.wallStations?(settlement)` says. Without it (or with none) the scene makes its own along
the wall buildings: wall 6 m, palisade 3 m, tower 9 m, gatehouse 7 m above the ground, two to a wall segment, a pair in a tower, one
at the gate. The stations nearest the besiegers' camp are manned first, and towers and the gate are preferred. Archers and
crossbowmen go up and shoot from the height (a shot from 6 m reaches further and the parapet covers the man behind it); spearmen and
the rest hold the gate and the breaches. A garrison seldom has archers enough for its walls, but every castle has bows in its
armoury: the lowest of the men who carry none take a shortbow (24 arrows) until two in five of the defenders shoot, as many as
there are stations; men without a shield go first, a man at arms needed on the wall leaves his shield, knights and riders hold the
gate. Once a ladder is up, two of the reserve take the stations beside its head. The attackers have the same stairs: with the gate
open or a breach made, the men inside go up to the wall-walk after the men still shooting from it (if no wall stands between them and
the stairs).

**The ram.** A crew of at least two carries it from the camp to the gate (the draw item is a `ram` in the `siegeWorks` view source, with
its swing phase). At the gate it swings every 3.2 s and on the stroke the gate takes a blow of `0.043 × crew/5` (0.3..1.3; an upgraded
gate takes 0.65 of it). Five men break a gate in 45 s; at 0.6 it is `broken` and the attackers pour in. The player can push beside
them (**Push the ram**): his weight counts in the crew. A ram has a roof: arrows from the wall do not reach its crew.

**Ladders.** A ladder is carried by at least two (1.2 m/s, slower with fewer bearers) to the foot of a wall segment away from the gate
and planted (a `ladder` item in `siegeWorks`, its foot on the ground and its head on the wall-top). The queue at its foot climbs one man
at a time at 0.8 m/s along its length (the `climb` animation: the body is carried along the ladder, not walked); the man who reaches the
top lands on the wall-walk and fights there as one of the men who hold it. A defender on the station beside the head may heave the
ladder off before anyone has landed (the climber falls: a bad knock, `a fall from a ladder`; the ladder lies 9 s and is raised again).
A man on the wall-walk with no defender within 4 m drops down inside after 12 s, and three of them inside at the gate for 6 s throw it
open ("The gate is thrown open from within!", the gatehouse then counts as broken). The player can climb (**Climb the ladder**). The
climb ends on the wall-walk if the navigation can stand a body up there; if it cannot (the zone's navigation has no heights yet) he is
put inside, at the foot of the stairs, so he is never left standing in stone.

**Breaches and engines.** An engine (trebuchet, mangonel: only when the House has the technique) throws a stone every 15 s at a wall
segment (projectile kind `stone`): damage 0.055, ×1.8 on a palisade, ×0.6 on a gatehouse. A wall with damage ≥ 0.5 is a breach: the
fighters path through it, and the scene counts it. **Man the wall** (a defender's verb) puts the player on a free station.

`SiegeStatus` (`combat.siegeStatus()`) is what the HUD's storm card shows: the gate (`shut`, `open`, `broken`) and its integrity, the
rams and ladders, how many are on the walls, the breaches, the stations manned, the engines.

## 3. Troops you direct

A detail fight keeps its men in **groups** (`foot`, `archers`, `horse`) on each side, in two layers: the AI's, and the player's. How
many men are the player's is his command level (SPEC §7): a squad is 8, a company 30, an army 60, the nearest men of his own side
that are in the fight (`commandSpan`). `military.battleGroups('own')` lists his groups (with an `all` row when there are several),
`battleGroups('enemy')` the enemy's groups as far as they are in sight, each with count, centre, facing, order, formation, target,
whether engaged and morale.

**Orders** (`military.orderGroup(group, order)`): `follow` (come with me: the group keeps about 4.5 m behind the player), `hold` (here),
`advance` (to a point, or towards the enemy), `move` (to a point, and no fighting on the way), `charge` (every man at the enemy, or the man
named), `loose` (at will, or at the man named: archers shoot, the rest fight as they please), `retreat` (to a point behind the group, and
off the field once clear of the enemy: they are counted among those who got away), and `formation`: `loose` (open order), `line` (two
ranks, 1.35 m between men), `shield_wall` (0.86 m between men, shields up, a crawl: 0.85 of the pace) and `wedge` (rows of 1, 3, 5…
with the strongest man at the tip). Every man keeps a **slot** in the formation relative to a moving anchor (the group's anchor walks at
1.85 m/s for foot, 2.7 for horse, slower while the group is ragged: the men close up by their cohesion); a man in melee fights where he
stands and comes back to his slot after; archers shoot from theirs.

**Morale** is each man's own: it drifts towards a level set by his health (and his legs) and by the odds, as a ratio of the men still
standing (a handful against a crowd breaks, an army that has lost a few does not); a blow, and a death nearby, push it down at once,
scaled by the size of the army so that a big host does not fall apart in seconds. A group's morale (the HUD's bar) is the mean of its
men's. A man whose courage fails runs, or, if he is noble and the fight allows it, yields.

**The AI commander** (`commander.ts`) gives its groups the same orders every 1.6 s: attackers advance, the horse charge when the foot
is engaged, archers loose when an enemy is in range, defenders hold (the walls too), the lost (ratio below 0.32, morale below 0.5)
retreat. It commands every man the player does not, and the player's layer while he is down. The player's own orders hold for 45 s
before the AI would touch that group.

The six macro orders of the command panel (`hold`, `advance`, `charge`, `loose`, `retreat`, `follow`) become orders to every commanded
group at once (`orderAll`).

## 4. The command HUD and the tactical view

Keys in a battle where the player commands men (nothing changes for a man who only follows orders):

| Key | Does |
| --- | --- |
| **4 / 5 / 6 / 7** | select all / foot / archers / horse (again lets go) |
| **8** | the order wheel (1 follow · 2 hold · 3 advance · 4 charge · 5 loose · 6 retreat · 7 line · 8 shield wall · 9 wedge; 1–9 pick, Esc closes) |
| **C** | the tactical view (C or Esc back) |
| click on the group bar | selects the group |

Advance goes where the player looks, charge and loose at the man he looks at (the wheel reads the crosshair). The group bar shows the
four groups with their keycap, count, order word and a morale bar (green, gold, vermilion); banners float over every group, the
player's with a pole, the enemy's in red, at projected positions (DOM, the renderer's `project`).

**The tactical view** (C): the world slows to a quarter (`SLOW_SPEED`), the camera rises over the field (`setOverview`, with a fallback
to `setCameraPose` for a renderer without it), the banners stay, and orders are drawn on the ground (`setOrderMarks`: gold arrows
for the player's orders, hold flags, attack rings, the enemy's in red). Click ground to march the selected group there (alt: move
without fighting), click an enemy to charge (archers loose), drag a banner to move its group, right-drag turns, the wheel zooms, C or
Esc goes back and the previous speed returns. It closes itself when the player has no men to command or the battle ends.

## 5. Fighting

- **From the saddle**: the sword cuts to the side (a horseman's arc, reach lengthened by the horse's shoulder, a damage bonus from the
  ride), the spear thrusts and **couches** at speed (≥ 4.5 m/s, canter and gallop; trot is not enough): the damage is the weight of
  horse and rider at that speed (spear 0.7 of a lance). A **braced** spear (a foot spearman who does not move and faces the charge)
  strikes the horse and may stop the charge.
- **Horses** are hit and wounded: an arrow below the saddle height (1.25 m) hits the horse; a hurt horse slows (the gait is bounded
  by what it has left), rears (the `rear` animation), and a horse that is killed falls and throws its rider (`throwRider`), who gets
  up on foot (stunned). The corpse stays as an `AnimalDrawItem` of kind `dead`.
- **On foot**: the spear thrusts, the sword cuts and guards, the bow shoots from a drawn string (no regression in the tests and the
  shots: see 8).
- **Budget.** All of it runs in the arena's own sub-step, and a storm of 60 a side costs what a field battle of 60 a side costs (§7).

## 6. Subdue, captives

`combat.engage(sides, { intent: 'subdue' })`: the fight is to wound, not to kill. The subduing side (the side without the player,
else side 0, or `subdueSide`) strikes with 0.55 of its force, never lethal (a man falls to his knees at 14 % health rather than dying),
never hits the downed; the other side yields instead of fleeing when it is beaten. At the end the winner takes every downed or
yielding survivor alive: `FightResult.captured`, with the person bound and bandaged (`book.tend`).

`military.takeCaptive(captive, captor, opts)` and `military.release(captive, reason)` are what the law module (B3) uses to hold and
let go: the captive goes into the same book as a prisoner of war (ransom, release, the macro model's `captured` event).

## 7. Budgets and measurements

TODO-MEASUREMENTS

## 8. Tests

`npm test` runs all of these (the timing file only with `npm run test:perf`):

| File | What it pins down |
| --- | --- |
| `tests/sim/military/alert.test.ts` (10) | breach and gate rules, `alertOf` by army distance, siege camp and storm, `fortState` and the forts view, its cost |
| `tests/sim/military/captive.test.ts` (5) | `takeCaptive` / `release`, a prisoner taken in a fight is bound up, the old ransom flow still works |
| `tests/sim/military/storm.test.ts` (4) | the macro assault becomes a detail storm with the player in it, runs to a result and concludes the macro siege; defender and commander cases |
| `tests/sim/military/commandModel.test.ts` (9) | keys, wheel, clicks, marks, the overview circle, the signature that decides when banners are rebuilt |
| `tests/combat/command.test.ts` (9) | formation slots, groups and the AI commander, the player's orders (hold, advance, retreat, shield wall, follow), determinism |
| `tests/combat/storm.test.ts` (11) | stations at the wall-walk height, the armoury, crews and squads, the shut gate and the ram, pouring in, ladders and the climb, breaches, shots stopped by the parapet, engines, determinism |
| `tests/combat/warActions.test.ts` (6) | push the ram, climb a ladder (with and without a way up), man a station, nothing offered outside a storm |
| `tests/combat/mounted.test.ts` (7) | what can be couched, the sword from the saddle, the couched spear, horses hit by arrows and blows, rearing, falling, thrown riders, the braced spear |
| `tests/combat/subdue.test.ts` (5) | strike to wound, the downed are not struck, the captured list, determinism, the other side winning |
| `tests/combat/foot.test.ts` (6) | the sword's cut cycle, spear reach, the bow's draw, range and flight |
| `tests/combat/war.perf.test.ts` (2, `PERF=1`) | 60 a side, a field battle and a storm: < 1 ms mean, < 8 ms worst per sub-step |

The storm tests use a ring of curtain wall with four towers and a gatehouse built into the mock world (`tests/combat/stormHelpers.ts`);
the military tests use the real combat module and the real player controller on a fake zone (`tests/sim/military/stormRig.ts`).

## 9. Screenshots

TODO-SHOTS

## 10. Contract changes and hand-offs

**Contract changes, all additive** (`src/sim/wave3.ts` is untouched):

- `src/core/time.ts`: `SLOW_SPEED = 0.25` and `SPEEDS = [1, 3, 8, SLOW_SPEED]`. The clock could not go below 1×, which the tactical view
  needs (the brief allows this one change). `setSpeed` accepts it; the clock's buttons never offer it; the tactical view sets it and puts
  the previous speed back; the combat module puts a game loaded at 0.25 back to 1×.
- `src/sim/military/war.ts` (new): `SiegeSetup`, `WarEngageOpts` (`engage`'s options: `intent`, `subdueSide`, `siege`, `command`), `SiegeStatus`,
  `WarCombatApi` (`groups`, `orderGroup`, `siegeStatus`, `sideOf` on the combat module), `isWarCombat`. The combat module satisfies the
  contract's `CombatApi` as before; the extended members are found with `isWarCombat`.
- `MilitaryRuntime` (`src/sim/military/types.ts`) now has `alertOf`, `fortState`, `battleGroups`, `orderGroup`, `takeCaptive`, `release`
  (they are optional in the contract's `MilitaryApi`, required members of the runtime).
- Projectile kind `stone` (engine shots) in `src/combat/projectiles.ts`; the `siegeWorks` view source is fed by the combat module.

**For B2 (3D and art):** draw `view.forts()` (a `shut` gate leaf, a `broken` gate, a breach by its 0..1: rubble across the segment) with
`view.fortsVersion()` to know when to rebuild; draw `view.siegeWorks()` (a ram with its roof and swing phase 0..1, ladders leaning from
their foot on the ground to the wall-top, mantlets, trebuchets and mangonels with the arm phase); the `climb` and `push` clips for the
men on a ladder and at the beam; the horse's `rear` animation and a horse corpse (an `AnimalDrawItem` with the `dead` animation, left where the horse fell); the `stone`
projectile; `setOverview` and `setOrderMarks` (the tactical view drives both; without them it falls back to `setCameraPose` and the
orders are not drawn on the ground).

**For B3 (law, watch, player body):** `ZoneApi.wallStations(settlement)` is consumed by the storm scene when present (the fallback
heights are in §2); for a player on the wall-walk the navigation must be able to stand a body at the station's height (until it can,
the climb ends inside the wall at the foot of the stairs). The zone reads `military.alertOf` (watch doubled, militia to the walls,
bells) and `military.fortState` (a shut gate is solid; the navigation does not block the gatehouse, so a shut gate is the zone's to
enforce; a breach ≥ 0.5 is a way in). `combat.engage(sides, { intent: 'subdue' })` takes the side without the player as the one that
strikes to wound (else side 0, or `subdueSide`); `FightResult.captured` lists those it took alive; `military.takeCaptive(captive, captor,
{ settlement?, reason? })` and `military.release(captive, 'escaped' | 'pardoned' | 'served' | 'ransomed')` put them in the military book
and let them go.

**For B6 / B1 (UI):** keys 4–7 select a group, 8 opens the order wheel, C is the tactical view in a battle where the player commands men
and the command panel otherwise (`KEYMAP.battle`, handled through `registerHotkey` in the HUD part, so the key dispatch needs no edit);
the HUD part is `registerHudPart('battle')` and the tactical view the ext panel `battle`. `tools/game-flow.mjs` has no step for them.

**Not done:** the wall-walk is not a place the player can stand until the zone's navigation has heights; ranged garrisons are
the macro model's (a garrison with no archers is given bows from its armoury, §2); the macro kinds `archer` and `crossbow` that are not
careers are not turned into bows in the detail fight; a detail fight is not saved (a load settles it by the macro model, as before).

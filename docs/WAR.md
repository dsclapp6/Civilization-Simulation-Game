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
the rest hold the gate and the breaches. The attackers have the same stairs: a man who gets inside goes up to the wall-walk.

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

**Orders** (`military.orderGroup(group, order)`): `follow` (come with me), `hold` (here), `advance` (to a point, or to the enemy),
`move` (to a point, no fighting on the way), `charge` (at a man, or the enemy), `loose` (archers: at a man or the enemy), `retreat`,
`formation` (`loose`, `line`, `shield_wall`, `wedge`). Foot, archers and horse take them each their own way: archers hold back and
loose at range, the horse charge as a wedge, a shield wall locks shields and moves at a crawl, `retreat` runs for the edge. Every man
keeps a **slot** in the formation relative to a moving anchor (the group's anchor walks at 1.85 m/s for foot, 2.7 for horse; the men
close up by their cohesion). A man in melee fights where he stands and comes back to his slot after.

**Morale** is per group and moves with the fight: the dead and the fleeing nearby, the odds (as a ratio), the man's rank and whether
the player is down. A broken group routs. Army size scales a death's effect so that a big host does not fall apart in seconds.

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

TODO

## 8. Tests

TODO

## 9. Screenshots

TODO

## 10. Contract changes and hand-offs

TODO

# Interiors: doors that open, insides you walk into, nothing that leads nowhere

The owner's words: *"when I say you should be able to go in the houses, that means open & close doors, and walk freely about them. There
should be no stairs or features anywhere that are unusable or lead nowhere."* There is no separate room mode any more: a building's inside
is in the world where the building stands, and one walks in at its door.

## How it is made

| part | where | what it does |
|---|---|---|
| The recipe's record | `src/assets/buildings/parts.ts` (`ShellRec`, `DoorwayRec`, `ChimneyRec`, `roundShell`, `hint`, `yardSolid`) | As a building recipe raises its walls it records what it built: every block of the house kit with its storeys, wall kinds and openings; every doorway (threshold, outward face, size, shape, leaf colour); the chimney stacks; the yard's solid things; and hints for what the kit does not know (a flight of steps, a landing, a hay loft behind a loft door, a trestle in a mill's roundhouse, a round tower's or dovecote's round wall). The run can be "dry" (`MeshBuilder.dry`: nothing meshed) for plans. |
| The plan | `src/assets/interiors/plan.ts`, `furnish.ts`, `types.ts` | From that record, pure data: the **levels** one stands at; the **walls** with their thickness (0.12 m planks … 0.5 m stone, 0.7 m in churches, 1–1.9 m in castles) and the gaps of the doorways; a doorway **through every wall where two blocks meet** (an arch in a church, an arcade into an aisle, a door in a house); floors put into tall towers and keeps every few metres under their windows, and at the sill of a door set high in a wall; the **stairs and ladders** between the storeys (a flight against a wall clear of the doorways, a ladder in a small room, a hatch ladder flat to the wall in a turret; in a tower they go round the walls like a square spiral, each flight's head at the corner where the next one starts); the **floors** less the stairwells, with rails round them; then the **rooms** of the kind and their **furniture**, at the scale of people, kept clear of the ways through, and the **places** people use (seats, beds, benches, the forge, the altar) and the **lights** (hearths, forges, ovens, candles). Cached per kind, level, culture and seed bucket. |
| The check | `src/assets/interiors/validate.ts`, `tests/assets/interiors.test.ts`, `npx tsx tools/interiors-dump.ts [culture] [kind] --plans [--all] [--map]` | A body of 0.25 m walked on a 0.1 m grid from the doorways: every floor, doorway, stair head and place must be reached. Furniture that would cut a room in two is not put down (`Fill.stillConnected`). |
| The model of the inside | `src/assets/interiors/model.ts` | Drawn from the plan: inner faces of the walls with their thickness (reveals, sills, shutters folded back, panes that show the day), round walls as rings, earth strewn with rushes, flags or boards, joists under an upper floor, rafters and boards under the roof, partitions of plastered studwork, stairs with treads and handrails, ladders, balusters round the wells, and ~70 kinds of furniture (beds with tester and curtains for a lord, pallets, tables with a jug and a loaf, benches, the high table on its dais, the lord's chair, forge and anvil, looms, vats, millstones, altars with cross and candles, pews, fonts, pulpits, cells with bars, bookcases, stalls and mangers…). Three channels: body, glow (embers, flames), panes. |
| Placement | `src/assets/buildings/placement.ts` | Where the model stands (`placedRot`, `placedY`; mills turned to their water, towers by quarter turns to face the middle of their place): the renderer and the navigation share it, so the floor one walks is the floor one sees. |
| The navigation | `src/agents/nav/interiors.ts`, `nav/index.ts` | The plans of the buildings within 42 m of the focus are loaded and placed. A moving body (with the height of its feet) then sees, instead of the building's box, its walls with the gaps of the open doors, its shut doors, its furniture and its yard things at its height; the floor under it is the highest of the plan's floors, stairs, ladders and steps within a step (0.55 m) of its feet — a door's threshold is stepped onto from the ground whatever the ground does; nobody drops more than 0.7 m from a floor, a flight or steps (a stairwell, the side of a stair, the edge of a loft). New on `NavApi` (optional): `move(…, y)`, `floorY`, `interiorAt`, `doorAgainst`, `prepareInteriors`. |
| Doors | `src/agents/doors.ts` (`DoorBook`, `ZoneApi.doorBook`) | A view of the zone, not saved. Leaves swing open to 1.45 rad and to (2.6 rad/s). A pass opens a door and it swings to behind (1.8 s); one opened by hand stays so 40 s. A workshop's, an alehouse's, a barn's door stands open in working hours, a church's by day. At night a home is barred, and a shut-up place (a workshop, a store, a church, a hall) locked, to anyone but its household and servants, the owner's House, the invited and the law (bailiffs, stewards, sergeants, knights, men-at-arms, soldiers of the place; the clergy have the church's keys). Towers, gatehouses, barracks, stables and the like are never locked. |
| People inside | `src/agents/indoors.ts`, `indoorPath.ts` | For the building the player is in and up to two near ones with a door open (16 m): everyone whose day has them in it now is there at the place of what they do — in the beds at night (a chamber's or a solar's bed upstairs is a place to sleep), at the table at meals, at the forge, loom, oven at work, in the pews at Mass, on the benches of the alehouse, on the watch of a tower, the head of the house in the best place. **They climb as the player does**: paths on a 0.2 m grid per plan (8 neighbours, a body of 0.17 m) join the levels at the flights; a leg up or down a flight is walked at the pace of the height climbed (stairs 0.85 m/s, a ladder 0.5, the `climb` animation) with the feet on the flight's surface (`flightY`: the floor at its foot to the floor at its head), so one is seen on the stair, never flying. When the day changes inside the room (from bed to the table, from the table to the loom upstairs) they get up and walk to the new place by the flights (`Indoors.regoTo`, not while still on the way somewhere); a sleeper whose day takes them out, with the player in the room, gets up and goes down to the door; someone the zone lets in at the door (`behaviour.ts ghost`) walks in to their place, up the stairs if it is up. **Nobody is put where they could not walk**: a place is offered only if a path leads to it from one of the building's outer doors (`pathExists`, cached; a cloister has two ways in, to ranges that meet nowhere inside), and a person for whom the door has no path to their place (it is reached from another) is simply there, as one is in a room already drawn. One whose day takes them out walks to the door, which opens, and is given back to the street. They can be talked to (`interactables`). Up to 14 a room. |
| Agents and doors | `behaviour.ts atDoor`, `zone.ts`, `geometry.ts`, `doorTable.ts` | People going in open the door (it swings to behind them); people coming out of a door open it. Where they stand to use a door is the real door: the plans' main door when loaded (placed as the model is), else `DOOR_STAND` — a table measured from the plans of every kind, level and culture (`tools/door-table.ts`, checked by `tests/agents/doorTable.test.ts`). `DOOR_X` stays as the fallback of kinds without a plan. |
| The player | `src/player/body.ts`, `controller.ts` | The body walks with its height through the insides: in at the door, up the stairs, onto a tower top and on along the wall-walk, off the wall-walk down the steps. Walking into a shut door opens it before him (`bumpDoor`), unless it is locked — "The door is barred for the night. Knock, or force it (a crime)." |
| The verbs | `src/app/interior.ts` (provider `interior`) | On a door within reach (outer or a chamber's): **Open the door / Shut the door** (E, priority 9), and when locked **Knock** (someone at home and awake who is not ill-disposed lets you in for the evening) and **Force the door** (4 s; it stays broken until the morning; the household inside or a witness raises the hue and cry: `LawApi.breakIn`, a patrol for the crime). On the wheel for those who want them: **Go inside** (through the main door) and, inside, **Leave** (out by the nearest outer door) and **Sleep in your bed** (a bed of your household's within reach). |
| The renderer | `src/render/interior.ts` (`InteriorLayer`), `render/buildings.ts`, `assets/core/materials.ts` | Draws the insides the zone names (`GameRenderer.setInteriors`), each where its building stands. Near models (lod 0) are drawn with their doorways dark and every door has a real leaf (instanced per leaf shape: plank doors with straps and a ring, arched leaves for pointed and round doorways, double leaves for cart doors) swung by the door book. The building one looks into, or stands in, is cut open by the shared building shader (`BUILDING_CUT`, set per draw): its open doorways are holes; standing inside in third person its roof and the storeys above the player are gone and the walls between the camera and the player are down to a sill (the cut faces dark, so walls read solid); in first person (the eye at the head) nothing is cut — walls, ceilings and the floor above are whole. The camera boom (`BuildingSystem.raycast`) runs in the room one stands in until it leaves it over the cut (free: the view from above into the room) or through a wall (stopped there, so the camera stays in a hall); a room too small for the camera (the foot of a stair by the back wall) lets it out through the wall, which the cut takes away between camera and player. A cut building is drawn with copies of its materials kept for its slot (three.js uploads a material's uniforms only when the material changes between draws, so the cut set before a draw reaches the shader only on materials of its own); the copies share the programs. Window panes and fire glow are cut with the walls. Hearths, forges, ovens and candles light the room and the people in it (`INDOOR_LIGHTS`, four, flickering; in the building and crowd shaders, no extra programs); window panes inside show the daylight. |

First person (the default camera, built apart by the first-person builder): rooms, doors and furniture are at real scale, the eye
inside sees the room whole, E opens the door the player faces (the door verbs are on the building target whose nearest doorway is
within 2.6 m), walking into a door opens it, and stairs and ladders are ramps the body walks up. The camera files are not touched here.

## The audit: every stair, ladder, door, hatch, gallery, balcony, walkway and gate

| feature | building(s) | now |
|---|---|---|
| Doors drawn with `opening()` | every house-kit building | Real: a leaf hung in its frame (lod 0), a doorway in the plan with its gap in the wall, its threshold and the room behind. |
| Doors for beasts (under 1.2 m: the pigsty's, the coop's, the stall half-doors of a stable) | pigsty, henhouse, stable | Doors for the beasts: a leaf that opens; a person goes into the stable by its side door. |
| Open doorways (porches, cart doors drawn open, the cloister's gate) | barns, tithe barn, slaughterhouse, church porch, great hall porch, cloister, tavern stable | Doorways with no leaf, always passable, into the room behind. |
| Tower doors (drawn as decals) | wall tower (round, square, the norse timber one) | Real doors (`opening`), the tower turned by quarter turns to face its door to the middle of its place — **but never into the end of a length of wall, a palisade or a gatehouse** (`placement.ts towerTurn` with the wall pieces near: a tower in a line has its two free faces, the middle's side is taken; a corner tower, with a wall ending at each inner face, has its door on an outer face, entered from the ground outside; the renderer, the navigation's plans and `agents/nav/walls.ts` — the stair foot — all read the same turn); inside, floors every few metres and ladders round the walls up to the top, which is the wall-walk's floor (one walks on from the top along the walls). A round tower's room is the square inscribed in its wall; the masonry round it is solid. |
| "Climb the stairs" of a tower, gatehouse or wall (`nav/walls.ts`) | wall, tower, gatehouse, palisade | The stairs are now there: one curtain segment in four (seed bucket 0) has two stone flights up its inner face, the low inner parapet open at the head; a gatehouse has a door from the gate passage into its left tower (the guardroom), with ladders inside up to its top; a fighting palisade a ladder on every other length; a tower its door and ladders. Walked up (ramps) onto the wall-walk; the verbs remain as shortcuts at the same foot and head. |
| The keep's stair to its first-floor door | keep | Rebuilt: the door is now on the east side of the forebuilding, 5 m up, and the flight runs up beside it to a landing before it (it used to end beside the forebuilding, short of a door on its front); inside, the forebuilding's vestibule at that level, the hall beyond, the undercroft below and the chambers above by stairs in the keep, the roof on top. The masonry under the vestibule has no floor. |
| The motte's flying bridge | motte | Walked: from the foot of the mound up to the top inside the stakes (a floor), to the timber keep's door; ladder inside to its fighting floor. The mound is solid round the bridge. |
| Granary steps | granary | Walked up to the raised door; the granary floor on its staddle stones inside. |
| Loft doors in gablets | cowshed, stable, alehouse (level 2+) | A loft floor at the eaves behind the loft door, with a ladder up to it. |
| Upper storeys | cottages, townhouses, manors, carpenters, weavers, tanneries, mills, alehouses, taverns, guildhalls, warehouses, schools, libraries (the gallery), barracks, cloisters (the dormitory), infirmaries, gaols, porch towers | A stair or ladder to every storey with windows (rooms partitioned where the kind wants it). A storey with no window, door or stair (the top of the manor's porch tower under its leads) has no floor. |
| The manor's porch tower | manor house level 3 | Widened (3.1 m) so its chamber is reached; joined to the wing's first floor by a door. |
| The market hall's upper chamber (on posts, no way up) | market hall | See above: the stair under the arcade; the arcade piers and posts are solid. |
| Church towers | church, abbey church, cathedral, cloister bell turret | The tower door (west) and an arch into the nave; ringing chambers and the belfry with its bell by ladders round the walls. The cloister's turret has a door from its range (it had none). The tall planks towers of the norse abbey church and cathedral are reached to the top: the aisle's 0.7 m wall runs into their 0.12 m room, so the flights are laid in the room less the bands of the walls built against it (`plan.ts towerRoom`, from the fifth way round that `interiorPlan` tries). |
| Cloister ranges | cloister | Each range has a door from the walks; the gate range a door through to them; the arcades' sill walls keep one on the walks. |
| Dovecote (round stone) | dovecote | A real door; inside, the nest-holes. (The norse/teuton dovecote on posts has no door: the birds fly in at the slits.) |
| Windmill buck: door and ladder | windmill | **Removed** (the buck turns to the wind: nothing to stand on; the tail pole stays). The roundhouse (level 2) has its door and inside, the trestle turned across the diagonals, clear of the door. |
| Ladder leaning on the gallows beam | gallows | **Removed.** |
| Ladder leaning on nothing by the bloomery | bloomery | **Removed** (the rake lies by the billets). |
| Gates | gatehouse | The military's `fortState` (open, shut and barred, battered in) as before; no leaf of the door book. The left tower is the guardroom and the way up (a door from the passage, ladders inside), and **the room over the passage is reached from it**: the tower has a floor level with the passage room's (`plan.ts gateBridge`, `towerFloors`: the nearest floor is made level with it) and an arch joins them at that level; the timber gatehouse's room is cut to the part over the passage (its recipe drew it across both towers under a hip roof). It is furnished as **the winch room** (`furnish.ts`: the portcullis winch, a wheel and drum against a wall, the winder's place, a chest, a brazier). The right-hand tower stays sealed (no way in, no floor: a hoarding's windows). |
| The market hall's chamber | market hall | A timber stair up from the market under the arcade at the west end, through a hatch into the council chamber (no door on the outside). |
| Siege ladders | siege works | Already usable ("Climb the ladder" puts one on the real walk). The ram, mantlet and engines have no stairs. |
| Open sheds and stalls (no door) | smithy level 1, cowshed level 1, market stalls, lumber camp, salt pans | No door: walked into where they are open (no inside of their own). |

## Tops one stands on

Every walkable top is open and crenellated, never roofed over (`tools/interiors-tops.mjs` looks at each from above in the gallery; `docs/interiors/tops-*.png`):

| top | what it is |
|---|---|
| Curtain wall (7 m, 9 at level 2) | the wall-walk between a crenellated outer parapet (machicolated at level 2) and a low inner one, the head of the stair open |
| Wall tower (11 m, 14 at level 2) | a flat platform ringed by merlons, whatever the roofs of the culture (the cone and pyramid hoods of the franc, teuton and anglo towers, and the norse timber tower's shingled hood, are gone: they stood over the floor the ladders climb to) — the timber tower is built 11 m high to the walk's height, with a plank parapet |
| Gatehouse (11.5 m; the timber one 6.6) | the stone gatehouse's crenellated roof across both towers (as it was); the timber gatehouse has **no thatched hip roof any more**: a plank deck at the towers' tops across the whole footprint with a plank parapet all round, the room over the passage cut to the passage and under it |
| Palisade (level 2) | the fighting platform behind the stakes at 1.95 m with its rail (a level 1 palisade has none: the men stand on the ground) |
| Keep and motte | the keep's roof is the walk (crenellated); the motte's fighting floor is under the stakes' hoarding as before |

## Measurements

* Plans: 556 for every kind, level and culture (`tools/interiors-dump.ts --plans --all`); a plan is made by a dry run of the recipe in
  2–30 ms (cached; a tall tower is tried up to eight ways round). All 556 pass the reachability check (the test has no allowlist).
* The renderer: the insides drawn are the one the player is in and at most two near ones with a door open; an inside is 3 draw calls
  (body, glow, panes); the leaves are one instanced draw call per leaf shape in sight (typically 3–8); no new shader programs (the cut
  and the indoor lights are branches on uniforms in the existing building and crowd shaders; the cut building's material copies use
  the same programs). Away from buildings nothing is drawn or computed beyond the leaves.
* The zone: plans loaded for the buildings within 42 m (at most 18); the people inside scanned every 1.5 s for the drawn rooms only.
### Frame time inside buildings against outside (`tools/interiors-live.mjs perf`)

Measured in the real game (first person, medium quality, the default view), headless Chromium on a shared 4-core machine with a software GL
(SwiftShader: every draw runs on the CPU, seconds a frame, and the browser is killed for memory now and then — the tool starts a fresh page per
case and retries). The context's draw and clear calls are made to do nothing, so what is timed is the **JS of a frame** (the scene update, culling,
uniforms, state changes; `GameHooks.draw()`), the median of 40 frames, the quieter of two rounds each (the machine's other load shows in the
spread, not in the medians); the draw-call and triangle counts are the renderer's own. Each case is twelve metres out from the door, in at the
door, and for the townhouse up its stair. Budgets (ARCHITECTURE section 13): draw calls < 600, triangles < 2.5 M, JS frame time < 8 ms on a quiet machine.

| building | outside: JS ms · calls · triangles | inside: JS ms · calls · triangles | upstairs |
|---|---|---|---|
| cottage | 10.8 · 319 · 2.02 M | 9.1 · 317 · 2.10 M | — |
| townhouse | 8.7 · 309 · 2.06 M | 11.7 · 330 · 2.02 M | 7.6 · 340 · 2.05 M |
| manor hall | 12.9 · 343 · 2.44 M | 13.2 · 322 · 2.46 M | — |
| church | 15.4 · 333 · 2.15 M | 11.7 · 320 · 2.12 M | — |
| keep (castle) | 11.4 · 322 · 1.97 M | 14.3 · 326 · 1.99 M | — |

Inside costs the same as outside to within the noise of the machine (0.75–1.35 × the outside view, the check requires under 2 ×; and
the world's own density near the spawn is what puts the triangles at 2 M outside): a drawn inside adds 3 draw calls (body, glow, panes)
and the door leaves, and takes away the terrain and the vegetation its walls hide. Every case is inside the draw-call and triangle budgets
(at most 343 calls, 2.46 M triangles); the 8 ms of JS is the figure of a quiet machine and is not reached here outside or inside alike, so the
inside is held to "no worse than outside". The zone's own step (people, doors, the indoor scan) is 1–2 ms inside against 1–4 ms outside.

## Tests

| file | what it pins down |
|---|---|
| `tests/assets/interiors.test.ts` | every plan of every kind, level and culture is reached from its doors; the plan's doorways are the model's; one-storey cottages have no stair, townhouses have theirs |
| `tests/agents/stairs.test.ts` | a way to a bed upstairs goes up a flight with the feet on its surface, and back; every place upstairs of every kind is walked to from an outer door; a tower between two lengths of wall faces the middle, a corner tower's door is off the wall ends (also a gatehouse beside it) |
| `tests/agents/yard.test.ts` | the yard of a home raised in play is its household's (`landAt`, so `ownLand` passes), not while the walls go up; `pickHome` and `HomeAllocator` pass over a home still going up |
| `tests/agents/lead.test.ts` (last test) | a led animal comes with the player set down kilometres away, and follows on |
| `tests/assets/interiors.test.ts` | (also) the room over every gatehouse passage has its door and its winch; the tall norse planks towers are reached to the top |
| `tests/agents/interiors.test.ts` | a body walks in at the door of a cottage, a church and a workshop (the door opens before it), up a townhouse's stair to the floor above, and is stopped by a home's door barred at night until it is let in |
| `tests/agents/doorTable.test.ts` | the agents' door table is the plans' main doors |
| `tests/agents/nav-walk.test.ts`, `tests/combat/wallwalk.test.ts` | the wall-walk with the stairs where they now are |

## Screenshots

`PORT=5293 node tools/interiors-shots.mjs [door] [cottage] [townhouse] [manor] [church] [workshop] [keep]` → `docs/interiors/` (day and night; `DBG=1` prints where the camera and the player are in the plan).
`PORT=5294 node tools/interiors-tops.mjs [culture …]` → `docs/interiors/tops-<kind><level>-<culture>.png` (the walkable tops from above).

## Live checks in the real game

`PORT=5295 node tools/interiors-live.mjs [stairs] [tower] [led] [perf]` drives the game through `window.__game` (private Vite port, Chromium; prints JSON lines, exit 1 on a failed check):
`stairs` stands in a townhouse at night (the household asleep, one upstairs on a floor of the plan), moves the clock to dawn and watches the heights of the people: someone gets up from a bed at 5.45 m and comes down 4.1 → 3.0 → 2.16 → 0.6 → 0.25 m, on the flights and the landing;
`tower` walks up to the door of each of the seven towers of a castle from the ground (none stands against a wall, all are entered);
`led` takes a cow on a halter, is set down 2.5 km off and goes there by the Go-to skip: the cow is beside the player each time;
`perf` below. (The software GL of the headless browser brings a shared machine's tab down now and then: the tool starts a fresh page for each case and retries.)

## Open points

None. (People walk about the rooms that are drawn — the one the player is in and up to two near ones with a door open — and are put in their places when a room first comes into view, as nobody saw them come; they are not simulated in rooms nobody looks into, which is how the zone keeps its budget.)

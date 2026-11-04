# Clarity & feel pass — design

Playtest verdict: days far too fast; no clear way to know what is going on, how to do things, who is who
or where you are; no visible impact from work; odd cursor behaviour. This pass fixes those without
changing what the game is (SPEC). Decisions by the owner: **10-minute days, 16-day years kept** (the days were later made **thirty minutes**, once villagers walked at real speeds: see §1).

## 1. Time

- `DAY_SECONDS = 1800` (core/time; 600 in the clarity pass itself, thirty minutes by the owner's choice afterwards, because people walk
  at real speeds and on a ten-minute day farmers spent three quarters of the daylight on the road). One game hour = 75 s at 1×;
  daylight ≈ 20 min. Calendar systems keep their per-day/per-year balance; they simply run three times slower in real time than
  they did at ten minutes. A year ≈ 8 h at 1×.
- **Player work is measured in game time.** A work bout is 10–15 s real (≈ half a game hour at ten minutes a day, a sixth at thirty:
  the numbers below are those of the ten-minute day, and per bout they scale with `DAY_SECONDS`, see ECONOMY.md). The player
  works about **2× as productively per game hour as a capable adult NPC** (the hero compresses chores, so a
  task feels snappy but is still a real job): reaping an ordinary strip ≈ 6–8 bouts (≈ 1.5 min), ploughing a
  strip with a team similar, felling a tree 3–5 bouts. Piece pay is at NPC rates per unit of work, so a full
  day of hard work pays ≈ 2× a labourer's day — believable wages (SPEC §4), progress that is earned.
- **Stats and skills by game time:** training and XP per game hour of work ≈ 2× an NPC's. A youth who works
  and practises most days reaches STR 10 and Archery 3 (the archer test) at about 14–15, as before.
- **Pacing (SPEC §21) is by real minutes:** something to deal with every 2–3 min — now mostly from objectives
  (tutorial, daily chores, job, goals) plus requests and events. What is offered by the clock is scaled to the length of the day so that
  it holds per minute of play: requests (`happenings/requests.ts` `PACE`: the chance per hour, the gap and the time an offer stands)
  and the household's chores (set again every four game hours of the working day, three rounds a day, `objectives/chores.ts`
  `CHORE_ROUNDS`). Festivals, weddings, funerals and disasters are calendar events and come once per game year as before, so they are
  three times rarer per minute of play; `tools/pacing.ts` reports the cadence.
- Villagers **walk** their routes now that a day is long enough (leaving early enough to arrive on time);
  only trips entirely out of view may complete off-screen.

## 2. Knowing what to do — objectives

One module (`src/sim/objectives`, contract `types.ts`) owns what the player should be doing:

| Source | Example | When |
|---|---|---|
| tutorial | "Meet your family" → "Fetch water from the well" → "Help on the family's strip" → "Sleep at home" | First in-game day; a different chain per birth class (farm child, craftsman's child, merchant's child, page in a lord's hall) |
| chore | "Sow the barley on the north strip (Father)", "Gather 2 loads of firewood", "Feed the pigs" | Each dawn the household head sets 1–3, fitted to season, age, sex and the household plan; twice more through the working day he tops them up |
| job | "Work at Wat's smithy until noon: 4 tasks" | While employed |
| goal | "Join the archers: STR 8.9/10, Archery 1/3", "Save 24d for a good sickle", "Choose your path at 14 (in 1 year)" | Always a few, from career paths, savings targets, ambitions |
| request | (bridged from happenings) "Agnes asks for 4 bundles of firewood" | When villagers ask |
| story | "Your father is gravely ill: fetch the healer" | Life events |

Duties and the lord (`duties.ts`, `src/ui/core/agenda.ts`). Someone with no master to set their day has the **duty of their
station** (a `job` objective, `roleDuty`): a knight rides the bounds, trains the men at the yard, sees to his arms or stands the
watch; a soldier guards, patrols or drills; priests, healers and master craftsmen have their rounds; it is asked again every few game
hours (`moreDuty`, beside the chore rounds). A grown tradesman is never asked to *choose a path*. A person who holds a title
(`managesRealm`) **manages**: no chores, duties, goals or villagers' requests; the tracker's *Matters of the realm* (`realmAgenda`) sit
under the tracked steps, dangers first, each opening the page where it is decided. A run may start as a lord
(`newRun({ start: 'lord' })`): the tutorial chain `lord` (steward, fields, purse, yard, sleep) reads its ruling steps from the realm
(match kind `realm`: a count of the player's plans or commands rises above what it was when the step was made).

- Steps are **concrete and located**: each has a target (person, building, strip, tree, place) with a map
  position and a one-line *how* hint ("Stand on the strip and press E, or click it").
- One objective is **tracked** (auto: today's first chore or the tutorial, until the player picks another).
  Its current step shows on the HUD tracker, as a **beacon in the world**, on the **compass** and **minimap**,
  and on the map.
- **"What now?"** suggestions are always available: the tracked step, then situational ones (it is getting
  dark → go home; hungry → eat; market day → sell your eggs at Dromore; holy day → Mass then the butts).
- **Day summary** when the player sleeps: work done, money earned and spent, goods, skill XP, stat changes,
  objectives finished, household state, and what tomorrow holds.

## 3. Who is who, where you are

- **Nameplates**: full name on the first line; relation and role on the second ("your father · farmer",
  "Wat's apprentice", "the reeve", "Lord of Dromore"); coloured by relationship (kin gold, household amber,
  friend green, rival/enemy red, lord purple, clergy white, strangers grey); a mark when someone has a task
  for you or is tracked. Kin/household/quest people show from ~40 m, strangers ~15 m, anyone hovered always.
- **Buildings and things have names** when looked at or hovered: "Your home", "Wat's smithy", "St Mary's
  church", "The Bell (alehouse)", "Your family's east strip · barley, ripe", "Common pasture", "Oak".
- **Settlement banner** on arrival: "DROMORE — village in Mornia · lord: Sir Hugh of Dromore".
- **Compass ribbon** (top centre): bearings, the tracked objective, home, work, market, church, with distances.
- **Minimap** (corner, toggle N): roads, buildings (home highlighted), your family's strips (gold), people
  (kin gold, others grey), markers; click opens the map.
- **Journal (O)**: Objectives (tracked, others, steps, Track), Today (what kind of day, the family's plan,
  what is open), People you know (family, household, neighbours, employer, lord — relation, role, where they
  are now, **Find** puts a marker on them), Places (home, strips, church, market, smithy… with Find).

## 4. Visible impact

- **Strips show the work**: ploughing lays dark furrows along the strip as you go; sowing darkens/rows it;
  reaping leaves a cut stubble band with **stooks** of sheaves set up behind you; carrying removes them;
  mowing leaves hay rows/cocks. (`StripView.task` + `work` 0..1, drawn from the strip's first edge.)
- **World props show results**: stooks on reaped strips until carried, a **woodpile** at home that grows with
  firewood stores, **sacks** of grain at home/barn, **stone** at the quarry, a **stump and logs** where you felled
  a tree (logs go when carried; the stump stays). (`SimView.worldProps`.)
- **Floating text** at the work spot on every completed bout: "+3 sheaves", "+1d", "Farming +6"; bigger for a
  level-up; opinion changes over people ("♥ +3"). (`SimView.drainFloaters`.)
- **Sound**: simple synthesized effects — hoe/sickle/scythe swish, axe chop, hammer clank, coins, level-up
  chime, church bell for Mass, UI clicks (Settings volume).
- The household head reacts when a chore is done (a line and a small opinion gain).

## 5. Controls and the cursor

> **Superseded (first-person pass, G1):** the cursor is no longer free by default and the right button no longer turns the camera. The
> mouse looks (pointer lock; first person is the default view); **Left Alt / Option** frees the cursor for pointing and clicking as
> described below (hover card, click to walk and act, clickable HUD, a still camera); **Alt** again or a click on the hint "Click to look
> around" takes the mouse back; **Esc** frees it; opening a page frees it and closing it takes it back. In look mode a crosshair marks
> the middle and what is under it is the target (outlined, named, with what **E** does; a left tap acts, holding **E** opens the wheel);
> **LMB** strikes and **RMB** guards with the weapon drawn. The wheel steps first person, over the shoulder, farther out, the map. Buildings
> never shove the camera. The text below still describes the free-cursor behaviour, which is what **Alt** gives.

- **Exploring (default): a free, visible cursor.** Hold the **right mouse button** and drag to turn the camera
  (pointer lock only while held, so the cursor stays where it was); wheel zooms; WASD moves as before.
- **Hover** shows a tooltip with the name and the default action, the cursor changes (talk, work, trade,
  enter, attack) and the thing is highlighted. **Left click** on it walks there (path-finding) and does the
  default action; E still works on whatever is in front of you; holding E opens the action wheel.
- **Fighting: mouse-look** (pointer lock) while a weapon is drawn: **G** draws/sheathes, a fight draws it
  automatically; LMB attack (hold = heavy), RMB block/aim, Space dodge. Sheathing returns the free cursor.
- **Esc** never depends on pointer lock: it leaves mouse-look, else closes the top panel, else opens the menu.
- Setting: "Always use mouse-look" for players who prefer the old scheme.

### First person, the camera and the touchpad (wave J2)

- **Your arms.** In first person the arms are posed to be seen, at rest too: upper arms forward, elbows bent, hands ahead and low at the
  bottom corners of the view, a tool or weapon held in them (`fpArms` in `assets/characters/human/animator.ts`, eased in and out
  with `fpW`; the stride still swings them, a third as much). Clips that already work the arms (strike, draw, work, aim, carry a load) keep
  their own poses, which are in view. Riding keeps the reins.
- **Your shadow has a head.** The head, eyes and mouth are left out of the camera's pass only (`crowdHide` in the crowd shader, a
  per-fragment discard); the depth and distance materials that cast shadows do not discard, so the shadow on the ground is whole.
- **Third person: walls fade, the player never hides.** `assets/core/seeThrough.ts` holds the eye (camera) and the focus (the player's
  chest), written by the rig each frame; every building shader drops fragments by the same 4x4 ordered dither as the LOD cross-fade,
  more the nearer they are to the line of sight (none beyond 1.7 m of it, all within 0.5 m), between the camera and 0.6 m in front of the
  player. Off in first person, beyond 45 m, on the map, and inside a cut-away building (which cuts its own walls).
  Outside a building the boom no longer crowds the player when a wall is in the way: it goes on through the wall (up to 2.6 m past its
  face, `WALL_PASS` in the rig) and the wall fades along the line of sight; inside a building (`BuildingSystem.isInside`, `env.insideBuilding`)
  the walls stop the boom as before.
- **The touchpad.** A swipe is one gesture (`WheelGesture` in `app/inputLogic.ts`): its many small pixel events zoom by their length
  (one boom step per 110 px) and take at most one step between views (first person, the shoulder, far out, the map) once 26 px have
  gone one way, then the rest of the swipe and its inertia is ignored; events less than 200 ms apart belong to one gesture. A mouse notch
  (line mode or ~100 px) is still a step each. Pinch (ctrl + wheel) zooms and never zooms the page. The mouse look is linear in pixels
  (0.0022 rad per px at 1x, so 700 px across the pad is about 90 degrees), so many small `movementX/Y` equal one big one.
- **No menu, no scroll.** The browser's context menu is blocked over the whole game (text fields keep theirs); a two-finger click arrives as a
  right button and a Mac ctrl-click is read as one; a wheel anywhere that is not a list that scrolls by itself is swallowed, so the page
  never scrolls or swipes back.
- **Inside buildings the mouse keeps looking** (the old `inRoom` host hook is gone; interiors are walked into without a cut).

## 6. First minutes

Birth reveal → a short scene-setting card ("Spring. You wake in your father's cottage in Dromore; the barley
must go in.") → the camera turns to show home, the strip and the church with labels → the tutorial objective
is tracked with its beacon. Control hints are reduced to movement, camera (RMB-drag) and click/E; everything
else is taught by the objectives themselves.

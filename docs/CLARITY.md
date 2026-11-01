# Clarity & feel pass — design

Playtest verdict: days far too fast; no clear way to know what is going on, how to do things, who is who
or where you are; no visible impact from work; odd cursor behaviour. This pass fixes those without
changing what the game is (SPEC). Decisions by the owner: **10-minute days, 16-day years kept.**

## 1. Time

- `DAY_SECONDS = 600` (core/time). One game hour = 25 s at 1×; daylight ≈ 7 min. Calendar systems keep
  their per-day/per-year balance; they simply run 10× slower in real time. A year ≈ 2.7 h at 1×.
- **Player work is measured in game time.** A work bout is 10–15 s real (≈ half a game hour). The player
  works about **2× as productively per game hour as a capable adult NPC** (the hero compresses chores, so a
  task feels snappy but is still a real job): reaping an ordinary strip ≈ 6–8 bouts (≈ 1.5 min), ploughing a
  strip with a team similar, felling a tree 3–5 bouts. Piece pay is at NPC rates per unit of work, so a full
  day of hard work pays ≈ 2× a labourer's day — believable wages (SPEC §4), progress that is earned.
- **Stats and skills by game time:** training and XP per game hour of work ≈ 2× an NPC's. A youth who works
  and practises most days reaches STR 10 and Archery 3 (the archer test) at about 14–15, as before.
- **Pacing (SPEC §21) is by real minutes:** something to deal with every 2–3 min — now mostly from objectives
  (tutorial, daily chores, job, goals) plus requests and events, scaled for the longer day.
- Villagers **walk** their routes now that a day is long enough (leaving early enough to arrive on time);
  only trips entirely out of view may complete off-screen.

## 2. Knowing what to do — objectives

One module (`src/sim/objectives`, contract `types.ts`) owns what the player should be doing:

| Source | Example | When |
|---|---|---|
| tutorial | "Meet your family" → "Fetch water from the well" → "Help on the family's strip" → "Sleep at home" | First in-game day; a different chain per birth class (farm child, craftsman's child, merchant's child, page in a lord's hall) |
| chore | "Sow the barley on the north strip (Father)", "Gather 2 loads of firewood", "Feed the pigs" | Each dawn the household head sets 1–3, fitted to season, age, sex and the household plan |
| job | "Work at Wat's smithy until noon: 4 tasks" | While employed |
| goal | "Join the archers: STR 8.9/10, Archery 1/3", "Save 24d for a good sickle", "Choose your path at 14 (in 1 year)" | Always a few, from career paths, savings targets, ambitions |
| request | (bridged from happenings) "Agnes asks for 4 bundles of firewood" | When villagers ask |
| story | "Your father is gravely ill: fetch the healer" | Life events |

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

- **Exploring (default): a free, visible cursor.** Hold the **right mouse button** and drag to turn the camera
  (pointer lock only while held, so the cursor stays where it was); wheel zooms; WASD moves as before.
- **Hover** shows a tooltip with the name and the default action, the cursor changes (talk, work, trade,
  enter, attack) and the thing is highlighted. **Left click** on it walks there (path-finding) and does the
  default action; E still works on whatever is in front of you; holding E opens the action wheel.
- **Fighting: mouse-look** (pointer lock) while a weapon is drawn: **G** draws/sheathes, a fight draws it
  automatically; LMB attack (hold = heavy), RMB block/aim, Space dodge. Sheathing returns the free cursor.
- **Esc** never depends on pointer lock: it leaves mouse-look, else closes the top panel, else opens the menu.
- Setting: "Always use mouse-look" for players who prefer the old scheme.

## 6. First minutes

Birth reveal → a short scene-setting card ("Spring. You wake in your father's cottage in Dromore; the barley
must go in.") → the camera turns to show home, the strip and the church with labels → the tutorial objective
is tracked with its beacon. Control hints are reduced to movement, camera (RMB-drag) and click/E; everything
else is taught by the objectives themselves.

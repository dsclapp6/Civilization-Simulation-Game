# Playing Millennia

How to start the game, what the keys do, and how a session flows. (Design: `docs/SPEC.md`; build rules:
`docs/ARCHITECTURE.md`. This file describes what the **player** and **app** modules — `src/player`,
`src/app` — give you.)

## Start

```
npm install
npm run dev          # Vite dev server, then open the printed URL (http://localhost:5173/)
npm run build && npm run preview   # production build
```

The game is the default mode (`?mode=game`). The main menu offers **Continue** (if a run is saved), **New run**
(difficulty → stat shop → birth) and the settings. A new run generates a continent from a random seed
(about 4 s in a browser, with a loading screen), settles the people, builds the renderer and drops you at
your home door at 06:00 on the first day of Spring.

Exactly one run is kept, saved to IndexedDB every ~10 s, on every important event, when the tab is hidden
and when you leave to the menu. The world pauses while the game is closed. Death is permanent; if nobody
eligible is left the run ends and your Legacy gold stays.

## Controls

| Key / mouse | Action |
|---|---|
| **W A S D** (or arrows) | Move, relative to the camera. The default gait is a jog (3.2 m/s) |
| **Shift** | Sprint (5.5 m/s, drains stamina; out of breath = walk). On a horse: gallop (11 m/s) |
| **X** | Toggle slow walk (1.4 m/s; riding: 1.7 m/s) |
| **Space** | Dodge roll (costs stamina) |
| **E** (tap) | The default action on what you face: talk, work, trade, use. The prompt shows what it will do |
| **E** (hold ½ s) | The action wheel: every option on the target, with reasons for the disabled ones. With nothing in front: rest, sit, sleep (at home) |
| **Q** | Stop the timed action in progress (walking away also stops it) |
| **F** | Mount the household's horse nearby / dismount |
| **Mouse** | Look around (click the view to capture the mouse; **Esc** releases it and opens the pause menu) |
| **Left button** | Strike: a tap is a quick blow, holding builds a heavy overhead stroke. With a bow: loose the arrow |
| **Right button** | Guard (a shield helps a great deal). With a bow or crossbow: hold to draw and aim along the camera |
| **Wheel** | Zoom. Far out, the view becomes the strategic map |
| **1 / 2 / 3** | Game speed 1× / 3× / 8× (refused with a message while an enemy is within 150 m) |
| **P** | Pause |
| **Tab** character · **I** inventory · **H** family and House · **J** ledger · **M** map and travel · **L** chronicle · **Z** sleep or wait | The UI's books and pages |
| **R** requests and news · **B** wounds · **T** House techniques · **K** realm and politics · **C** command and army (the household page of the ledger when you have no troops) | The wave 3 pages. Each also has a button in the dock (bottom right); modules that are not in the run have none |
| **F1** | Help and controls (also in the pause menu): all the keys, first steps, fighting, lords and wars |
| **Esc** | Close the top page; with nothing open, the pause menu |
| **← →**, **1–9**, **↑ ↓**, **PgUp PgDn**, **Enter** | Inside pages: switch tabs, scroll, confirm. **Enter** with a notice showing at the top of the screen opens the page it points to (a levy call or a war first) |

While a panel or menu has the focus the movement keys and the mouse look do nothing.

## The screen

- **Top left**: your plate: name, age and rank, purse, **health**, **blood** (appears when you bleed or have lost blood),
  **stamina** and four signs for hunger, rest, warmth and mood (gold = soon, red = now). A gold *Perk ready* badge
  appears when a skill level offers a choice. Under it, in the first minutes of a run, a **hint card** says what to do
  next and which key does it (see below).
- **Top right**: the date, time of day and a dial, the place and realm you stand in, holy and market days, and the
  speed buttons. Badges say *Paused*, *Action time* (the calendar crawls while you fight, talk or trade) and
  *Danger nearby*.
- **Bottom centre**: the prompt (`E  Reap · strip of barley`), the progress bar of work in progress and floating gains.
  In a fight a small chip names your stance: *On guard*, *Striking*, *Drawing*, *Aiming*, *Staggered*…
- **Bottom left**: the message feed. **Top centre**: toasts and **notices** (below).
- **Bottom right**: the dock. Two rows of buttons for every page: character, inventory, family, ledger, map,
  chronicle, rest; then requests, wounds, House techniques, realm and politics, command and army, and the menu. A gold dot
  with a number says something waits (requests, letters and petitions); a red one that the levy is called or a wound
  bleeds.

### Notices

Things that deserve your attention arrive as a toast at the top of the screen with a button that opens the right
page: a villager asking a favour (the requests journal), a letter from another House or a tenant's petition (the
realm page), a declared war (the wars tab), a siege, a raid or a plague at your own place, and the levy call (the
command page). **Enter** takes the most pressing one. The levy call no longer seizes the screen: you may finish what
you are doing first.

### The first minutes

A new run starts as a twelve-year-old in a peasant household. The hint card under your plate suggests, one at a
time and only when it applies: how to move and look, what E does, that work earns coin and skill, the character
sheet, what to do when you are hungry, tired or cold, the speed keys, the map, the holy-day archery, the choice
of a career as you near fourteen, the fighting controls the first time steel is drawn, the bow, wounds, and F1.
A hint goes away when you do what it asks, or with its **×**, and is not shown twice in a run. *Hide all hints*
(on the card) or the **Hints for new players** switch in the settings turns the guide off.

## The loop

- **Time.** A day is 60 s at 1×; a season is 4 days (day 4 is the holy day), a year 16 days. You walk in
  real time at every speed; the speeds fast-forward the world, your work and your walking together.
  Conversations and standoffs slow the calendar twentyfold.
- **Acting.** Walk up to something and the prompt names the default action (`E  Reap · strip of barley`).
  Timed actions run in simulated seconds, show their animation on your body and a progress bar, repeat
  as work bouts, and stop when you walk away or press **Q**. Heavy work drains **stamina** (Endurance
  sets the pool); rest, sitting and standing still refill it.
- **Riding.** Stand near a horse your household owns and press **F**: walk 1.7, trot 4 (default), gallop
  11 m/s. A horse cannot strafe and turns on a wide circle. Crossing the continent takes about 25 minutes
  at 1× gallop.
- **Following.** The wheel offers *Follow* on a person: you walk after them until you move yourself.
- **Sleep.** At your home door the wheel offers *Sleep until dawn*; **Z** opens the sleep/wait menu anywhere.

### Map travel

Open the map (**M**), pick a settlement, *Travel there*. Your party follows the roads on the map at 8×
(on foot about 2.4 m/s, on a horse about 6.5 m/s; roads are quicker than tracks and paths, bad weather
slows you). Each ~120 m of road rolls for an **encounter**, more likely in forest, wild country and at
borders, at night, with winter wolves, and at higher difficulty. An encounter drops you to street level
on the spot, slows time, and asks you to choose:

| Encounter | Choices |
|---|---|
| Bandits | pay what they ask · run for it (Agility, Endurance, a horse; on failure you lose goods and coin and take a wound) · talk your way out (Charisma, Persuasion, rank) |
| A patrol | pay the toll · talk past (rank helps) · turn back |
| A merchant | look over his wares (the nearest market's prices) · news · move on |
| Travellers, pilgrims, a messenger | share news · walk with them / give alms · move on |
| Wolves | drive them off with fire (needs a torch, candle or firewood) · run · stand your ground |

After a choice the journey resumes at 8× (or ends if you turned back). The journey panel the UI opens for an
encounter offers *Face them* (street level: tap or hold **E** and the wheel lists the choices above),
*Press on* (the same as running past the outlaws, paying the patrol or nodding to the harmless),
*Turn back* (get away, then head for where you started) and *End the journey here* (in front of
outlaws or wolves that means turning and running). **Cancel journey** on the HUD stops where you are.

### Fighting

Fights come from the road (bandits, wolves, a patrol that will not be talked round), from raiders and soldiers at your
door, and from your own quarrels. When steel is out the weapon appears in your hand and the calendar slows.

- **Melee.** Tap the left button for a quick blow, hold it for a heavy overhead stroke that costs more breath. Hold
  the right button to guard. **Space** rolls out of the way: for a moment nothing can touch you. Every swing, guard and
  roll costs **stamina**; out of breath you can only walk (the stamina bar turns amber and pulses).
- **Bows and crossbows.** Hold the right button to draw. A **reticle** appears in the middle of the screen and its ring
  closes as the string comes back; then it holds steady (a held bow tires the arm). The arrow leaves along the camera:
  click the left button to loose. A long shot drops, so aim a little high. A crossbow must be spanned between shots.
- **Lances.** On a horse with a lance, gallop and hold the left button to couch it.
- **Being hurt.** There is no health pool that refills by itself: blows leave **wounds** (head, torso, arms, legs; cut,
  stab, bruise, arrow) that bleed, break bones, fester and mend over days. The screen flashes red on every blow,
  the **blood** bar appears and the dock's wound button gets a red dot while you bleed. Open **Wounds** (**B**) to see
  where you are hurt and to **bind** the wounds (Medicine skill decides how well); rest, food, a healer and the
  infirmary do the rest. Lame legs and scars may remain.
- **Down.** A heavy blow or loss of blood can knock you down: the screen darkens and says *You are down*. You cannot act
  until you are on your feet again (a few seconds, unless you are dying). A nobleman who yields is held for ransom
  instead of being killed.

### Lords, wars and levies

Your lord may go to war. **The levy** calls every man from fifteen to sixty on his manors: a notice tells you and the
dock's **Command** button (**C**) turns red. In the command page you may *March to the muster* (you join the army) or
refuse (a fine and shame). In an army you serve as a levy spearman, archer, man-at-arms, sergeant or knight depending on
your arms and skills (the page shows the recruiter's tests) and your rank decides whom you command: yourself, a squad,
a company or the whole army. In battle the keys **1–6** give orders (hold, advance, charge, loose, fall back, follow me).
Armies march, besiege castles and walled towns, raid villages (burning, stealing herds, taking captives), and fight
battles near you; the *Armies & wars* tab lists them, the *Forces* tab the strength of the great Houses.

### Realm, offices and the House tree

- **Realm and politics** (**K**): *Standing* (your House, its liege, vassals, strength and the letters waiting for an
  answer), *Houses* (neighbours and rivals, with offers of truce, trade, marriage, alliance), *Wars* (peace terms),
  *Claims*, *Offices* (the posts of your place and the elections for them: stand, canvass, pay for the ale) and *Command*
  (what your titles let you rule: a manor's rents and labour, a barony's vassals, a realm's laws) and *Petitions*
  (tenants asking a lord for relief). What you may command grows with your station; locked pages say how to unlock them.
- **House techniques** (**T**): four branches (economy, military, kinship and diplomacy, knowledge and belief) of
  techniques your House has, can learn or has lost. They live in people: practise the craft or study at a school and
  you learn it; an unrecorded art dies with its last master.
- **Requests and news** (**R**): the journal of favours people have asked of you (fetch, work, a loan, a lost animal, a
  message, a watch, a godparent) with what is promised, and the notices of the district (fire, plague, fair).

### Death and succession

When your character dies the body falls and the death screen shows the life story and who may carry on
(your family, and House members of equal rank). Choose one: the camera rises to the map, slides to the
new character and settles behind them. The same works on purpose from the family panel (*Play as*).
With nobody left the run ends (game over, records, Legacy gold).

## Developer parameters

All optional, on the URL of the game page (`?mode=world|gallery|chars|village|ui` selects the developer viewers instead of the game):

| Parameter | Effect |
|---|---|
| `autostart=1` | skip the menus and start a new run (`autostart=continue` resumes the saved run) |
| `seed=abc` `difficulty=squire\|knight\|lord\|king` | the continent and difficulty of an autostarted run |
| `quality=low\|medium\|high` | override the saved quality setting |
| `time=0..1` `day=0..3` `season=0..3` | start at this time of day / day of the season / season |
| `debug=1` | overlay with frame timings, renderer and simulation statistics (and, with `profile=1`, the cost of the busiest systems) |
| `hud=1` | a plain-text stand-in for the HUD (prompt, action, journey, encounter choices, successor buttons) for builds without the real UI |
| `devzone=1` | stand-in villagers and a horse around your home, buildings that block you (for builds without the real agents module) |
| `shots=1` | keep the drawing buffer and expose `window.__game` / `window.__ui` for tools: `session`, `ready()`, `advance(seconds, input)` (the world moves by simulated seconds with the given input), `tick(seconds)` (whole frames with the real held keys, no drawing), `draw()`, `settle()`, `freeze(on)`, `frames(n)`, `killPlayer()` |

Tools (headless Chromium, software GL, so they are slow): `node tools/game-shots.mjs` plays through the
situations above and writes `docs/game/*.png`; `node tools/game-flow.mjs` clicks and types through the run
start, hotkeys, pause, the action wheel, the map, a journey with encounters, death and succession and
*Save and quit* / *Continue*, and checks what the game and the UI report at every step (including the dock, the hotkeys of the wave 3 pages, notices and hints). `node tools/game-shots.mjs hint help notice fight bow down command politics techs requests` takes the wave 4 screens (`docs/game/`).

## For other modules

- **Input** reaches the player as an `InputState` (`src/player/types.ts`), mapped by `src/app/inputLogic.ts`
  (pure) from the keys `KEYMAP.input`; `src/app/input.ts` is the DOM layer.
- **Verbs.** The player module registers its own `ActionProvider` (`player`): *Mount*, *Dismount*, *Sit
  down* / *Stand up*, *Follow*, *Rest or wait…*, *Sleep until dawn*, and the encounter choices. Everything
  else (work, trade, talk) comes from the other providers on `sim.actions`; the player controller lists
  the options on the target in front and starts the one you pick.
- **Riding hooks.** The zone may implement `claimAnimal(id)` / `releaseAnimal(id, x, y, yaw)` (additive,
  optional in `src/agents/types.ts`) so a ridden horse stops being drawn on the ground.
- **Saved state.** `state.ext['player']` holds the body's position and the ridden horse; nothing else.
  After *Continue* you stand where you were. A journey in progress is not resumed: you stop on the road.
- **Frame hooks.** `PlayerApi.frame(dt)` smooths the 20 Hz body between steps for drawing; `mapFocus()`
  tells the app where to centre the map camera during a journey or a character switch; `persist()` writes
  the position before the save is flushed.

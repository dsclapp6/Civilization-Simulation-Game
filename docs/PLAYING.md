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
| **Wheel** | Zoom. Far out, the view becomes the strategic map |
| **1 / 2 / 3** | Game speed 1× / 3× / 8× (refused with a message while an enemy is within 150 m) |
| **P** | Pause |
| **M** map and travel · **Tab** character · **I** inventory · **J** ledger and management · **H** family and House · **L** chronicle · **Z** sleep or wait · **Esc** menu | The UI's keys (see `src/ui`) |

While a panel or menu has the focus the movement keys and the mouse look do nothing.

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

After a choice the journey resumes at 8× (or ends if you turned back). **Cancel** on the HUD stops where
you are.

### Death and succession

When your character dies the body falls and the death screen shows the life story and who may carry on
(your family, and House members of equal rank). Choose one: the camera rises to the map, slides to the
new character and settles behind them. The same works on purpose from the family panel (*Play as*).
With nobody left the run ends (game over, records, Legacy gold).

## Developer parameters

All optional, on the URL of the game page:

| Parameter | Effect |
|---|---|
| `autostart=1` | skip the menus and start a new run (`autostart=continue` resumes the saved run) |
| `seed=abc` `difficulty=squire\|knight\|lord\|king` | the continent and difficulty of an autostarted run |
| `quality=low\|medium\|high` | override the saved quality setting |
| `time=0..1` `day=0..3` `season=0..3` | start at this time of day / day of the season / season |
| `debug=1` | overlay with frame timings, renderer and simulation statistics, and a plain-text HUD (prompt, action, journey, encounter choices, successor buttons) for use without the real UI |
| `devzone=1` | stand-in villagers and a horse around your home, buildings that block you (for builds without the real agents module) |
| `shots=1` | keep the drawing buffer and expose `window.__game` (`session`, `advance(seconds, input)`, `draw()`, `freeze(on)`, `frames(n)`, `killPlayer()`, `ready()`) for screenshot tools |

`node tools/game-shots.mjs` starts Vite, plays through the situations above in headless Chromium and
writes `docs/game/*.png`.

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

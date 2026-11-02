# Lives UI (civilization pass, wave B6)

Living as anyone, quest marks in the HUD, hands-on work, the wounds tab, the accolade, the new keys. The design is
`docs/CIV.md` §1, §2, §8, §9; what the player sees is in `docs/PLAYING.md` ("Living as anyone", "Who wants something of you",
"The accolade"). Everything here is `src/ui/**` plus the app layer (`src/app/host.ts`, `input.ts`, `inputLogic.ts`, `game.ts`).

```
npx vitest run tests/ui tests/app            # the models and the app layer (about 215 tests)
node tools/game-flow.mjs                     # the real game, clicking and typing: 132 checks, of which about 50 are these (V and the way across,
                                             # the death screen's search, the wounds tab, marks on the compass/minimap/hover/journal, steps, the accolade)
node tools/ui-shots.mjs lives-liveas lives-liveas-rule lives-arrival lives-fade lives-death lives-death-family lives-accolade   # docs/ui/lives-*-1280x720.jpg, -1920x1080.jpg (the gallery)
node tools/game-clarity-shots.mjs lives --out=docs/ui --format=jpg                                   # docs/ui/lives-*.jpg (the real game, 1280x720)
```

## Living as anyone (`src/ui/panels/liveas.ts`, `src/ui/core/liveAsModel.ts`, `switchfx.ts`, `liveAsAction.ts`)

**The panel.** `{ panel: 'ext', name: 'liveAs', id?, data?: { reason: 'choose' | 'rule' } }` (registered through `src/ui/panels/ext.ts`;
B1 opens it with `reason: 'rule'` from *Rule this town*). The person is `id`, else the one under the cursor (`player.hover`), else the one in
front (`player.target`); nobody → a **chooser** (`chooserPanel`: your family and House, people near, and a search over everyone alive, the
same list as the death screen; choosing leads to the card). The card (`liveAsCard`) names them (with "Sir" for a
knight), age, trade, rank, where they live, household, House, what they are doing, how they are related to you and how far they are.
`sim.canSwitchTo` decides: anyone alive but yourself; for `'rule'` the realm must say they rule something. *Live as X* calls
`PanelCtx.liveAs(id, { reason })`. The setting **Ask before living as someone** (`Settings.askBeforeLiveAs`, default on; also a switch on the
card) skips the card: the panel then switches on its first frame.

**Entry points.** V (`KEYMAP.ui.liveAs`); the action wheel (*Live as Godwin*: an `ActionProvider` `ui.liveAs`, registered on `sim.actions`
while a game is bound, instant, lowest priority, outcome `ui: { panel: 'ext', name: 'liveAs', id }`: it changes nothing itself); the
journal's *People you know* (*Live as* on each row); the family panel and the person page (*Live as Godwin* for anyone alive); the death
screen; B1's map *People here* and *Rule this town*.

**The way across (`UiApp.liveAs`, `onPlayerSwitched`, `SwitchFx`).** The UI starts the change and owns its clock (the UI's own clock, so it
runs the same under `__game.tick`):

| the new body is | what the player sees | how |
|---|---|---|
| within 300 m (`GLIDE_MAX_DISTANCE`) and the street camera is on | the camera glides from where it was to behind them, ~1.2 s, then follows | `UiHost.cameraPose(focus)` reads the camera; `followPoseBehind` keeps the boom (distance and pitch) and turns it to the new body's yaw; `UiRendererControls.setCameraPose(pos, look, 1.2)`; at the end `setCameraMode('follow')` blends the last bit |
| farther, or no street camera | the screen fades to black (0.32 s), the change is made at the black, a beat, the screen opens (0.7 s) | `SwitchFx` ('out' → cut → 'hold' → 'in'); the veil is `div.mu-veil` at the top of the UI root |

Then the **who you are now** card (`src/ui/hud/arrival.ts`, in the HUD's left column): name, age, trade (and rank, unless it is the same
word: a knight is "Knight"), place, household, House, what they were doing ("She was playing."), and up to three of the tasks the objectives
module has set, a line each (the tracked one says what to do next; "and 1 more in the journal"; a *Journal* link), read again for 15 s while
the module settles. It goes after 40 s, with its cross, or with Esc. While it is up the hint cards below it step aside (`.arrival-on` on the
column: the column must fit 1280x720), the toasts of the old life are cleared at the change and the new tasks are not toasted one by one
over it (`ArrivalCard.settling`). *Rule this town* (`reason: 'rule'`) opens ruler mode (`{ panel: 'ext', name: 'ruler' }`) once the change is over.

**The player module's own camera rise.** `src/player/controller.ts` raises the camera to the strategic map for ~1.5 s whenever the character
changes (`switchFx`, view mode `'map'`, which also sends the whole zone home meanwhile). The glide and the fade replace it:
`skipPlayerSwitchEffect` calls `PlayerApi.frame(2)` right after the switch, which ends the effect at once, and the camera is put in
`'free'` (by `setCameraPose`) so the renderer ignores any view-mode change. *Hand-off to B3 / the integrator:* drop `switchFx` from the
controller (or skip it when the UI says so); the call is then a harmless extra frame.

**The chooser (`src/ui/panels/chooser.ts`) and the death screen (`panels/death.ts`).** Your family and House first
(`run.pendingSuccession.eligible` on the death screen, `sim.eligibleSwitchTargets()` for V), then *Near where you fell / Near you*
(`nearbyPeople`: the zone's agents nearest the body, then the notable residents of the place), then **Anyone alive**: a search box over
name, place and trade (`PeopleIndex`: a lowercase index built on the first query, a few ms for ten thousand people; names that start with
a word first, then the same place, then rank). One component (`personChooser`) draws all three for both screens. *Carry on as X*; *End the
run* (confirm) is the only way to end it by choice.

**Esc.** The *who you are now* card takes the first Esc after a change of life (the same rule as the *What now?* card); the pause menu
comes with the next.

## Quest marks in the HUD (`src/ui/core/questMarks.ts`)

`QuestMarkView` merges `zone.markedPeople?()` (who is marked and where, in the zone or by schedule, indoors or not) with
`objectives.marks?()` (what each is about); either may be missing. `NavState.quest` keeps it fresh each frame (rows are reused: no
allocation). The marks come first among the nav markers, so a person standing where the church, the market or a door is marked keeps
their badge (the same spot is shown once); the tracked objective's own marker is never dropped. The compass shows the nearest three within
150 m (`COMPASS_RANGE`) as a gold **!** or silver **?** badge with the distance (its tip repaints when a mark's words arrive); the
minimap dots all of them (badge, fainter when indoors); the hover card gains a line with what they want; the journal's Tasks page has *Who
wants something of you* with *Find* (the module's person marker, or a pin without it).

## Hands-on work (`src/ui/core/stepModel.ts`, `soundModel.ts`, `audio/`)

`ActionOption.steps` (cumulative shares of the bout's seconds): `stepAt(steps, progress)` says which step the bout is in. The action bar
(`hud.ts`) shows its label, a tick on the bar where each step ends (`stepEnds`) and a dot per step. `CueScheduler` (in the sound director)
plays each step's `sfx` cue once as the bout enters it and — for the rhythmic ones — the strokes every `period` s while it lasts; new
synthesized sounds: bellows, quench, cut, stir, fire, grind, scrape, knead (`audio/sfx.ts`; the others existed). A bout that repeats starts
its cues again. `SoundDirector.cuesPlayed` and `UiApp.debugState().cues` record what was asked (the browser may keep audio asleep).
The wheel has an icon per option (`optionIcon`): lead (a halter), let go, work on the building (a saw or a trowel), slaughter (a knife),
butchery (a cleaver), the digs, crafts (an anvil), *Live as*.

## Wounds, the accolade, the keys

* **Wounds** are a tab of the character sheet (`characterPanel(ctx, 'wounds')`, request `{ panel: 'character', tab: 'wounds' }`; only when
  the combat module is in the run) and a mark on the HUD plate (gold while they mend, red and throbbing while one bleeds). Someone else's
  wounds still open in a window (`{ panel: 'ext', name: 'wounds', id }`); `{ panel: 'ext', name: 'wounds' }` for yourself opens the tab (the window
  names you whichever page it opens on). The guide's wounds hint points there. The dock lost its Wounds button (B is the builder's now).
* **The accolade** (`src/ui/core/accolade.ts`, `panels/accolade.ts`): the UI listens for `careerChanged` with `to: 'knight'`, reads the
  chronicle line a frame later (`classifyAccolade`: valour / his liege / dubbed by a lord / dubbed by the player's own hand), and shows the
  scene card — the vigil in the church of the knight's place, the sword on the shoulders, "Arise, Sir …". Only for the player, and for
  their own men when the player dubbed them (ruler mode); in a fight it waits as a notice with *Read it*. "Sir …" in the HUD plate and
  the cards for any knight (`titles.ts`).
* **Keys and the dock.** B builder (a hammer), U ruler (a castle; the crown is the realm and politics page's), V live as (KEYMAP.ui, from the contract commit); dock buttons for Builder and Ruler (they
  need `sim.services.construction` / `realm`; the panels are B1's). Hold **F** for your horse: the input layer calls `PlayerApi.callHorse`
  once after 0.35 s of holding F when you are not riding (tap F still mounts at once). Help (F1) and the controls table are updated.

## Contract changes (all additive)

`Settings.askBeforeLiveAs`; `UiHost.cameraPose?`; `PanelCtx.liveAs`, `PanelCtx.noteOpened`; `GameUIExt.debugState` gains `arrival`,
`switching`, `veil`, `cues`; `InternalRequest` `character` gains `tab`; `DockNeeds` gains `'construction' | 'realm'`; `NavMarker.kind`
gains `'quest' | 'turnin'`; `InputHost.callHorse?`, `mounted?`; `FrameIntent.callHorse`. The `wounds` entry left `DOCK_ENTRIES`.

## Screenshots (all looked at; `docs/ui/`)

The gallery's (`lives-*-1280x720.jpg`, `lives-*-1920x1080.jpg`; the mock world, the real UI):

| file | shows |
|---|---|
| `lives-liveas` | the confirmation card: who, where, household and House, what they are doing, how far, the setting's switch |
| `lives-liveas-rule` | the same for *Rule this town*: "Gavin rules the town of Kingsbridge. Live as them and the seat of government (U) is yours." |
| `lives-arrival` | *who you are now*: the card in the left column (name, age, trade, place, what they were doing, the tasks; the hint card makes room) |
| `lives-fade` | the veil half closed on the way to someone far away (the clock held by hand) |
| `lives-death-family` | the death screen: the search always in view at the top, then your family and House |
| `lives-death` | the same with a search typed: "ben" finds Benoit de Châtillon, Sir Benoit de Vendome… |
| `lives-accolade` | the vigil and the accolade: "Arise, Sir Quenild." |

The real game's (`lives-*.jpg`, 1280x720, the real objectives module, combat and zone):

| file | shows |
|---|---|
| `lives-hud` | the plain HUD: the dock has Builder (hammer) and Ruler (castle) buttons; the minimap's key says "! ? who wants something" |
| `lives-marks` | a gold **!** over a head, the **?** and the church on the compass, the hover card "Tormod wants 7 bundles of firewood" |
| `lives-marks-journal` | the journal's *Who wants something of you*, each with *Find* |
| `lives-steps` | the action bar of a forge bout: "Forge a sword", the tick where each step ends, "Draw it out", a dot per step |
| `lives-wheel` | the wheel on a person: an icon on every option, *Live as Padraig*, *Follow*, *Attack* |
| `lives-wound-mark` | the red mark under the name while a wound bleeds |
| `lives-wounds-tab` | the character sheet's Wounds page: the body shaded by its worst wound, the wounds, *Bind your wounds* |
| `lives-accolade`, `lives-sir` | the scene in the real game, then "Sir Ewan McMurchad" on the plate |
| `lives-liveas`, `lives-glide`, `lives-arrival` | V on the person under the cursor: the card, the camera mid-glide to them with the new plate, the *who you are now* card |
| `lives-liveas-far` | the card for someone 5.9 km away (the screen would fade, not glide) |
| `lives-death`, `lives-death-search`, `lives-after-death` | the death screen in the real game, a search, and carrying on as the stranger found |

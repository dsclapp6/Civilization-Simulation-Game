# Hands-on work: what it shows, how long it takes, and its games

The owner's report: *"theres no visible progress when you are performing tasks, like for example the digging flower beds literally
does nothing it just digs at the ground and shows nothing visible. and then the little interactive bits dont even work right. and it
says 10s or 20s but then runs like 5 times."* Every point was checked by playing the real game (headless Chromium, seed `work`, the
`window.__game` hooks) on the base build (`a237e02`) and again after the work pass. This page lists what was seen and what changed.

## The three faults, found by playing

1. **Nothing showed.** Digging, sowing, weeding and gathering a garden bed changed the save (`E.farm.g`) but the prop feed drew no
   beds. Crafts at the bench (bread, a hoe at the forge, yarn, cheese, planks…) drew nothing either; their product went straight
   into the pack.
2. **The time lied.** Every work option carried `repeat: true` (`workkit.option()`), and the runner started the same option again
   after each bout for as long as it stayed enabled. The bar showed one bout's seconds (*Dig a garden bed · 20 seconds*) and then
   started again at 20; at the bench a batch of bread ran three times, malting six, archery eight, until the player pressed Q or the
   materials ran out.
3. **The mini-games did not work.** The HUD read the UI clock (seconds) as milliseconds, so every game advanced a thousandth as fast
   as meant: the needle of *Strike on the gold* barely moved, the seed game's timer never ran out, the steady hand never scored,
   the bow never drew, and a stroke's word (*Miss*) never cleared. Besides: J pressed while the game was **paused** still scored
   and shortened the bout; **K** was swallowed during every game (the realm page would not open while digging); the game did **not
   reset** between bouts (the same id kept the same game); a step's pose could swap the game mid-bout without the tally
   following; an **ignored** sowing or steady game scored misses (a worse hand than not playing at all, against the design); the
   card sat over the worker in the middle of the view; and there was no way to switch the games off.

## Each kind of work, before → after

Seconds are at 1×; "bar" is the action bar's text one second in. *Before* is the base build, *after* this pass.

| Work | Before | After |
|---|---|---|
| Dig a garden bed | bar *20 s*, ran 2 bouts (40 s) with the bar resetting to 20; nothing drawn | job of 2 bouts: bar *Dig a garden bed · 40 s · Bout 1 of 2 · Q stops*, fills over both, stops when dug. A bed is drawn before the door: pegs and line, a quarter, half, three quarters turned **as the spade goes**, the spade standing in it, then dark turned soil |
| Sow the bed | nothing drawn; the seed game's timer never ran | one bout; drills with seed; the seed game asks J/K in time |
| (growing) | nothing drawn | rows of seedlings → young plants → grown → ripe cabbage, onions, leeks or turnips; weeds among them until weeded |
| Weed the bed | nothing drawn | one bout; the weeds go |
| Gather the vegetables | nothing drawn | job of 2 bouts; a basket by the bed **fills as you gather**, then stands full by the cleared bed for a day |
| Plough / harrow / sow / weed / reap / bind a strip | each bout restarted until the task was done, bar showing one bout | one job of the bouts the task still needs (*Weed · 85 s · Bout 1 of 3*), then stops; *Keep working the strip* is a separate wheel choice that goes task after task until Q. The strip's furrows, sheaves and stooks were already drawn (strip feed) |
| Fell a tree | one long action (3 bouts in one), stump and logs drawn | unchanged (already right) |
| Gather firewood, break a rock | one action | unchanged |
| Quarry stone / mine ore / dig clay / fell timber at a works | repeated bout after bout; stone pile only at quarries | one bout; *Keep at it: …* is its own choice. Fresh ore, clay or trunks lie at the works for a day, growing bout by bout |
| Forge (smithy) | bar *72 s*, then ran again and again (2+ bouts) | one batch; **a blade on the anvil** with the hammer by it, sparks |
| Bake bread | 3 batches unasked | one batch; **loaves on a board** on a trestle |
| Malt, brew, salt meat | 6 batches unasked | one batch; sacks of malt, a cask |
| Spin, weave, sew | 4 batches unasked | one batch; **bolts of cloth / hanks of yarn** on a trestle |
| Tan a hide | one 2-minute bout (spoiled at a novice's hand) | one batch; leather over a rail when it comes out |
| Saw planks, carpentry | 2 batches unasked | one batch; a plank pile (barrels, crates for the carpenter's goods) |
| Fire pots / bricks, boil salt | repeated | one batch; pots in rows, brick hacks, a salt heap |
| Press cheese | 2 batches unasked; its games never moved | one batch; **cheeses on a board**; the stirring step plays the steady hand, the pressing the strike |
| Cook (seven dishes) | repeated; nothing drawn | one batch; **a pot steaming on a trestle** with bowls by the door |
| Grind at the mill / quern | 3 bouts unasked | one bout; a sack of flour at the mill |
| Milk, shear, muck out | repeated | one bout; milk in a cask, wool in sacks, a dung heap |
| Slaughter, butcher | carcass hanging in the yard | one job; **joints of meat** on the rack where it was cut up |
| Bind a wound (combat module) | *steady* game never scored | the game works; no world result (the wounds page shows it) |
| Practise archery at the butts | 8 rounds unasked; the bow never drew | one round; *Keep shooting at the butts* is its own choice; the bow draws and looses |
| Drill at the pell, spar, study, work on a building site, push the ram (other modules) | repeated silently | still open-ended (their modules give no bout count), but the bar now says so: *Bout 3 · on until you stop (Q)* |
| Lead an animal | instant | unchanged |

## How the job works (code)

* `ActionOption.bouts` — bouts the job still needs, this one included; `open` — work that goes on until stopped. `workkit.option()`
  gives every economy option `bouts: 1` unless the listing says more (strip tasks: `boutsLeft(TASK_BOUTS[task], ex.p)`; garden dig
  and gather: `boutsLeft(2, bed.p)`).
* The runner (`src/sim/actions.ts`) keeps a `JobState` per running bout (`bout`, `bouts`, `label`) and a `serial` per bout. After a
  bout it re-lists the option and starts the next only while the job lasts (`bout < bouts`, or open), shortening the job when the
  state says fewer bouts are left; the last bout's `completed` event says `jobDone`. `sim.actions.job(actor)` gives the bar its
  view (`jobViewOf`: seconds left for the whole job, progress over the whole job).
* The bar (`hud.ts`, `hudModel.jobBarView`) shows the job's label, *Bout k of n · Q stops* (or *on until you stop (Q)*), the time
  left in real seconds at the present speed (3× and 8× divide it), a tick between bouts on the bar.
* A stroke of the game moves the bout's end nearer (`actions.perform`), which shortens the time left at once.

## The games (`src/ui/hud/minigame.ts`)

* The time step is the UI clock's seconds (was read as milliseconds).
* A new bout (`serial`) starts a new game; a step of the bout that plays another kind (the cheese's stirring, then pressing) swaps
  the game but keeps the bout's tally.
* Nothing counts until the player's first key of the bout: an ignored game costs nothing (the hand stays "unplayed", as without
  the game).
* Paused, keys are taken but play nothing; the card says *— paused*.
* The game takes only the keys it uses: K only while sowing (elsewhere K opens the realm page as ever). With no bout J is the
  ledger. With steel drawn no game runs, so J/K are the weapon's.
* The card sits to the left of the action bar (clear of the worker), and says what the hand has given so far: *Hand good 72% ·
  bout 18% quicker*; each stroke says *Perfect / Good / Rough / Miss*; the finished bout's message adds *(Good work.)* or
  *(Masterly work.)*.
* Settings → Interface → **Work games** switches them off.

## How to see it

Start a game, stand before your house and press E: *Dig a garden bed*. The bed appears to the right of the door as you dig; play
the needle with J; watch the bar count the whole job and stop. Sow it, sleep a night, see it come up; weed it; gather it when ripe.
At any bench, one press of E makes one batch and the result is set out by the door.

Tests: `tests/sim/economy/workjobs.test.ts` (a bed dug in two bouts and drawn as it is dug, sown and grown; a strip task as one job;
the open-ended choice; a one-bout batch), `tests/ui/minigame.test.ts` (no misses before the first key, K only for sowing, the kind
from the motion). Props stay under the 1500-triangle budget (`tests/assets/assets.test.ts`).

## Left as it is

* The other modules' repeating work (pell, sparring, study, building sites, the ram) is labelled honestly as open-ended but not
  counted: their providers would need to say how many bouts their job has.
* Archery leaves no arrows in the butts; binding a wound leaves nothing in the world.
* The beds stand before the house whatever the croft garden behind it; a household's beds are drawn only for the player's
  household (the others keep no beds).
* In the headless tool's `tick()` mode a Q pressed and released between frames is not seen (the real loop sees it).

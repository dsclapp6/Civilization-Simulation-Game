# Law: trespass, patrols and captivity (`src/sim/law`; docs/CIV.md §4)

The lord's law on his land, for the player and for everyone else. `installLaw(sim, deps)` registers `sim.services.law` (`LawApi`,
`src/sim/law/types.ts`; the contract of wave B, extended only additively) and finds every other module lazily — the zone, the
player body, territory, combat, military, politics, economy may each be missing (headless runs, tests) and the law carries on with
what it has. Saved in `state.ext['law']` (`LAW_VERSION` 1), deterministic (`sim.rng('law')`, `hash01`), nothing else is written.

| file | what it does |
|---|---|
| `config.ts` | every number below (`LAW`), the careers that ride and lead |
| `watch.ts` | twice a second asks the territory whether the player may be where he stands; who sees him; when the patrol is sent |
| `patrol.ts` | the patrol state machine: coming, halt, escort, attack, taking, gone; the lines, the choices, the fight, the walk to the gaol |
| `pick.ts` | who rides: a leader and 1–3 men, which of them are mounted (pure, by hash) |
| `captive.ts` | the record of a prisoner, the card's choices, fines, sentences, escape, the hangman, the daily tick; the player's restraint |
| `ai.ts` | the AI's poachers, outlaws and scouts, off-screen, once a day |
| `store.ts`, `context.ts`, `names.ts` | the saved section; what the parts share; "Sir Hugh" |
| `src/agents/` | the zone side: riders on horses, the orders (`approach`, `follow`, `goto` with a gait), prisoners in their cells, alert and stations — see docs/AGENTS.md |
| `src/player/` | the body: restraints (`restrain`), gaits of a horse, hold F to call the horse, the steps of a bout |
| `src/ui/panels/law.ts`, `src/ui/hud/law.ts` | the card of the patrol and of the prisoner; the HUD plaque |

## Being seen (`watch.ts`)

The watch looks at the player every 0.5 s (`LAW.watchPeriod`) while he is in the street, free and not skipping time, and asks
`territory.trespass(person, x, z)`. The wanted list (an escaped prisoner, a killer of the lord's men) makes the lands it names
*hostile* for him whatever the territory says. When the level is not `none`, a **case** opens; it needs a **witness**: someone of the
owning settlement (or of the House that holds the land) who is in the zone, grown (11 and over), visible, and *sees* him:

* by day within **80 m**, at night **26 m**, **48 m** if the witness carries a torch; rain and fog take off up to 30 % and 40 %
  (never below 45 %); not through a wall (`nav.lineClear`) and not from another lord's land.
* A villager carries the word to the manor: the patrol is sent **7–16 s** later (a draw of the law's stream). An armed man within
  55 m whistles up the others himself: **3–8 s** (on hostile land, and against a man already warned or wanted, **0.5–3 s**: the watch
  reacts at once).
* If the player is off the land again for 6 s before the patrol is sent, the case closes. A second report while a patrol is out
  sends no second one (`maxPatrols` 1).

`LawRuntime.report(person, x, z)` skips the witness and the delay (tests, tools).

## The patrol (`patrol.ts`, `pick.ts`)

* **Who**: a leader — the armed witness if fit, else the best of the lord's armed men (knight, sergeant, man-at-arms, soldier, archer,
  squire), else an officer (sheriff, bailiff, reeve, steward, marshal), else the strongest man — and **1–3 men** (one more on hostile
  land), from the settlement; where it keeps fewer than two soldiers, from the nearest places of the same House (4.5 km). Fit means a
  free adult man, 17–58, hp ≥ 0.5, not in a fight. The lord himself does not ride after a trespasser while anyone else is fit; when he
  must, the halt is *"Halt. These are my closes."*. **Mounted** as many as the leader's or the lord's household keeps horses
  (`economy.holding(...).livestock.horse`). They carry spear and heater shield, or lance when mounted or a knight, a torch at night.
* **Coming**: they are summoned into the zone at the **edge of sight** (168 m from the player, just inside the zone's no-warp radius of
  190 m, along the way from the lord's hall; the leader where he stands if he was the witness) and ordered to `approach` the player: riders
  at a **gallop** (10 m/s), men on foot at a jog; the leader stops 3.4 m from him, the men fan out behind. Nobody is hurried, nobody
  warps: `sim.hostileNear` is chained so that fast speed and sleeping are refused while the patrol rides. A leader who is held up (he has
  gone less than 6 m in 6 s and is still over 15 m from the man: a pond's edge, a snag in the path) is sent, with his men, to a point
  round the way by another bearing — three times; then, if he can see the man (`nav.lineClear`) and is within 70 m, he calls out from where
  he is (and flight is measured from where the man stood, not from the leader), else the patrol gives up and is gone. Found by playing:
  in one village the planner passed a thin stream that the exact terrain test did not.
* **Halt**: when the leader is up with him he says the line of CIV §4 — *"Halt. You are on the lands of Sir Hugh. State your business or
  be gone."* (variants: *"Halt! This is Sir Hugh's park. What business have you here?"*, *"Halt. The castle is shut…"*, *"Poaching in Sir
  Hugh's park! You'll answer for this."*; at war *"Yield! You are on the lands of House Avenel, at war with you!"*; to a man warned
  before *"I told you to keep off! Take him!"*), the **law panel** opens and the standoff runs in **action time** (as a conversation does).
  The leader waits **70 s**, asks again (*"Well? Speak, or be taken!"*), waits 22 s more and then attacks. Walking more than 10 m away
  is flight: *"Stop! Stand where you are!"*, and 3.4 s later they attack.
* **The choices** (`patrolChoices`, numbered on the card):
  * **Leave** — they see him to the edge of the land. The point is `territory.exitFrom`; the time is `exit distance / 1.45 + 12 s`
    (45 s at the least, 300 s at the most: a walker can do it), counted on the HUD with the way to go. The men `follow` him a few
    metres behind. Off the land: *"And stay off."*, they turn back and ride away; he is let go. At the deadline: *"Your time is up. Take
    him!"* and the fight. A man who comes back onto those lands within 240 s of being escorted off is attacked as soon as they are up.
  * **State your business** — one try. The chance (shown in words and per cent, with its reasons) is 0.34, +0.30 for a request or work
    in the place, +0.20 on market day (by day), +0.11 per rank above the leader's (−0.25…+0.42), +0.025 per Charisma point above 10 and
    +0.012 per level of persuasion, −0.25 on hostile land, −0.30 poaching, −0.15 per earlier offence here (three at most), +0.06 for a
    man of honour; 5–92 %. Success: `territory.grantLeave` for 0.75–2 days by the best reason; they go. Failure: *"A thin tale…"*.
  * **Offer a bribe** — `6d × the leader's rank tier` (at least 8d, 1.8× at war, dearer for the great). It works about 58 % of the time
    (+3 % per Charisma point; −38 % for an honest leader, +22 % for a greedy one, less on hostile land and for poachers) and buys half
    a day's leave. When it fails they keep the coin and take him.
  * **Pay the fine** (private land only) — 3d demesne, 6d park, 9d castle grounds, ×2.2 for poaching (the game he carries is taken:
    `economy.give` to the leader), +25 % per rank above a freeman, +40 % per earlier offence; paid to the lord's household.
  * **Yield** — bound and taken (below). **Refuse** — the fight.
  * At war, to a soldier or noble of the enemy, an outlaw or a lord's declared enemy, only **Yield** and **Refuse**.
* **The fight**: `combat.engage([{ faction: 'player', … }, { faction: 'patrol', people: [leader, …men], mounted }], { yieldAllowed: true,
  reason: 'patrol', intent: 'subdue' })` — the men strike to wound; `'kill'` only for an armed enemy at war. `FightResult.captured`
  (or the patrol winning without killing him) takes him prisoner; if he kills the lord's men he is named an **outlaw** and **wanted**
  on those lands for 8 days (`LAW.wantedDays`: the patrol that finds him again attacks on sight, *"There he is! Take him!"*); if he
  dies the patrol is dropped. Without a combat module the men simply take him.

## Captivity (`captive.ts`)

A **record** (`CaptiveRec`) for every prisoner the law holds: who, the kind (`trespass`, `poaching`, `crime`, `war`), the captor and the
House that holds him, where (settlement and building), since when, the **fine**, the **ransom** (war only), the **sentence** in days,
whether he is serving it, the warning of the rope, failed escapes, whether the military module keeps him too.

* **Taken** (`seizePerson`): flagged `captive`, the record made, the military module told (`takeCaptive`; the law marks the record as
  the module's only if the module then reports the prisoner), a notice and the log. The place is the lock-up of the land's settlement —
  the **gaol**, else the keep, the manor's lock-up, the guardroom of the great hall or barracks, a gatehouse or tower cell — else the
  nearest such place of the same House within 7 km, else "the stocks". The **player** is *bound and led on foot* (`player.restrain({
  kind: 'led', by })`, the `bound_walk` clip) behind the leader to the cell's door, the men following the leader; the leader waits for
  him when he lags (5.5 m) and brings him in. Farther than 240 m the walk begins in sight and the clock carries the rest (`waitUntil`:
  *"You are marched to the gaol of Dromore: about 3 hours on the road"*). In the cell he is `held` (`restrain({ kind: 'held', … })`).
* **The card** (`captivityChoices`): **Wait** for your family (or for the ransom), **Pay** the fine (or your own ransom) from his purse
  and his household's, **Serve a sentence** (labour on the lord's works: a day of it is worth 3d to the lord, the days run in the daily
  tick, and he is turned out when they are done), **Try to escape tonight** (night only): the chance is `0.34 + 0.022 (Agility − 10) +
  0.014 (Strength − 10) + 0.018 stealth − the guard (1.5 % per armed man of the place, 4 % in a building) − 7 % per failed try`,
  7–82 %. Away: wanted on those lands for 8 days. Caught: **worse** — 3 more days, the fine ×1.5 + 4d, a beating, the lord's opinion −8.
  And **Live as someone else** (B6's panel) and *Sleep or wait*, which the card links to.
* **Every dawn** (`dailyCaptives`): bread and water — a prisoner's hunger is kept at 0.35 at least, so nobody starves in the lord's keeping;
  a man the warning was given to may be hanged (below); a sentence being served runs down; **the
  family pays** a fine or ransom after 2 days if it can raise it and someone cares (a spouse, a child, a parent, a friend at +15, the
  head of a great House); **the lord loses patience** after 6 days and sets a sentence; a prisoner of war the military no longer keeps
  is let go after 30 days; one the military has freed by its own rules is freed here.
* **The rope**: only an enemy soldier (or noble) who killed the lord's men, at war — or an outlaw who did — under a lord whose
  cruelty is 40 or more; he is *warned* when taken ("he may hang you") and, a night later, hanged at dawn with a 35 % chance each day.
  Never a poacher, a plain trespasser or a gentle lord's prisoner.
* **Prisoners of war** (`military.captiveOf`) have the same card: the ransom is the military's figure and is paid through
  `military.payRansom`; they cannot serve a sentence. A capture the military makes in a battle or a raid and tells the world of
  (`captured`) is the player's case at once (`adoptWar`): the card opens, he is bound in the cell.
* The ruler's list (`prisoners(settlement?)`) is the law's records plus the military's prisoners the law keeps no record of.

## The AI's cases (`ai.ts`)

Once a day, six settlements of the continent are looked at (a window that walks round the whole list: all 140 in about 24 days),
at most two cases a day and 36 held at once. A **poacher** (a poor free man of the place or the next two, 16–50, not armed, with
under about 45d), only where the woods are (`woodland`: a handful of reads of the macro map, cached); the place's watch must catch him
(22 % + 8 % per armed man, 85 % at most). An **outlaw** living there is taken (20 % a day, 25 % + 8 % per armed man, 45 % that the
case has blood on it). An **enemy scout** — a knight, sergeant, man-at-arms or squire of a House at war with the lord, not with an army
— is taken at 10 % a day. All go through `seizePerson` and then live by the same daily rules as the player's case: fines paid by
families, sentences served, patience lost, escapes never (the AI does not try), the rope under the rules above.

## What the player sees

* **The HUD plaque** (`src/ui/hud/law.ts`, bottom centre): *"Lands of Sir Hugh · private"* with why ("The lord's deer park at Cyney."),
  or *"Hostile: House Avenel, at war with yours"*; *"Riders are coming"*; *"The riders have halted you"* with **Answer them**; during an
  escort *"Off the land in 42 s"* and *"213 m to the edge, east"*; when bound or held, where and why, what is asked, with **Your
  options**; the horse that was called. The most pressing thing wins. It also keeps **hold F** (0.55 s): `player.callHorse()`.
* **The law panel** (`src/ui/panels/law.ts`, `{ panel: 'ext', name: 'law' }`): the leader's words, why the land is closed, who is come,
  the answers numbered 1…n with their chances and prices (digit keys), or the prisoner's card (where, since when, what is asked, the
  warning, the ways out). It closes itself two seconds after the case is over. `Esc` closes it; the plaque reopens it.

## The player's body and the zone

Restraints, gaits, mounting, hold-F and the steps playback are in docs/AGENTS.md (zone) and the comments of `src/player/`.
`PlayerApi.restrain(r)` / `restraint()` (`Restraint = { kind: 'led', by, reason } | { kind: 'held', x, z, building, reason } |
{ kind: 'escorted', by, toX, toZ, reason }`): a restrained body does not take the keys, cannot work, draw or ride, shows the bound
clips (`bound_walk` while led, `bound` standing in the cell), is taken off the saddle, and is not saved (the law restores it on load: a
prisoner is in his cell; a man who was being led is put in the cell). The law itself uses `led` and `held`; `escorted` walks the body
to a point and is there for other modules.

## Pictures

`node tools/village-law-shots.mjs` (Vite on :5193; `--out=` to put them elsewhere) plays each situation in the whole game, the real law,
territory and zone, and writes `docs/agents/law-*.png`:

| picture | shows |
|---|---|
| `law-plaque` | the HUD plaque on the lord's closes: *Lands of Sir Brian · private — The lord's closes at Moymor.* |
| `law-riders` | the patrol gallops in (a leader and a man on horses, lances up), 17 m off, with *Riders are coming* |
| `law-halt-world`, `law-halt` | the riders drawn up about him, the leader's words over his head and on the plaque; the card with the six answers |
| `law-escort` | the men close behind him, *Off the land in 40 s — 4 m to the edge, south* |
| `law-led`, `law-led-front` | bound and led on foot behind the leader to the manor's lock-up (the bound-walk clip), the plaque says where and why |
| `law-cell`, `law-bound` | the prisoner's card (held by whom since when, the fine, the ways out); the body at the door of the lock-up, *You are a prisoner* on the prompt |
| `law-alert` | a walled city on alarm: men on the wall-walk and the tower, at the heights of the building recipes |
| `law-horse` | the household's horse trots in at a call, *Your horse is coming — About 3 s* |
| `law-steps-1…3` | a smith's bout with steps (heat the bar, draw it out, quench): the body plays each step's clip and holds its items |

The FX of the steps (steam, sparks, chips, dust, smoke, fire) are emitted into the view's FX queue (`tests/player/civ.test.ts`); drawing them
is the renderer's. The shut gates and the breaches reach the navigation through `view.forts()`; drawing them is the renderer's too.

## Tunables and tests

All numbers are in `LAW` (`config.ts`). Tests: `tests/sim/law/` — `patrol` (the halt, leave, business, bribe, fine, the lord who stays home,
a leader held up), `captivity` (yield, refuse, war, the cell, rations, pay, serve, escape, the rope), `watch` (who sees whom), `ai` (the daily
cases), `save` (round trips with the player held; a patrol out at save time), `military` (the module's calls, with a fake that keeps captives),
`ui` (the cards and the plaque as pure models); `tests/agents/{patrol,alert,horse,prisoner,lawzone}.test.ts` (the last is the real zone,
territory and law together: it found the sight test that said no from beside a wall, the riders the road made faster than a gallop, and the
riders that stuck at a pond's edge) and `tests/player/civ.test.ts` for the bodies.

## Contract notes

Additive only: `PatrolView` / `CaptivityView` optional fields; `LawApi.wanted?`; `LawRuntime` (`report`, `seize`, `dispose`);
`ZoneApi.callHorse?`, `ZoneApi.summon(…, opts)`, the `approach` order, `AgentOrder` gaits, `NavApi.lineClear?`, `AnimalDrawItem.ledBy`;
`PlayerApi.restrain/restraint`. The military module's `takeCaptive?`, `release?`, `alertOf?`, `fortState?` and combat's
`intent: 'subdue'` / `FightResult.captured` are used when present and the law works without them.

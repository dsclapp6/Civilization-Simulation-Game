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
(difficulty and how to begin: *Be born into a family* → stat shop → birth, or *Start as a lord*) and the settings. A new run generates a continent from a random seed
(about 4 s in a browser, with a loading screen), settles the people, builds the renderer and drops you at
your home door at 06:00 on the first day of Spring.

Exactly one run is kept, saved to IndexedDB every ~10 s, on every important event, when the tab is hidden
and when you leave to the menu. The world pauses while the game is closed. Death is permanent; if nobody
eligible is left the run ends and your Legacy gold stays.

## Controls

| Key / mouse | Action |
|---|---|
| **W A S D** (or arrows) | Move, relative to the camera. The default gait is a jog (3.2 m/s) |
| **Shift** | Sprint (5.5 m/s, drains stamina; out of breath = walk). On a horse (a trot, 3.5 m/s, by default): canter (6 m/s); held 1.2 s, gallop (10 m/s) |
| **X** | Toggle slow walk (1.4 m/s; riding: a walk, 1.7 m/s) |
| **Space** | Dodge roll (costs stamina) |
| **Mouse** (looking, the default) | **First person**: the camera is at your eyes (a rider's eyes on a horse) and turns with the mouse or trackpad — no button held. A small crosshair marks the middle; the person, animal, door, strip, tree or thing under it (within reach) is outlined, named under the crosshair with what **E** does. Look down for your own hands, arms and body (not your head) with what they hold; your shadow is cast; the view bobs gently with your stride (Settings: *Head bob*). The first click in the game takes the mouse (a hint says so) and never acts. Sensitivity and invert-Y are in the Settings |
| **Alt** (Left Alt, **Option** on a Mac) | Free the cursor: point at things (a tooltip names them and what a click does, the cursor shows the kind of action, the thing is outlined) and click them and the HUD; the view stays still. **Alt** again, or a click on the hint *Click to look around*, takes the mouse back. **Esc** frees it too (never opening the menu for that press); opening any page frees it and closing it takes it back |
| **Left click** (cursor free) | Walk to what is under the cursor along the paths and do its default action there (bare ground: just walk). Any movement key, **E**, **Q** or a dodge stops the walk; a click on something that cannot be done says why instead of walking. While looking, a tap of the left button (weapon sheathed) does what **E** does on the thing under the crosshair |
| **E** (tap) | The default action on what is under the crosshair: talk, work, trade, use. The prompt shows what it will do |
| **E** (hold ½ s) | The action wheel: every option on the target, with reasons for the disabled ones. With nothing in front: rest, sit, sleep (at home) |
| **G** | Draw or put away the weapon. While looking, with it drawn: left strikes, right guards (a two-finger click on a Mac trackpad); with a bow right draws and aims along the crosshair. A fight draws it by itself and it goes away a few seconds after the fight. The click that takes the mouse is never a blow. **J** / **K** strike and guard from the keyboard |
| **Q** | Stop the timed action in progress (walking away also stops it) |
| **F** | Mount the horse in front of you (your household's, or your lord's if you serve him) / dismount. **Hold F** (½ s) with no horse at hand: call yours — it trots to you from the stable or where you left it |
| **Y** | The "What now?" card: the tracked task's next step first, then what the hour and the day suggest; choose a line to be shown the way |
| **O** | The journal: tasks, today, the people you know, places (each with **Find**) |
| **N** | Show or hide the minimap |
| **Wheel** | Steps between **first person**, **over the shoulder** (third person), **farther out** and the **strategic map** (one step at a time out of first person). The choice is remembered. In third person buildings never shove the camera: it eases in smoothly when something comes between and lets go slowly |
| **1 / 2 / 3** | Game speed 1× / 3× / 8× (refused with a message while an enemy is within 150 m) |
| **P** | Pause |
| **Tab** character · **I** inventory · **H** family and House · **J** ledger · **M** map and travel · **L** chronicle · **Z** sleep or wait | The UI's books and pages |
| **R** requests and news · **T** House techniques · **K** realm and politics · **C** command and army (the household page of the ledger when you have no troops) | The wave 3 pages. Each also has a button in the dock (bottom right); modules that are not in the run have none |
| **V** | **Live as** the person under the cursor or in front of you: anyone alive, at any time (see *Living as anyone*) |
| **B** · **U** | **Builder mode** and **ruler mode** (the seat of government) — civilization pass; each has a dock button too |
| **4 5 6 7** · **8** · **C** (in a battle where you command men) | Choose a group (all / foot / archers / horse) · the order wheel · the tactical view (outside a battle **C** is the command page) |
| **Tab**, then *Wounds* | The wounds page is a tab of the character sheet (and the red or gold mark under your name on the HUD opens it): *Bind your wounds* there |
| **F1** | Help and controls (also in the pause menu): all the keys, first steps, fighting, lords and wars |
| **Esc** | Free the cursor first (it never opens the menu for that press); else close the top page (or the "What now?" card); with nothing open, the pause menu |
| **← →**, **1–9**, **↑ ↓**, **PgUp PgDn**, **Enter** | Inside pages: switch tabs, scroll, confirm. **Enter** with a notice showing at the top of the screen opens the page it points to (a levy call or a war first) |

While a panel or menu has the focus the movement keys and the mouse do nothing. (The old setting *Always use mouse-look* is gone:
the mouse always looks unless you free it with **Alt**.)

## The screen

- **Top left**: your plate (with the setting *Compact HUD*, Settings → Interface, every card is flat and soft, the columns narrower and the button bar one slim row): name, age and rank, purse, **health**, **blood** (appears when you bleed or have lost blood),
  **stamina** and four signs for hunger, rest, warmth and mood (gold = soon, red = now). A gold *Perk ready* badge
  appears when a skill level offers a choice. Under it the **objective tracker**: the task you follow, its next step and
  how to do it, how far and which way it is (the little arrow turns as you turn), and two buttons: the journal (**O**)
  and **What now?** (**Y**). Under that, in the first minutes of a run, a **hint card** teaches the controls.
- **Top centre**: the **compass ribbon**: which way you face, and the tracked objective, a pinned place, home, work, the
  church and the market with their distances (a mark past the edge sits at the edge with a chevron). When you enter a
  village or town its **banner** appears for a few seconds: name, kind, county and lord.
- **Top right**: the date, time of day and a dial, what kind of day it is in words (a working day, market day at Dromore, a
  holy day) with a tip that a day lasts thirty minutes, the place and realm you stand in, and the speed buttons (click the
  card for *Today* in the journal). Badges say *Paused*, *Action time* (the calendar crawls while you fight, talk or
  trade) and *Danger nearby*. Under it the **minimap** (**N**): north-up chart of roads, rivers, the buildings of the
  place (your home in gold), the family's strips (gold), people (kin gold, household amber, others grey), markers and
  where the camera looks; **+** and **−** zoom, a click opens the map.
- **On the screen edge**: an arrow for the tracked objective (or a pinned place) when it is out of sight, with its
  distance. **Under the cursor**: the tooltip (name, who or what, what a click does, how far) and, while you walk to a
  click, a ring on the destination.
- **Bottom centre**: the prompt (`E  Reap · strip of barley`), the progress bar of work in progress and floating gains. A bout of
  hands-on work (the forge, the butcher's block, the kiln, the digs, a building going up) shows **the step it is at** under the bar
  ("Heat the bar", "Draw it out", "Quench"), with a tick on the bar and a dot under it for each step; each step has its own sound.
  In a fight a small chip names your stance: *On guard*, *Striking*, *Drawing*, *Aiming*, *Staggered*…
- **Bottom left**: the message feed. **Top centre**: toasts and **notices** (below).
- **Bottom right**: the dock. Two rows of buttons for every page: character, inventory, family, ledger, map,
  chronicle, rest; then requests, builder mode (**B**), ruler mode (**U**), House techniques, realm and politics, command and army, and
  the menu. A gold dot with a number says something waits (requests, letters and petitions); a red one that the levy is called.
- **Under your name**: besides the bars and the four signs, a **wound mark** (gold while wounds mend, red and throbbing while one bleeds;
  it opens the Wounds page of the character sheet) and, after you take up another life, the **who you are now** card.

### Notices

Things that deserve your attention arrive as a toast at the top of the screen with a button that opens the right
page: a villager asking a favour (the requests journal), a letter from another House or a tenant's petition (the
realm page), a declared war (the wars tab), a siege, a raid or a plague at your own place, and the levy call (the
command page). **Enter** takes the most pressing one. The levy call no longer seizes the screen: you may finish what
you are doing first.

### Starting as a lord

The New run page offers two ways to begin beside the difficulty. **Be born into a family** (the default) is the birth lottery
with the Legacy shop. **Start as a lord** skips the shop: you are a grown man or woman (18 to 45) who holds a manor (a town or barony if
the world has no manor-lord fit to rule), from the first morning, with its fields, purse and men. The reveal reads "You are the lord of
…" and says what ruling means; after the scene-setting card and the tour the **seat of government** (**U**) opens by itself. The
first-day tutorial is the *lord chain*: meet your household, hear your steward, name a crop or set the labour sent to the works
(*Set your fields and labour*), put your purse to work (research, men or a trade order: *Put your purse to work*), drill at the pell
twice, sleep. Its steps are read from the realm, so any way of giving the order counts. For a test or a tool, `?autostart=1&start=lord`
starts this way, and `newGame({ start: 'lord' })` in code (`'birth'` is the default). Nothing else changes: taking over anyone,
death and succession, the score are the same.

### Duties, not chores, for a station; the agenda for a lord

Someone with no master to set the day has the **duty of their station**, one at a time through the working day (on the
thirty-minute day it is asked again every few hours): a knight rides the bounds (three marks round the place), trains the men at the
yard, sees to his arms at the forge or stands the watch; a soldier guards the gate, rides the bounds or drills; a priest keeps the
church and visits the sick; a healer tends whoever is ailing or prepares remedies; a master craftsman works at his own bench. Chores
and the *choose your path* goal go to the young and the landless; a grown tradesman is not asked to choose a path again.

A **lord manages**: he gets no chores, duties, goals or villagers' requests. In their place the tracker card carries **Matters of the
realm** under the tracked steps (and alone when no step is tracked): raiders on the lands and the host in the field (with a count of
men, and a warning when yours are fewer), works standing idle, fields with no crop named when the sowing is at hand, no research
under way, a thin treasury, people in want, a petition waiting. Dangers come first and glow red. Each is a button that opens the page
where it is decided: the seat of government on its page, the build page, battle command, the petitions page of politics. Everyone else
keeps the real-time pacing of requests (one every few minutes of play) and of chores.

### The first minutes

A new run starts as a twelve-year-old in a peasant household (or the child of a craftsman, a merchant, a lord's page, a
baronial heir). After the birth reveal comes a short **scene-setting card** ("Spring. You wake in your father's cottage
in Dromore…"). *Show me round* turns the camera over your home, the family's strip and the church with their names on
them; *Straight in* skips it. The first-day **tutorial task** is already tracked: a short chain fitted to who you were born
as (a farm child meets the family member at hand, works at what the household needs, runs a neighbour's errand, buys or
sells something, hears Mass, and goes home to sleep), each step located (gold marker and beacon in the world, compass,
minimap, edge arrow) with a one-line *how*. Every morning the household head sets a few chores; the journal (**O**) lists
them with goals, requests and jobs, and **Y** says what is worth doing right now.

Hint cards under the tracker teach only the **controls**, one at a time and only when they apply: walking and looking
(right button drag), pointing and clicking, where the tasks are, the speed keys, the weapon (**G**) the first time steel
is drawn, the bow, wounds, and **F1**. A hint goes away when you do what it asks, or with its **×**, and is not shown
twice in a run. *Hide all hints* (on the card) or the **Hints for new players** switch in the settings turns the guide off.

### The day written up

When you sleep (or the night closes the day) a **day summary** card says what the day was: the work you did, what came in
and went out of your purse, goods, skills and strength gained, the tasks finished, how the household fared and what
tomorrow holds (a market day, a holy day, the chores already set). If you are still up at midnight it is offered as a
notice (*Read it*) rather than a page that stops the world.

### Sound

Effects are made in the browser, no files: the swish of a scythe or sickle, the chop of an axe, a hammer's clank, a
pick, a saw, a hoe's thud (keyed to the animation of the work you do), coins on a trade or a wage, a chime for a
level-up, a ding for a task, the church bell at Mass (louder the nearer the church) and a soft click on buttons. Work with steps
sounds each step's own cue as it begins — bellows, hammer, quench, saw, chop, cut, dig, stir, fire, grind, scrape, knead — and the
strokes of the rhythmic ones while the step lasts. The
**Sound volume** setting scales them; browsers start sound only after the first click or key press.

## The loop

- **Time.** A day is 30 minutes at 1× (about 20 of them daylight); a season is 4 days (day 4 is the holy day), a year 16 days. You walk in
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

### Living as anyone

You may take up the life of **anyone alive, at any time** (civilization pass; the one you leave goes on with their life, run by the
world). Ways in, all leading to the same card — a parchment card with their name, age, trade, where they live, their household and House,
what they are doing and how they are related to you (**Live as Godwin** / **Stay as you are**; the card is switched off with *Ask before
living as someone* in the settings or its own switch):

- **V** on the person under the cursor, or in front of you (nobody there: a list to choose from — your family and House, people near
  you, and a search over everyone alive);
- the action wheel (hold **E** on a person): *Live as Godwin*;
- the journal's **People you know** (a *Live as* button on each), the **Family & House** page and a person's page;
- the death screen (below); the map's *People here* and *Rule this town* (banner, map, ruler panel) open the same card with
  `{ panel: 'ext', name: 'liveAs', id, data: { reason: 'choose' | 'rule' } }`. *Rule this town* lives as the holder of the town's title (or
  its regent or steward) and opens the seat of government (**U**) when you arrive.

**The way across.** When the new body is within 300 m the camera glides from where it was to behind them (about 1.2 s) while the world
goes on; farther, the screen fades to black and opens on them. Then a card in the top left says **who you are now** (name, age, trade,
place, household, what they were doing, the tasks the objectives set them) and goes by itself after a while, with its cross or with
Esc (the first Esc takes the card; the pause menu comes with the next). A knight is *Sir …* on the HUD.

**On death** the screen offers your family and House first, then **people near where you fell**, and a **search over everyone alive**
(a name, a place or a trade: "smith Dromore"). Choose one and *Carry on as …*. The run ends only when you give it up (*End the run* on
that screen, or the pause menu).

### Who wants something of you

A person with something for you has a gold **!** over their head, and one you can hand a finished task to a silver **?**. The compass
ribbon shows the nearest few within 150 m (with the distance), the minimap dots them (**!** and **?** badges, fainter when they are
indoors), the hover card says what they want ("Maire wants 7 bundles of firewood"), and the journal's Tasks page lists **Who wants
something of you** with *Find* on each.

### The accolade

When you are made a knight — by your liege, dubbed by a lord, or for valour on the field — a scene card tells the vigil in the church
and the sword laid on your shoulders ("Arise, Sir …"); from then on you are *Sir …* on the HUD. The same card, told your way, when you
dub one of your own men in ruler mode. In the middle of a fight it waits as a notice with a *Read it* button.

### Building (B)

**B** opens builder mode wherever you may build: a household head on his own plot and yard, a master at his workshop, a lord (or
his steward or reeve) anywhere in his manor's lands, a baron and up in all the lands he holds and, in the wild, at outposts. If you
may build nowhere, a card says why. The camera rises over your land, which is tinted (**W A S D** pan, the **wheel** zooms, **right
drag** turns; **Esc** or **B** leaves). The catalogue lists what you may raise with its cost (materials, worker-days, money), what it
needs (a technique, a river, a rise, the coast, a forest, the right deposit, your rank) and what it does; what you may not build says
why. Pick one: a ghost follows the cursor, green when it fits and red with the reason when it does not (**Q / E** or **Shift + wheel**
turn it); click to stake out the site, or let **Place for me** find a spot. Click a building of yours to upgrade, repair or pull it
down; click a site to see its stage, what it waits for (and what is on the way from market), who works there and when it should be
done, and to cancel it, raise its priority or hire hands. Materials come from your stores, then are bought at the nearest market and
carted in; the work is done by your household (task *Build*), hired labourers, the manor's week-work and you (**E** at the site: *Work
on the building*). A building goes up in stages — pegs and lines, footings, frame and walls, roof — with scaffolding for stone.

### Ruling (U)

**U** opens the seat of government for anyone who rules something (a manor, a town, a barony and up; the steward or reeve for what
their office covers). The game pauses while it is open. Its pages: **Overview** (your lands, treasury and books, stores, people,
prosperity, strength, works, research, troops, threats, news), **Lands & works** (each settlement and outpost, the building queue),
**Fields & labour** (which crop each field sows next, the share of labour-service sent to your works, the manor's dues), **Research**
(a technique is worked out by a person who could know it, at a fitting place, paid in its branch's goods: timber and brick for the
economy, iron for war, cloth and ale for kinship, vellum and candles for learning — *Buy the rest and start* orders what you lack),
**Military** (recruit archers, crossbowmen, men-at-arms, sergeants, knights, mercenaries; keep or discharge them; dub a knight; raise
an army), **Trade** (what your lands yield and lack; standing orders to sell surplus or buy materials at a market), **Diplomacy** and
**Rivals** (every House near you: strength, what it built, learnt and raised this year, its stance and how much it threatens you).
**Rule this town** (on the settlement banner, the map and the seat of government) lives as the place's ruler in one click.
Rival lords run the same loop with the same costs: their towns grow, wall themselves when threatened, found outposts at deposits and
come for the weak — the news tells you.

### Whose land you are on

The land belongs to someone. On a lord's private ground (his demesne, park, castle grounds) or on the land of a House at war or feud
with yours, a plaque at the bottom of the screen says whose it is and why you should not be there. People who see you report it, and
riders come: a knight or sergeant with a few men, who halt you (*"Halt. You are on the lands of Sir Hugh. State your business or be
gone."*). Answer them (the plaque's *Answer them*, or the card): **Leave** (they see you off the land — the plaque counts the seconds
and the way to its edge), **State your business** (a task or a job here, market day, your rank, your tongue or a bribe may let you
stay), **Pay the fine** (poaching: the game is taken), **Yield** (you are taken), or refuse, flee or come back — and they ride you
down to take you, or worse. At war they skip the talk: *Yield!*

### Taken prisoner

A prisoner is bound and led on foot to the lord's gaol, keep or lock-up and held there. The prisoner's card says by whom, since when
and what is asked, and the ways out: **wait for ransom** (your House or family pays if it can and cares), **pay it yourself**, **serve
the sentence** on the lord's works, **try to escape** at night (your Agility and Strength against the watch; caught, it goes worse) —
or live as someone else. Only an enemy soldier who killed the lord's men, at war, under a cruel lord risks the rope, and is warned.

### Walls, sieges and commanding men

A town at war shuts its gates at night (and always when an army is near), doubles the watch, sends the militia to the walls and, in
an assault, rings the bells and sends its people indoors. When you storm walls, archers and crossbowmen shoot from the wall-walks and
towers; the attackers bring a roofed **ram** to the gate (*Push the ram*), raise **ladders** (*Climb the ladder*; defenders throw them
down) and pour through **breaches** the engines make; a defender can man a place on the wall and shoot. If you command men, **4–7**
choose a group (all, foot, archers, horse), **8** opens the order wheel — follow me, hold, advance to, charge, loose at, form line,
shield wall or wedge, retreat — and a click on the ground or an enemy gives a move or an attack. **C** in battle opens the tactical view:
time slows to a quarter, the camera rises over the field, your groups are banners with their orders drawn on the ground; drag a banner
to move it, click an enemy to attack. On a horse a held attack at a canter or gallop couches the lance or spear; the sword cuts from
the saddle.

### Hands-on work

Any recipe can be tried at a workplace you may use — your own, your employer's, or a bench hired for the bout (the fee and the risk are
shown; a novice wastes material and may spoil the work, but learns). Each bout goes in steps with their own movement and sound — at
the forge *heat the bar, draw it out, quench, grind and finish* — named under the action bar. Animals: lead your own on a halter (**E**:
*Lead*, up to four), slaughter a pig, sheep, goat or fowl at home (a cow or ox at the slaughterhouse), butcher the carcass into meat,
hide and tallow, salt the meat to keep it. New works dig clay, fire bricks, boil salt, fell timber and mine iron, silver and gold where
the deposits are.

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
  the **blood** bar appears and the wound mark under your name turns red and throbs while you bleed. Open the character sheet (**Tab**, or the
  mark under your name) and its **Wounds** page to see where you are hurt and to **bind** the wounds (Medicine skill decides how well); rest, food, a healer and the
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

When your character dies the body falls and the death screen shows the life story and who may carry on: your family and
House first, then people near where you fell, and a search over everyone alive. Choose one: the camera glides to them
(or the screen fades) and a card says who you are now. The same works on purpose any time (*Living as anyone*, above).
The run ends only when you give it up, or when nobody at all is left (game over, records, Legacy gold).

## Developer parameters

All optional, on the URL of the game page (`?mode=world|gallery|chars|village|ui` selects the developer viewers instead of the game):

| Parameter | Effect |
|---|---|
| `autostart=1` | skip the menus and start a new run (`autostart=continue` resumes the saved run) |
| `seed=abc` `difficulty=squire\|knight\|lord\|king` `start=lord` | the continent and difficulty of an autostarted run; `start=lord` begins as the holder of a manor instead of a birth |
| `quality=low\|medium\|high` | override the saved quality setting |
| `time=0..1` `day=0..3` `season=0..3` | start at this time of day / day of the season / season |
| `debug=1` | overlay with frame timings, renderer and simulation statistics (and, with `profile=1`, the cost of the busiest systems) |
| `hud=1` | a plain-text stand-in for the HUD (prompt, action, journey, encounter choices, successor buttons) for builds without the real UI |
| `devzone=1` | stand-in villagers and a horse around your home, buildings that block you (for builds without the real agents module) |
| `fakeobjectives=1` | the UI's stand-in objectives (`src/ui/dev/mockObjectives.ts`: a first-day chain with real places, chores, goals, suggestions, a day summary) instead of the objectives module: for the UI gallery, the tests and looking at the tracker without playing a day |
| `shots=1` | keep the drawing buffer and expose `window.__game` / `window.__ui` for tools: `session`, `ready()`, `advance(seconds, input)` (the world moves by simulated seconds with the given input), `tick(seconds)` (whole frames with the real held keys, no drawing), `draw()`, `settle()`, `freeze(on)`, `frames(n)`, `killPlayer()` |

Tools (headless Chromium, software GL, so they are slow): `node tools/game-shots.mjs` plays through the
situations above and writes `docs/game/*.png`; `node tools/game-flow.mjs` clicks and types through the run
start, hotkeys, pause, the action wheel, the map, a journey with encounters, death and succession and
*Save and quit* / *Continue*, and checks what the game and the UI report at every step (including the dock, the hotkeys of the wave 3 pages, notices and hints). `node tools/game-shots.mjs hint help notice fight bow down command politics techs requests` takes the wave 4 screens (`docs/game/`).

## For other modules

- **Input** reaches the player as an `InputState` (`src/player/types.ts`), mapped by `src/app/inputLogic.ts`
  (pure) from the keys `KEYMAP.input`; `src/app/input.ts` is the DOM layer. The mouse (`MouseModes` in `inputLogic.ts`):
  the cursor is free; a left press and release without travel is a **click** (`player.pointerClick`), the right button
  held turns the camera (pointer lock only while held), and in mouse-look mode (weapon drawn, or the *Always mouse-look*
  setting) the buttons are `attack`/`block` and the first press only takes the pointer. Esc asks the input layer
  (`UiHost.releaseMouseLook`) before the UI uses it.
- **Pointer and click-to-act** (`src/player/pointer.ts`, `PlayerApi.pointerMove/pointerClick/hover/goTo`): the renderer is
  reached through a `PickPort` (`pick`, `ray`, optional `setHover`, built in `src/app/session.ts`). The thing under the
  cursor is found with the renderer's `pick` (people, animals, buildings, ground), `pickScatter` (trees and rocks from the
  world's scatter) and `zone.interactables` (strips, commons, the zone's own names), matched with
  `sim.actions.list(...)`'s default option, and published as a `HoverInfo` (name, sub-line, action, preview or reason,
  cursor kind, distance). `goTo({ target, x, z, label })` walks the body along `zone.nav.findPath` and performs the default
  option on arrival (`goStop` says how close); movement keys, E, Q, dodge, a conversation or a drawn weapon cancel it.
  `setDrawn` / `drawn` / `PlayerHud.drawn` are the weapon state; `fightOf(player) > 0` draws it by itself.
- **Hover outlines.** What the cursor is on is handed to the renderer's `GameRenderer.setHover(target | null)` (a
  `HoverMark`, which is a `TargetRef`: `building`, `strip`, `scatter`, `item`, `person`, `animal`; `parcel` is ignored) through
  `PickPort.setHover`, built in `src/app/session.ts`. The renderer outlines buildings, strips, trees and piles, rings people
  and animals and keeps their nameplate up. People and animals also get `draw.highlight = 1` (the contract's own signal).
- **Objectives** reach the UI as `GameServices.objectives` (`src/sim/objectives/types.ts`): the tracker, the "What now?" card,
  the journal and the day summary read `tracked()`, `list()`, `suggestions()`, `daySummary()` and call `track(id)`,
  `trackPerson(id)` and `trackPlace(target)`. The optional members are used when the module has them: `places()` (the
  journal's Places page, with the module's names), `found()` (which row "Find" is on, and the "Stop" button), `version()`
  (the tracker and the journal read the tasks only when it changes) and `intro()` (the first line of the intro card).
  Without them (an older module, a test double) the UI keeps a pin of its own (`src/ui/core/pins.ts`) and builds the lists
  itself (`src/ui/core/finder.ts` is the one place that decides). The HUD reads the markers from `SimView.worldMarkers()`
  (compass, minimap, edge arrows) and listens to the `objective` and `dayEnd` events; a spot marked twice is drawn once.
  When the body reaches what "Find" pointed at, the marker is cleared (`arrivedAt`).
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

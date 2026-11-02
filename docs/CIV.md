# Civilization pass — design

Owner's requests after the clarity pass, made into one design: quests you can trace from afar, switching into **anyone**,
enemy land that is defended, **builder mode** and **ruler mode**, realistic walking, hands-on production (slaughter, forge),
the knight's life (sword, bow, horse, couched lance), towns that defend their walls and troops you direct, rival towns that
grow on their own, and resources tied to places (metals in the mountains, clay by rivers…) that are the currencies of building
and advancement.

Decisions by the owner: **you can live as anyone, any time**; **builder and ruler modes follow your character's rank**
(a peasant builds on what he owns, a lord on his manor, a king in his realm) and one click — *Rule this town* — puts you into
the town's ruler. Everything else here is the design's call; numbers marked *(tune)* are starting values.

The world keeps its rules (SPEC §0 pillar 5, real medieval practice) and every system is shared by the player and the AI:
AI lords build, research, recruit and attack with the same APIs as the player's ruler.

---

## 1. Quests you can trace

- **"!" over anyone who has something for you** (a request, a job offer you were told about, the head of the household with
  today's chores, the giver of a story step): a gold exclamation mark floating over the head, bobbing gently, **visible from
  ~90 m** and kept at least ~14 px tall on screen; it shows through crowds and thin cover at reduced strength; people indoors
  are not drawn (the compass/minimap still show them).
- **"?" over the person to report to** when a task is ready to hand in (goods gathered, work done): silver question mark.
- The **compass** shows "!"/"?" icons for those within 150 m, the **minimap** shows them as dots, the hover card says what they
  want ("Maire wants 7 bundles of firewood"), and the journal lists *Who wants something of you* with **Find**.
- Data: `CharacterDrawItem.mark` gains `'turnin'`; the objectives module tells the zone both sets
  (`ZoneApi.setQuestMarks?`, superseding `setQuestGivers`, which stays as the 'quest' subset).

## 2. Living as anyone

- **Rule:** you may take over **any living person, any time** (SPEC §8 changed). The one you leave goes on with their life under
  the AI. On death you choose anyone to go on as (family and House are suggested first). A run ends only when you abandon it.
  Score: points keep accruing for the run; the birth-class multiplier is that of the person you are playing.
- **Ways in (all lead to the same confirmation card, skippable with a setting):**
  - **V** on the person under the cursor (or in front of you): *Live as Godwin*.
  - The action wheel on a person: *Live as …*.
  - Journal → People: *Live as*. Family panel: *Play as* (no longer limited).
  - Map: click a settlement → **People here** (the lord, reeve, priest, smiths, knights, soldiers, merchants, children…,
    searchable) → *Live as*.
  - **Rule this town** (settlement banner, map, ruler panel): live as the holder of the town's or manor's title (or the
    regent / steward if the holder cannot act).
- **Transition:** the camera glides from the old body to the new one when it is near (≤ 300 m), else a short fade; a card says
  who you are now (name, age, place, role, household, what they were doing) and the objectives refresh for this life (no
  tutorial; the current chores/job/goals of that person are set up at once).

## 3. Walking and running like people

- People **walk** 1.1–1.5 m/s (by age, health, load, build; elders and the hurt slower), **hurry** at most 1.3× (a brisk 1.9 m/s)
  and **jog/run** (run animation, 2.8–3.6 m/s) only when they are badly late and able (youths, messengers, soldiers) or in
  danger. The walk/run animation's cycle follows the ground speed (no sliding, no "speed-walking").
- **No visible warps or speed-ups:** nothing within sight moves faster than these speeds at 1×; trips are started early
  enough from realistic speeds; only trips entirely out of sight may complete off-screen (as now).
- The world runs at **1×** unless the player chooses 3×/8× (shown on the clock as *Fast-forward*), or sleeps/travels.
- Horses: walk 1.7, trot 3.5, canter 6, gallop 10 m/s. Carts at a walk.
- Acceptance: a measured day in a village (tool): ≥ 98 % of visible agent movement ≤ 2.0 m/s while walking, every faster
  movement uses the run clip, zero jumps > 1 m within sight.

## 4. Land, trespass and patrols

- **Land belongs to someone** (`src/sim/territory`): every point is classed — field strips, common pasture/meadow, garden/yard,
  the lord's **demesne** and closes, **forest/park** (the lord's game), town, castle grounds, road, water, **wild** (beyond any
  settlement's lands, nominally the crown's). A settlement's lands are its Voronoi cell clipped to a radius *(tune 2.5 km)*;
  the holder of its manor/town title (and their House) owns the lord's parts.
- **Trespass levels for a person at a point:** *none* (own land, common land of their own settlement, roads in peace,
  wild), *private* (a lord's demesne/park/castle grounds you have no business on; poaching), *hostile* (any land of a House at
  war or feud with yours, or whose lord is hostile to you personally — an outlaw, a known enemy).
- **Being seen:** people of the owning settlement who see a trespasser report it; on *hostile* land a garrison/watch that sees
  armed men or a known enemy reacts at once.
- **Patrol:** the lord's men come — a mounted **knight** or **sergeant** with 1–3 men from the castle, manor or nearest watch
  (summoned riding in from the edge of sight if no armed man is near). They ride up and speak:
  *"Halt. You are on the lands of Sir Hugh. State your business or be gone."*
  - **Leave** → they escort you to the edge of the land (you have ~60 s to be off it; they follow).
  - **Business** → a check (a request or job here, market day, your rank vs theirs, Charisma, a bribe) lets you stay.
  - **Pay the fine** (poaching: the game is taken and a fine paid).
  - **Yield** → you are **taken prisoner**.
  - **Refuse, flee into the land, or come back** → they **attack** (to wound or kill), and take you if you go down or yield.
  - At war they skip the talk for soldiers and nobles of the enemy: *"Yield!"* — or the fight.
- **Captivity:** bound and led (walking) to the gaol (castle keep, town gaol, the manor's lock-up). Options shown on a captivity
  card: **wait for ransom** (your House or family pays if it can and cares), **pay your own** (money you carry or have at home),
  **serve a sentence** (labour on the lord's works for N days), **try to escape** at night (Agility/Strength/lockpick vs the
  watch; caught = worse), or **live as someone else**. Execution only for enemy soldiers who killed the lord's men, at war, under
  a cruel lord (warned before). AI trespassers (poachers, bandits, enemy scouts) are handled the same way off-screen.

## 5. Builder mode (B)

- **Who builds what** (rank, SPEC §7): anyone — on their **own plot** (sheds, pens, a pigsty, a hen-house, a kiln, a new home on a
  bought or rented vacant plot); a master — their **workshop** (and its upgrade); the **household head** — the family's buildings;
  a **lord** (manor/town holder, or the steward/reeve on the lord's orders) — anywhere in the manor's lands, any building; a
  **baron and up** — anywhere in lands they hold, and **outposts in the wild**; the town council (mayor) — civic buildings of the
  town. What you may not build is shown and says why ("Only the lord of Dromore may raise a wall").
- **The mode:** B lifts the camera to a builder's view over your land (orbit, pan, zoom; the world keeps running); your
  buildable land is tinted, other land shaded; a **catalogue** (homes, farm, crafts, food, religion, civic, defence, resources)
  shows each building's **cost** (materials, labour, money), requirements (technique, terrain: river for a watermill, a
  rise for a windmill, a deposit for a mine/quarry/clay pit, the coast for salt pans) and what it does. Pick one → a **ghost**
  follows the cursor (rotate with Q/E or the wheel), green when it fits, red with the reason when not (slope, overlap, water,
  roads, strips, outside your land). Click → a **construction site** is staked out. Also: **upgrade** (next level),
  **repair**, **demolish** a building you own.
- **Costs** *(tune, content/construction.json)*: materials — timber, planks, stone, **bricks**, iron/nails, straw (thatch);
  **labour** in worker-days; money for hired hands. Examples: hovel 2 wd, cottage 8 wd + 20 planks + 30 straw, barn 14 wd,
  smithy 16 wd + 6 stone, watermill 60 wd (tech), stone church 900 wd + 400 stone, palisade segment 6 wd + 30 timber,
  curtain wall segment 120 wd + 160 stone (tech), stone keep 2000 wd + 2500 stone (tech).
- **How it gets built:** materials come from the builder's stores (household, the lord's household, the House's barns and
  warehouses in that settlement), then are **bought at the nearest market** automatically at its price (carted; it takes time),
  or produced by the builder's own people. Labour: household members the head sets to *Build*, hired labourers (a day's wage),
  the manor's **week-work** (a lord may direct a share of serfs' labour-service to his works), and **the player's own bouts**
  (stand at the site, press E or click: hammer/saw/lay stones; hero factor as other work). The site shows its progress in
  stages (pegs and lines → footings → frame/walls → roof → done; scaffolding for stone), workers are seen working there, a card
  says what it waits for ("Waiting for 12 planks — on the way from Dromore market, 1 day").
- **On completion** the building works like any other: homes take a household (the builder's, a new family moving in, or
  rented out), workshops create jobs and recipes, barns add storage, mills grind, walls and towers add defence (and wall
  stations, §9), churches pull in congregation and piety, schools and scriptoria take researchers (§6).
- **Outposts:** in the wild (or far parts of your lands) a baron or above can found a **named outpost** — a mining camp at an
  ore deposit, a quarry, a lumber camp, a fishing hamlet. It belongs to its parent settlement for the economy and is drawn and
  named on the map; families move in when it has homes.

## 6. Ruler mode (U)

Opens for anyone who rules something — the holder of a manor, town, barony, county or kingdom (and the steward/reeve for the
parts their office covers). It is a full-screen **seat of government** over the world (the game pauses while it is open unless the
player unpauses), with these pages:

1. **Overview** — your lands on a small map, treasury, stores, population, prosperity, forces, works in progress, research,
   threats, and the **news** of neighbours and rivals.
2. **Lands & works** — each settlement and outpost: buildings, what they make, jobs filled, stores; **construction queue**
   (priorities, cancel, open builder mode there).
3. **Fields & labour** — the field plan (which spring and winter crop each field of the demesne sows), the manor's dues and
   labour policy (rent, week-work, boon-work — the existing manor policy), the share of labour-service sent to works, and
   household tasks of your own household.
4. **Research** — the four branches of the House tree. A technique is researched by **assigning a person who could work it out**
   (a qualified craftsman, a clerk, a monk, a master) at a fitting place (smithy, workshop, school, scriptorium, guildhall,
   training yard) and **paying its cost** — each branch has its own **currencies** *(tune)*:
   - **Economy** — timber, bricks/stone, coin;
   - **Military** — iron, coin (horses for destriers, stone for keeps and walls);
   - **Kinship & Diplomacy** — coin and gifts (cloth, ale, fine goods);
   - **Knowledge & Belief** — vellum, candles, coin.
   Progress runs daily by the researcher's skill and the place; done, the researcher knows the technique (SPEC §17 —
   techniques live in people) and can teach it; the House commands it.
5. **Military** — forces (levy pool, retinue, garrison, mercenaries), **recruit and train**: archers (bows from stores, practice
   at the butts), men-at-arms (armour and arms from the armoury), mounted sergeants and knights (horses, armour; knights are
   dubbed by you), crossbowmen (tech), mercenaries (coin); upkeep in coin and food; **raise an army** and give it orders on the
   map (march, attack, raid, besiege, garrison, hold); **take the field yourself** — your character joins/leads the army.
6. **Trade** — what your lands produce and lack; the steward's **trade orders** (sell surplus grain at Dromore when the price is
   above X; buy 200 bricks at the best market; keep 300 bushels in store), caravans to other towns, tolls and market charters.
   Profit fills the treasury — the "gold" of the realm.
7. **Diplomacy** — the existing politics actions (letters, marriages, truces, alliances, war and peace, claims, demands).
8. **Rivals** — every House near you: strength, growth (new buildings, techniques, troops this year), stance, and a **threat**
   reading; their news ("Avenbourg's masons are raising a curtain wall", "Lord Ralph has hired 60 crossbowmen").

## 7. Resources, places and currencies

- **Deposits** (world generation): **iron ore** (uplands and mountains, on slopes), **stone** (rocky uplands, mountains, river
  cliffs), **clay** (river banks, marshes, lowlands by water → bricks at a kiln), **salt** (coastal marsh → salt pans),
  **silver** (rare, mountains), **gold** (very rare, mountain streams), plus forest (timber) and fertility (grain) maps and
  fishing waters. Each deposit has a position, a size and a richness, and is drawn in the world (ore-stained outcrops, clay
  banks, salt flats) and on the map.
- A settlement's **resource profile** is what lies in its lands: a mountain village can mine iron, a river town make bricks, a
  forest hamlet sell timber, a coastal one salt and fish. To get what your lands lack you **trade** for it, **conquer** a place
  that has it, or **found an outpost** where it lies (§5).
- New goods *(content/goods.json)*: `clay`, `brick`, `vellum`, `silver_ore`, `gold_ore`, `tallow`, `salt_meat`. Silver and gold
  ore sell high (the crown's mint and goldsmiths) and are the quickest coin for a realm that holds them.
- Production chains added: clay pit → clay → kiln → bricks; hides → tannery → vellum; carcass → butcher → meat, hide, tallow
  → candles; meat + salt → salt meat (keeps); ore + charcoal → bloomery → iron (exists) → smith → arms.

## 8. Hands-on production

- **Animals:** your animals can be **led** (E on your animal → *Lead*: it follows on a halter; several = a small drove) to the
  market, the pasture or the **slaughterhouse**. **Slaughter** a pig, sheep, goat or fowl at home (knife; a cow/ox at the
  slaughterhouse or with help), then **butcher** the carcass → meat (by the beast's weight), hide, tallow; **salt** it to keep;
  **cook** at a hearth → meals. Sell to the butcher. Skill: husbandry (butchery perks).
- **Crafting open to all:** any recipe can be **attempted** at a workplace you may use (your own, your employer's, a public
  forge/bench hired by the hour); quality follows skill, tool and perks — a novice wastes material and makes crude goods, can fail
  and learns from it; guild towns fine unlicensed sale of crafted goods (not making them). Recipe ladders stay for jobs and
  mastership.
- **Visible process:** a craft is a short sequence of steps with their own animation and sound — the forge: *heat the bar*
  (bellows, glowing iron), *draw out* (hammer at the anvil), *quench* (steam), *grind and hilt*; the sword appears in your hand.
  The butcher's block, the kiln (load, fire, draw), the tannery vats, the brewer's mash tun likewise.

## 9. Knights, horses, and war you can direct

- **Becoming a knight:** born to it (page → squire → dubbed at 18–21 with horse and armour), **valour** in battle (exists:
  sergeant → captain → knighted), **service** as a squire in a knight's household, or **dubbed by a ruler** (ruler mode can knight
  your own men — and you, if you rule, are dubbed by your liege). The dubbing is a scene: a vigil in the church, the accolade.
- **Horses:** buy at markets and fairs, stable at home; **F** mounts the horse in front of you or your own (hold F to call it);
  gaits walk/trot/canter/gallop; **G** draws the weapon: from the saddle the sword cuts, the **spear/lance** is couched for a charge
  (hold attack while galloping), a spear thrusts; dismount with F. Horses can be wounded and fall.
- **Towns defend themselves:** when a hostile army is near or the House is at war, gates shut at night (or always), the watch is
  doubled, the militia musters. Under assault: **archers and crossbowmen man the walls and towers** (stations along the wall
  tops) and **shoot at attackers in range**; defenders hold the gates; bells ring; the people go indoors. Attackers **batter the
  gate** (ram) or **scale the walls** (ladders at wall segments — fights on the wall-walk), siege engines (tech) break walls into
  **breaches** of rubble you can climb through. The siege's outcome is shared with the macro siege (it is the same siege).
- **Directing troops** (by command level: squad → company → army): select **all / foot / archers / horse** (keys 4–7 or click
  their banner), give orders — **follow me, hold here, advance to, charge, loose at, form line / shield wall / wedge, retreat** —
  by keys, the order wheel, or clicking ground and enemies; a **tactical view** (C in battle: the world slows, the camera rises
  over the field, groups shown as banners with their orders, drag to move them). AI commanders use the same orders.

## 10. Rival towns grow — urgency

- Every House's ruler (AI) runs the same loop as the player: **plan works** (homes when crowded, the missing workshop of a chain
  it has materials for, a mill by a river, a church for piety, **defence when threatened**: palisade → wall → towers →
  keep), **research** (by personality and need), **recruit and train**, **trade surplus**, **found outposts** at deposits, and
  attack the weak (existing politics AI). They pay the same costs and use the same labour.
- Their towns **visibly grow**: new buildings, walls, towers, outposts; their troops get better arms; the **news** reports what
  neighbours and rivals do, with a threat reading. A strong neighbour that out-builds you will come for your lands.

## 11. Order of building (waves)

- **Wave A — foundations (sim):** world deposits and territory; construction; realm (research, recruitment, trade orders, crop
  plan, rule-this-town, news); hands-on production in the economy; agents (realistic movement, workers at sites, new buildings
  used, led animals) and quest marks; switching rule.
- **Wave B — play and presentation:** builder and ruler UIs, switching UX, quest marks and deposits drawn, construction visuals
  and new models, patrols and captivity, war in the zone (wall defence, assaults, troop orders, tactical view, horses and
  knights), AI towns' growth and news.
- **Wave C — integration, balance (fullsim with building AI), performance, screenshots.**

# Millennia — Game Specification (v1.0, signed off)

> Working title **Millennia**. Note: an unrelated, already-released strategy game uses the
> same name (C Prompt Games / Paradox, 2024). Kept by owner's decision; revisit before any
> public release.

This document is the single source of truth for game design. `docs/ARCHITECTURE.md` covers
how it is built. Numbers marked *(tune)* are starting values to be balanced in testing.

---

## 0. Pillars

1. **You live one life at a time.** You are one person in a fully simulated society. Your
   character has exactly the same rules as every NPC: same health, same wounds, no buffs.
2. **Authority is earned.** What you can command depends on your rank and offices. As a
   peasant you control yourself; as a lord you run a manor; as king, the realm.
3. **Consequences are real.** Death is permanent. Rivals can out-grow, out-think and destroy
   you. There is no rollback.
4. **Grindy but never dull.** Long climbs, constant tangible progress, frequent action.
5. **Based on real life.** Society, law, money, farming and careers follow real medieval
   practice (England and its neighbours), simplified for play. See §4.

---

## 1. Game structure

### Levels
- The game is a set of **levels**, one civilization/era each, played separately.
  First build: **one level — Medieval**. Later levels (Tribal, Bronze, Classical, Age of
  Sail, Industrial, Modern, Solar System, Galaxy) reuse the same rules.
- **Levels never end.** You keep growing — expand, dominate other kingdoms, gain power —
  until your House is wiped out.

### Runs
- A **run** starts with a new continent (new seed) and a new character.
- A run ends only when **no eligible character is left** (see §8) or the player abandons it.
  Then you start a fresh run. Getting the crown is a milestone, not an ending.

### Saves
- Exactly **one copy of the current run**, overwritten continuously (every ~10 s and on
  every important event). No save slots, no manual save/load, no backups, no export.
- Quitting and returning continues exactly where you were. A death cannot be undone.
- The world **pauses while the game is closed** (no offline progress).

### Points, Legacy gold, stat upgrades
- **Points** are earned for advancement (§20). Per level, the game records your **best run
  score** and your **highest % of the continent ruled**. Point milestones unlock other
  levels (when they exist).
- **Legacy gold** is a per-level meta currency: points convert to gold as they are earned
  (*tune*: 1 gold per 10 points) and gold is kept forever, even when a run ends.
- **The only thing gold buys: base-stat upgrades for the starting character of the next
  run.** Bought fresh each run (consumed), not permanent.
  - Each stat can be raised in ranks; each rank costs more (*tune*: 100, 250, 450, 700, 1000…).
  - **Cap: 18** (top of the natural human range; the best NPCs are also ~18).
  - Upgrades raise the character's *potential* (genes) — children inherit normally.
- Points multiplier by birth class (harder births earn more): serf ×1.5, free peasant ×1.3,
  craftsman ×1.1, merchant ×1.0, gentry ×0.9, knightly ×0.8, baronial and above ×0.6 *(tune)*.

### Difficulty (chosen at run start)
| Tier | Legacy gold | Changes (all visible, never hidden AI cheats) |
|---|---|---|
| Squire | ×0.5 | Rivals less aggressive and slower to expand; fewer plagues/famines; gentler prices |
| Knight | ×1.0 | Standard |
| Lord | ×1.5 | Rivals start stronger; smarter coalitions; more frequent disasters |
| King | ×2.5 | Ruthless rivals; frequent famine/plague; heavy banditry; your family starts poorer |

---

## 2. Time

- **1 day = 60 s** at 1× *(tune — single constant)*. Daylight ≈ 40 s, night ≈ 20 s, varying
  by season. **1 season = 4 days; 1 year = 16 days** (≈16 min). People age one year per year,
  so one adult life ≈ 10–12 h of play and a run spans generations.
- **Action time:** while the player is in combat, a duel, a chase or a conversation, the
  calendar slows 20× (≈1 day per 20 min) so fights don't burn days. Movement stays real-time.
- **Speed:** 1×, 3×, 8×. Fast speeds are refused/cancelled when a hostile is within 150 m
  of the player. Pause is allowed (single-player).
- **Skips:** *Sleep until dawn*; *Wait until* (dawn / noon / dusk / crop ripe / market day).
- **Travel:** open the map, pick a destination; your party token follows roads on the map
  view at 8× until arrival or an **encounter** (bandits, patrols, travellers, wolves, an
  army), which drops you back to street level.
- **Growth & building times** *(tune)*: garden crops 2–3 days; field crops 3–5 days; crops
  only grow spring–autumn (several harvests a year); livestock breed in spring and mature
  within a year; hut 1 day; house 2–3 days; mill 4 days; stone keep a few seasons; curtain
  walls years.

---

## 3. The Medieval level — world

### Continent
- Procedurally generated each run (so repeated runs stay fresh) but **real-life based**:
  temperate Western-European landscape — lowland farmland, river valleys, oak/beech woods,
  pine uplands, heath, moor, fen and marsh, hills, a mountain range, cliffs, beaches, islands.
- **Size ≈ 16 × 16 km.** Seamless zoom from street level to the whole continent.
  Riding across ≈ 25 min at 1× (≈3 min with travel speed-up).
- **6–8 kingdoms**, each built on a real medieval culture (naming, dress, architecture,
  troop mix), with generated names in that culture's style:
  `anglo` (English-like, the default home), `franc` (French-like), `gael` (Scottish/Irish-like),
  `cymric` (Welsh-like), `norse` (Scandinavian-like), `teuton` (German-like).
  One shared Church across the continent (first build).
- **Settlements (~120):** villages (~70%), hamlets, market towns (walled), 1 capital city per
  kingdom, castles (wooden motte-and-bailey → stone keeps), abbeys/priories/nunneries.
  Villages have a church, a manor house, crofts (house + garden plot), open fields in strips
  around them, common pasture, woodland. Towns have markets, guilds, taverns, workshops.
- **Roads** connect settlements (tracks → roads → highways), with fords and bridges.
- **Population ≈ 10–15k** named people, all simulated (see Architecture for LOD).
- **Wildlife:** deer, boar, wolves, foxes, hares, birds; livestock in settlements (oxen,
  horses, sheep, pigs, cattle, poultry). Lords' hunting grounds where poaching is a crime.

---

## 4. Society — real-life basis

Verified historical anchors used by the design (simplified for play):

- **Three orders:** those who pray (clergy), those who fight (nobility), those who work.
  Peasants were roughly **80–90%** of people. Upward mobility existed but was limited.
  [Medievalists.net][three-orders]
- **Serfs (villeins)** were bound to their lord's manor and owed **week-work** (labour on the
  lord's land, typically 2–3 days a week, more in summer) and **boon-work** at harvest and
  ploughing. They paid **merchet** when a daughter married and **heriot** (best animal) at
  death. [Ole Miss glossary][manorial] [Merriam-Webster][weekwork]
- **Year and a day:** customary law held that a serf who lived in a chartered town for a
  year and a day unclaimed became free (inconsistently enforced). [Wikipedia][stadtluft]
- **Tithe:** a tenth of produce went to the parish church. [Herefordshire][tithe]
- **The manor's officers:** the **reeve** was a peasant chosen yearly (elected by villagers in
  some manors, appointed in others) to oversee labour services and manor sales; the
  **bailiff** collected rents and fines; the **steward** was the lord's chief manager, often
  over several manors. [Wikipedia][reeve]
- **Open fields & rotation:** three-field system — one field winter crop (wheat/rye), one
  spring crop (barley, oats, peas, beans), one fallow; peas and beans enrich the soil; oats
  mostly fodder; barley for bread and brewing. [Wikipedia][openfield]
- **Crafts:** apprenticeship ≈ **7 years** (varied by trade) → paid **journeyman** → a
  **masterpiece** judged by the guild's masters → **master** (own shop, own apprentices).
  Guild/town freedom by **apprenticeship, patrimony (born to a member) or redemption (a fee)**.
  [Fermilab][apprentice] [Lightmongers][freedom]
- **Knighthood:** page (~7–10), **squire from ~14**, knighted ~18–21; cost of horse and
  armour kept some squires from ever being knighted; commoners were sometimes knighted for
  valour. [World History Encyclopedia][knight]
- **Arms obligation:** freemen had to keep arms **according to their wealth** (England,
  Assize of Arms, 1181). [Wikipedia][assize]
- **Archery practice:** able-bodied men ordered to practise archery on Sundays and holidays
  (England, 1363; one account says ages 15–60). [Wikipedia][yeoman]
- **Ransom:** a captured knight could yield and pledge a ransom; the right belonged to the
  captor; ransoms were sometimes valued at about a year's income of the estate; common
  soldiers were often killed. [Hundred Years War site][ransom]
- **Inheritance:** with no sons, daughters inherited land jointly as **coheiresses**.
  [National Archives][coheiress]
- **Women's work:** women brewed most ale before the mid-14th century (**alewives**); the
  custom of London let a married woman with her own separate business trade as a
  **femme sole**; widows often continued a late husband's workshop (rules varied, tightening
  later); **abbesses** controlled manors and appointed bailiffs and officials.
  [Wikipedia][alewife] [History Jar][femmesole] [Medieval Marginalia][widow] [Boydell][abbess]
- **Money:** 12 pence (d) = 1 shilling (s); 20 s = 1 pound (£); the silver penny was the coin
  most people handled. Rough calibration: an unskilled labourer ≈ 1–3 d/day; ale ≈ 1–1.5 d a
  gallon; ~1 d bought two chickens; a linen shirt ≈ 12 d. [History Hit][money] [Datawrapper][prices]

[three-orders]: https://www.medievalists.net/2023/11/three-orders-medieval-society/
[manorial]: https://home.olemiss.edu/~tjray/medieval/manorial.htm
[weekwork]: https://www.merriam-webster.com/dictionary/week%20works
[stadtluft]: https://en.wikipedia.org/wiki/Stadtluft_macht_frei
[tithe]: https://htt.herefordshire.gov.uk/herefordshires-past/the-medieval-period/churches/the-growth-of-parish-churches/
[reeve]: https://en.wikipedia.org/wiki/Reeve_(England)
[openfield]: https://en.wikipedia.org/wiki/Open-field_system
[apprentice]: https://ed.fnal.gov/lincon/f97/projects/guildhall/guilds/apprenticeship.html
[freedom]: https://lightmongers.co.uk/?p=1340
[knight]: https://www.worldhistory.org/article/1240/how-to-become-a-medieval-knight
[assize]: https://en.wikipedia.org/wiki/Assize_of_Arms_of_1181
[yeoman]: https://en.wikipedia.org/wiki/Yeoman_archer
[ransom]: https://www.macs.hw.ac.uk/~hwloidl/hundredyearswar.com/Books/History/Some_Agi.htm
[coheiress]: https://blog.nationalarchives.gov.uk/what-is-a-coheiress-manors-moieties-and-english-inheritance-law/
[alewife]: https://en.wikipedia.org/wiki/Alewife_(trade)
[femmesole]: https://thehistoryjar.com/2021/05/07/femme-sole-a-woman-alone-and-looking-after-her-own-money/
[widow]: https://medievalmarginalia.substack.com/p/on-medieval-widowhood
[abbess]: https://boydellandbrewer.com/book/leadership-in-medieval-english-nunneries-9781843831501/
[money]: https://www.historyhit.com/money-in-medieval-england/
[prices]: https://www.datawrapper.de/blog/medieval-prices-wages

### Rank tiers (used for authority and switching)
| Tier | Rank | Examples |
|---|---|---|
| 1 | Unfree | serf/villein, cottar, servant |
| 2 | Commoner | free peasant, labourer, apprentice, journeyman, soldier, novice, nun, parish priest |
| 3 | Middling | yeoman, master craftsman, merchant, sergeant, alewife-tavern keeper, monk |
| 4 | Gentry | esquire, great merchant, alderman/mayor, steward, prior/prioress |
| 5 | Knight | landed knight (one manor) |
| 6 | Baron | baron (several manors, castle), abbot/abbess, bishop |
| 7 | Magnate | earl, duke |
| 8 | Royal | king/queen and the royal family |

Legal **estate** is tracked separately (unfree / free / clergy / noble).

### Money
- Internal unit: **pence**. Displayed as £ s d. Coins: silver pennies (gold coins appear via
  the tech tree late). Barter of goods is allowed everywhere.
- Prices/wages calibrated to the anchors above; other prices derive from labour time,
  materials and scarcity, kept in plausible ratios.

---

## 5. Characters

### Stats (1–20; population mean 10, s.d. 2.5, natural max 18)
| Stat | Affects |
|---|---|
| Strength | melee damage, carrying, drawing heavy bows, heavy labour speed |
| Endurance | health, stamina, fatigue, disease resistance |
| Agility | move speed (±10%), attack speed, dodge, riding |
| Intellect | learning speed, literacy, craft quality, management |
| Perception | archery accuracy, spotting, appraisal (trade), hunting |
| Charisma | persuasion, prices, opinion gain, leadership (morale), courtship |

- **Potential** (genes, inherited: mean of parents + variation) and **trained level**.
  Trained rises with use toward potential, falls with neglect (to ~85%). Children grow:
  ~65% of potential at 12 → 100% by ~18–20. Physical stats decline after ~40.
- Eating well speeds strength/endurance training; hunger blocks it.
- **Traits** (inherited or acquired): e.g. Quick learner, Strong back, Keen-eyed, Sickly,
  Brave, Craven, Pious, Greedy, Honest, Deceitful, Ambitious, Content, Hot-tempered, Patient,
  Comely, Scarred, Lame (from wounds).

### Skills (0–20, XP by use; perk choice at 5/10/15/20, pick 1 of 2)
Farming · Husbandry · Hunting · Woodcutting · Mining · Smithing · Carpentry · Masonry ·
Tailoring · Brewing & Cooking · Trade · Stewardship · Leadership · Persuasion · Melee ·
Archery · Riding · Medicine · Letters (literacy) · Stealth.
NPCs use the same skills and pick perks by personality.

### Needs
Hunger (food and drink), Rest, Warmth (clothes, shelter, fire), Health, Mood (comfort,
company, faith, status, grief). Unmet needs slow work, block training, and kill.

### Social
- **Prestige** (deeds), **Reputation** facets (honour, generosity, piety, cruelty, valour),
  **Opinions** of specific people (sparse), relationships (friend, rival, lover, spouse, kin).
- **Household** (who lives under one roof; head commands it) and **House** (family line plus
  sworn people: servants, retainers, vassals).
- NPC **ambitions**: marry X, get land, become master, become reeve, avenge, rise, flee.

---

## 6. A life

### Birth (run start)
- You are **born into a random family**, weighted like the period (mostly peasants; rare
  gentry/noble births). No choice of family. You **start at age 12**.
- Run start screen: difficulty → spend Legacy gold on stat upgrades → see your birth.

### Youth (12–14)
Help the household (labour builds strength/endurance), errands, minding animals, church,
holiday archery practice, wrestling and play, odd jobs for coin, parish lessons if lucky.
Stats, skills and reputation by 14 decide which doors open. Knight-born children start as
**pages** in a lord's household.

### Choosing a field (from 14; switching later is possible but slow)
| Field | Entry | Ladder | Sex rule (historical) |
|---|---|---|---|
| Land | family holding / hire as farmhand | labourer → tenant (strips) → free tenant → yeoman → gentry (buy a manor) | both; women hold land as widows/coheiresses |
| Husbandry | herd for the village / own beasts | herd boy/girl → shepherd → own flock → wool trader | both |
| Brewing | household brewing, sell surplus | alewife → alehouse → tavern keeper | both (women dominant early) |
| Craft (smith, carpenter, mason, tanner, weaver, tailor, baker, miller) | a master accepts you (reputation, kin, or premium fee) | apprentice (~7 yrs) → journeyman → masterpiece → master → guild warden | men; women in some trades (spinning/weaving), widows may run the workshop |
| Trade | shop boy / peddler; needs capital | peddler → merchant → great merchant → alderman → mayor | men; women as femme sole in towns |
| Arms | recruiter's test (§13); levy call-ups for all men 15–60 | levy → archer / man-at-arms → sergeant → captain → knighted | men only |
| Knighthood | knight-born page → squire at 14; commoners knighted for valour | squire → knight (~18–21) if horse + armour affordable or a patron pays | men only |
| Church | novice (letters or a gift) | novice → monk/priest → prior → abbot/bishop (top posts mostly for the well-born) | men: monk/priest; women: nun → prioress → abbess |
| Service | servant in a great household | servant → clerk (needs Letters) → bailiff → steward → royal official | both as servants; men for offices |
| Healing | learn from a healer / the infirmary | herbalist → healer → physician (Letters) | both; midwife women |
| Outlaw | poach, rob, flee | poacher → outlaw → band leader → pardon or rebel | both |
| Serf's escape | buy freedom, or flee to a town and stay a year and a day uncaught | — | both |

### Example loops (tangible progress)
- **Farmer:** work strips (plough, sow, weed, harvest) → thresh → mill (pay the lord's miller
  or own a mill) → sell → better sickle → oxen + plough → hire helpers → rent more strips →
  buy land → yeoman.
- **Smith's apprentice:** fetch, pump bellows, strike → simple items → journeyman wages →
  save for tools and a shop → masterpiece → master with apprentices.
- **Archer:** holiday practice → pass the test → paid service → battles, plunder, ransom shares
  → sergeant → captain → knighted for valour.

---

## 7. Earned authority — what you can command

| Position | Commands |
|---|---|
| Anyone | yourself, your belongings; hire helpers if you can pay and have work |
| Household head | household members' daily work, household purse and stores |
| Master / merchant | workshop or business: apprentices, journeymen, agents, caravans |
| Reeve (yearly office; elected or appointed per manor custom) | village field plan, labour-service rota, sale of manor produce |
| Bailiff / Steward (appointed) | rents, fines, labour services, manor court (steward), on the lord's behalf |
| Guild warden / alderman / mayor | guild rules and quality, town council votes, market rules |
| Sergeant / captain | your squad / company in battle |
| Landed knight | the manor: villagers' work, buildings, rents and dues, retinue, local justice |
| Baron | several manors, castle, vassal knights, levies, alliances and private war (if realm law allows) |
| Earl / Duke | county/duchy, vassal barons, seat on the king's council |
| King / Queen | the realm: laws, taxes, offices, war and peace, vassals |
| Abbot / Abbess / Bishop | church estates and their manors, scriptorium, school, infirmary |

When you don't hold power, NPCs in power make those decisions with their own personalities.
You influence them through opinion, favours, petitions, votes, bribes, marriage or force.
Management panels in the UI unlock exactly as authority is gained.

---

## 8. Death and switching

- Permadeath. On death: a death screen with the life story, then pick who to continue as.
- **Eligible to switch to (any time, or on death):** your **family** (blood or marriage), or a
  member of **your House** (household, sworn men, vassals) of **equal rank tier**.
- **Game over** when no eligible person remains. Final score recorded; Legacy gold kept.
- An NPC you leave reverts to AI and continues their life.

---

## 9. Economy

- **Goods (~30):** wheat, barley, oats, rye, peas/beans, flour, bread, ale, vegetables,
  cheese, meat, fish, salt, wool, cloth, linen, hides, leather, timber, planks, charcoal,
  stone, iron ore, iron, tools, weapons, armour, arrows, candles, horses/livestock.
- **Chains:** grain → mill → flour → bakery → bread; barley → malt → ale; wool → spinning →
  weaving → (fulling) → cloth → tailor → clothing; ore + charcoal → bloomery → iron → smith →
  tools/weapons/armour; hides → tanner → leather → saddles, belts, armour; timber → sawyer → planks.
- **Tool quality tiers** (crude, common, good, fine, masterwork) change speed and yield.
- **Markets:** each town/city has prices driven by supply and demand (NPC production and
  consumption); prices differ by place and season — profit for traders, risk on the roads.
- **Costs of living:** rent or buy housing (hovel → cottage → longhouse → townhouse → manor),
  clothes (warmth and status — NPCs treat you by how you dress), food, supplies, services
  (healer, lessons, apprenticeship premium, fines, bribes).
- **Obligations:** rents, week-work/boon-work for serfs, merchet, heriot, tithe, lord's mill
  fees, tolls, royal taxes (in wartime).
- **Wages, loans and debt.** Lending to lords is a merchant's path to power.

## 10. Farming
- Crofts (house + garden) for fast vegetables; **open-field strips** for field crops; common
  pasture; meadows for hay. Three-field rotation decides what each field grows each year;
  fallow and legumes restore fertility; manure from livestock helps.
- Tasks: plough (needs oxen/horse or hired team), harrow, sow, weed, harvest (sickle/scythe),
  bind, thresh, winnow, carry to barn/mill. Weather and season matter.
- Livestock: oxen (draught), horses (riding, carts), sheep (wool), pigs, cattle (milk),
  poultry. Breed in spring, need fodder in winter.

## 11. Crafts
Workshop buildings with upgrade levels; recipe-based production with skill-based quality;
commissions from NPCs; masterpiece test for mastership; apprentices do routine work.

## 12. Trade
Buy low, sell high between markets; carts, pack horses, caravans, warehouses; bandits and
tolls on the road; market and fair charters; guild membership; town council.

---

## 13. Military

- **Levy:** all men 15–60 can be called up when their lord goes to war, bringing arms
  according to wealth.
- **Recruiter's test for better posts** (stats 1–20, *tune*):
  | Role | Requirement |
  |---|---|
  | Archer | Strength 10 (war bow draw), Archery 3 |
  | Man-at-arms | Strength 12, Endurance 10, Melee 4, armour (own or issued) |
  | Mounted sergeant | the above + Riding 4 + own horse |
  | Knight | knighted, with horse and armour |
- Getting stronger: hard labour (ploughing, mining, smithing, hauling), training-yard drills,
  sparring, eating well. Holiday archery practice at the village butts.
- **Units:** levy spearmen, archers, crossbowmen (town militia / mercenaries), men-at-arms,
  mounted sergeants, knights; mercenary companies for hire.
- **Battles:** armies of dozens to hundreds; your rank decides what you command
  (yourself → squad → company → army). **Sieges:** ladders, rams, trebuchets (tech), mining,
  blockade/starvation. **Raids:** burn fields, steal herds, take captives.
- **Ransom:** downed nobles may yield; captor holds the ransom right (~a year's estate income).

## 14. Combat
- **One wound model for everyone:** hit locations (head, torso, arms, legs), armour coverage
  (padded, mail, coat of plates, plate), bleeding, broken bones, infection, crippling.
  One arrow can kill. Horses can be wounded or killed; riders fall (and get hurt).
- **Weapons:** dagger, sword, axe, mace, spear, bill, lance, longbow, crossbow; shields.
- **Player controls:** light/heavy attack, block, dodge; bows are aimed with the mouse but
  the character's skill/fatigue adds scatter; couched-lance charges; orders to commanded men.
- Wounds heal over days with care (healer, rest, food); some leave permanent traits.

## 15. Politics
- **Titles:** manor (knight) → barony → county (earl) → duchy → kingdom.
- **Vassalage:** oaths of fealty; service days, aids; protection; rebellion when unhappy and strong.
- **Succession:** sons by birth order; with no sons, daughters as coheiresses (lands divided,
  title to the eldest) *(design simplification)*; regency for heirs under 16.
- **Marriage:** arranged matches, dowries, alliances; merchet for serfs; marriage into other
  houses and realms; your character can marry into another House and live there.
- **Diplomacy ladder:** contact → truce → trade → marriage ties → alliance → union (realms
  merge via marriage/inheritance) — or conquest/vassalage.
- **Claims and wars:** claims by blood/marriage; private wars where realm law allows; royal
  wars; coalitions against whoever grows too strong; peasant revolts under harsh dues or famine.
- **Offices:** reeve (yearly), bailiff, steward, sheriff, marshal, chancellor, guild warden,
  alderman, mayor, prior, abbot, bishop. Elections where custom says (reeve in some manors,
  guild offices, abbots by their monks); appointments otherwise.

## 16. Rival AI
- Every House and institution runs on the same rules as you: economy, marriages, wars, tech.
- Personalities (ambitious, cautious, greedy, honourable, cruel, pious) drive goals.
- **Opportunistic and harsh:** they strike when you are weak (famine, plague, winter, war
  elsewhere, a child heir), target stores, herds and families, demand submission, ally
  against the strongest. No catch-up help, no grace period, no hidden bonuses.
- Bandits and outlaws prey on roads and villages.

## 17. Advancement
- **House trees (4 branches), unlocked by doing the activity; techniques live in people**
  (masters teach apprentices; scribes and the abbey's books preserve them):
  - **Economy:** heavy plough, improved rotation, watermill, windmill, fulling mill, market
    charter, fair charter, guild charter, wool trade, letters of credit.
  - **Military:** longbow drill, crossbows, coat of plates → plate armour, destriers,
    stone keep → curtain walls → concentric castle, trebuchet, paid retinues, bombards (late).
  - **Kinship & Diplomacy:** marriage pacts, wardship, oaths, alliance treaties, truces,
    heralds, tournaments, council of the realm.
  - **Knowledge & Belief:** parish school, scriptorium, cathedral school → university,
    herbal medicine, infirmary/hospital, written charters and records, accounting, printing (late).
- **Personal skills and perks** as in §5.

## 18. Lively NPCs
Daily routines (dawn rise, work, midday meal, work, evening at home/alehouse, sleep);
holy days (church, then archery practice and games); market days in towns (every 4 days);
yearly fairs; weddings, funerals, christenings, harvest festival, midsummer; gossip,
quarrels, courtship, children playing, pilgrims, peddlers, minstrels, beggars.
NPCs **ask the player for things** (help, work, loans, protection, marriage) and petition
whoever rules.

## 19. Events & disasters
Plague waves, famine after bad harvests, town fires, floods, drought, harsh winters with
wolves, bandit gangs, peasant revolts, succession crises, wars, tournaments, fairs, royal
progresses, marriages of state.

## 20. Points (score)
- Rank milestones (first time reaching each tier, *tune*): 50, 150, 400, 1 000, 2 500, 6 000,
  15 000, 40 000.
- Yearly holdings: land, people ruled, wealth, buildings, offices.
- Deeds: battles and wars won, ransoms, masterpieces, techs adopted, marriages into higher
  Houses, heirs reaching adulthood, generations survived.
- **% of the continent ruled** (land under your House's titles, including vassals).
- Multiplied by difficulty and birth class.

## 21. Pacing targets
- Something to deal with (event, encounter, decision, request) every **2–3 min**.
- Something to improve every **5–15 min** early, **20–40 min** later.
- Routine work is delegated as you rise; your character can be put on a routine (autopilot)
  while you manage. Climb to the crown ≈ **40–60 h**; the level continues beyond.

## 22. Controls
WASD move · mouse look (third person) · LMB attack/use · RMB block/aim · Shift sprint ·
Space dodge · E interact (talk, trade, work, pick up) · F mount/dismount · M map/travel ·
Tab character · C command · I inventory · J ledger/management (as authority allows) ·
1/2/3 speed · Z sleep/wait · Esc menu/pause.

## 23. UI screens
Main menu (Continue / New run / Records) · Run start (difficulty, stat shop, birth reveal) ·
HUD (time, needs, money, location, alerts) · Character sheet (stats, skills, perks, traits,
health, reputation) · Inventory & equipment · Dialogue · Trade · Family tree & House ·
Management (household, workshop, manor, barony, realm — by authority) · Map & travel ·
Chronicle (events log) · Death & succession · Game over & records.

## 24. Art direction (summary — detail in ARCHITECTURE.md §Art)
Stylized low-poly, flat-shaded, warm natural palette, readable silhouettes. Real medieval
vernacular: timber-frame and wattle-and-daub cottages with thatch, stone churches,
motte-and-bailey castles and stone keeps, walled towns. Seasons visibly change the land.
Characters are recognisable by rank through clothing.

## 25. Platform
Browser game (TypeScript + Three.js), desktop keyboard and mouse first. Later: Steam via an
Electron wrapper.

## 26. Out of scope for the first build
Other levels; online leaderboards; multiplayer; real-world map; audio beyond basic effects;
Steam packaging.

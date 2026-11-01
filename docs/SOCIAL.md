# Millennia — Social: conversations, opinions, relationships, courtship

Module `src/sim/social/**`, entry point `installSocial(sim): SocialApi` (contract in `src/sim/social/types.ts`),
dialogue content in `src/content/dialogue.json` and `src/content/dialogue/*.json`, tests in `tests/sim/social/`.
It serves SPEC §5 Social, §8 (switching needs family), §15 (marriage) and §18 Lively NPCs. Headless and
deterministic: no DOM, no three, no `Math.random` (outcomes use `sim.rng('social')`; wedding household
choices `sim.rng('social.wedding')`; wording uses hashes, see *Determinism*).

## 1. What it gives the other modules

| Who | Uses |
|---|---|
| UI (dialogue panel) | `start / choose / end / current`, `Conversation.{lines, options, opinion, opinionDelta, mood, relation, page, pageLabel}`, `relations`, `relationLabel`, `courtship`; events `conversation`, `opinion`, `notify` |
| Player controller | the `social` ActionProvider (Talk, Greet, Wrestle, Play, Pray, Hear Mass, Confess) via `sim.actions`; holds/releases the NPC agent on `conversation` events |
| Agents | `bark(speaker, situation, listener?)` for speech bubbles; `setHooks({ awakeHook })` |
| Economy | `registerTopic` ("Ask for work", "Trade…"), `adjustOpinion`, `setHooks({ giveHook, itemInfoHook, priceTipsHook, dressTierHook, apprenticeHook })`; listens to `marriage` (merchet) |
| Politics (later) | `registerTopic`, `arrangeMatch`, `matchCandidates`, `adjustOpinion`, `propose` |

```ts
const social = installSocial(sim);               // first, before economy / agents / player / ui
social.registerTopic({
  id: 'economy',
  options(conv, out) { out.push({ id: 'work', provider: '', label: 'Ask for work', kind: 'work', enabled: true, priority: 90 }); },
  choose(conv, option) { return { lines: [{ speaker: conv.with, text: 'Aye, the mill wants hands.' }], opinion: 1, ui: { panel: 'jobs', settlement: 3 } }; },
});
social.setHooks({
  giveHook: (from, to, key, qty) => economy.give(from, to, key as never, qty),   // gifts of goods and money
  itemInfoHook: (key) => ({ name: 'sack of wheat', value: 20 }),                 // names and prices in the gift list
  priceTipsHook: (settlement) => [{ good: 'wheat', trend: 0.4 }],                // market gossip
  awakeHook: (person) => zone.agent(person) !== null,                            // agents know who is up
  dressTierHook: (person) => 3,                                                  // what clothes suggest to strangers
  apprenticeHook: (youth, master, dryRun) => ({ ok: true, premium: 240 }),       // economy: quote (dryRun) or enter the indenture
});
```

Providers appear on the **root page** of a conversation only (built-in menus replace the list while a page is
open). `registerTopic` returns an unregister function; a provider that throws is skipped, not fatal.

## 2. Conversations

**Lifecycle.** `start(actor, other)` refuses (`{ ok: false, reason }`) when the other is dead, asleep, an infant
(< 3), too ill to speak, the same person, hostile (opinion ≤ −45, the reason is their spoken refusal), or a
conversation is already open (the same pair gets the open conversation back). Otherwise it turns on action time
(`dispatch({type:'setActionTime', on:true})`, which drops speed to 1×), emits `conversation {phase:'start'}`,
opens with the NPC's greeting — by kinship, opinion, rank, time of day, culture and trade, and a second remark
when they owe or are owed, bear a grudge, remember a kindness, or (one time in three or so) dream aloud of their
ambition — and lists the options. `end` / "Farewell" / a death of either person / a switch of character / game over
close it, turn action time off and emit `conversation {phase:'end'}`. A save mid-conversation loads with no
conversation and action time cleared when social installs.

*Asleep:* by default people are asleep at night (`dayPart === 'night'`) unless on watch (soldiers, monks, healers,
outlaws, beggars…); `setHooks({ awakeHook })` overrides this with what the agents really show.

**Choosing.** `choose(id, optionId)` runs the provider, appends its lines (your own spoken line first, then
theirs), applies `opinion` (as a remembered deed with `reason`) and `mood`, opens `ui` if asked, and rebuilds the
options. Unknown or disabled options change nothing. The same `Conversation` object is mutated and returned;
`options` is replaced each time. If the other's opinion falls to −40 or below during a choice, they cut the
talk short (`cutoff` line, conversation ends). `Conversation.opinion` is *their* opinion of you,
`opinionDelta` how far it moved since the start, `mood` is `friendly ≥ 20 · neutral ≥ −8 · wary ≥ −30 · hostile`.

**Pages.** The built-in topics form a small menu so the list never gets long:

| Root entry (kind) | Page `id` | Contents |
|---|---|---|
| Pass the time of day… (chat) | `chat` | weather · harvest · prices · after their family · the lord · the Church · their work · what they hope for |
| What news? (news) | — | up to two gossip items they have, never the same one twice |
| Ask about… (ask) | `ask` | up to five people (lord, priest, reeve, those they hold opinions of) · three nearby places · who there is to marry |
| Speak your mind… (persuade) | `say` | flatter · boast · insult · threaten · apologise |
| Ask a favour… (favour) | `favour` | loan · a meal · a word put in with someone · lessons in letters (priest, clerk…) |
| Give a gift… (gift) | `gift` | up to three round sums and three goods from your inventory |
| Court … (court) | `court` | compliment · walk out · love token · ask how they feel (their tastes) |
| Ask … to marry you (marry) | — | when a courtship is 50% won; always askable, they say what stands in the way |
| Family matters… (family) | `family` | consent (blessing, hand, the lord's leave) · apprenticeship · fostering · a match arranged by your parent · propose a match for your ward · talk over whom to marry |
| Repay what you owe | — | at the root while you owe this person |
| Farewell (leave) | — | always last |

Options are sorted enabled first, then by `priority` (higher first), `leave` last. Disabled options keep a
`reason`. Options that are checks carry `chance` — **exactly the probability rolled**.

*Priority scale.* The root entries sit on the 0–10 scale the economy's topics use (theirs run 2–9), so a trade or
a job offer interleaves with them rather than always leading or trailing: propose 10 · repay 9.8 · chat 8.8 ·
news 7.8 · ask 6.5 · court 6.3 · family 5.5 · say 5 · favour 4.5 · gift 3.5 · farewell −100. Entries inside a page
use 10–80 among themselves.

*Long talks.* A conversation keeps its latest 200 lines (the oldest 40 beyond that are dropped at once, so the
panel redraws rarely).

**Chances.** Every check is `base + 0.004·their opinion of you + 0.02·(Charisma − 10) + 0.012·Persuasion level
+ rank term + trait terms + extras`, clamped to 3 %…97 % (`chance.ts`). The rank term costs `0.04` per tier when
the other stands above you and pays `0.015` per tier when below, unless the topic says otherwise. Per topic:

| Topic | Base | Notable terms |
|---|---|---|
| Flatter | 0.50 | ambitious +0.12, honest −0.12, deceitful −0.08, greedy +0.05; your deceitful +0.08, comely +0.05 |
| Boast | 0.30 + 0.40·strength of your best true claim | skill, stat ≥ 13, rank, office, wealth, valour, generosity, piety, fame; rivals −0.20 |
| Threaten | 0.28 | Leadership 0.015/level, +0.03·(your STR − theirs), their craven +0.20, brave −0.15, child +0.20, above you −0.12/tier |
| Apologise | 0.50 | only after a wrong; patient +0.15, hot-tempered −0.12, −0.01 per point of grievance |
| Loan | 0.22 | opinion 0.006/pt, kin +0.25, their generosity, greedy −0.15, bigger loans harder; none while you owe them |
| Meal / vouch / lessons | 0.32 / 0.25 / 0.45 | opinion, kin or household +0.30 (meal), their opinion of the third party (vouch), Intellect (lessons) |
| Courting gestures | 0.50 / 0.40 / 0.62 | Charisma 0.025/pt, comely +0.08, rank gap −0.05/tier, age gap, their **tastes** (§5) |
| Consent | 0.40 parent · 0.58 lord | opinion of you and of the match, rank and means of the match, ambition and greed, their own child's feeling |
| Proposal | 0.55 | opinion 0.006/pt, progress, rank, tastes |

**Outcomes** (all through `sim/skills.ts` and the reputation facets of `Person.rep`):

* Pleasant talk wins goodwill — a topic's base gain (0.9…1.8) × how much the other cares about it (a farmer on
  the harvest ×1.6, a pious soul on the Church ×1.8, parents on family ×1.5…) × `max(0, 1 − 0.22·topics used with
  them today)`; after five topics in a day they are "tired". The count is saved.
* Flattery +3 + 0.25·(Cha − 10) (×1.3 ambitious, ×0.8 content) / failure −2 (honest −3); Persuasion XP 8/4.
* Insult −8 (×1.3 if it hits a real flaw, ×1.4 hot-tempered, ×0.7 patient, + 25 % per tier above you), honour −1;
  a noble has you thrown out. Threat success −7 and their ready money (12 % of what someone of their rank typically carries, at least 2d), failure
  −10 (−18 and the end of the talk against a social superior); cruelty +2, honour −1; Leadership XP.
* Gifts: `2.2·ln(1 + value/scale)` (scale = ¼ of a typical purse of their rank; greedy ×1.4, beggars ×1.5),
  halved when they distrust you, ×`max(0, 1 − 0.45·gifts today)`. Generosity +1 for alms of ≥ 3d to the poor
  (once a day); alms of ≥ 24d are talked of.
* Loans become **debts** (saved; the lender's regard sours −1.5 every 4 days past day 8; repaying in full:
  honour +1, opinion +4). Lessons: +40 XP in Letters, once a day per teacher.
* Apology success restores 60 % of the grievance (4…18) and forgives the bad memories.

## 3. Opinions (SPEC §5)

`opinion(of, about)` ∈ −100…100 = **base** (recomputed from the world every time) + **memory**
(`Person.opinions[about]`, sparse, ≤ `OPINION_CAP` = 16 entries, weakest evicted first).

Base, in points (`opinion.ts`, `tuning.ts`), clamped to −45…65:

| Part | Value |
|---|---|
| Kinship (what `about` is to `of`) | wife/husband 30 · son/daughter 25 · mother 22 · father 20 · brother/sister 14 · grandchild 14 · grandparent 12 · nephew/niece 10 · uncle/aunt 9 · cousin 6 · in-laws 5–6 |
| Same household | +5 (family), +2 (service, garrison, lord) |
| Same settlement | +3 village (≤ 140 people), +1.5 town, +0.5 city; elsewhere −2, other culture −4 more, other kingdom −2 more |
| Rank | respect +1.5 per tier above (max +6); a serf of the lord of his manor −4; the gentry and above look down −2 per tier (max −8) |
| Reputation | `0.2·honour + 0.12·generosity + 0.1·piety − 0.22·cruelty + 0.1·valour`, weighted by what the observer values (honest ×1.6 honour, greedy ×1.5 generosity, pious ×2.5 piety, brave ×1.8 valour; hot-tempered ×0.6 / patient ×1.3 cruelty), within ±22 |
| Prestige | +0.04 per point (max 6), unless the subject stands more than a tier below the observer |
| Temperament | like traits warm (pious+pious +4, honest+honest +3 …), opposites chill (honest/deceitful −4 …), within ±8 |
| Looks | comely +3 (adults of the other sex), else +1; scarred −1 |

`explain(of, about)` returns the parts. Memory moves with `adjustOpinion(of, about, delta, reason)`
(rounded to 0.1). Deeds of ≥ 2 points by or towards the player are written to `state.ext['social'].mem`
(who, whom, day, reason code, delta — at most 5 per pair, 140 in all) so people can say "I've not forgotten how
you insulted me"; changes towards the player of ≥ 0.5 emit an `opinion` event with a readable reason
("your gift"). `reason` is a short code or free text: the tables in `dialogue.json` (`tables.reasons`) say how it reads in
the pop-up (`ui`), how an NPC words the memory (`mem`: "…you took the post I offered") and whether it was a good deed; a
reason with no entry is shown as given in the pop-up and never brought up by the NPC, so other modules may pass their own
words (the economy's free-text reasons "hired", "took the post", "left before the term", "worked the lord's land",
"bought freedom", "ran away", "a gift" and "ran an errand" already have entries). Memory fades ×0.944 every four days (half-life three game years), each settlement on its own hour
of its own day (`social.hourly`), and entries about the forgotten dead are dropped.

**Thresholds:** devoted ≥ 40 · warm ≥ 14 · neutral ≥ −8 · cold · hostile < −30; friends ≥ 28 (both ways);
rivals ≤ −28; enemies ≤ −50; **refuses to talk ≤ −45**.

**Reputation deeds:** generosity +1 (alms), cruelty +1/+2 (threats, insulting inferiors), piety +1 (prayer, once
a day), +2 (Mass), +1 (confession), honour +1 (repaying, apology, marriage) / −1 (insult, threat); missing Mass
on a holy day: piety −1 and the priest's regard −1.5 (the parish notices; every fourth holy day kept: piety +1).

## 4. Relationships

`relations(person)` lists up to 40 living people: spouse, betrothed, lover, parent, child, sibling, kin (anyone
`kinshipLabel` names), in-law, lord/vassal (holder of the settlement's title, or of the title one's own is held
from), master/apprentice (craft households with sworn apprentices), employer/employee, friend/rival/enemy (opinion
thresholds) and up to four neighbours (households within 40 m), each with both opinions and a label. Closest ties first.

`relationLabel(viewer, other)`: "your father", "your lord", "your master", "your friend", "your betrothed", else
by office or trade — "Agnes, the alewife", "the reeve", "a stranger from Ashby". For anyone but the player it says
"Wat's apprentice". The conversation header uses the same words without the name.

Address (`speech.ts`): kin terms; clergy (Father, Brother, Sister, my lord abbot…); upwards by perceived standing
(Sire · my lord · Sir {first} · master/mistress · goodman/goodwife); peers by first name or "friend";
downwards (lad, lass, fellow, my son from a priest); children to adult strangers say "sir/mistress". Each culture
overrides some forms (`franc` messire, `teuton` Herr/Frau/Meister …). Strangers are judged by **dress**: perceived
standing is the rank shaded ±0.7 by how rich or ragged the clothes look (`wealthShade`), or `dressTierHook`.

## 5. Courtship and marriage (SPEC §15)

Macro `life.ts` never marries the player; this module does, and reuses `life.marryPeople` for the wedding itself
(household, House, rank and home follow the usual patrilocal custom: the wife takes her husband's House and
standing; a new household is founded, or she joins his, as the macro matcher would).

**Who.** A man and a woman (the sim core has no other custom), unmarried, not in orders, not captive, not close
kin (`isCloseKin`), both ≥ 14 to court and ≥ 16 to wed, within 2 rank tiers (never noble with unfree), the man at
most 22 years older or 8 younger. `canCourt / canWed` give a reason for every refusal. A betrothal to another blocks.

**Courting.** Gestures — compliment (+0.05…0.08), walk out (+0.08), love token (+0.10, costs ~3 % of your money,
3…48d) — and ordinary pleasant talk (+0.012) raise progress 0…1. At most +0.22 a day; at most 4 gestures a day;
beyond 0.6 their heart must be won (opinion ≥ 26); neglected for 6 days it cools 0.02 a day; a rebuff −0.02.
**Tastes:** "ask how they feel" tells you how they stand and what they look for. An ambitious heart wants
standing, a pious one piety, an honest one honour, a content one kindness, a greedy one means, a brave one valour,
a deceitful one wit; a craven or hot-tempered one fears a cruel hand. Meeting a taste is worth +0.06…0.10 on every
check, missing it −0.06…0.15 (`CourtshipEngine.compatibility`). With honest dice a diligent suitor of ordinary
charm wins an ordinary villager in about 11 game days; an ambitious partner of higher rank takes about a month
(`tests/sim/social/courtship-odds.ts`).

**Consent.** Needed from: the father (else mother, else household head) of anyone under 18; the father of any noble
(tier ≥ 5) while he lives; the lord of the manor/town for any unfree party (merchet is the economy's business — it
listens to `marriage`). Asked in conversation ("Ask … for their blessing", "Ask for …'s hand", "Petition … for leave to
wed …"); the answer rolls the chance shown; a refusal means 8 days' wait. `courtship(a, b)` shows who is still
outstanding (`needsConsentFrom`) and who has agreed (`consentGiven`).

**Proposal.** `propose(a, b)`: needs progress 1, every consent and both ≥ 16; rolls 0.55 + tastes + 0.15·progress +
0.006·opinion + rank terms; refusal costs 0.3 progress and −3 opinion. Success weds at once: `marriage` event, chronicle
entry, honour +1, mutual opinion +10, "Married into a higher House" points (SPEC §20) when the spouse stood higher.

**Arranged matches.** `arrangeMatch(head, ward, partner)`: `head` must head the ward's household or be a living
parent. The bride's household pays a dowry of up to 35 % of its purse towards what the groom's rank expects
(10 % of a typical purse of his tier, ≥ 12d). The deciding head (the partner's household head, or the partner)
accepts with 0.5 + 0.005·their opinion of the proposer + 0.003·(the pair's opinions) + a rank term (marrying up
+0.07/tier, down −0.12/tier; ambitious ×1.6) + a dowry term (±0.22, greedy ×1.6) + the ward's name and prestige. The
reason says why not ("They look for a dowry of about 25d."). Adult pair: wed at once. A ward under 16 (12 for
commoners, 7 for tier ≥ 5) is **betrothed** (saved) and wed on the first holy day after both turn 16.
`matchCandidates(person, n)` ranks unmarried eligible people of the same and nearby settlements by age fit, rank,
place, mutual opinion, charm and looks.

**Fertility.** A married player's family has children through the normal `life.ts` rules; `tests/sim/social/courtship.test.ts`
verifies a couple (player male or female) has a child within twelve years in every tested seed.

**Limits.** Opposite-sex only (as the sim core). A betrothed ward could be matched elsewhere by the macro matcher
first (rare; the betrothal then lapses).

## 6. Social actions (`social` ActionProvider)

| id | On | Range | Time | Effect |
|---|---|---|---|---|
| `social.talk` (default, priority 60) | person | 4 m | instant | opens the conversation; outcome `ui: dialogue` |
| `social.greet` | person | 8 m | 1.2 s, `wave` | their reply as a message; +0.6 opinion the first time that day, if you have not yet talked |
| `social.wrestle` | same-sex peer 9–45, ≤ 1 tier apart | 3 m | 8 s, `work_lift` | STR +0.05–0.07, AGI +0.03 via `trainStat`; +2/+3 their opinion; valour +1 first win a day; win chance 0.5 + 0.035·ΔSTR + 0.02·ΔAGI + 0.01·Δmelee |
| `social.play` | youths and children | 3 m | 10 s, `dodge` | AGI +0.03, END +0.02, mood +0.05 both, +1.5 opinion, Leadership XP for an elder child |
| `social.pray` | church, chapel, abbey church, cathedral | 14 m | 6 s, `pray` | mood +0.04; piety +1 once a day |
| `social.mass` | same, holy-day mornings with a priest (abbeys and cathedrals daily), once a day | 14 m | 12 s | piety +2, mood +0.10, priest's regard +1.5, attendance noted |
| `social.confess` | a priest or monk | 3 m | 8 s, `kneel` | mood +0.05…0.15, piety +1, once in 4 days |

## 7. Barks

`bark(speaker, situation, listener?)` returns a line for a speech bubble or `null` — usually null. A speaker is
silent for 9 s after speaking (`BARK.cooldownDays`, 9 / `DAY_SECONDS` of a day); at most 3 non-urgent barks street-wide per 3 s; each
situation has its own chance per ten game-minutes (`greet` 55 %, `idle` 8 %, `fear` 95 %…); `fear`, `bump`, `angry`
ignore the street-wide limit. `greet` is upgraded to `greet_kin` / `greet_superior` by kinship and standing.
Every situation has ≥ 8 lines that suit anyone plus conditional ones (culture, rank, age, sex, trade, trait, weather,
holy day, market). Dead people and infants never speak. Costs ~1 µs when silent, ~13 µs when speaking.

## 8. News and rumour

`news(settlement, limit = 5)` returns gossip lines: births, burials, weddings, women with child, the gravely
ill, a new reeve (read from the world — nothing is recorded), heirs taking titles, deeds of the player
(alms ≥ 24d, insults, threats, weddings — a few small rumours in the save), and the economy's market gossip (`priceTipsHook`).
An item is heard in another settlement `distance / 900` days after it happened (≈ 5 days to a neighbour 4.5 km
away), up to 6.5 km; items stale after 10 days. Never more than half of one kind; the same call gives the same
text (wording is seeded by the item). "What news?" from an NPC tells up to two items you have not heard
(remembered in `told`).

## 9. Dialogue content

Everything an NPC says lives in JSON; code only picks and fills in.

* `src/content/dialogue.json` → `tables`: forms of address (`default`, then per culture), ambition phrases, deed
  reasons (what the opinion pop-up says, how an NPC words the memory), adjectives for describing people.
* `src/content/dialogue/{greetings,smalltalk,ask,news,manners,favours,romance,family,actions,barks}.json`: **pools**.
  A pool id is the key path (`chat.weather.reply`). A variant is a string or `{ "t": text, "tone": …, "if": cond, "w": weight }`.
* **Selection:** variants whose `if` holds are eligible; each matched key makes a variant 1.5× likelier (specific beats
  generic); the last variant used by this speaker is excluded and recent ones damped; the choice is a hash of speaker,
  listener, pool and a counter (no RNG). News uses a seed so it does not flicker.
* **Conditions** (`Cond`, all must hold; arrays mean any-of): `culture sex age rank rel op part season weather role
  trait not tag notTag place lsex lage` — speaker's culture, sex, age band (child < 12 · youth · adult < 50 · elder),
  rank band (low 1–2 · mid 3–4 · high 5+), `rel` (up/down/peer: the listener is above/below/level with the speaker), `op`
  (their opinion of the listener: hostile · cold · neutral · warm · devoted), time of day, season (0–3), weather (fair
  cloudy rain snow fog wind cold hot), `role` (career id, field, serf, noble, clergy, reeve, lord), traits, situation
  `tag`s (kin spouse parent child sibling stranger friend fond hostile sweetheart betrothed debtor creditor grudge
  favoured holy market night hungry tired unhappy cheerful married widowed beggar ambition_<id>, plus those a topic adds),
  and the settlement kind.
* **Placeholders** `{first}` (the listener), `{addr}`, `{named}`, `{kin}`, `{place}`, `{lord}`, `{priest}`, `{reeve}`,
  `{season}`, `{part}`, `{daygreet}`, `{weather}`, `{crop}`, `{trade}`, `{ltrade}`, `{spouse}`, `{ambition}`, `{self}` and
  the topic's own (`{money}`, `{third}`, `{names}`…); `{Capital}` capitalises. Unknown placeholders are caught by tests.
* **Adding lines:** append to the pool; run `npx vitest run tests/sim/social/content.test.ts` (known keys and values,
  placeholders, no blanks or duplicates, ≥ 8 free-for-all barks) and `npx tsx tests/sim/social/audit.ts` (per-pool
  count, how many variants a speaker really chooses from, how often fewer than three fit — the cue to add more).

## 10. Saved state and determinism

* Everything lives in existing fields (`Person.opinions`, `.rep`, `.money`, `.inventory`, `Household.purse`,
  `House.sworn`…) plus **one** ext section `state.ext['social']` (created on first use; installing changes nothing),
  rewritten whole, kept under ~20 KB: `mem` (memories), `talk` (this-week chat/gift/court counters), `court`
  (courtships and betrothals), `debts`, `rum` (rumours), `told`, `mass` (the player's devotions).
* Transient, never saved: the open conversation, bark cooldowns, recent wording.
* `tests/sim/social/persistence.test.ts`: save → `Simulation.load` → continue (nine days, then a conversation with
  rolled outcomes) gives the same `stateHash()` as never saving.
* Wording uses hashes, so it never consumes or disturbs a random stream; outcomes use `sim.rng('social')`.

## 11. Performance (full-size mock continent, 11 130 people; `npx tsx tests/sim/social/perf.ts`)

| | mean | p99 |
|---|---|---|
| `social.hourly` (decay, weddings) | 0.10–0.12 ms | see below |
| `social.daily` | 0.10 ms | max 0.9–1.3 ms |
| `opinion(a, b)` | 4 µs | 13 µs |
| `relations(person)` | 0.14 ms | 0.9 ms |
| `start` + `end` | 0.14 ms | 0.9 ms |
| `start`, small talk, `end` | 0.3 ms | 1.4 ms |
| `bark` (silent / speaking) | 1 µs / 11 µs | 14 / 45 µs |
| `news(settlement, 5)` | 0.11 ms | 1.0 ms |
| `matchCandidates` | 0.4 ms | 2.4 ms |
| `actions.list` on a person | 15 µs | 55 µs |

No per-step system; nothing runs per frame. The hourly system decays one settlement per hour of its own day
(every fourth day) and the weddings of holy-day mornings; the largest settlement of this world has 366 people and
its decay takes 0.1–0.3 ms warm, 0.9 ms on the very first call, so one call is bounded by the size of one
settlement. Whole-run profiles (`perf.ts` prints the maximum of the 768 hourly calls) sometimes show a single call of
5–15 ms on an ordinary 25–100-person settlement; which call it is changes from run to run and a forced collection
before the call does not remove it, which points to scheduling noise rather than the algorithm: the other builders' jobs
were sharing four cores (load average ≈ 8) while this was measured. Re-measure on a quiet machine before trusting that maximum.

## 12. Tests and tools

`npx vitest run tests/sim/social` (≈ 110 tests): conversation flow and action time, gating and chances, opinion base /
memory / decay, relations and labels, topics (gifts, loans, favours, speaking your mind, asking, news), courtship
→ consent → proposal → wedding with consistent indexes (`state.rebuildIndexes()` equals the live ones), arranged
matches and betrothals, fostering and apprenticeship, fertility of a married player, barks and rate limits, news
travel, actions, persistence, and the content itself.
Tools (not run by vitest; run with `npx tsx`): `tests/sim/social/demo.ts` (read real conversations),
`demo-wedding.ts [seed]` (a whole courtship told in lines — compliments, tokens, the father's blessing, the proposal,
the household afterwards; dice loaded in the suitor's favour), `audit.ts` (content), `perf.ts`, `courtship-odds.ts`
(how likely a courtship is to succeed with honest dice).

## 13. Known gaps

* No crime/justice: threatening or insulting a lord ends the talk and sours him, but nobody is arrested yet.
* Conversations are one-to-one with the player; NPC–NPC talk is not modelled (their opinions of each other come from
  the base and from what the player does).
* The player's dress is rank shaded by wealth until the economy supplies clothing through `dressTierHook`.
* Fostering is only into a household of the same settlement; a household move across settlements would need the
  player controller to re-place the body.
* Opposite-sex marriage only.

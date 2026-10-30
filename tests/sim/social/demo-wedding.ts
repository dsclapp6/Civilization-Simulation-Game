// The whole arc of a marriage, as the player would play it: court a villager over a week, win her
// father's blessing, propose, and see the household that results. Dice are loaded in the suitor's favour
// so the story runs to the end (the odds with honest dice: courtship-odds.ts).
//   npx tsx tests/sim/social/demo-wedding.ts [seed]
import { Rng } from '../../../src/core/rng';
import { fullName } from '../../../src/sim/state';
import { installSocial, socialInternals } from '../../../src/sim/social';
import type { Conversation } from '../../../src/sim/social/types';
import { mkHouse, mkHousehold, mkPerson, makePlayer } from '../builders';
import { newSim } from '../helpers';

const sim = newSim({ seed: process.argv[2] ?? 'wedding', preset: 'tiny' });
const social = installSocial(sim);
const core = socialInternals(sim)!;
const st = sim.state;
const lucky = new Rng('lucky');
lucky.next = () => 0.05;
core.rng = () => lucky;

const old = st.persons.get(st.run.playerId)!;
const me = mkPerson(sim, { sex: 'm', age: 20, household: old.household, father: st.persons.get(old.father) ?? null, mother: st.persons.get(old.mother) ?? null, byname: old.byname });
makePlayer(sim, me);
me.trained.cha = 12;
me.money = 300;

// a family in the same village with a daughter of seventeen
const hh = mkHousehold(sim, me.settlement);
const house = mkHouse(sim, 'Brewer');
const father = mkPerson(sim, { sex: 'm', age: 46, household: hh.id, house: house.id, byname: 'Brewer', career: 'farmer' });
const mother = mkPerson(sim, { sex: 'f', age: 42, household: hh.id, house: house.id, byname: 'Brewer' });
st.marry(father, mother, 0);
st.setHead(hh, father);
const her = mkPerson(sim, { sex: 'f', age: 16.4, household: hh.id, house: house.id, father, mother, byname: 'Brewer' });

const name = (id: number): string => (id === me.id ? 'YOU' : st.persons.get(id)?.first ?? '?');
function say(c: Conversation, from: number): void {
  for (const l of c.lines.slice(from)) console.log(`   ${name(l.speaker)}${l.tone ? ` (${l.tone})` : ''}: ${l.text}`);
}
function talk(who: typeof her, day: number, picks: string[]): void {
  st.clock.absDay = day + 0.5;
  st.clock.firedHour = Math.floor(st.clock.absDay * 24);
  console.log(`\n--- day ${day}: ${fullName(me)} and ${fullName(who)} (${social.relationLabel(me.id, who.id)}) ---`);
  const start = social.start(me.id, who.id);
  if ('ok' in start) { console.log('   cannot talk:', start.reason); return; }
  let c = start;
  say(c, 0);
  for (const id of picks) {
    const opt = c.options.find((o) => o.id === id);
    if (!opt) { console.log(`   (option ${id} is not on offer)`); continue; }
    const n = c.lines.length;
    console.log(`  > ${opt.label}${opt.chance !== undefined ? `  [${Math.round(opt.chance * 100)}%]` : ''}`);
    c = social.choose(c.id, id);
    say(c, n);
    if (c.ended) break;
  }
  if (!c.ended) social.end(c.id);
  const rec = social.courtship(me.id, who.id);
  if (rec) console.log(`   [courtship ${Math.round(rec.progress * 100)}% · consent outstanding from: ${rec.needsConsentFrom.map(name).join(', ') || 'nobody'}]`);
}

for (let day = 3; day < 12; day++) {
  talk(her, day, ['nav.court', 'romance.compliment', 'romance.walk', 'romance.token']);
  if ((social.courtship(me.id, her.id)?.progress ?? 0) >= 1) break;
}
talk(her, 13, ['romance.propose']);
talk(father, 13, ['nav.family', `family.consent.${her.id}`]);
console.log('\n--- the proposal ---');
const res = social.propose(me.id, her.id);
console.log('propose():', res);
talk(her, 14, []);
console.log(`\nspouse: ${fullName(me)} + ${fullName(st.persons.get(me.spouse)!)}  ·  household ${me.household}, House ${st.houses.get(me.house)?.name}  ·  chronicle: ${st.chronicle.slice(-1)[0]?.text}`);
sim.advanceDays(16 * 3);
const wife = st.persons.get(me.spouse)!;
console.log(`three years on: ${wife.children.length} child(ren), ${wife.pregnancy ? 'expecting' : 'not expecting'}`);

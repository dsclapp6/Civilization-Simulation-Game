// A scripted tour of the social system on a mock world — run it to read real conversations:
//   npx tsx tests/sim/social/demo.ts [seed] [preset]
// Not a test (vitest only runs *.test.ts); it prints what the player would see.
import { fullName } from '../../../src/sim/state';
import { installSocial, socialInternals } from '../../../src/sim/social';
import type { Conversation, SocialApi } from '../../../src/sim/social/types';
import { newSim } from '../helpers';

const seed = process.argv[2] ?? 'demo';
const preset = (process.argv[3] ?? 'tiny') as 'tiny' | 'small' | 'large';
const sim = newSim({ seed, preset });
const social: SocialApi = installSocial(sim);
const core = socialInternals(sim)!;
const st = sim.state;
const me = st.persons.get(st.run.playerId)!;

// midday, so everyone is awake
st.clock.absDay = Math.floor(sim.absDay) + 0.5;
st.clock.firedHour = Math.floor(st.clock.absDay * 24);

const name = (id: number): string => (id === me.id ? 'YOU' : st.persons.get(id)?.first ?? '?');
function show(c: Conversation, from = 0): void {
  for (const l of c.lines.slice(from)) console.log(`  ${name(l.speaker)}${l.tone ? ` (${l.tone})` : ''}: ${l.text}`);
}
function talk(otherId: number, picks: string[]): void {
  const other = st.persons.get(otherId)!;
  console.log(`\n=== ${fullName(me)} talks to ${fullName(other)} (${social.relationLabel(me.id, other.id)}) ===`);
  const r = social.start(me.id, otherId);
  if ('ok' in r) { console.log('  cannot start:', r.reason); return; }
  let c: Conversation = r;
  show(c);
  console.log(`  [opinion ${c.opinion}, ${c.mood}] options: ${c.options.map((o) => o.id + (o.chance !== undefined ? `(${Math.round(o.chance * 100)}%)` : '')).join(' | ')}`);
  for (const id of picks) {
    const opt = c.options.find((o) => o.id === id);
    if (!opt) { console.log(`  -- option ${id} not available`); continue; }
    const n = c.lines.length;
    console.log(`  > ${opt.label}${opt.enabled ? '' : ` [disabled: ${opt.reason}]`}`);
    c = social.choose(c.id, id);
    show(c, n);
    if (c.ended) { console.log('  (conversation ended)'); break; }
    if (c.opinionDelta !== 0) console.log(`  [opinion ${c.opinion} (${c.opinionDelta >= 0 ? '+' : ''}${c.opinionDelta})]`);
  }
  if (!c.ended) social.end(c.id);
}

const hh = st.households.get(me.household)!;
const kin = hh.members.map((id) => st.persons.get(id)!).filter((p) => p.id !== me.id && core.age(p) >= 5);
const neighbours = st.residentList(me.settlement).filter((p) => !kin.includes(p) && core.age(p) >= 18 && p.id !== me.id);
const priest = neighbours.find((p) => p.career === 'priest');
const reeveOrAny = neighbours.find((p) => p.offices.some((o) => o.office === 'reeve')) ?? neighbours[0];

if (kin[0]) talk(kin[0].id, ['nav.chat', 'chat.family', 'chat.weather', 'chat.hopes', 'nav.back', 'news', 'farewell']);
if (reeveOrAny) talk(reeveOrAny.id, ['nav.chat', 'chat.weather', 'chat.harvest', 'chat.lord', 'nav.back', 'nav.say', 'say.flatter', 'say.boast', 'nav.back', 'nav.ask', 'farewell']);
if (priest) talk(priest.id, ['nav.chat', 'chat.church', 'nav.back', 'nav.favour', 'favour.lessons', 'farewell']);
const stranger = neighbours.find((p) => p.rankTier >= 4) ?? neighbours[5];
if (stranger) talk(stranger.id, ['nav.gift', 'nav.say', 'say.insult']);
console.log('\nnews at home:', social.news(me.settlement, 4));
console.log('barks:', ['greet', 'weather', 'idle', 'working'].map((s) => `${s}: ${social.bark(neighbours[1].id, s as 'greet', me.id)}`));

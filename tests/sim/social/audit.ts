// Content audit: plays the built-in topics against a whole mock world and reports, per dialogue pool,
// how many variants exist, how many were ever chosen, and how often a speaker had only a handful to
// choose from. Thin pools are where conversations start to repeat.
//   npx tsx tests/sim/social/audit.ts [seed] [maxPeople]
import { installSocial, socialInternals } from '../../../src/sim/social';
import { newSim } from '../helpers';

const seed = process.argv[2] ?? 'audit';
const max = Number(process.argv[3] ?? '300');
const sim = newSim({ seed, preset: 'large' });
const social = installSocial(sim);
const core = socialInternals(sim)!;
const st = sim.state;
const player = st.persons.get(st.run.playerId)!;

interface Stat { calls: number; eligibleSum: number; thin: number; used: Set<number> }
const stats = new Map<string, Stat>();
core.speech.probe = (pool, eligible, chosen) => {
  let s = stats.get(pool);
  if (!s) { s = { calls: 0, eligibleSum: 0, thin: 0, used: new Set() }; stats.set(pool, s); }
  s.calls++; s.eligibleSum += eligible; if (eligible <= 2) s.thin++; s.used.add(chosen);
};

// a wide, deterministic sample of adults and youths in all kingdoms
const people = [...st.persons.values()].filter((p) => !p.death && core.age(p) >= 8 && p.id !== player.id && p.id % 5 === 0).slice(0, max);
const paths: string[][] = [
  ...['weather', 'harvest', 'prices', 'family', 'lord', 'church', 'work', 'hopes'].map((t) => ['nav.chat', `chat.${t}`]),
  ['news'],
  ['nav.say', 'say.flatter'], ['nav.say', 'say.boast'], ['nav.say', 'say.insult'], ['nav.say', 'say.threaten'],
  ['nav.say', 'say.insult', 'nav.say', 'say.apologise'],
  ['nav.favour', 'favour.meal'], ['nav.favour', '*loan'], ['nav.favour', 'favour.lessons'],
  ['nav.gift', '*gift'],
  ['farewell'],
];
player.money = 5000;
for (const p of people) p.money = Math.max(p.money, 200);
let day = 1;
paths.push(['nav.ask', '*ask']);
for (const p of people) {
  paths.forEach((path, pi) => {
    // a fresh day for every path, so nobody is "tired of talking" and every pool is reached
    st.clock.absDay = 100 + (day++) * 3 + 0.3 + ((p.id + pi) % 5) * 0.1;
    st.clock.firedHour = Math.floor(st.clock.absDay * 24);
    const start = social.start(player.id, p.id);
    if ('ok' in start) return;
    let c = start;
    for (const id of path) {
      if (c.ended) break;
      if (id === '*ask') {
        for (const o of c.options.filter((x) => x.id.startsWith('ask.')).slice(0, 5)) if (!c.ended) c = social.choose(c.id, o.id);
        continue;
      }
      if (id === '*loan' || id === '*gift') {
        const o = c.options.find((x) => x.enabled && x.id.startsWith(id === '*loan' ? 'favour.loan.' : 'gift.money.'));
        if (o) c = social.choose(c.id, o.id);
        continue;
      }
      const o = c.options.find((x) => x.id === id);
      if (!o || !o.enabled) continue;
      c = social.choose(c.id, id);
    }
    if (!c.ended) social.end(c.id);
  });
}

const rows = [...stats.entries()].map(([pool, s]) => {
  const total = core.speech.pool(pool)?.lines.length ?? 0;
  return { pool, total, used: s.used.size, calls: s.calls, avgFit: s.eligibleSum / s.calls, thin: s.thin / s.calls };
}).sort((a, b) => b.thin - a.thin || a.avgFit - b.avgFit);
console.log('pool'.padEnd(34), 'lines', 'used', 'calls', 'avgFit', '%thin(<=2)');
for (const r of rows.slice(0, 60)) {
  console.log(r.pool.padEnd(34), String(r.total).padStart(5), String(r.used).padStart(4), String(r.calls).padStart(5), r.avgFit.toFixed(1).padStart(6), `${Math.round(r.thin * 100)}%`.padStart(8));
}
const unused = [...core.speech.poolIds()].filter((id) => !stats.has(id));
console.log('\npools never reached in this sweep:', unused.join(', '));
console.log('missing pools:', [...core.speech.missingPools].join(', ') || 'none', ' unknown vars:', [...core.speech.unknownVars].join(', ') || 'none');

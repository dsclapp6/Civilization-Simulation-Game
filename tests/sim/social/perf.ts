// Performance numbers for the social system on the full-size mock continent (~11 000 people):
//   npx tsx tests/sim/social/perf.ts
// Prints per-call cost of the scheduled systems and of the calls the UI and agents make.
import { performance } from 'node:perf_hooks';
import { installSocial, socialInternals } from '../../../src/sim/social';
import { newSim } from '../helpers';

const sim = newSim({ seed: 'perf', preset: 'large' });
const social = installSocial(sim);
const core = socialInternals(sim)!;
const st = sim.state;
const player = st.persons.get(st.run.playerId)!;
console.log(`world: ${st.persons.size} people, ${sim.world.settlements.length} settlements`);

// ---- scheduled systems over a month of game time, with memories to decay ----
const residents = st.residentList(player.settlement).filter((p) => p.id !== player.id);
for (const p of residents.slice(0, 60)) social.adjustOpinion(p.id, player.id, 12, 'gift');
for (const p of st.persons.values()) if (!p.death && p.id % 3 === 0) p.opinions[(p.id * 7) % 5000 + 1] = 6;
sim.scheduler.profiling = true;
sim.advanceDays(32);
sim.scheduler.profiling = false;
for (const [name, prof] of sim.scheduler.profile) {
  if (name.startsWith('social.')) console.log(`${name.padEnd(16)} calls ${String(prof.calls).padStart(5)}  mean ${(prof.totalMs / prof.calls).toFixed(3)} ms  max ${prof.maxMs.toFixed(3)} ms`);
}
const life = sim.scheduler.profile.get('life.settlements');
if (life) console.log(`${'life.settlements'.padEnd(16)} calls ${String(life.calls).padStart(5)}  mean ${(life.totalMs / life.calls).toFixed(3)} ms  max ${life.maxMs.toFixed(3)} ms  (for comparison)`);

// ---- calls ----
function bench(label: string, n: number, fn: (i: number) => void): void {
  for (let i = 0; i < Math.min(n, 30); i++) fn(i); // warm up
  const times: number[] = [];
  const t0 = performance.now();
  for (let i = 0; i < n; i++) { const a = performance.now(); fn(i); times.push(performance.now() - a); }
  const mean = (performance.now() - t0) / n;
  times.sort((x, y) => x - y);
  const p99 = times[Math.floor(times.length * 0.99)];
  const fmt = (v: number): string => (v < 0.01 ? `${(v * 1000).toFixed(1)} µs` : `${v.toFixed(3)} ms`);
  console.log(`${label.padEnd(34)} mean ${fmt(mean)}   p99 ${fmt(p99)}   max ${times[times.length - 1].toFixed(3)} ms   (${n} calls)`);
}

const folk = st.residentList(player.settlement).filter((p) => core.age(p) >= 14 && p.id !== player.id);
const noon = Math.floor(sim.absDay) + 0.5;
st.clock.absDay = noon;
bench('opinion(a, b)', 20000, (i) => social.opinion(folk[i % folk.length].id, player.id));
bench('relations(person)', 500, (i) => social.relations(folk[i % folk.length].id));
bench('relationLabel', 5000, (i) => social.relationLabel(player.id, folk[i % folk.length].id));
bench('start + end conversation', 300, (i) => {
  st.clock.absDay = noon + Math.floor(i / 20);
  const c = social.start(player.id, folk[i % folk.length].id);
  if (!('ok' in c)) social.end(c.id);
});
bench('start, small talk, end', 300, (i) => {
  st.clock.absDay = noon + 40 + i;
  const c = social.start(player.id, folk[i % folk.length].id);
  if ('ok' in c) return;
  social.choose(c.id, 'nav.chat');
  social.choose(c.id, 'chat.weather');
  social.end(c.id);
});
const speakers = st.residentList(player.settlement).slice(0, 80);
bench('bark (rate-limited)', 20000, (i) => { st.clock.absDay = noon + i * 0.0003; social.bark(speakers[i % speakers.length].id, 'greet', player.id); });
bench('bark text (forced)', 20000, (i) => core.barks.say(speakers[i % speakers.length].id, 'greet', player.id));
bench('news(settlement, 5)', 200, (i) => { st.clock.absDay = noon + 100 + i; social.news(player.settlement, 5); });
bench('matchCandidates', 200, (i) => { st.clock.absDay = noon + 200 + i; social.matchCandidates(folk[i % folk.length].id, 5); });
bench('actions.list on a person', 2000, (i) => sim.actions.list(player.id, { kind: 'person', id: folk[i % folk.length].id }));
console.log(`ext size: ${JSON.stringify(st.ext['social'] ?? {}).length} bytes`);

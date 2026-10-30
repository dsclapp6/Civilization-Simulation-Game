// Headless politics run: a continent lives for N years with social, economy and politics installed, and the
// tool prints per-year wars, changes of power, the chronicle's political lines and the systems' cost.
//
//   npx tsx tools/politics.ts [years=10] [preset=large|small|tiny|real] [difficulty=knight] [seed=pol]
//
// `real` uses the true continent generator (src/world/generate.ts) instead of the mock world.
import { newProfile } from '../src/sim/legacy';
import { installEconomy } from '../src/sim/economy';
import { installPolitics } from '../src/sim/politics';
import { Simulation } from '../src/sim/sim';
import { installSocial } from '../src/sim/social';
import type { Person } from '../src/sim/state';
import { createMockWorld } from '../src/sim/testing/mockWorld';
import { generateWorld } from '../src/world/generate';

const years = Number(process.argv[2] ?? 10);
const preset = process.argv[3] ?? 'large';
const difficulty = (process.argv[4] ?? 'knight') as 'squire' | 'knight' | 'lord' | 'king';
const seed = process.argv[5] ?? 'pol';

const gen = preset === 'real'
  ? (s: string) => generateWorld(s)
  : (s: string) => createMockWorld({ seed: s, preset: preset as 'large' | 'small' | 'tiny' });
const sim = Simulation.newGame({ seed, difficulty, generateWorld: gen, profile: newProfile() });
const st = sim.state;
// no player: the run cannot end, and the AI plays every House
const player = st.persons.get(st.run.playerId) as Person;
delete player.flags.player;
st.run.playerId = 0;
const social = installSocial(sim);
const economy = installEconomy(sim, { social });
const pol = installPolitics(sim, { social, economy });

const counts: Record<string, number> = {};
for (const k of ['war', 'battle', 'raid', 'office', 'stance', 'captured', 'happening'] as const) sim.events.on(k, () => { counts[k] = (counts[k] ?? 0) + 1; });
const causes: Record<string, number> = {};
sim.events.on('war', (e) => {
  if (e.phase !== 'declared') return;
  const w = pol.war(e.war);
  if (w) causes[w.cause] = (causes[w.cause] ?? 0) + 1;
});

sim.scheduler.profiling = true;
let seen = 0;
const t0 = Date.now();
console.log(`${preset} continent, ${st.persons.size} people, ${pol.actors().length} Houses hold land, difficulty ${difficulty}`);
for (let y = 1; y <= years; y++) {
  const a = Date.now();
  sim.advanceDays(16);
  const s = pol.stats();
  console.log(`year ${String(y).padStart(2)}: wars ${pol.wars().length} (declared ${s.warsDeclared}), titles moved ${s.titlesMoved}, leagues ${s.coalitions}, revolts ${s.revolts}, independence ${s.independence}, pop ${st.population}, ${Date.now() - a} ms`);
  for (const e of st.chronicle.slice(seen)) {
    if (['war', 'title', 'coalition', 'revolt', 'vassal', 'independence', 'alliance', 'union', 'ransom'].includes(e.kind)) console.log(`        y${Math.floor(e.day / 16)} ${e.kind}: ${e.text}`);
  }
  seen = st.chronicle.length;
}
console.log('wars by cause', causes);
console.log('events', counts);
for (const [name, p] of [...sim.scheduler.profile.entries()].filter(([k]) => k.startsWith('politics.'))) {
  console.log(name.padEnd(20), `calls ${p.calls}`.padEnd(14), `avg ${(p.totalMs / p.calls).toFixed(3)} ms`.padEnd(16), `max ${p.maxMs.toFixed(2)} ms`);
}
console.log(`total ${((Date.now() - t0) / 1000).toFixed(1)} s`);

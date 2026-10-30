// Headless economy report: runs the macro economy for N years with no player and prints, every few years, the
// prices of the staple goods at the market towns (as a multiple of their base price), prosperity, hunger and
// the cost of the economy systems. Usage:
//   npx tsx tools/econ.ts --years 100 [--preset tiny|small|large] [--seed x] [--every 10]
import { performance } from 'node:perf_hooks';
import { DAYS_PER_YEAR } from '../src/core/time';
import { installEconomy } from '../src/sim/economy';
import { GOODS, MACRO_GOODS } from '../src/sim/economy/data';
import { newProfile } from '../src/sim/legacy';
import { Simulation } from '../src/sim/sim';
import { installSocial } from '../src/sim/social';
import { createMockWorld } from '../src/sim/testing/mockWorld';
import { generateWorld } from '../src/world/generate';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}

const seed = arg('seed', 'econ');
const years = Number(arg('years', '50'));
const every = Number(arg('every', '10'));
const preset = arg('preset', 'small') as 'tiny' | 'small' | 'large' | 'real';

const sim = Simulation.newGame({
  seed, difficulty: 'knight', profile: newProfile(),
  generateWorld: (s) => (preset === 'real' ? generateWorld(s) : createMockWorld({ seed: s, preset })),
});
const eco = installEconomy(sim, { social: installSocial(sim) });
// no player: the study must not stop when the character dies
const pl = sim.state.persons.get(sim.state.run.playerId);
if (pl) { delete pl.flags.player; sim.state.touch(pl); }
sim.state.run.playerId = 0;

const markets = sim.world.settlements.filter((s) => s.market);
sim.scheduler.profiling = true;
const t0 = performance.now();
const goods = ['wheat', 'rye', 'barley', 'ale', 'bread', 'meat', 'firewood'];
console.log(`economy report: ${preset} world, seed ${seed}, ${markets.length} market towns`);
console.log(['year', 'pop', 'prosp', ...goods].map((h) => h.padStart(9)).join(''));
for (let y = 1; y <= years; y++) {
  sim.advanceDays(DAYS_PER_YEAR);
  if (y % every !== 0 && y !== 1) continue;
  let pop = 0;
  for (const p of sim.state.persons.values()) if (!p.death) pop++;
  let pros = 0, n = 0;
  for (const s of sim.state.settlements.values()) { pros += s.prosperity; n++; }
  const cells = goods.map((g) => {
    let sum = 0, k = 0;
    for (const m of markets) { const v = eco.price(m.id, g, 'buy'); if (v > 0) { sum += v / GOODS[g].basePrice; k++; } }
    return (k ? sum / k : 0).toFixed(2);
  });
  console.log([String(y), String(pop), (pros / Math.max(1, n)).toFixed(2), ...cells].map((c) => c.padStart(9)).join(''));
}
const secs = (performance.now() - t0) / 1000;
console.log(`\n${years} years in ${secs.toFixed(1)} s (${((secs / years) * 1000).toFixed(0)} ms a year, whole simulation)`);
for (const [name, p] of sim.scheduler.profile) {
  if (name.startsWith('econ.')) console.log(`  ${name.padEnd(18)} avg ${(p.totalMs / p.calls).toFixed(3)} ms  max ${p.maxMs.toFixed(2)} ms  calls ${p.calls}`);
}
console.log(`macro goods tracked: ${MACRO_GOODS.join(', ')}`);

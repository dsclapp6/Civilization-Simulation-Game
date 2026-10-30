// Headless run of the whole simulation with every gameplay module installed (no zone/player):
// population, food, conflict and happenings per year, plus per-system cost.
//   npx tsx tools/fullsim.ts --years 10 [--seed millennia] [--difficulty knight] [--preset tiny|small|large]
import { performance } from 'node:perf_hooks';
import type { Difficulty } from '../src/core/domain';
import { installCombat } from '../src/combat';
import { installAdvancement } from '../src/sim/advancement';
import { installEconomy } from '../src/sim/economy';
import { newProfile } from '../src/sim/legacy';
import { installMilitary } from '../src/sim/military';
import { installPolitics } from '../src/sim/politics';
import { Simulation } from '../src/sim/sim';
import { installSocial } from '../src/sim/social';
import { createMockWorld } from '../src/sim/testing/mockWorld';
import { generateWorld } from '../src/world/generate';

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const years = Number(arg('years', '10'));
const seed = arg('seed', 'millennia');
const difficulty = arg('difficulty', 'knight') as Difficulty;
const preset = arg('preset', '') as '' | 'tiny' | 'small' | 'large';

const t0 = performance.now();
const sim = Simulation.newGame({
  seed, difficulty, profile: newProfile(),
  generateWorld: (s) => (preset ? createMockWorld({ seed: s, preset }) : generateWorld(s)),
});
const social = installSocial(sim);
const economy = installEconomy(sim, { social });
const deps = { economy, social };
installPolitics(sim, deps);
installMilitary(sim, deps);
installCombat(sim, deps);
installAdvancement(sim, deps);
console.log(`ready in ${((performance.now() - t0) / 1000).toFixed(1)} s: ${sim.world.settlements.length} settlements, services: ${Object.keys(sim.services).join(', ')}`);

const tally: Record<string, number> = {};
const bump = (k: string): void => { tally[k] = (tally[k] ?? 0) + 1; };
sim.events.on('war', (e) => bump(`war.${e.phase}`));
sim.events.on('battle', () => bump('battle'));
sim.events.on('siege', (e) => bump(`siege.${e.phase}`));
sim.events.on('raid', () => bump('raid'));
sim.events.on('captured', () => bump('captured'));
sim.events.on('happening', (e) => { if (e.phase === 'start') bump(`happening.${e.kind}`); });
sim.events.on('request', () => bump('request'));
sim.events.on('tech', () => bump('tech'));
sim.events.on('office', (e) => { if (e.gained) bump('office'); });

sim.scheduler.profiling = true;
const living = (): number => { let n = 0; for (const p of sim.state.persons.values()) if (!p.death) n++; return n; };
const prosperity = (): number => {
  let s = 0, n = 0;
  for (const st of sim.state.settlements.values()) { s += st.prosperity; n++; }
  return n ? s / n : 1;
};
console.log('year   pop  prosp  wars  battles  sieges  raids  happenings  ms/yr');
for (let y = 1; y <= years; y++) {
  const ts = performance.now();
  for (let d = 0; d < 16; d++) {
    sim.advanceDays(1);
    const p2 = sim.state.run.pendingSuccession;
    if (sim.state.run.phase === 'choosing' && p2 && p2.eligible.length) { sim.dispatch({ type: 'switchCharacter', personId: p2.eligible[0] }); bump('succession'); }
  }
  const ms = performance.now() - ts;
  const happenings = Object.entries(tally).filter(([k]) => k.startsWith('happening.')).reduce((a, [, v]) => a + v, 0);
  console.log(`${String(y).padStart(4)} ${String(living()).padStart(6)}  ${prosperity().toFixed(2)}  ${String(tally['war.declared'] ?? 0).padStart(4)}  ${String(tally.battle ?? 0).padStart(7)}  ${String(tally['siege.start'] ?? 0).padStart(6)}  ${String(tally.raid ?? 0).padStart(5)}  ${String(happenings).padStart(10)}  ${ms.toFixed(0).padStart(5)}`);
  // headless: when the player dies, carry on as the first eligible successor
  const ps = sim.state.run.pendingSuccession;
  if (sim.state.run.phase === 'choosing' && ps && ps.eligible.length) { sim.dispatch({ type: 'switchCharacter', personId: ps.eligible[0] }); bump('succession'); }
  if (sim.state.run.phase === 'over') { console.log('run over: no heir left'); break; }
}
console.log('\ntotals:', Object.entries(tally).sort().map(([k, v]) => `${k}=${v}`).join('  '));
const prof = [...sim.scheduler.profile.entries()].sort((a, b) => b[1].maxMs - a[1].maxMs).slice(0, 12);
console.log('\nslowest systems (max ms per call / avg ms):');
for (const [name, p] of prof) console.log(`  ${name.padEnd(28)} max ${p.maxMs.toFixed(1).padStart(6)}  avg ${(p.totalMs / Math.max(1, p.calls)).toFixed(3)}  calls ${p.calls}`);

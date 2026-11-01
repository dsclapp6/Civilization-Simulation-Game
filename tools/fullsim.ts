// Headless run of the whole simulation with every gameplay module installed (no zone/player):
// population, food, conflict and happenings per year, plus per-system cost. From 20 years on it also prints a summary
// per decade (population min/max, prosperity, famine, revolts, wars, battles, sieges, raids) and the drift per year.
//   npx tsx tools/fullsim.ts --years 10 [--seed millennia] [--difficulty knight] [--preset tiny|small|large] [--quiet] [--keep-player] [--cpu] [--sections]
import { performance } from 'node:perf_hooks';
import type { Difficulty } from '../src/core/domain';
import { DAY_SECONDS } from '../src/core/time';
import { installCombat } from '../src/combat';
import { installAdvancement } from '../src/sim/advancement';
import { installEconomy } from '../src/sim/economy';
import { newProfile } from '../src/sim/legacy';
import { installMilitary, militaryContext } from '../src/sim/military';
import { installPolitics } from '../src/sim/politics';
import { SLOW_MS } from '../src/sim/scheduler';
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
const quiet = process.argv.includes('--quiet');

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

// no player: a long study must not stop when the random character dies (`--keep-player` plays on through successors instead)
if (!process.argv.includes('--keep-player')) {
  const pl = sim.state.persons.get(sim.state.run.playerId);
  if (pl) { delete pl.flags.player; sim.state.touch(pl); }
  sim.state.run.playerId = 0;
}
sim.scheduler.profiling = true;
const sections = process.argv.includes('--sections');
// --spikes <ms>: every profiled call over the threshold, with the game hour/day it ran in (to see which slice is heavy)
const spikeMs = process.argv.includes('--spikes') ? Number(arg('spikes', '6')) : 0;
const spikes: Array<{ name: string; ms: number; hour: number; day: number }> = [];
if (spikeMs > 0) sim.scheduler.onCall = (name, ms) => {
  if (ms >= spikeMs && process.argv.includes('--trace-spikes')) console.log(`SPIKE ${name} ${ms.toFixed(1)}`);
  if (ms >= spikeMs) spikes.push({ name, ms, hour: Math.floor(((sim.absDay % 1) + 1e-6) * 24), day: Math.floor(sim.absDay) });
};
if (sections) militaryContext(sim).timings = {};
// Wall time by default (a quiet machine); --cpu uses this thread's CPU time instead (4 ms resolution here, and a shared machine's other work is not counted)
if (process.argv.includes('--cpu')) {
  const cpu = (process as unknown as { threadCpuUsage?: () => NodeJS.CpuUsage }).threadCpuUsage?.bind(process) ?? process.cpuUsage.bind(process);
  sim.scheduler.clock = () => { const u = cpu(); return (u.user + u.system) / 1000; };
}
const living = (): number => { let n = 0; for (const p of sim.state.persons.values()) if (!p.death) n++; return n; };
const prosperity = (): number => {
  let s = 0, n = 0;
  for (const st of sim.state.settlements.values()) { s += st.prosperity; n++; }
  return n ? s / n : 1;
};
if (!quiet) console.log('year   pop  prosp  low  famine  wars  battles  sieges  raids  happenings  ms/yr');
interface YearRow { year: number; pop: number; pros: number; prosMin: number; famine: number; revolts: number; wars: number; battles: number; sieges: number; raids: number; ms: number }
const rows: YearRow[] = [];
const count = (...keys: string[]): number => keys.reduce((a, k) => a + (tally[k] ?? 0), 0);
const prev = { famine: 0, revolts: 0, wars: 0, battles: 0, sieges: 0, raids: 0 };
const minProsperity = (): number => { let m = 9; for (const st of sim.state.settlements.values()) m = Math.min(m, st.prosperity); return m === 9 ? 1 : m; };
for (let y = 1; y <= years; y++) {
  const ts = performance.now();
  for (let d = 0; d < 16; d++) {
    sim.advanceDays(1);
    const p2 = sim.state.run.pendingSuccession;
    if (sim.state.run.phase === 'choosing' && p2 && p2.eligible.length) { sim.dispatch({ type: 'switchCharacter', personId: p2.eligible[0] }); bump('succession'); }
  }
  const ms = performance.now() - ts;
  const happenings = Object.entries(tally).filter(([k]) => k.startsWith('happening.')).reduce((a, [, v]) => a + v, 0);
  const prevFam = prev.famine;
  const now = { famine: count('happening.famine'), revolts: count('happening.peasant_revolt', 'happening.revolt'), wars: count('war.declared'), battles: count('battle'), sieges: count('siege.start'), raids: count('raid') };
  rows.push({ year: y, pop: living(), pros: prosperity(), prosMin: minProsperity(), famine: now.famine - prev.famine, revolts: now.revolts - prev.revolts, wars: now.wars - prev.wars, battles: now.battles - prev.battles, sieges: now.sieges - prev.sieges, raids: now.raids - prev.raids, ms });
  Object.assign(prev, now);
  if (!quiet) console.log(`${String(y).padStart(4)} ${String(living()).padStart(6)}  ${prosperity().toFixed(2)}  ${minProsperity().toFixed(2)}  ${String(now.famine - prevFam).padStart(6)}  ${String(tally['war.declared'] ?? 0).padStart(4)}  ${String(tally.battle ?? 0).padStart(7)}  ${String(tally['siege.start'] ?? 0).padStart(6)}  ${String(tally.raid ?? 0).padStart(5)}  ${String(happenings).padStart(10)}  ${ms.toFixed(0).padStart(5)}`);
  // headless: when the player dies, carry on as the first eligible successor
  const ps = sim.state.run.pendingSuccession;
  if (sim.state.run.phase === 'choosing' && ps && ps.eligible.length) { sim.dispatch({ type: 'switchCharacter', personId: ps.eligible[0] }); bump('succession'); }
  if (sim.state.run.phase === 'over') { console.log('run over: no heir left'); break; }
}
console.log('\ntotals:', Object.entries(tally).sort().map(([k, v]) => `${k}=${v}`).join('  '));
const prof = [...sim.scheduler.profile.entries()].sort((a, b) => b[1].maxMs - a[1].maxMs).slice(0, 14);
console.log(`\nslowest systems (ms per call; "slow" = calls over ${SLOW_MS} ms):`);
for (const [name, p] of prof) console.log(`  ${name.padEnd(28)} max ${p.maxMs.toFixed(1).padStart(6)}  avg ${(p.totalMs / Math.max(1, p.calls)).toFixed(3)}  slow ${String(p.slow).padStart(4)}  calls ${p.calls}`);
if (spikeMs > 0) {
  const by = new Map<string, { n: number; max: number }>();
  const warm = Number(arg('warm', '3')) * 16; // the first years run cold (JIT), and a browser warms up in the first minutes too
  console.log(`by game year: ${[...new Set(spikes.map((x) => Math.floor(x.day / 16)))].map((y) => `${y + 1}:${spikes.filter((x) => Math.floor(x.day / 16) === y).length}`).join(' ')} (listing below: after year ${warm / 16})`);
  for (const sp of spikes.filter((x) => x.day >= warm)) { const k = `${sp.name} @${String(sp.hour).padStart(2)}h`; const e = by.get(k) ?? { n: 0, max: 0 }; e.n++; e.max = Math.max(e.max, sp.ms); by.set(k, e); }
  console.log(`\ncalls over ${spikeMs} ms: ${spikes.length}; by system and game hour:`);
  for (const [k, v] of [...by.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) console.log(`  ${k.padEnd(34)} n ${String(v.n).padStart(4)}  max ${v.max.toFixed(1)}`);
}
let totalMs = 0;
for (const p of sim.scheduler.profile.values()) totalMs += p.totalMs;
const perHour = totalMs / (years * 16 * 24);
// at 8x a game hour lasts DAY_SECONDS / 24 / 8 seconds (3.1 s on a ten-minute day) = that many frames of 60 Hz; the headless run has no agents, zone or player systems
const framesPerHourAt8x = (DAY_SECONDS / 24 / 8) * 60;
console.log(`all systems: ${perHour.toFixed(3)} ms per game hour = ${(perHour / framesPerHourAt8x).toFixed(3)} ms per frame at 8x (averaged over the hour)`);

if (rows.length >= 20) {
  console.log('\nper decade (counts are events in the decade; pop/prosperity are the min..max of the yearly values):');
  console.log('years      pop min..max     prosp mean (worst town)   famines (bad years)  revolts  wars  battles  sieges  raids');
  for (let a = 0; a < rows.length; a += 10) {
    const d = rows.slice(a, a + 10);
    const sum = (f: (r: YearRow) => number): number => d.reduce((x, r) => x + f(r), 0);
    const pops = d.map((r) => r.pop);
    const bad = d.filter((r) => r.famine > 0).length;
    const cells = [`${d[0].year}-${d[d.length - 1].year}`.padEnd(8), `${Math.min(...pops)}..${Math.max(...pops)}`.padEnd(16), `${(sum((r) => r.pros) / d.length).toFixed(2)} (${Math.min(...d.map((r) => r.prosMin)).toFixed(2)})`.padEnd(24),
      `${sum((r) => r.famine)} (${bad})`.padEnd(20), String(sum((r) => r.revolts)).padEnd(8), String(sum((r) => r.wars)).padEnd(6), String(sum((r) => r.battles)).padEnd(9), String(sum((r) => r.sieges)).padEnd(8), String(sum((r) => r.raids))];
    console.log(cells.join(' '));
  }
  // least-squares drift of the population over the years (percent a year)
  const n = rows.length;
  const xs = rows.map((r) => r.year), ys = rows.map((r) => Math.log(r.pop));
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  const slope = xs.reduce((a, x, i) => a + (x - mx) * (ys[i] - my), 0) / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
  console.log(`population drift ${(slope * 100).toFixed(2)} %/yr (fit over ${n} years: ${rows[0].pop} -> ${rows[n - 1].pop}); famine starts ${rows.reduce((a, r) => a + r.famine, 0)} in ${n} years`);
}

if (sections) {
  console.log('\nmilitary sections (ms; wall clock):');
  for (const [k, v] of Object.entries(militaryContext(sim).timings ?? {}).sort((a, b) => b[1].ms - a[1].ms).slice(0, 12)) {
    console.log(`  ${k.padEnd(18)} total ${v.ms.toFixed(0).padStart(6)}  avg ${(v.ms / v.calls).toFixed(3)}  max ${v.max.toFixed(1).padStart(6)}  calls ${v.calls}`);
  }
}

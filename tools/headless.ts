// Headless simulation: builds a continent, populates it, runs N years of macro life and prints
// demographics. Usage:
//   npx tsx tools/headless.ts --seed x --years 100 [--preset large|small|tiny (mock world)] [--difficulty knight]
//                             [--save] [--quiet] [--player]
// By default the run has no player (a demographic study must not stop when the player's line dies
// out); with --player the character is kept alive by taking over the youngest adult relative.
import { performance } from 'node:perf_hooks';
import type { Difficulty } from '../src/core/domain';
import { DAYS_PER_YEAR } from '../src/core/time';
import type { WorldModel } from '../src/world/types';
import { newProfile } from '../src/sim/legacy';
import { MemorySaveStore } from '../src/sim/save-memory';
import { Simulation } from '../src/sim/sim';
import { createMockWorld } from '../src/sim/testing/mockWorld';
import { generateWorld } from '../src/world/generate';
import { ageYears, type GameState } from '../src/sim/state';

// The real continent by default; `--preset tiny|small|large` uses a fast mock world instead.
const buildWorld = (seed: string, preset: 'tiny' | 'small' | 'large' | ''): WorldModel =>
  preset ? createMockWorld({ seed, preset }) : generateWorld(seed);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
}
const flag = (name: string): boolean => process.argv.includes(`--${name}`);

const seed = arg('seed', 'headless');
const years = Number(arg('years', '100'));
const preset = arg('preset', '') as 'tiny' | 'small' | 'large' | '';
const difficulty = arg('difficulty', 'knight') as Difficulty;
const quiet = flag('quiet');
const withSave = flag('save');
const keepPlayer = flag('player');

function pct(n: number, total: number): string { return `${((n / Math.max(1, total)) * 100).toFixed(1)}%`; }

function composition(sim: Simulation, title: string): void {
  const state = sim.state;
  const kindOf = new Map(sim.world.settlements.map((s) => [s.id, s.kind] as const));
  const tiers: number[] = new Array(9).fill(0);
  const kinds: Record<string, number> = {};
  const ages: number[] = new Array(10).fill(0);
  let males = 0;
  let n = 0;
  for (const p of state.persons.values()) {
    if (p.death) continue;
    n++;
    tiers[p.rankTier]++;
    kinds[kindOf.get(p.settlement) ?? '?'] = (kinds[kindOf.get(p.settlement) ?? '?'] ?? 0) + 1;
    ages[Math.min(9, Math.floor(ageYears(p, state.clock.absDay) / 10))]++;
    if (p.sex === 'm') males++;
  }
  console.log(`\n== ${title}: ${n} people, ${state.households.size} households, ${state.houses.size} houses, ${state.titles.size} titles ==`);
  console.log('by rank tier :', tiers.map((c, t) => (t ? `${t}:${c} (${pct(c, n)})` : '')).filter(Boolean).join('  '));
  console.log('peasants (tiers 1-2):', pct(tiers[1] + tiers[2], n), ' middling+:', pct(n - tiers[1] - tiers[2], n));
  console.log('by settlement:', Object.entries(kinds).map(([k, c]) => `${k}:${c}`).join('  '));
  console.log('by age decade:', ages.map((c, i) => `${i * 10}s:${pct(c, n)}`).join('  '), ` male:${pct(males, n)}`);
}

function lifeExpectancy(state: GameState, lastYears: number): { e0: number; infant: number } {
  const hist = state.stats.history.slice(-lastYears);
  let sum = 0, deaths = 0, infant = 0, births = 0;
  for (const y of hist) { sum += y.ageAtDeathSum; deaths += y.deaths; infant += y.infantDeaths; births += y.births; }
  return { e0: deaths ? sum / deaths : 0, infant: births ? infant / births : 0 };
}

async function main(): Promise<void> {
  const tWorld = performance.now();
  const store = withSave ? new MemorySaveStore() : undefined;
  const sim = Simulation.newGame({
    seed, difficulty, store, profile: newProfile(),
    generateWorld: (s) => buildWorld(s, preset),
    autosave: { budgetMs: 3, intervalMs: 0 },
  });
  const tReady = performance.now();
  console.log(`world + population ready in ${(tReady - tWorld).toFixed(0)} ms (${sim.world.settlements.length} settlements)`);
  const player = sim.state.persons.get(sim.state.run.playerId);
  if (player) {
    console.log(`player: ${player.first} ${player.byname}, ${player.sex === 'm' ? 'boy' : 'girl'} of tier ${player.rankTier} in ${sim.world.settlements.find((s) => s.id === player.settlement)?.name}; birth class ${sim.state.run.birthClass}`);
  }
  composition(sim, 'Start');

  if (!keepPlayer) {
    const p = sim.state.persons.get(sim.state.run.playerId);
    if (p) { delete p.flags.player; sim.state.touch(p); }
    sim.state.run.playerId = 0;
  }
  // with --player: take over a young relative whenever the character dies
  sim.events.on('playerDied', (e) => {
    if (e.eligible.length === 0) return;
    const people = e.eligible.map((id) => sim.state.persons.get(id)).filter((p): p is NonNullable<typeof p> => !!p);
    const adults = people.filter((p) => ageYears(p, sim.absDay) >= 14).sort((a, b) => b.birthDay - a.birthDay || a.id - b.id);
    const pick = adults.length ? adults[0] : people.sort((a, b) => a.birthDay - b.birthDay)[0];
    sim.dispatch({ type: 'switchCharacter', personId: pick.id });
  });

  sim.scheduler.profiling = true;
  const yearMs: number[] = [];
  let saveStats = { slices: 0, maxSlice: 0, bytes: 0, cycles: 0 };
  if (!quiet) console.log('\nyear  population  births  deaths  marriages  infant-deaths  arrivals   ms');
  const tRun = performance.now();
  for (let y = 1; y <= years; y++) {
    const t0 = performance.now();
    sim.advanceDays(DAYS_PER_YEAR);
    if (sim.state.run.phase === 'over') { console.log(`GAME OVER in year ${y}`); break; }
    if (sim.saver) {
      sim.saver.requestNow();
      for (let guard = 0; guard < 100000 && (sim.saver.busy || guard === 0); guard++) { sim.saver.tick(); if (!sim.saver.busy) break; }
      await sim.flush();
      saveStats = { slices: sim.saver.stats.slices, maxSlice: sim.saver.stats.maxSliceMs, bytes: sim.saver.stats.lastCycleBytes, cycles: sim.saver.stats.cycles };
    }
    const ms = performance.now() - t0;
    yearMs.push(ms);
    const h = sim.state.stats.history[sim.state.stats.history.length - 1];
    if (!quiet && h && (y <= 5 || y % 5 === 0 || y === years)) {
      console.log(`${String(y).padStart(4)}  ${String(h.population).padStart(10)}  ${String(h.births).padStart(6)}  ${String(h.deaths).padStart(6)}  ${String(h.marriages).padStart(9)}  ${String(h.infantDeaths).padStart(13)}  ${String(h.arrivals).padStart(8)}  ${ms.toFixed(0).padStart(4)}`);
    }
  }
  const total = performance.now() - tRun;

  composition(sim, `After ${yearMs.length} years`);
  const hist = sim.state.stats.history;
  const first = hist[0]?.population ?? 0;
  const last = hist[hist.length - 1]?.population ?? 0;
  const growth = yearMs.length ? (Math.pow(last / Math.max(1, first), 1 / yearMs.length) - 1) * 100 : 0;
  const le = lifeExpectancy(sim.state, 50);
  let births = 0, deaths = 0, marriages = 0;
  for (const y of hist) { births += y.births; deaths += y.deaths; marriages += y.marriages; }
  const causes: Record<string, number> = {};
  for (const y of hist) for (const [c, n] of Object.entries(y.deathsByCause)) causes[c] = (causes[c] ?? 0) + (n ?? 0);
  console.log('\n== Summary ==');
  console.log(`population ${first} -> ${last} (${growth >= 0 ? '+' : ''}${growth.toFixed(2)}%/yr), households ${sim.state.households.size}`);
  console.log(`births ${births}, deaths ${deaths}, marriages ${marriages} over ${hist.length} years (per year: ${(births / hist.length).toFixed(0)} / ${(deaths / hist.length).toFixed(0)} / ${(marriages / hist.length).toFixed(0)})`);
  console.log(`life expectancy at birth (mean age at death, last 50 y): ${le.e0.toFixed(1)}; infant mortality ${(le.infant * 100).toFixed(1)}% of births`);
  console.log('causes of death:', Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c}:${n}`).join('  '));
  console.log(`time: ${(total / 1000).toFixed(1)} s for ${yearMs.length} years = ${(total / Math.max(1, yearMs.length)).toFixed(0)} ms/year (max ${Math.max(0, ...yearMs).toFixed(0)} ms)`);
  console.log(`registry: ${sim.state.persons.size} persons (living ${sim.state.living}), ${sim.state.houses.size} houses`);
  console.log('systems:', [...sim.scheduler.profile].map(([n, p]) => `${n} ${p.totalMs.toFixed(0)}ms (max ${p.maxMs.toFixed(1)})`).join('; '));
  if (store) {
    console.log(`save: ${store.commits} commits, last cycle ${(saveStats.bytes / 1024).toFixed(0)} KB, ${saveStats.cycles} cycles, longest slice ${saveStats.maxSlice.toFixed(2)} ms, store size ${(store.runSize() / 1024 / 1024).toFixed(1)} MB`);
  }
  const run = sim.state.run;
  console.log(`run: ${run.phase}, score ${sim.state.score.points}, legacy gold ${sim.profile.levels.medieval.legacyGold}, character switches ${run.switches}`);
}

void main();

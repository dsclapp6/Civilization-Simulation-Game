import { describe, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { autoSuccessor } from '../helpers';
import { declareWar, fakeCombat, fakePolitics, milSim } from './helpers';

describe('explore', () => {
  it('a long war', () => {
    const { sim, mil } = milSim({ preset: 'large', seed: 'warlong' });
    autoSuccessor(sim);
    const pol = fakePolitics(sim);
    fakeCombat(sim, 0.35);
    sim.scheduler.profiling = true;
    const kings = [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
    const M = militaryContext(sim);
    M.timings = {};
    const counts: Record<string, number> = {};
    for (const ev of ['battle', 'siege', 'raid', 'captured'] as const) sim.events.on(ev, () => { counts[ev] = (counts[ev] ?? 0) + 1; });
    declareWar(pol, sim, [kings[0]], [kings[1]]);
    declareWar(pol, sim, [kings[2]], [kings[3]]);
    declareWar(pol, sim, [kings[4]], [kings[5]]);
    const t0 = performance.now();
    for (let d = 0; d < 160; d++) {
      sim.advanceDays(1);
      if (d % 20 === 19) {
        const armies = mil.armies();
        console.log(`day ${d + 1}: armies=${armies.length} men=${armies.reduce((s, a) => s + Object.values(a.troops).reduce((x, y) => x + y, 0), 0)} sieges=${mil.sieges().length} captives=${mil.captives().length} ${JSON.stringify(counts)} dead=${M.data.stats.dead} tasks=${armies.map((a) => a.task[0]).join('')}`);
      }
    }
    console.log('ms', Math.round(performance.now() - t0));
    const prof = [...sim.scheduler.profile.entries()].filter(([k]) => k.startsWith('military')).map(([k, v]) => `${k} calls=${v.calls} avg=${(v.totalMs / v.calls).toFixed(2)}ms max=${v.maxMs.toFixed(1)}ms`);
    console.log(prof.join('\n'));
    console.log(Object.entries(M.timings!).map(([k, v]) => `${k} calls=${v.calls} avg=${(v.ms / v.calls).toFixed(2)} max=${v.max.toFixed(1)} over8=${v.over8 ?? 0}`).join('\n'));
    console.log(sim.state.chronicle.filter((c) => ['battle', 'siege', 'raid', 'muster'].includes(c.kind)).slice(-25).map((c) => `${c.day.toFixed(0)} ${c.kind}: ${c.text}`).join('\n'));
  });
});

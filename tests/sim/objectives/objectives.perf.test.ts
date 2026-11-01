// Timing budgets of the objectives (run alone: `PERF=1 npx vitest run --no-file-parallelism objectives.perf`).
// Nothing here may scale with the population or run per frame beyond a handful of cheap checks.
import { describe, expect, it } from 'vitest';
import { active, objSim, playObjectives, runTo, skipTutorial } from './helpers';

const time = (n: number, fn: (i: number) => void): number => {
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  return (performance.now() - t0) / n;
};

describe('objectives timing', () => {
  it('the looks, the lists and the markers cost next to nothing; dawn work a few milliseconds', () => {
    const o = objSim({ seed: 's1' });
    playObjectives(o, ['tutorial']);
    runTo(o, 2, 6);
    o.adv.happenings.offerRequest('fetch');
    o.obj.poll(true);
    expect(active(o).length).toBeGreaterThan(3);

    const poll = time(2000, () => o.obj.poll(false));
    const slow = time(400, () => o.obj.poll(true));
    const list = time(20000, () => { o.obj.list(); o.obj.tracked(); });
    const markers = time(20000, () => o.sim.view.worldMarkers?.());
    const suggestions = time(500, () => o.obj.suggestions(4));
    const places = time(300, () => o.obj.places?.());
    // a whole day of hooks with the module installed against without it
    const withIt = time(40, () => o.sim.advanceHours(1));
    const dawn = time(60, (i) => { o.obj.obj.save.choresDay = -1; o.obj.obj.save.jobsDay = -1; o.obj.obj.save.goalsDay = -1; if (i % 4 === 0) o.sim.advanceHours(1); o.obj.dawn(); });
    // eslint-disable-next-line no-console
    console.log(`objectives: poll ${(poll * 1000).toFixed(1)} µs · slow poll ${(slow * 1000).toFixed(0)} µs · list ${(list * 1000).toFixed(2)} µs · markers ${(markers * 1000).toFixed(2)} µs · suggestions ${(suggestions * 1000).toFixed(0)} µs · places ${(places * 1000).toFixed(0)} µs · hour ${withIt.toFixed(2)} ms · dawn ${dawn.toFixed(2)} ms`);
    expect(poll).toBeLessThan(0.2);
    expect(slow).toBeLessThan(1.5);
    expect(list).toBeLessThan(0.01);
    expect(markers).toBeLessThan(0.05);
    expect(suggestions).toBeLessThan(2);
    expect(places).toBeLessThan(3);
    expect(dawn).toBeLessThan(12);
  });

  it('the module adds little to an hour of the calendar', () => {
    const a = objSim({ seed: 's2', install: false });
    const b = objSim({ seed: 's2' });
    skipTutorial(b);
    const base = time(60, () => a.sim.advanceHours(1));
    const mine = time(60, () => b.sim.advanceHours(1));
    // eslint-disable-next-line no-console
    console.log(`an hour: ${base.toFixed(2)} ms without, ${mine.toFixed(2)} ms with the objectives`);
    expect(mine - base).toBeLessThan(2.5);
  });
});

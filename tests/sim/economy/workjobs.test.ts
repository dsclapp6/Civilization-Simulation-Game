// One action is one job (docs/WORK.md): the runner stops after the job's bouts instead of starting the same work again
// and again; the job's time is the whole job's; open-ended work is its own choice; the garden bed the job works shows in
// the world as it is dug, sown, grown and gathered.
import { describe, expect, it } from 'vitest';
import { jobBouts, jobViewOf, type ActionOption } from '../../../src/sim/actions';
import { jobBarView } from '../../../src/ui/core/hudModel';
import { econSim, find, makeFarmer, optionsFor } from './helpers';
import type { Simulation } from '../../../src/sim/sim';

function workday(sim: Simulation): void {
  for (let i = 0; i < 400; i++) {
    if (Math.floor(sim.absDay) % 4 !== 3 && sim.absDay % 1 > 0.3 && sim.absDay % 1 < 0.45) return;
    sim.advanceHours(1);
  }
}

/** Runs a job to its end (or `max` simulated seconds), counting its bouts. */
function runJob(sim: Simulation, o: ActionOption, max = 600): { bouts: number; jobDone: boolean; seconds: number } {
  const me = sim.state.run.playerId;
  let bouts = 0, jobDone = false;
  const off = sim.actions.onEvent((e) => { if (e.type === 'completed' && e.actor === me) { bouts++; if (e.jobDone) jobDone = true; } });
  expect(sim.actions.start(me, o).ok).toBe(true);
  let t = 0;
  while (sim.actions.active(me) && t < max) { sim.step(1 / 20); t += 1 / 20; }
  off();
  return { bouts, jobDone, seconds: t };
}

describe('jobs: one action is one job', () => {
  it('counts a job: a one-off, a job of bouts, an open-ended job', () => {
    const base = { id: 'x', provider: 'p', label: 'X', category: 'work', target: { kind: 'self' }, enabled: true, seconds: 10, range: 5, priority: 1 } as ActionOption;
    expect(jobBouts({ ...base })).toBe(1);
    expect(jobBouts({ ...base, repeat: true, bouts: 3 })).toBe(3);
    expect(jobBouts({ ...base, repeat: true, open: true })).toBeNull();
    expect(jobBouts({ ...base, repeat: true })).toBeNull();
    const v = jobViewOf({ option: { ...base, repeat: true, bouts: 2 }, elapsed: 4, progress: 0.4, job: { bout: 1, bouts: 2, label: 'Dig a bed' } });
    expect(v.secondsLeft).toBeCloseTo(16);
    expect(v.progress).toBeCloseTo(0.2);
    // the bar tells the whole job, at the speed the player waits it out
    const bar = jobBarView(v, 8);
    expect(bar.bout).toMatch(/Bout 1 of 2/);
    expect(bar.secondsLeft).toBe(2);
    expect(jobBarView({ ...v, bouts: null }, 1).bout).toMatch(/until you stop/);
  });

  it('digs a garden bed in two bouts and stops; the bar counts both; the bed is drawn as it is dug', () => {
    const { sim, eco } = econSim({ seed: 'job-garden' });
    const { player, hh } = makeFarmer(sim, { age: 20, strips: 1 });
    workday(sim);
    const home = { kind: 'building', id: hh.home } as const;
    const dig = find(optionsFor(sim, home), 'garden.dig')!;
    expect(dig, 'the home offers to dig a bed').toBeTruthy();
    expect(dig.enabled, dig.reason).toBe(true);
    expect(dig.bouts).toBe(2);
    const me = player.id;
    sim.actions.start(me, dig);
    const j0 = sim.actions.job(me)!;
    expect(j0.bouts).toBe(2);
    expect(j0.secondsLeft).toBeCloseTo(dig.seconds * 2, 0);
    // half way through the first bout the bed is being dug (a quarter turned)
    for (let t = 0; t < dig.seconds * 0.6; t += 1 / 20) sim.step(1 / 20);
    const props = (): string[] => eco.econ.sim.view.worldProps().filter((p) => /bed/.test(p.kind) && p.id >= 1e10 + hh.id * 32 && p.id < 1e10 + hh.id * 32 + 32).map((p) => `${p.kind}:${p.count}`);
    expect(props()).toEqual(['garden_bed:1']);
    sim.actions.cancel(me);
    // finish it: the rest of the job, then nothing more
    const rest = find(optionsFor(sim, home), 'garden.dig')!;
    expect(rest.label).toBe('Finish digging the bed');
    const r = runJob(sim, rest);
    expect(r.bouts).toBe(2);
    expect(r.jobDone).toBe(true);
    expect(sim.actions.active(me)).toBeNull();
    expect(props()).toEqual(['garden_bed:4']);
    // sow it: one bout; drills with seed; then it grows and shows
    const sow = optionsFor(sim, home).find((o) => o.id.startsWith('garden.sow.') && o.enabled)!;
    expect(runJob(sim, sow).bouts).toBe(1);
    expect(props()).toEqual(['garden_bed:5']);
    sim.advanceHours(24);
    expect(props()[0]).toMatch(/^bed_\w+:[1-8]$/);
  });

  it('works a strip task as one job of the bouts it still needs; "Keep working the strip" is its own open-ended choice', () => {
    const { sim } = econSim({ seed: 'job-strip' });
    const { player, strips } = makeFarmer(sim, { age: 20, strips: 1 });
    workday(sim);
    const target = { kind: 'strip', id: strips[0] } as const;
    const opts = optionsFor(sim, target);
    const task = opts.find((o) => o.enabled && o.repeat && o.bouts !== undefined && o.id !== 'farm.keep' && o.seconds > 0);
    expect(task, opts.map((o) => `${o.id} ${o.enabled} ${o.reason}`).join("; ")).toBeTruthy();
    if (!task) return;
    const keep = find(opts, 'farm.keep');
    expect(keep, 'the open-ended choice is offered').toBeTruthy();
    expect(keep!.open).toBe(true);
    expect(keep!.label).toMatch(/Keep working/);
    expect(keep!.priority).toBeLessThan(task.priority);
    const n = task.bouts!;
    const r = runJob(sim, task, 60 * 20);
    expect(r.bouts).toBeLessThanOrEqual(n);
    expect(r.jobDone).toBe(true);
    expect(sim.actions.active(player.id)).toBeNull();
  });

  it('a craft batch is one bout: it does not start again by itself', () => {
    const { sim } = econSim({ seed: 'job-craft' });
    const { hh } = makeFarmer(sim, { age: 20, strips: 1 });
    workday(sim);
    hh.stores.flour = 40; hh.stores.firewood = 10; sim.state.touchHousehold(hh);
    const bake = optionsFor(sim, { kind: 'building', id: hh.home }).find((o) => o.id === 'craft.bake_bread' && o.enabled);
    expect(bake, "bake").toBeTruthy();
    if (!bake) return;
    expect(bake.bouts).toBe(1);
    const r = runJob(sim, bake);
    expect(r.bouts).toBe(1);
    expect(r.jobDone).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import type { ActionOption } from '../../src/sim/actions';
import { newSim } from './helpers';

describe('the action runner and the worker\'s hand (mini-games)', () => {
  it('good strokes bring the end of a bout nearer, and the provider reads the hand when it is done', () => {
    const sim = newSim({ seed: 'mini' });
    const me = sim.state.run.playerId;
    let seen = -2;
    sim.actions.register({
      id: 'test',
      list: (_c, _a, target, out) => { out.push({ id: 'work', provider: 'test', label: 'Work', category: 'work', target, enabled: true, seconds: 20, range: 99, priority: 1, anim: 'work_hammer' }); },
      complete: (_c, actor) => { seen = sim.actions.performance(actor); return { ok: true, message: 'Done.' }; },
    });
    const opt = sim.actions.list(me, { kind: 'self' }).find((o) => o.provider === 'test') as ActionOption;
    expect(sim.actions.start(me, opt).ok).toBe(true);
    for (let i = 0; i < 4; i++) sim.actions.perform(me, 1);
    const a = sim.actions.active(me)!;
    expect(a.progress).toBeGreaterThan(0.15);
    expect(a.perf).toBe(1);
    sim.actions.perform(me, 0);
    expect(sim.actions.active(me)!.perf).toBeCloseTo(0.8);
    let message = '';
    sim.actions.onEvent((e) => { if (e.type === 'completed') message = e.outcome.message ?? ''; });
    sim.actions.tick(30);
    expect(seen).toBeCloseTo(0.8);
    expect(message).toMatch(/Good work/);
    // unplayed: the hand is unknown (−1) and nothing changes
    expect(sim.actions.start(me, opt).ok).toBe(true);
    sim.actions.tick(30);
    expect(seen).toBe(-1);
  });
});

// Training is counted (docs/WORK.md): the pell, sparring and the yard target are jobs of so many rounds that stop, the pell
// is also offered openly; a bound wound shows on the body (the look's bandages) and the wound panel says so.
import { describe, expect, it } from 'vitest';
import { PELL_ROUNDS, SPAR_BOUTS, TARGET_ROUNDS } from '../../src/combat/actions';
import { bagAdd } from '../../src/sim/economy/items';
import { adultMen, combatRig } from './helpers';

function yardOf(r: ReturnType<typeof combatRig>): number {
  let yard = [...r.sim.state.buildings.values()].find((b) => b.kind === 'training_yard');
  if (!yard) {
    const src = [...r.sim.state.buildings.values()][0];
    yard = { ...src, id: r.sim.state.nextBuildingId++, plot: -1, kind: 'training_yard', household: 0 };
    r.sim.state.buildings.set(yard.id, yard);
  }
  return yard.id;
}

describe('counted training', () => {
  it('the pell is six rounds that stop; the open choice goes on; sparring and the target are counted', () => {
    const r = combatRig({ seed: 'train-jobs', player: true });
    const pid = r.sim.state.run.playerId;
    const me = r.sim.state.persons.get(pid)!;
    me.needs.hunger = 1;
    const yard = yardOf(r);
    bagAdd(me.inventory, 'longbow#1', 1);
    bagAdd(me.inventory, 'arrow#1', 24);
    const yb = r.sim.state.buildings.get(yard)!;
    r.player!.placeAt(yb.x + 2, yb.z + 2);
    r.sim.step(1 / 20);
    const opts = r.sim.actions.list(pid, { kind: 'building', id: yard });
    const pell = opts.find((o) => o.id === 'pell')!;
    expect(pell.bouts).toBe(PELL_ROUNDS);
    const keep = opts.find((o) => o.id === 'pell.keep')!;
    expect(keep.open).toBe(true);
    expect(keep.bouts).toBeUndefined();
    expect(opts.find((o) => o.id === 'target')?.bouts).toBe(TARGET_ROUNDS);
    // run the pell job: exactly its rounds, the last one says the job is done
    let bouts = 0, jobDone = false;
    r.sim.actions.onEvent((e) => { if (e.type === 'completed' && e.actor === pid) { bouts++; if (e.jobDone) jobDone = true; } });
    expect(r.sim.actions.start(pid, pell).ok).toBe(true);
    for (let i = 0; i < 20 * 120 && r.sim.actions.active(pid); i++) r.sim.step(1 / 20);
    expect(bouts).toBe(PELL_ROUNDS);
    expect(jobDone).toBe(true);
    expect(r.sim.actions.active(pid)).toBeNull();
    const [mate] = adultMen(r.sim, 1);
    mate.career = 'soldier';
    const spar = r.sim.actions.list(pid, { kind: 'person', id: mate.id }).find((o) => o.id === 'spar')!;
    expect(spar.bouts).toBe(SPAR_BOUTS);
    const job = (() => { r.sim.actions.start(pid, spar); return r.sim.actions.job(pid)!; })();
    expect(job.bouts).toBe(SPAR_BOUTS);
    expect(job.secondsLeft).toBeCloseTo(spar.seconds * SPAR_BOUTS, 0);
  });
});

describe('a bound wound shows', () => {
  it('binding puts linen on the part where the wound is, in the look, and takes it off when the wound is gone', () => {
    const r = combatRig({ seed: 'bandage', player: true });
    const pid = r.sim.state.run.playerId;
    const me = r.sim.state.persons.get(pid)!;
    const look = () => r.sim.view.appearance.get(r.sim.state, me, r.sim.absDay);
    expect(look().look.bandages).toBeUndefined();
    const v0 = look().version;
    r.combat.book.inflict(me, { location: 'arm_l', kind: 'cut', damage: 20, severity: 0.3, bleeding: true, rate: 0.003, fracture: false, mortal: false, stun: 0 }, 'axe');
    // open: nothing yet
    expect(look().look.bandages).toBeUndefined();
    const bind = r.sim.actions.list(pid, { kind: 'self' }).find((o) => o.id === 'bind')!;
    expect(bind.enabled).toBe(true);
    r.sim.actions.start(pid, { ...bind, seconds: 0 });
    const l = look();
    expect(l.look.bandages! & 4).toBe(4); // the left arm
    expect(l.look.bandages! & ~4).toBe(0);
    expect(l.version).toBeGreaterThan(v0);
    // a wound on the head is bound too
    r.combat.book.inflict(me, { location: 'head', kind: 'blunt', damage: 10, severity: 0.2, bleeding: false, rate: 0, fracture: false, mortal: false, stun: 0 }, 'club');
    r.combat.tend!(pid, pid);
    expect(look().look.bandages! & 1).toBe(1);
  });
});

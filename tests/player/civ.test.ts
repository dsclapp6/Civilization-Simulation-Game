// The player's body in the civilization pass (docs/CIV.md §3, §4, §8, §9): restraints (led behind a captor, held in a cell, escorted), the
// four gaits of a horse and the rules of who may ride what, the call of the horse (hold F), and the steps of a bout played on the body
// with what they throw up.
import { describe, expect, it } from 'vitest';
import { RIDE_CANTER, RIDE_GALLOP, RIDE_TROT, RIDE_WALK, GALLOP_AFTER, pickRideGait, rideAnim, rideSpeed } from '../../src/player/movement';
import { SIM_DT } from '../../src/core/time';
import type { ActionOption, ActionProvider } from '../../src/sim/actions';
import type { Person } from '../../src/sim/state';
import { FakeZone, input, rig, run, workProvider, type Rig } from './fakes';

const person = (r: Rig): Person => r.sim.state.persons.get(r.sim.state.run.playerId)!;
function tap(r: Rig, key: 'interact' | 'mount' | 'dodge' | 'cancel', extra: Record<string, unknown> = {}): void {
  r.player.setInput(input({ [key]: true, ...extra }));
  r.sim.step(SIM_DT);
  r.player.frame?.(SIM_DT);
}

describe('restraints', () => {
  it('a body held in a cell does not move to the keys, cannot work, ride or draw, and shows the bound clip', () => {
    const r = rig();
    const b0 = { ...r.player.body()! };
    r.player.restrain!({ kind: 'held', x: b0.x + 3, z: b0.z + 3, building: 4, reason: 'Held in the gaol of Dromore' });
    expect(r.player.restraint!()).toMatchObject({ kind: 'held' });
    expect(r.player.hud()!.restraint).toMatchObject({ reason: 'Held in the gaol of Dromore' });
    run(r, 2, { forward: 1, sprint: true });
    const b = r.player.body()!;
    expect(b.x).toBeCloseTo(b0.x + 3, 1);
    expect(b.z).toBeCloseTo(b0.z + 3, 1);
    expect(r.zone.attached!.draw.anim).toBe('bound');
    // no weapon, no horse
    r.player.setDrawn!(true);
    expect(r.player.drawn!()).toBe(false);
    r.zone.addAnimal(900, 'horse', b.x + 1, b.z, person(r).household);
    tap(r, 'mount');
    expect(r.player.mounted!()).toBe(false);
    expect(r.player.mountHorse!().ok).toBe(false);
    // work is refused: only speech, society and rest are allowed
    const work: ActionOption = { id: 'w', provider: 'x', label: 'Work', category: 'work', target: { kind: 'self' }, enabled: true, seconds: 3, range: 99, priority: 1 };
    expect(r.player.perform(work)).toMatchObject({ ok: false, message: 'You are bound.' });
    expect(r.player.goTo!({ target: { kind: 'ground', x: b.x + 10, z: b.z }, x: b.x + 10, z: b.z, label: 'there' }).ok).toBe(false);
    expect(r.player.travelTo(2).ok).toBe(false);
    // freed, he moves again
    r.player.restrain!(null);
    expect(r.player.hud()!.restraint).toBeNull();
    run(r, 1.5, { forward: 1, cameraYaw: 0 });
    expect(Math.hypot(r.player.body()!.x - (b0.x + 3), r.player.body()!.z - (b0.z + 3))).toBeGreaterThan(1);
  });

  it('a body led walks behind his captor at his pace, with the bound-walk clip, and stands when he stands', () => {
    const r = rig();
    const b0 = { ...r.player.body()! };
    const captor = r.zone.addAgent(321, b0.x + 6, b0.z);
    r.player.restrain!({ kind: 'led', by: 321, reason: 'Bound and led to the gaol of Dromore' });
    // the keys do nothing; the body follows the leader, who walks east at 1.0 m/s (the twelve-year-old of the rig walks a little slower than a man)
    let maxSpeed = 0;
    const clips = new Set<string>();
    for (let i = 0; i < 20 * 24; i++) {
      captor.x += 1.0 / 20; captor.speed = 1.0;
      r.player.setInput(input({ forward: -1, cameraYaw: 0 }));
      r.sim.step(SIM_DT);
      r.player.frame?.(SIM_DT);
      maxSpeed = Math.max(maxSpeed, r.player.hud()!.speed ?? 0);
      clips.add(r.zone.attached!.draw.anim);
    }
    const b = r.player.body()!;
    const gap = Math.hypot(captor.x - b.x, captor.z - b.z);
    expect(gap).toBeLessThan(6);
    expect(gap).toBeGreaterThan(1.2);
    // behind him, never past him
    expect(b.x).toBeLessThan(captor.x);
    expect(b.x).toBeGreaterThan(b0.x + 12);
    expect(maxSpeed).toBeLessThan(1.8);
    expect(clips.has('bound_walk')).toBe(true);
    // the leader stops: so does he, bound and still
    run(r, 6, {});
    expect(r.zone.attached!.draw.anim).toBe('bound');
    expect(r.player.hud()!.speed!).toBeLessThan(0.1);
    // a captor who is out of the open (gone in at a door) leaves him standing
    r.zone.agentList.splice(r.zone.agentList.indexOf(captor), 1);
    const x = r.player.body()!.x;
    run(r, 3, {});
    expect(Math.abs(r.player.body()!.x - x)).toBeLessThan(0.3);
  });

  it('an escorted body is walked to the point, and stops there', () => {
    const r = rig();
    const b0 = { ...r.player.body()! };
    r.player.restrain!({ kind: 'escorted', by: 321, toX: b0.x + 12, toZ: b0.z, reason: 'Escorted off the land' });
    run(r, 14, { forward: -1 });
    const b = r.player.body()!;
    expect(Math.hypot(b.x - (b0.x + 12), b.z - b0.z)).toBeLessThan(2);
    expect(r.zone.attached!.draw.anim).toBe('bound');
  });

  it('is taken off the saddle when he is bound, and does not outlive the character (a new body is free)', () => {
    const r = rig();
    const p = person(r);
    const b = r.player.body()!;
    r.zone.addAnimal(500, 'horse', b.x + 2, b.z, p.household);
    tap(r, 'mount');
    run(r, 2, {});
    expect(r.player.mounted!()).toBe(true);
    r.player.restrain!({ kind: 'held', x: b.x, z: b.z, building: -1, reason: 'Held' });
    expect(r.player.mounted!()).toBe(false);
    expect(r.zone.releasedAnimals.length).toBe(1);
    expect(r.zone.attached!.draw.mount).toBeUndefined();
  });
});

describe('the gaits of a horse', () => {
  it('walk 1.7, trot 3.5 (the default), canter 6 (Shift), gallop 10 (Shift held on); X walks', () => {
    expect([RIDE_WALK, RIDE_TROT, RIDE_CANTER, RIDE_GALLOP]).toEqual([1.7, 3.5, 6, 10]);
    expect(rideSpeed('walk')).toBe(1.7);
    expect(rideSpeed('canter')).toBe(6);
    expect(pickRideGait({ sprint: false, walkToggle: false, exhausted: false, stamina: 50 })).toBe('trot');
    expect(pickRideGait({ sprint: true, walkToggle: false, exhausted: false, stamina: 50 })).toBe('canter');
    expect(pickRideGait({ sprint: true, walkToggle: false, exhausted: false, stamina: 50, sprintHeld: GALLOP_AFTER + 0.1 })).toBe('gallop');
    expect(pickRideGait({ sprint: true, walkToggle: true, exhausted: false, stamina: 50, sprintHeld: 5 })).toBe('walk');
    expect(pickRideGait({ sprint: true, walkToggle: false, exhausted: true, stamina: 0, sprintHeld: 5 })).toBe('trot');
    expect(rideAnim(1.7)).toEqual({ human: 'ride_walk', horse: 'walk' });
    expect(rideAnim(3.5).horse).toBe('trot');
    expect(rideAnim(6).human).toBe('ride_gallop');
    expect(rideAnim(10).horse).toBe('gallop');
  });

  it('in the saddle: the horse trots, Shift canters and held on gallops, let go and it comes back to a trot; the lance wants a canter', () => {
    const r = rig();
    const p = person(r);
    const b = r.player.body()!;
    r.zone.addAnimal(500, 'horse', b.x + 2, b.z, p.household);
    tap(r, 'mount');
    run(r, 2, {});
    run(r, 4, { forward: 1 });
    expect(r.player.hud()!.speed!).toBeGreaterThan(RIDE_TROT * 0.8);
    expect(r.player.hud()!.speed!).toBeLessThan(RIDE_TROT * 1.15);
    expect(r.player.hud()!.gait).toBe('trot');
    // a trot is slower than the couched lance asks (4.5 m/s)
    expect(RIDE_TROT).toBeLessThan(4.5);
    expect(RIDE_CANTER).toBeGreaterThanOrEqual(4.5);
    run(r, 0.9, { forward: 1, sprint: true });
    expect(r.player.hud()!.gait).toBe('canter');
    // the canter is faster than the trot, within a gallop's reach
    expect(r.player.hud()!.speed!).toBeGreaterThan(RIDE_TROT);
    expect(r.player.hud()!.speed!).toBeLessThan(RIDE_CANTER * 1.2);
    run(r, 4, { forward: 1, sprint: true });
    expect(r.player.hud()!.gait).toBe('gallop');
    expect(r.player.hud()!.speed!).toBeGreaterThan(RIDE_GALLOP * 0.8);
    expect(r.zone.attached!.draw.anim).toBe('ride_gallop');
    run(r, 4, { forward: 1 });
    expect(r.player.hud()!.gait).toBe('trot');
  });
});

describe('who may ride what', () => {
  it('the household\'s horse; the lord\'s horse for a man of his House in his service; not a neighbour\'s, not a stranger\'s', () => {
    const r = rig();
    const p = person(r);
    const st = r.sim.state;
    const b = r.player.body()!;
    // a garrison household of the player's own House: its horse is the lord's, and he serves
    const lordHh = st.addHousehold({ id: st.households.alloc(), kind: 'garrison', head: 0, members: [], home: -1, settlement: p.settlement, purse: 0, stores: {}, house: p.house });
    // a neighbour's household, a peasant family
    const neighbourHh = st.addHousehold({ id: st.households.alloc(), kind: 'family', head: 0, members: [], home: -1, settlement: p.settlement, purse: 0, stores: {} });
    p.birthDay = r.sim.absDay - 16 * 20;
    r.zone.addAnimal(600, 'horse', b.x + 2, b.z, p.household);
    r.zone.addAnimal(601, 'horse', b.x + 3, b.z, lordHh.id);
    r.zone.addAnimal(602, 'horse', b.x + 4, b.z, neighbourHh.id);
    r.zone.addAnimal(603, 'horse', b.x + 5, b.z, 0);
    const opt = (id: number): ActionOption => r.sim.actions.list(p.id, { kind: 'animal', id }).find((o) => o.id === 'mount')!;
    expect(opt(600).enabled).toBe(true);
    expect(opt(601).enabled).toBe(true);
    expect(opt(602).enabled).toBe(false);
    expect(opt(602).reason).toMatch(/not your household/);
    expect(opt(603).enabled).toBe(false);
    expect(opt(603).reason).toMatch(/no one you know/);
    // a man of another House is not in the lord's service
    p.house = p.house + 1000;
    expect(opt(601).enabled).toBe(false);
    expect(opt(601).reason).toMatch(/lord's horse/);
  });
});

describe('the horse call (hold F)', () => {
  it('asks the zone for the household\'s horse when none is by, and says so; F with a horse by just mounts', () => {
    const calls: number[] = [];
    const r = rig({ zone: (z: FakeZone) => { z.callHorse = (person) => { calls.push(person); return { ok: true, eta: 24 }; }; } });
    const notes: string[] = [];
    r.sim.events.on('notify', (n) => notes.push(n.text));
    tap(r, 'mount');
    expect(notes.some((t) => /Hold F to call/.test(t))).toBe(true);
    expect(r.player.callHorse!()).toEqual({ ok: true });
    expect(calls).toEqual([r.pid]);
    expect(notes.some((t) => /whistle/.test(t) && /24/.test(t))).toBe(true);
    expect(r.player.hud()!.horseCall).toEqual({ eta: 24 });
    run(r, 5, {});
    expect(r.player.hud()!.horseCall!.eta).toBeLessThanOrEqual(20);
    // with the horse by, there is nothing to call
    const p = person(r);
    const b = r.player.body()!;
    r.zone.addAnimal(500, 'horse', b.x + 2, b.z, p.household);
    expect(r.player.callHorse!()).toMatchObject({ ok: false });
    expect(calls.length).toBe(1);
  });

  it('passes the zone\'s refusal on (no horse, too far), and is refused in the saddle or in chains', () => {
    const r = rig({ zone: (z: FakeZone) => { z.callHorse = () => ({ ok: false, reason: 'Your horse is too far off to hear you; call it when you are nearer.' }); } });
    const res = r.player.callHorse!();
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/too far/);
    expect(r.player.hud()!.horseCall).toBeNull();
    r.player.restrain!({ kind: 'held', x: 0, z: 0, building: -1, reason: 'Held' });
    expect(r.player.callHorse!()).toEqual({ ok: false, reason: 'You are bound.' });
  });

  it('is told, when a horse is bought at a market, that it is the household\'s now', () => {
    const r = rig();
    const notes: string[] = [];
    r.sim.events.on('notify', (n) => notes.push(n.text));
    r.sim.events.emit('trade', { buyer: r.pid, seller: 99, settlement: 0, item: 'horse#2', qty: 1, pence: 300 });
    expect(notes.some((t) => /household/.test(t) && /Hold F/.test(t))).toBe(true);
    notes.length = 0;
    r.sim.events.emit('trade', { buyer: r.pid, seller: 99, settlement: 0, item: 'wheat', qty: 3, pence: 3 });
    expect(notes).toEqual([]);
  });
});

describe('the steps of a bout', () => {
  const stepped = (r: Rig): ActionProvider => ({
    id: 'forge',
    list(_c, actor, target, out) {
      if (target.kind === 'self') return;
      out.push({
        id: 'forge', provider: '', label: 'Forge a blade', category: 'work', target, enabled: true, seconds: 10, anim: 'work_hammer', mainHand: 'hammer', range: 3, priority: 5,
        steps: [
          { share: 0.3, label: 'Heat the bar', anim: 'work_lift', mainHand: 'tongs', sfx: 'bellows' },
          { share: 0.4, label: 'Draw it out', anim: 'work_hammer', mainHand: 'hammer', offHand: 'tongs', sfx: 'hammer' },
          { share: 0.3, label: 'Quench', anim: 'work_lift', mainHand: 'tongs', sfx: 'quench' },
        ],
      });
    },
    complete() { return { ok: true, message: 'You forge a blade.' }; },
    partial: true,
  });

  it('play each step\'s clip and items in turn, tell the HUD which step it is, and throw up sparks, steam and smoke on entering them', () => {
    const r = rig();
    r.sim.actions.register(stepped(r));
    const b = r.player.body()!;
    r.zone.things.push({ target: { kind: 'building', id: 3 }, x: b.x + Math.sin(b.yaw) * 1.5, z: b.z + Math.cos(b.yaw) * 1.5, label: 'Anvil' });
    run(r, 0.5, {});
    const opt = r.sim.actions.list(r.pid, { kind: 'building', id: 3 }).find((o) => o.id === 'forge')!;
    expect(r.player.perform(opt).ok).toBe(true);
    const seen: Array<{ step: number; label: string; anim: string; main: string; off: string; sfx?: string }> = [];
    const fx: string[] = [];
    for (let i = 0; i < 20 * 9.5; i++) {
      r.player.setInput(input({}));
      r.sim.step(SIM_DT);
      r.player.frame?.(SIM_DT);
      const h = r.player.hud()!;
      const d = r.zone.attached!.draw;
      if (h.action?.step && seen[seen.length - 1]?.step !== h.action.step.index) {
        seen.push({ step: h.action.step.index, label: h.action.step.label, anim: d.anim, main: d.mainHand, off: d.offHand, sfx: h.action.step.sfx });
      }
      for (const e of r.sim.view.drainFx()) fx.push(e.kind);
    }
    expect(seen.map((s) => s.label)).toEqual(['Heat the bar', 'Draw it out', 'Quench']);
    expect(seen.map((s) => s.anim)).toEqual(['work_lift', 'work_hammer', 'work_lift']);
    expect(seen.map((s) => s.main)).toEqual(['tongs', 'hammer', 'tongs']);
    expect(seen[1].off).toBe('tongs');
    expect(seen.map((s) => s.sfx)).toEqual(['bellows', 'hammer', 'quench']);
    // the bellows blow sparks and smoke, the hammer on hot iron strikes sparks, the quench steams
    expect(fx).toContain('smoke');
    expect(fx).toContain('sparks');
    expect(fx).toContain('steam');
    // sparks come over and over while the hammer works (not just once)
    expect(fx.filter((k) => k === 'sparks').length).toBeGreaterThan(4);
    expect(fx.filter((k) => k === 'steam').length).toBeGreaterThanOrEqual(1);
  });

  it('a bout without steps keeps its one clip and throws nothing up', () => {
    const r = rig();
    r.sim.actions.register(workProvider({ seconds: 3 }));
    const b = r.player.body()!;
    r.zone.things.push({ target: { kind: 'strip', id: 7 }, x: b.x + Math.sin(b.yaw) * 1.5, z: b.z + Math.cos(b.yaw) * 1.5, label: 'Strip' });
    run(r, 0.5, {});
    const opt = r.sim.actions.list(r.pid, { kind: 'strip', id: 7 }).find((o) => o.id === 'work')!;
    expect(r.player.perform(opt).ok).toBe(true);
    run(r, 1, {});
    expect(r.zone.attached!.draw.anim).toBe('work_hoe');
    expect(r.player.hud()!.action!.step).toBeUndefined();
    expect(r.sim.view.drainFx().length).toBe(0);
  });
});

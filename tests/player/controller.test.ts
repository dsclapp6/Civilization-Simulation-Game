import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../../src/core/time';
import type { ActionOption, ActionProvider } from '../../src/sim/actions';
import { killPerson } from '../../src/sim/succession';
import { doorPoint } from '../../src/sim/view-impl';
import type { Person } from '../../src/sim/state';
import { FakeZone, input, rig, run, workProvider, type Rig } from './fakes';

const angleDiffTo = (a: number, b: number): number => Math.atan2(Math.sin(b - a), Math.cos(b - a));
const person = (r: Rig): Person => r.sim.state.persons.get(r.sim.state.run.playerId)!;

/** One frame carrying an edge-triggered key. */
function tap(r: Rig, key: 'interact' | 'mount' | 'dodge' | 'cancel', extra: Record<string, unknown> = {}): void {
  r.player.setInput(input({ [key]: true, ...extra }));
  r.sim.step(SIM_DT);
  r.player.frame?.(SIM_DT);
}

describe('attachment and spawning', () => {
  it('puts the body at the home door, attaches the draw item to the zone and feeds the view', () => {
    const r = rig();
    const p = person(r);
    const hh = r.sim.state.households.get(p.household)!;
    const door = doorPoint(r.sim.state.buildings.get(hh.home)!, 1.6);
    const body = r.player.body()!;
    expect(body.x).toBeCloseTo(door.x, 1);
    expect(body.z).toBeCloseTo(door.z, 1);
    expect(r.zone.attached?.person).toBe(p.id);
    expect(r.zone.attached?.draw.highlight).toBe(3);
    expect(r.zone.attached?.draw.id).toBe(p.id);
    const v = r.sim.view.player()!;
    expect(v.personId).toBe(p.id);
    expect(v.alive).toBe(true);
    expect(r.sim.view.focus().x).toBeCloseTo(door.x, 1);
    expect(r.sim.view.mode()).toBe('street');
    expect(r.zone.resyncCount).toBeGreaterThan(0);
  });

  it('hands the HUD a model of the character', () => {
    const r = rig();
    const h = r.player.hud()!;
    expect(h.personId).toBe(r.pid);
    expect(h.name.length).toBeGreaterThan(2);
    expect(h.age).toBe(12);
    expect(h.maxStamina).toBeGreaterThan(50);
    expect(h.stamina).toBe(h.maxStamina);
    expect(h.maxHp).toBeGreaterThan(40);
    expect(h.hp).toBe(h.maxHp);
    expect(h.prompt).toBeNull();
    expect(h.action).toBeNull();
    expect(h.travel).toBeNull();
    expect(h.mounted).toBe(false);
  });
});

describe('moving and drawing', () => {
  it('moves with input and animates run → idle', () => {
    const r = rig();
    const z0 = r.player.body()!.z;
    run(r, 2, { forward: 1 });
    expect(r.player.body()!.z).toBeGreaterThan(z0 + 4);
    const d = r.zone.attached!.draw;
    expect(d.anim).toBe('run');
    expect(d.moveSpeed).toBeGreaterThan(2.5);
    run(r, 1, {});
    expect(d.anim).toBe('idle');
    expect(d.moveSpeed).toBe(0);
  });

  it('smooths the 20 Hz steps across 60 fps frames', () => {
    const r = rig();
    const d = r.zone.attached!.draw;
    const zs: number[] = [];
    for (let i = 0; i < 90; i++) {
      r.player.setInput(input({ forward: 1 }));
      r.sim.step(1 / 60);
      r.player.frame!(1 / 60);
      zs.push(d.z);
    }
    let maxJump = 0, minJump = Infinity;
    for (let i = 20; i < zs.length; i++) { const j = zs[i] - zs[i - 1]; maxJump = Math.max(maxJump, j); minJump = Math.min(minJump, j); }
    // steady running at 3.2 m/s is 0.053 m per frame; without interpolation it would be 0, 0, 0.16
    expect(minJump).toBeGreaterThan(0.03);
    expect(maxJump).toBeLessThan(0.075);
  });

  it('keeps edge keys until a sub-step consumes them and drops them while paused', () => {
    const r = rig();
    const w = workProvider();
    r.sim.actions.register(w);
    r.zone.things = [{ target: { kind: 'scatter', id: 0 }, x: r.player.body()!.x + Math.sin(r.player.body()!.yaw) * 1.5, z: r.player.body()!.z + Math.cos(r.player.body()!.yaw) * 1.5, label: 'Strip' }];
    run(r, 0.3, {});
    r.sim.step(0.001); // no sub-step runs in this frame
    r.player.setInput(input({ interact: true }));
    r.sim.step(0.001);
    expect(w.started).toBe(0);
    r.player.setInput(input());
    r.sim.step(SIM_DT);
    expect(w.started).toBe(1);

    r.sim.dispatch({ type: 'pause' });
    r.player.setInput(input({ mount: true, interact: true }));
    r.sim.step(0.1);
    r.player.frame!(0.1);
    r.sim.dispatch({ type: 'resume' });
    r.sim.step(SIM_DT);
    expect(w.started).toBe(1);
  });
});

/** Puts something to act on 1.5 m in front of the body. */
function facing(r: Rig, label = 'Strip of barley', id = 3): void {
  const b = r.player.body()!;
  r.zone.things = [{ target: { kind: 'scatter', id }, x: b.x + Math.sin(b.yaw) * 1.5, z: b.z + Math.cos(b.yaw) * 1.5, label }];
}

describe('targets, prompts and actions', () => {
  it('targets what is in front, names the default action and lists the rest', () => {
    const r = rig();
    r.sim.actions.register(workProvider());
    facing(r);
    run(r, 0.3, {});
    const t = r.player.target()!;
    expect(t.target).toEqual({ kind: 'scatter', id: 3 });
    expect(t.label).toBe('Strip of barley');
    const h = r.player.hud()!;
    expect(h.prompt).toEqual({ label: 'Work', targetLabel: 'Strip of barley', enabled: true, reason: undefined });
    expect(r.player.options().map((o) => o.label)).toEqual(['Work', 'Chat']);
    // nothing in reach: no target, no prompt
    r.zone.things = [];
    run(r, 0.3, {});
    expect(r.player.target()).toBeNull();
    expect(r.player.hud()!.prompt).toBeNull();
  });

  it('shows a disabled prompt with its reason when nothing can be done', () => {
    const r = rig();
    const locked: ActionProvider = {
      id: 'locked', list(_c, _a, target, out) { out.push({ id: 'x', provider: '', label: 'Reap', category: 'work', target, enabled: false, reason: 'Needs a sickle', seconds: 3, range: 2.6, priority: 5 }); },
      complete: () => ({ ok: true }),
    };
    r.sim.actions.register(locked);
    facing(r);
    run(r, 0.3, {});
    const p = r.player.hud()!.prompt!;
    expect(p.enabled).toBe(false);
    expect(p.reason).toBe('Needs a sickle');
    tap(r, 'interact');
    expect(r.sim.actions.active(r.pid)).toBeNull();
  });

  it('skips targets that offer nothing in favour of ones that do', () => {
    const r = rig();
    r.sim.actions.register(workProvider());
    const b = r.player.body()!;
    r.zone.things = [
      { target: { kind: 'self' }, x: b.x, z: b.z, label: 'You' },
      { target: { kind: 'scatter', id: 9 }, x: b.x + 0.5, z: b.z + 0.5, label: 'Oak' },
    ];
    run(r, 0.3, {});
    // the provider offers work on scatter too, so the oak is chosen; 'self' is never a target
    expect(r.player.target()?.target.kind).toBe('scatter');
  });

  it('E starts the default action; the body plays its animation and props; progress shows in the HUD', () => {
    const r = rig();
    const w = workProvider({ seconds: 4 });
    r.sim.actions.register(w);
    facing(r);
    run(r, 0.3, {});
    tap(r, 'interact');
    expect(w.started).toBe(1);
    const d = r.zone.attached!.draw;
    expect(d.anim).toBe('work_hoe');
    expect(d.mainHand).toBe('hoe');
    run(r, 2, {});
    const h = r.player.hud()!;
    expect(h.action?.label).toBe('Work');
    expect(h.action!.progress).toBeGreaterThan(0.4);
    expect(h.action!.seconds).toBe(4);
    expect(h.stamina).toBeLessThan(h.maxStamina);
    run(r, 2.3, {});
    expect(w.done).toEqual([1]);
    expect(r.sim.actions.active(r.pid)).toBeNull();
    expect(d.anim).toBe('idle');
    expect(d.mainHand).toBe('none');
  });

  it('moving cancels a timed action with reason "moved"; the cancel key cancels it too; E again stops it', () => {
    const r = rig();
    const w = workProvider({ seconds: 6 });
    r.sim.actions.register(w);
    const reasons: string[] = [];
    r.sim.events.on('action', (e) => { if (e.type === 'cancelled') reasons.push(e.reason); });
    facing(r);
    run(r, 0.3, {});
    tap(r, 'interact');
    run(r, 1, {});
    expect(r.sim.actions.active(r.pid)).not.toBeNull();
    const z = r.player.body()!.z;
    run(r, 0.5, { forward: 1 });
    expect(reasons).toEqual(['moved']);
    expect(r.player.body()!.z).toBeGreaterThan(z);
    expect(w.done.length).toBe(1);
    expect(w.done[0]).toBeGreaterThan(0.1);
    expect(w.done[0]).toBeLessThan(0.5);

    facing(r);
    run(r, 0.3, {});
    tap(r, 'interact');
    run(r, 0.5, {});
    tap(r, 'cancel');
    expect(reasons).toEqual(['moved', 'cancelled']);
    tap(r, 'interact');
    run(r, 0.3, {});
    expect(r.sim.actions.active(r.pid)).not.toBeNull();
    tap(r, 'interact');
    expect(r.sim.actions.active(r.pid)).toBeNull();
  });

  it('refuses options whose target is out of range, and faces the target of a timed one', () => {
    const r = rig();
    r.sim.actions.register(workProvider());
    const b = { ...r.player.body()! };
    const gx = b.x + Math.sin(b.yaw) * 1.5, gz = b.z + Math.cos(b.yaw) * 1.5;
    r.zone.things = [{ target: { kind: 'ground', x: gx, z: gz }, x: gx, z: gz, label: 'Spot' }];
    run(r, 0.3, {});
    const far: ActionOption = { ...r.player.options()[0], target: { kind: 'ground', x: b.x + 30, z: b.z + 30 } };
    const res = r.player.perform(far);
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/too far/i);
    const near = r.player.options()[0];
    expect(r.player.perform(near).ok).toBe(true);
    run(r, 0.8, {});
    expect(Math.abs(angleDiffTo(r.player.body()!.yaw, Math.atan2(gx - b.x, gz - b.z)))).toBeLessThan(0.2); // faces the spot
  });

  it('highlights the person or animal in front and clears it when they leave', () => {
    const r = rig();
    r.sim.actions.register(workProvider());
    const b = { ...r.player.body()! };
    const npc = r.zone.addAgent(999, b.x + Math.sin(b.yaw) * 1.5, b.z + Math.cos(b.yaw) * 1.5);
    r.zone.things = [{ target: { kind: 'person', id: 999 }, x: npc.x, z: npc.z, label: 'Agnes' }];
    run(r, 0.3, { });
    expect(npc.draw.highlight).toBe(1);
    r.zone.things = [];
    run(r, 0.3, {});
    expect(npc.draw.highlight).toBe(0);
  });

  it('does not let heavy work be free: it costs stamina', () => {
    const r = rig();
    r.sim.actions.register(workProvider({ seconds: 20 }));
    facing(r, 'Strip', 1);
    run(r, 0.3, {});
    tap(r, 'interact');
    const before = r.player.hud()!.stamina;
    run(r, 10, {});
    expect(r.player.hud()!.stamina).toBeLessThan(before - 5);
  });
});

describe('conversation', () => {
  it('talkTo uses the Talk action when there is one and holds the partner for the conversation', () => {
    const r = rig();
    const talk: ActionProvider = {
      id: 'talk',
      list(_c, _a, target, out) { if (target.kind === 'person') out.push({ id: 'talk', provider: '', label: 'Talk', category: 'talk', target, enabled: true, seconds: 0, range: 3, priority: 9 }); },
      complete(ctx, actor, option) {
        const other = option.target.kind === 'person' ? option.target.id : 0;
        ctx.events.emit('conversation', { phase: 'start', id: 1, actor, with: other });
        return { ok: true, ui: { panel: 'dialogue', conversation: 1 } };
      },
    };
    r.sim.actions.register(talk);
    const b = r.player.body()!;
    const npc = r.zone.addAgent(777, b.x + 2, b.z);
    const ui: unknown[] = [];
    r.sim.events.on('ui', (u) => ui.push(u));
    expect(r.player.talkTo(777).ok).toBe(true);
    expect(ui).toEqual([{ panel: 'dialogue', conversation: 1 }]);
    expect(r.zone.held.get(777)).toBe(r.pid);
    r.sim.events.emit('conversation', { phase: 'end', id: 1, actor: r.pid, with: 777 });
    expect(r.zone.released).toContain(777);
    // too far or not around
    npc.x += 40;
    expect(r.player.talkTo(777).ok).toBe(false);
    expect(r.player.talkTo(123456).ok).toBe(false);
  });

  it('starts a conversation through whatever the social module offers (its Talk action, or its API)', () => {
    const r = rig();
    const b = r.player.body()!;
    r.zone.addAgent(55, b.x + 1, b.z);
    const social = r.social as unknown as { start: (a: number, b: number) => unknown };
    social.start = () => ({ id: 7, actor: r.pid, with: 55, lines: [], options: [], opinion: 0, opinionDelta: 0, mood: 'neutral', relation: '', ended: false });
    const ui: unknown[] = [];
    r.sim.events.on('ui', (u) => ui.push(u));
    expect(r.player.talkTo(55).ok).toBe(true);
    expect(ui.length).toBe(1);
    expect((ui[0] as { panel: string }).panel).toBe('dialogue');
  });

  it('stands still while the player is in a conversation', () => {
    const r = rig();
    const social = r.social as unknown as { current: () => unknown };
    social.current = () => ({ id: 1, actor: r.pid, with: 2, ended: false, lines: [], options: [] });
    const z = r.player.body()!.z;
    run(r, 1, { forward: 1 });
    expect(r.player.body()!.z).toBeCloseTo(z, 3);
  });
});

describe('own actions', () => {
  it('offers sleep at the home door and starts a sleep skip', () => {
    const r = rig();
    const p = person(r);
    const home = r.sim.state.households.get(p.household)!.home;
    r.zone.things = [{ target: { kind: 'building', id: home }, x: r.player.body()!.x, z: r.player.body()!.z + 1, label: 'Your home' }];
    run(r, 0.3, {});
    const opts = r.player.options();
    expect(opts.map((o) => o.label)).toContain('Sleep until dawn');
    expect(opts.map((o) => o.label)).toContain('Rest or wait…');
    const ui: unknown[] = [];
    r.sim.events.on('ui', (u) => ui.push(u));
    const rest = opts.find((o) => o.id === 'rest')!;
    expect(r.player.perform(rest).ok).toBe(true);
    expect(ui).toEqual([{ panel: 'rest' }]);
    const sleep = opts.find((o) => o.id === 'sleep')!;
    expect(r.player.perform(sleep).ok).toBe(true);
    expect(r.sim.clock.skip?.kind).toBe('sleep');
    r.sim.step(0.05);
    r.player.frame!(0.05);
    expect(r.zone.attached!.draw.anim).toBe('sleep');
  });

  it('with nothing targeted the wheel offers self actions: rest and sit', () => {
    const r = rig();
    run(r, 0.3, {});
    const labels = r.player.options().map((o) => o.label);
    expect(labels).toContain('Rest or wait…');
    expect(labels).toContain('Sit down');
    const sit = r.player.options().find((o) => o.id === 'sit')!;
    r.player.perform(sit);
    run(r, 0.3, {});
    expect(r.zone.attached!.draw.anim).toBe('sit');
    const z = r.player.body()!.z;
    run(r, 0.5, { forward: 1 });
    expect(r.zone.attached!.draw.anim).not.toBe('sit');
    expect(r.player.body()!.z).toBeGreaterThan(z);
  });

  it('follows a person and stops when the player moves', () => {
    const r = rig();
    const b = { ...r.player.body()! };
    const npc = r.zone.addAgent(321, b.x + 12, b.z);
    const follow = r.sim.actions.list(r.pid, { kind: 'person', id: 321 }).find((o) => o.id === 'follow')!;
    expect(follow).toBeDefined();
    expect(r.player.perform(follow).ok).toBe(true);
    expect(r.player.hud()!.following).toBe(r.sim.state.persons.get(321)?.first ?? 'someone');
    npc.x = b.x + 25;
    run(r, 6, {});
    expect(r.player.body()!.x).toBeGreaterThan(b.x + 10);
    run(r, 0.5, { forward: 1, cameraYaw: Math.PI });
    const x = r.player.body()!.x;
    run(r, 2, {});
    expect(Math.abs(r.player.body()!.x - x)).toBeLessThan(0.5);
  });
});

describe('riding', () => {
  function withHorse(): { r: Rig; id: number } {
    const r = rig();
    const p = person(r);
    const b = { ...r.player.body()! };
    r.zone.addAnimal(500, 'horse', b.x + 3, b.z, p.household);
    r.zone.addAnimal(501, 'horse', b.x - 3, b.z, 0);
    return { r, id: 500 };
  }

  it('F mounts the household\'s horse (not strangers\') and F again dismounts, leaving the horse where it stood', () => {
    const { r } = withHorse();
    const b0 = { ...r.player.body()! };
    tap(r, 'mount');
    expect(r.player.mounted!()).toBe(true);
    expect(r.zone.claimed).toEqual([500]);
    const body = r.player.body()!;
    expect(body.x).toBeCloseTo(b0.x + 3, 1);
    const d = r.zone.attached!.draw;
    expect(d.mount?.coat).toBe(0x7a5032);
    expect(d.anim).toBe('mount');
    run(r, 2, {});
    expect(d.anim).toBe('ride_idle');
    expect(r.sim.view.player()!.mounted).toBe(true);
    expect(r.player.hud()!.mounted).toBe(true);
    run(r, 3, { forward: 1 });
    expect(d.anim).toBe('ride_trot');
    expect(d.mount?.anim).toBe('trot');
    expect(r.player.hud()!.speed!).toBeGreaterThan(3);
    run(r, 6, { forward: 1, sprint: true });
    expect(d.anim).toBe('ride_gallop');
    expect(r.player.hud()!.speed!).toBeGreaterThan(8);
    run(r, 3, { forward: 0 });
    tap(r, 'mount');
    run(r, 2.5, {});
    expect(r.player.mounted!()).toBe(false);
    expect(d.mount).toBeUndefined();
    expect(r.zone.releasedAnimals.length).toBe(1);
    expect(r.zone.releasedAnimals[0].id).toBe(500);
  });

  it('refuses a horse that is not the household\'s and says why', () => {
    const { r } = withHorse();
    const stranger = r.zone.animals().find((a) => a.id === 501)!;
    r.zone.things = [{ target: { kind: 'animal', id: 501 }, x: stranger.x, z: stranger.z, label: 'Horse' }];
    const opts = r.sim.actions.list(r.pid, { kind: 'animal', id: 501 });
    const mount = opts.find((o) => o.id === 'mount')!;
    expect(mount.enabled).toBe(false);
    expect(mount.reason).toMatch(/not|no one/i);
    expect(r.sim.actions.start(r.pid, mount).ok).toBe(false);
  });

  it('rides even when the zone cannot claim animals', () => {
    const { r } = withHorse();
    r.zone.supportsClaims = false;
    const notes: string[] = [];
    r.sim.events.on('notify', (n) => notes.push(n.text));
    tap(r, 'mount');
    expect(r.player.mounted!()).toBe(false);
    expect(notes.join(' ')).toMatch(/will not be ridden/);
  });

  it('does nothing without a horse close by', () => {
    const r = rig();
    const notes: string[] = [];
    r.sim.events.on('notify', (n) => notes.push(n.text));
    tap(r, 'mount');
    expect(r.player.mounted!()).toBe(false);
    expect(notes.length).toBe(1);
  });
});

describe('death and switching', () => {
  it('freezes the body when the player dies, hides the HUD and keeps the camera on the body', () => {
    const r = rig({ preset: 'small' });
    const p = person(r);
    const b = { ...r.player.body()! };
    const died: unknown[] = [];
    r.sim.events.on('playerDied', (e) => died.push(e));
    killPerson(r.sim, p, 'accident', r.sim.absDay);
    expect(died.length).toBe(1);
    expect(r.player.body()).toBeNull();
    expect(r.player.hud()).toBeNull();
    expect(r.player.target()).toBeNull();
    expect(r.player.options()).toEqual([]);
    const d = r.zone.attached!.draw;
    r.player.frame!(0.1);
    expect(d.anim).toBe('fall');
    r.player.frame!(2);
    expect(d.anim).toBe('dead');
    const v = r.sim.view.player()!;
    expect(v.alive).toBe(false);
    expect(v.x).toBeCloseTo(b.x, 1);
    expect(r.sim.view.focus().z).toBeCloseTo(b.z, 1);
    // input does nothing
    r.player.setInput(input({ forward: 1 }));
    r.sim.step(0.1);
    expect(r.sim.view.player()!.z).toBeCloseTo(b.z, 1);
  });

  it('re-attaches to the successor with a map-camera transition', () => {
    const r = rig({ preset: 'small' });
    const p = person(r);
    killPerson(r.sim, p, 'accident', r.sim.absDay);
    const heir = r.sim.state.run.pendingSuccession!.eligible[0];
    expect(heir).toBeDefined();
    const attachBefore = r.zone.attachCount;
    expect(r.sim.dispatch({ type: 'switchCharacter', personId: heir }).ok).toBe(true);
    expect(r.zone.detachCount).toBeGreaterThan(0);
    expect(r.zone.attachCount).toBe(attachBefore + 1);
    expect(r.zone.attached!.person).toBe(heir);
    expect(r.player.body()).not.toBeNull();
    expect(r.player.hud()!.personId).toBe(heir);
    expect(r.sim.view.player()!.personId).toBe(heir);
    expect(r.sim.view.player()!.alive).toBe(true);
    // the camera rises to the map and slides to the new character, then comes back down
    expect(r.sim.view.mode()).toBe('map');
    expect(r.player.mapFocus!()).not.toBeNull();
    r.player.frame!(1);
    r.player.frame!(1);
    r.player.frame!(1);
    expect(r.sim.view.mode()).toBe('street');
    expect(r.player.mapFocus!()).toBeNull();
    // the new body walks
    const z = r.player.body()!.z;
    run(r, 1, { forward: 1 });
    expect(r.player.body()!.z).toBeGreaterThan(z + 1);
  });

  it('voluntary switching works the same way and cancels what the old character was doing', () => {
    const r = rig({ preset: 'small' });
    r.sim.actions.register(workProvider({ seconds: 30 }));
    facing(r, 'Strip', 1);
    run(r, 0.3, {});
    tap(r, 'interact');
    expect(r.sim.actions.active(r.pid)).not.toBeNull();
    const targets = r.sim.eligibleSwitchTargets();
    expect(targets.length).toBeGreaterThan(0);
    const old = r.pid;
    expect(r.sim.dispatch({ type: 'switchCharacter', personId: targets[0] }).ok).toBe(true);
    expect(r.sim.actions.active(old)).toBeNull();
    expect(r.zone.attached!.person).toBe(targets[0]);
  });
});

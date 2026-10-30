import { describe, expect, it } from 'vitest';
import type { ActionOption } from '../../../src/sim/actions';
import type { SimEvents } from '../../../src/sim/events';
import type { Person } from '../../../src/sim/state';
import { forceRolls, mkPerson, rig, setClock, villager, type Rig } from './helpers';

function listFor(r: Rig, target: Parameters<Rig['sim']['actions']['list']>[1]): ActionOption[] {
  return r.sim.actions.list(r.player.id, target);
}
const person = (id: number) => ({ kind: 'person', id }) as const;
const find = (opts: ActionOption[], id: string): ActionOption => {
  const o = opts.find((x) => x.id === id);
  if (!o) throw new Error(`no action ${id} among ${opts.map((x) => x.id).join(', ')}`);
  return o;
};

function run(r: Rig, seconds: number): void {
  for (let i = 0; i < Math.ceil(seconds * 20) + 2; i++) r.sim.step(1 / 20);
}

describe('talk and greet', () => {
  it('offers Talk as the default on a person, and opens the dialogue panel', () => {
    const r = rig({ seed: 'act-talk' });
    const npc = villager(r);
    const opts = listFor(r, person(npc.id));
    const talk = find(opts, 'social.talk');
    expect(opts[0].id).toBe('social.talk');
    expect(talk).toMatchObject({ provider: 'social', category: 'talk', enabled: true, seconds: 0, range: 4 });
    expect(talk.preview).toBeTruthy();
    expect(r.sim.actions.defaultFor(r.player.id, person(npc.id))?.id).toBe('social.talk');
    const ui: SimEvents['ui'][] = [];
    r.sim.events.on('ui', (e) => ui.push(e));
    const out = r.sim.actions.start(r.player.id, talk);
    expect(out.ok).toBe(true);
    const conv = r.social.current()!;
    expect(conv.with).toBe(npc.id);
    expect(ui).toEqual([{ panel: 'dialogue', conversation: conv.id }]);
    expect(r.sim.state.clock.actionTime).toBe(true);
    r.social.end(conv.id);
  });

  it('disables Talk with a reason for the sleeping and the dead, and nothing is offered on yourself', () => {
    const r = rig({ seed: 'act-talk-no' });
    const npc = villager(r);
    setClock(r.sim, 0.04);
    const talk = find(listFor(r, person(npc.id)), 'social.talk');
    expect(talk.enabled).toBe(false);
    expect(talk.reason).toMatch(/asleep/);
    expect(find(listFor(r, person(npc.id)), 'social.greet').enabled).toBe(false);
    expect(listFor(r, person(r.player.id)).filter((o) => o.provider === 'social')).toEqual([]);
    expect(listFor(r, { kind: 'ground', x: 1, z: 2 }).filter((o) => o.provider === 'social')).toEqual([]);
  });

  it('greets: a wave, their reply, a little goodwill once a day', () => {
    const r = rig({ seed: 'act-greet' });
    const npc = villager(r);
    const before = r.social.opinion(npc.id, r.player.id);
    const opt = find(listFor(r, person(npc.id)), 'social.greet');
    expect(opt).toMatchObject({ category: 'social', anim: 'wave', seconds: 1.2 });
    const msgs: string[] = [];
    r.sim.events.on('notify', (n) => msgs.push(n.text));
    r.sim.actions.start(r.player.id, opt);
    run(r, 1.5);
    expect(msgs.some((m) => m.startsWith(`${npc.first}:`) || m.includes('nods'))).toBe(true);
    expect(r.social.opinion(npc.id, r.player.id)).toBeGreaterThanOrEqual(before);
    // the second greeting the same day adds nothing
    const mid = r.social.opinion(npc.id, r.player.id);
    r.sim.actions.start(r.player.id, find(listFor(r, person(npc.id)), 'social.greet'));
    run(r, 1.5);
    expect(r.social.opinion(npc.id, r.player.id)).toBe(mid);
  });
});

describe('wrestling and play', () => {
  it('trains strength and agility, wins friends and a name for valour', () => {
    const r = rig({ seed: 'act-wrestle' });
    const lad = mkPerson(r.sim, { sex: r.player.sex, age: 13, household: r.player.household, settlement: r.player.settlement });
    const opts = listFor(r, person(lad.id));
    const wrestle = find(opts, 'social.wrestle');
    expect(wrestle.enabled).toBe(true);
    expect(wrestle).toMatchObject({ seconds: 8, anim: 'work_lift', category: 'social' });
    r.player.potential.str = 16; r.player.potential.agi = 16;
    r.player.trained.str = 8; r.player.trained.agi = 8;
    r.player.rep.valour = 0;
    const msgs: SimEvents['notify'][] = [];
    r.sim.events.on('notify', (n) => msgs.push(n));
    const restore = forceRolls(r, 0.0); // she wins
    const opinion = r.social.opinion(lad.id, r.player.id);
    r.sim.actions.start(r.player.id, wrestle);
    run(r, 8.5);
    restore();
    expect(r.player.trained.str).toBeGreaterThan(8);
    expect(r.player.trained.agi).toBeGreaterThan(8);
    expect(r.social.opinion(lad.id, r.player.id)).toBeGreaterThan(opinion);
    expect(r.player.rep.valour).toBe(1);
    expect(msgs.length).toBeGreaterThan(0);
    // valour is earned once a day per opponent
    const again = find(listFor(r, person(lad.id)), 'social.wrestle');
    const restore2 = forceRolls(r, 0.0);
    r.sim.actions.start(r.player.id, again);
    run(r, 8.5);
    restore2();
    expect(r.player.rep.valour).toBe(1);
  });

  it('is for those of a size and a sex; the injured sit it out', () => {
    const r = rig({ seed: 'act-wrestle-no' });
    const sameSex = mkPerson(r.sim, { sex: r.player.sex, age: 12, household: r.player.household });
    const opposite = mkPerson(r.sim, { sex: r.player.sex === 'm' ? 'f' : 'm', age: 12, household: r.player.household });
    const old = mkPerson(r.sim, { sex: r.player.sex, age: 62, household: r.player.household });
    const noble = villager(r, { sex: r.player.sex, age: 13, tier: 5, estate: 'noble' });
    expect(listFor(r, person(opposite.id)).some((o) => o.id === 'social.wrestle')).toBe(false);
    expect(listFor(r, person(old.id)).some((o) => o.id === 'social.wrestle')).toBe(false);
    expect(find(listFor(r, person(noble.id)), 'social.wrestle').enabled).toBe(false);
    expect(find(listFor(r, person(sameSex.id)), 'social.wrestle').enabled).toBe(true);
    r.player.health.hp = 0.4;
    const hurt = find(listFor(r, person(sameSex.id)), 'social.wrestle');
    expect(hurt.enabled).toBe(false);
    expect(hurt.reason).toMatch(/condition/);
  });

  it('plays with the young: agility, good company, goodwill', () => {
    const r = rig({ seed: 'act-play' });
    const child = mkPerson(r.sim, { age: 8, household: r.player.household });
    child.needs.mood = 0.4; r.player.needs.mood = 0.4;
    const play = find(listFor(r, person(child.id)), 'social.play');
    r.player.potential.agi = 16; r.player.trained.agi = 9;
    const before = r.social.opinion(child.id, r.player.id);
    r.sim.actions.start(r.player.id, play);
    run(r, 10.5);
    expect(child.needs.mood).toBeGreaterThan(0.4);
    expect(r.player.needs.mood).toBeGreaterThan(0.4);
    expect(r.player.trained.agi).toBeGreaterThan(9);
    expect(r.social.opinion(child.id, r.player.id)).toBeGreaterThan(before);
    const grown = villager(r, { age: 40 });
    expect(listFor(r, person(grown.id)).some((o) => o.id === 'social.play')).toBe(false);
  });
});

describe('church', () => {
  function churchOf(r: Rig): number {
    const b = r.sim.state.buildingsAt.get(r.player.settlement)!.find((x) => x.kind === 'church' || x.kind === 'chapel');
    if (!b) throw new Error('no church in the settlement');
    return b.id;
  }
  const building = (id: number) => ({ kind: 'building', id }) as const;
  const HOLY_DAY = 3; // the fourth day of the first week

  it('lets you pray at a church, once a day for piety, always for peace', () => {
    const r = rig({ seed: 'act-pray' });
    const church = churchOf(r);
    r.player.rep.piety = 0;
    r.player.needs.mood = 0.5;
    const pray = find(listFor(r, building(church)), 'social.pray');
    expect(pray).toMatchObject({ enabled: true, anim: 'pray', seconds: 6, category: 'rest' });
    r.sim.actions.start(r.player.id, pray);
    run(r, 6.5);
    expect(r.player.rep.piety).toBe(1);
    expect(r.player.needs.mood).toBeGreaterThan(0.5);
    r.sim.actions.start(r.player.id, find(listFor(r, building(church)), 'social.pray'));
    run(r, 6.5);
    expect(r.player.rep.piety).toBe(1);
    expect(listFor(r, { kind: 'building', id: [...r.sim.state.buildings.values()].find((b) => b.kind === 'well')!.id }).some((o) => o.id === 'social.pray')).toBe(false);
  });

  it('holds Mass on holy-day mornings, with a priest, once a day; the priest notices', () => {
    const r = rig({ seed: 'act-mass' });
    const church = churchOf(r);
    const priest = r.core.scene(r.player.settlement).priest ?? villager(r, { sex: 'm', age: 40, career: 'priest', estate: 'clergy' });
    r.core.scene(r.player.settlement).priest = priest;
    setClock(r.sim, 0.5, 1); // an ordinary day
    let mass = find(listFor(r, building(church)), 'social.mass');
    expect(mass.enabled).toBe(false);
    expect(mass.reason).toMatch(/holy days/);
    setClock(r.sim, 0.9, HOLY_DAY); // evening of the holy day
    mass = find(listFor(r, building(church)), 'social.mass');
    expect(mass.reason).toMatch(/morning/);
    setClock(r.sim, 0.35, HOLY_DAY);
    r.core.scene(r.player.settlement).priest = priest;
    mass = find(listFor(r, building(church)), 'social.mass');
    expect(mass.enabled).toBe(true);
    r.player.rep.piety = 0;
    const op = r.social.opinion(priest.id, r.player.id);
    r.sim.actions.start(r.player.id, mass);
    run(r, 12.5);
    expect(r.player.rep.piety).toBe(2);
    expect(r.core.store.read().mass.last).toBe(HOLY_DAY);
    expect(r.social.opinion(priest.id, r.player.id)).toBeGreaterThan(op);
    const again = find(listFor(r, building(church)), 'social.mass');
    expect(again.enabled).toBe(false);
    expect(again.reason).toMatch(/heard Mass/);
  });

  it('notices who missed Mass the day after, and who came', () => {
    const r = rig({ seed: 'act-notice' });
    const church = churchOf(r);
    const priest = r.core.scene(r.player.settlement).priest ?? villager(r, { sex: 'm', age: 40, career: 'priest', estate: 'clergy' });
    r.core.scene(r.player.settlement).priest = priest;
    r.player.rep.piety = 10;
    const warnings: string[] = [];
    r.sim.events.on('notify', (n) => { if (n.kind === 'warn') warnings.push(n.text); });
    // holy day passes without Mass
    setClock(r.sim, 0.3, HOLY_DAY);
    r.sim.advanceDays(1.2);
    expect(warnings.some((w) => /missed Mass/.test(w))).toBe(true);
    expect(r.player.rep.piety).toBe(9);
    // next holy day: attends
    setClock(r.sim, 0.35, HOLY_DAY + 4);
    r.core.scene(r.player.settlement).priest = priest;
    r.sim.actions.start(r.player.id, find(listFor(r, building(church)), 'social.mass'));
    run(r, 12.5);
    const piety = r.player.rep.piety;
    const w = warnings.length;
    r.sim.advanceDays(1.2);
    expect(warnings.length).toBe(w);
    expect(r.player.rep.piety).toBeGreaterThanOrEqual(piety);
    expect(r.core.store.read().mass.missed).toBe(0);
  });

  it('hears confession from a priest, once in a while', () => {
    const r = rig({ seed: 'act-confess' });
    const priest = villager(r, { sex: 'm', age: 45, career: 'priest', estate: 'clergy' });
    r.player.needs.mood = 0.3;
    r.player.rep.cruelty = 20;
    const confess = find(listFor(r, person(priest.id)), 'social.confess');
    expect(confess).toMatchObject({ enabled: true, anim: 'kneel', seconds: 8 });
    r.sim.actions.start(r.player.id, confess);
    run(r, 8.5);
    expect(r.player.needs.mood).toBeGreaterThan(0.4);
    const again = find(listFor(r, person(priest.id)), 'social.confess');
    expect(again.enabled).toBe(false);
    expect(again.reason).toMatch(/lately/);
    const layman = villager(r);
    expect(listFor(r, person(layman.id)).some((o) => o.id === 'social.confess')).toBe(false);
  });
});

export type { Person };

import { describe, expect, it } from 'vitest';
import { OPINION_CAP } from '../../../src/sim/state';
import { OPINION } from '../../../src/sim/social/tuning';
import type { SimEvents } from '../../../src/sim/events';
import { mkPerson, rig, setClock, villager } from './helpers';

describe('opinion: the base from the world', () => {
  it('is warmer for kin than for strangers, and warmest for spouses', () => {
    const r = rig({ seed: 'op-kin' });
    const father = villager(r, { sex: 'm', age: 40, byname: 'Hayward' });
    const mother = mkPerson(r.sim, { sex: 'f', age: 38, household: father.household, byname: 'Hayward' });
    r.sim.state.marry(father, mother, 0);
    const kid = mkPerson(r.sim, { sex: 'm', age: 12, household: father.household, father, mother, byname: 'Hayward' });
    const sister = mkPerson(r.sim, { sex: 'f', age: 15, household: father.household, father, mother, byname: 'Hayward' });
    const stranger = villager(r, { sex: 'm', age: 30, byname: 'Otherman' });
    const o = (a: typeof father, b: typeof father): number => r.social.opinion(a.id, b.id);
    expect(o(father, kid)).toBeGreaterThan(o(father, stranger) + 15);
    expect(o(kid, father)).toBeGreaterThan(o(kid, stranger) + 12);
    expect(o(father, mother)).toBeGreaterThan(o(father, kid));
    expect(o(kid, sister)).toBeGreaterThan(o(kid, stranger) + 8);
    expect(o(father, mother)).toBeLessThanOrEqual(100);
  });

  it('counts rank: a knight looks down on a serf, a serf is wary of the lord of the manor', () => {
    const r = rig({ seed: 'op-rank' });
    const serf = villager(r, { tier: 1, estate: 'unfree' });
    const knight = villager(r, { tier: 5, estate: 'noble', career: 'knight' });
    const peasant = villager(r, { tier: 2 });
    expect(r.social.opinion(knight.id, serf.id)).toBeLessThan(r.social.opinion(peasant.id, serf.id));
    expect(r.social.opinion(knight.id, serf.id)).toBeLessThan(0);
    // the serf's own lord: the holder of the settlement's manor/town title
    const title = r.core.lordTitleOf(serf.settlement);
    if (title && title.holder) {
      const lord = r.sim.state.persons.get(title.holder)!;
      const explained = r.core.opinion.explain(serf, lord);
      expect(explained.parts.some((p) => p.label.startsWith('rank'))).toBe(true);
    }
  });

  it('weighs reputation by what the observer values', () => {
    const r = rig({ seed: 'op-rep' });
    const hero = villager(r, { sex: 'm' });
    const honestFolk = villager(r, { traits: ['honest'] });
    const deceitfulFolk = villager(r, { traits: ['deceitful'] });
    hero.rep.honour = 40; hero.rep.generosity = 0; hero.rep.cruelty = 0; hero.rep.piety = 0; hero.rep.valour = 0;
    expect(r.social.opinion(honestFolk.id, hero.id)).toBeGreaterThan(r.social.opinion(deceitfulFolk.id, hero.id));
    hero.rep.honour = 0; hero.rep.cruelty = 40;
    expect(r.social.opinion(honestFolk.id, hero.id)).toBeLessThan(0);
  });

  it('explains itself: the parts sum to the base', () => {
    const r = rig({ seed: 'op-explain' });
    const a = villager(r), b = villager(r);
    r.core.opinion.adjust(a.id, b.id, 7, 'gift');
    const ex = r.core.opinion.explain(a, b);
    expect(ex.memory).toBe(7);
    const sum = ex.parts.filter((p) => p.label !== 'memory').reduce((n, p) => n + p.value, 0);
    expect(Math.abs(sum - ex.base)).toBeLessThan(1);
    expect(ex.total).toBe(Math.round(Math.max(-100, Math.min(100, ex.base + ex.memory))));
  });
});

describe('opinion: memory', () => {
  it('moves with adjustOpinion, is bounded, and is kept as a few memories of deeds towards the player', () => {
    const r = rig({ seed: 'op-adjust' });
    const npc = villager(r);
    const before = r.social.opinion(npc.id, r.player.id);
    r.social.adjustOpinion(npc.id, r.player.id, 9, 'gift');
    expect(r.social.opinion(npc.id, r.player.id)).toBe(before + 9);
    r.social.adjustOpinion(npc.id, r.player.id, 500, 'gift');
    expect(r.social.opinion(npc.id, r.player.id)).toBe(100);
    r.social.adjustOpinion(npc.id, r.player.id, -900, 'insult');
    expect(r.social.opinion(npc.id, r.player.id)).toBeLessThanOrEqual(-50);
    const mem = r.core.store.memoriesOf(npc.id, r.player.id);
    expect(mem.length).toBeGreaterThan(0);
    expect(mem.length).toBeLessThanOrEqual(5);
    expect(mem[mem.length - 1].r).toBe('insult');
  });

  it('emits an opinion event for deeds towards the player, with a readable reason', () => {
    const r = rig({ seed: 'op-event' });
    const npc = villager(r);
    const seen: SimEvents['opinion'][] = [];
    r.sim.events.on('opinion', (e) => seen.push(e));
    r.social.adjustOpinion(npc.id, r.player.id, 3, 'gift');
    r.social.adjustOpinion(npc.id, r.player.id, 0.2, 'gift'); // too small to show
    r.social.adjustOpinion(npc.id, npc.id, 5, 'gift'); // nobody judges themselves
    const other = villager(r);
    r.social.adjustOpinion(npc.id, other.id, 4, 'gift'); // not about the player
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ of: npc.id, about: r.player.id, delta: 3, reason: 'your gift' });
  });

  it('remembers at most OPINION_CAP people, forgetting the faintest first', () => {
    const r = rig({ seed: 'op-cap' });
    const npc = villager(r);
    const others = Array.from({ length: OPINION_CAP + 6 }, () => villager(r));
    others.forEach((o, i) => r.social.adjustOpinion(npc.id, o.id, 5 + i, 'chat'));
    expect(Object.keys(npc.opinions).length).toBeLessThanOrEqual(OPINION_CAP);
    // the strongest feelings survive
    expect(npc.opinions[others[others.length - 1].id]).toBeDefined();
    expect(npc.opinions[others[0].id]).toBeUndefined();
  });

  it('fades towards the base, season by season, never past it, and forgets the trivial', () => {
    const r = rig({ seed: 'op-decay' });
    const npc = villager(r);
    r.social.adjustOpinion(npc.id, r.player.id, 30, 'gift');
    const base = r.core.opinion.base(npc, r.player);
    let last = r.social.opinion(npc.id, r.player.id);
    expect(last).toBeGreaterThan(base + 25);
    for (let season = 0; season < 6; season++) {
      r.core.opinion.decayPerson(npc);
      const now = r.social.opinion(npc.id, r.player.id);
      expect(now).toBeLessThanOrEqual(last);
      expect(now).toBeGreaterThanOrEqual(Math.round(base));
      last = now;
    }
    expect(last).toBeLessThan(base + 24);
    for (let season = 0; season < 80; season++) r.core.opinion.decayPerson(npc);
    expect(npc.opinions[r.player.id]).toBeUndefined();
    expect(r.social.opinion(npc.id, r.player.id)).toBe(Math.round(base));
  });

  it('is faded by the hourly system on each settlement\'s own day, and forgets the dead', () => {
    const r = rig({ seed: 'op-sched' });
    const npc = villager(r);
    const ghost = villager(r);
    r.social.adjustOpinion(npc.id, r.player.id, 40, 'gift');
    r.social.adjustOpinion(npc.id, ghost.id, 25, 'gift');
    const start = r.social.opinion(npc.id, r.player.id);
    r.sim.state.persons.delete(ghost.id);
    r.sim.advanceDays(9);
    expect(r.social.opinion(npc.id, r.player.id)).toBeLessThan(start);
    expect(npc.opinions[ghost.id]).toBeUndefined();
  });

  it('refuses to talk to an enemy: opinion at or below the refusal line', () => {
    const r = rig({ seed: 'op-enemy' });
    const npc = villager(r);
    r.social.adjustOpinion(npc.id, r.player.id, -(60 + Math.abs(r.core.opinion.base(npc, r.player))), 'insult');
    expect(r.social.opinion(npc.id, r.player.id)).toBeLessThanOrEqual(OPINION.refuseAtOrBelow);
    const res = r.social.start(r.player.id, npc.id);
    expect('ok' in res && !res.ok).toBe(true);
    expect(r.social.current()).toBeNull();
    expect(r.sim.state.clock.actionTime).toBe(false);
    setClock(r.sim, 0.5);
  });
});

import { describe, expect, it } from 'vitest';
import type { ActionOption, ActionProvider, TargetRef } from '../../src/sim/actions';
import { sameTarget, targetKey } from '../../src/sim/actions';
import { familyTree, householdCard, kinshipLabel, personCard, runCard, settlementCard } from '../../src/sim/api';
import { dayPart, isHolyDay, isMarketDay, marketDayOf, nextMarketDay } from '../../src/sim/calendar';
import { itemKey, parseItemKey } from '../../src/sim/economy/types';
import { formatMoney } from '../../src/sim/money';
import { gainSkill, openPerkSlots, trainStat } from '../../src/sim/skills';
import { refreshTrained } from '../../src/sim/people';
import { ageYears } from '../../src/sim/state';
import { newSim } from './helpers';

const self: TargetRef = { kind: 'self' };

function provider(over: Partial<ActionProvider> & { seconds?: number; repeat?: boolean } = {}): ActionProvider & { done: number[] } {
  const done: number[] = [];
  return {
    id: 'test',
    done,
    list(_ctx, _actor, target, out) {
      out.push({ id: 'dig', provider: '', label: 'Dig', category: 'work', target, enabled: true, seconds: over.seconds ?? 2, range: 3, priority: 5, repeat: over.repeat });
      out.push({ id: 'nap', provider: '', label: 'Nap', category: 'rest', target, enabled: false, reason: 'Not tired', seconds: 0, range: 3, priority: 9 });
    },
    complete(_ctx, _actor, _opt, fraction) { done.push(fraction); return { ok: true, message: 'Dug.', gains: [{ label: 'Dirt', amount: 1 }] }; },
    ...over,
  };
}

describe('action registry and runner', () => {
  it('lists options enabled first, then by priority, and tags the provider', () => {
    const sim = newSim();
    sim.actions.register(provider());
    const list = sim.actions.list(sim.state.run.playerId, self);
    expect(list.map((o) => o.id)).toEqual(['dig', 'nap']);
    expect(list[0].provider).toBe('test');
    expect(sim.actions.defaultFor(sim.state.run.playerId, self)?.id).toBe('dig');
  });

  it('runs a timed action in simulated seconds and reports the outcome as events', () => {
    const sim = newSim();
    const p = provider({ seconds: 2 });
    sim.actions.register(p);
    const actor = sim.state.run.playerId;
    const events: string[] = [];
    sim.events.on('action', (e) => events.push(e.type));
    const notes: string[] = [];
    sim.events.on('notify', (n) => notes.push(n.text));
    const opt = sim.actions.list(actor, self)[0];
    expect(sim.actions.start(actor, opt).ok).toBe(true);
    expect(sim.actions.active(actor)).not.toBeNull();
    for (let i = 0; i < 30; i++) sim.step(1 / 20);
    expect(sim.actions.active(actor)?.progress ?? 0).toBeGreaterThan(0.6);
    for (let i = 0; i < 20; i++) sim.step(1 / 20);
    expect(p.done).toEqual([1]);
    expect(sim.actions.active(actor)).toBeNull();
    expect(events).toEqual(['started', 'completed']);
    expect(notes).toContain('Dug.');
  });

  it('repeats work bouts, supports partial completion on cancel, and refuses disabled options', () => {
    const sim = newSim();
    const p = provider({ seconds: 1, repeat: true, partial: true });
    sim.actions.register(p);
    const actor = sim.state.run.playerId;
    const [dig, nap] = sim.actions.list(actor, self);
    expect(sim.actions.start(actor, nap).ok).toBe(false);
    sim.actions.start(actor, dig);
    for (let i = 0; i < 50; i++) sim.step(1 / 20); // 2.5 s → two bouts done, a third running
    expect(p.done).toEqual([1, 1]);
    sim.actions.cancel(actor);
    expect(p.done.length).toBe(3);
    expect(p.done[2]).toBeGreaterThan(0.3);
    expect(p.done[2]).toBeLessThan(0.7);
  });

  it('cancels when the provider check fails and survives a throwing provider', () => {
    const sim = newSim();
    let ok = true;
    sim.actions.register(provider({ id: 'checked', seconds: 5, check: () => (ok ? null : 'The strip is done') }));
    sim.actions.register({ id: 'broken', list() { throw new Error('boom'); }, complete: () => ({ ok: true }) });
    const actor = sim.state.run.playerId;
    const opt = sim.actions.list(actor, self).find((o) => o.id === 'dig') as ActionOption;
    sim.actions.start(actor, opt);
    ok = false;
    const reasons: string[] = [];
    sim.events.on('action', (e) => { if (e.type === 'cancelled') reasons.push(e.reason); });
    for (let i = 0; i < 30; i++) sim.step(1 / 20);
    expect(reasons).toEqual(['The strip is done']);
  });

  it('keys targets', () => {
    expect(targetKey({ kind: 'strip', id: 4 })).toBe('strip:4');
    expect(sameTarget({ kind: 'person', id: 2 }, { kind: 'person', id: 2 })).toBe(true);
    expect(sameTarget({ kind: 'person', id: 2 }, { kind: 'animal', id: 2 })).toBe(false);
  });
});

describe('calendar, money and items', () => {
  it('has one holy day per four-day week and market days that avoid it', () => {
    let holy = 0;
    for (let d = 0; d < 16; d++) if (isHolyDay(d + 0.5)) holy++;
    expect(holy).toBe(4);
    for (let s = 0; s < 30; s++) {
      expect(marketDayOf(s)).toBeGreaterThanOrEqual(1);
      expect(marketDayOf(s)).toBeLessThanOrEqual(3);
      const next = nextMarketDay(5.2, s);
      expect(next).toBeGreaterThan(5.2);
      expect(isMarketDay(next + 0.5, s)).toBe(true);
      expect(isHolyDay(next + 0.5)).toBe(false);
    }
    expect(dayPart(10.5)).toBe('midday');
    expect(dayPart(10.02)).toBe('night');
  });

  it('formats pence as £ s d', () => {
    expect(formatMoney(0)).toBe('0d');
    expect(formatMoney(7)).toBe('7d');
    expect(formatMoney(40)).toBe('3s 4d');
    expect(formatMoney(240 * 2 + 12 * 3 + 4)).toBe('£2 3s 4d');
    expect(formatMoney(1.5)).toBe('1½d');
    expect(formatMoney(-12)).toBe('−1s');
  });

  it('encodes item keys with quality', () => {
    expect(itemKey('wheat')).toBe('wheat');
    expect(itemKey('sickle', 2)).toBe('sickle#2');
    expect(parseItemKey('sickle#2')).toEqual({ good: 'sickle', quality: 2 });
    expect(parseItemKey('wheat')).toEqual({ good: 'wheat', quality: undefined });
  });
});

describe('skills and training', () => {
  it('levels skills with events and counts perk slots', () => {
    const sim = newSim();
    const p = sim.state.persons.get(sim.state.run.playerId)!;
    p.skills.archery = 0;
    const levels: number[] = [];
    sim.events.on('skillLevel', (e) => { if (e.skill === 'archery') levels.push(e.level); });
    gainSkill(sim, p, 'archery', 2000);
    expect(levels.length).toBeGreaterThanOrEqual(4);
    expect(openPerkSlots(p, 'archery')).toBeGreaterThanOrEqual(levels.includes(5) ? 1 : 0);
    p.perks.push('archery.steady_aim');
    expect(openPerkSlots(p, 'archery')).toBe(levels.filter((l) => [5, 10, 15, 20].includes(l)).length - 1);
  });

  it('trains a young stat towards its ceiling and keeps the bonus through yearly refreshes', () => {
    const sim = newSim();
    const p = sim.state.persons.get(sim.state.run.playerId)!;
    const age = ageYears(p, sim.absDay);
    p.potential.str = 14;
    refreshTrained(p, age);
    const before = p.trained.str;
    for (let i = 0; i < 40; i++) trainStat(sim, p, 'str', 0.1);
    expect(p.trained.str).toBeGreaterThan(before + 1);
    expect(p.trained.str).toBeLessThanOrEqual(14);
    const trained = p.trained.str;
    refreshTrained(p, age);
    expect(p.trained.str).toBeCloseTo(trained, 1);
  });
});

describe('UI read helpers', () => {
  it('builds cards for the player, household, settlement, run and family', () => {
    const sim = newSim({ preset: 'small' });
    const id = sim.state.run.playerId;
    const card = personCard(sim, id)!;
    expect(card.isPlayer).toBe(true);
    expect(card.age).toBe(12);
    expect(card.stats).toHaveLength(6);
    expect(card.skills).toHaveLength(20);
    const hh = householdCard(sim, card.household)!;
    expect(hh.members.some((m) => m.id === id)).toBe(true);
    const head = sim.state.persons.get(hh.head)!;
    const me = sim.state.persons.get(id)!;
    if (head.id !== id) expect(['son', 'daughter', 'brother', 'sister', 'grandson', 'granddaughter', 'nephew', 'niece', '']).toContain(kinshipLabel(sim.state, head, me));
    const s = settlementCard(sim, card.settlement)!;
    expect(s.population).toBeGreaterThan(0);
    const run = runCard(sim);
    expect(run.player).toBe(id);
    expect(run.lives).toBe(1);
    const tree = familyTree(sim.state, id)!;
    const find = (n: typeof tree): boolean => n.id === id || n.children.some(find);
    expect(find(tree)).toBe(true);
  });
});

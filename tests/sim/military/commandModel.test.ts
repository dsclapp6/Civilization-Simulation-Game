// The command HUD's logic (keys, order wheel, clicks, marks, camera circle).
import { describe, expect, it } from 'vitest';
import {
  ORDER_CHOICES, SELECT_KEYS, clickOrder, dragOrder, groupLine, groupsSignature, keycapOf, moraleTone, orderByDigit, orderMarks, overviewFor, selectionAfter,
} from '../../../src/sim/military/commandModel';
import type { BattleGroupView } from '../../../src/sim/wave3';

function g(key: BattleGroupView['key'], over: Partial<BattleGroupView> = {}): BattleGroupView {
  const label = key === 'all' ? 'All' : key === 'foot' ? 'Foot' : key === 'archers' ? 'Archers' : 'Horse';
  return { key, label, count: 10, x: 100, z: 100, yaw: 0, order: 'hold', formation: 'line', at: null, target: 0, engaged: false, morale: 0.8, ...over };
}

describe('keys', () => {
  it('4–7 select all, foot, archers and horse; the same key again lets go; an empty group cannot be selected', () => {
    expect(SELECT_KEYS.Digit4).toBe('all');
    expect(SELECT_KEYS.Digit5).toBe('foot');
    expect(SELECT_KEYS.Digit6).toBe('archers');
    expect(SELECT_KEYS.Digit7).toBe('horse');
    expect(keycapOf('archers')).toBe('6');
    const groups = [g('all', { count: 18 }), g('foot'), g('archers'), g('horse', { count: 0 })];
    expect(selectionAfter(null, 'foot', groups)).toBe('foot');
    expect(selectionAfter('foot', 'foot', groups)).toBeNull();
    expect(selectionAfter('foot', 'archers', groups)).toBe('archers');
    expect(selectionAfter('foot', 'horse', groups)).toBe('foot');
  });
});

describe('the order wheel', () => {
  it('has nine numbered choices: follow, hold, advance, charge, loose, retreat and the three formations', () => {
    expect(ORDER_CHOICES.map((o) => o.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(ORDER_CHOICES.map((o) => o.order({ ahead: null, target: 0 }).kind)).toEqual(['follow', 'hold', 'advance', 'charge', 'loose', 'retreat', 'formation', 'formation', 'formation']);
    expect(orderByDigit(8)?.order({ ahead: null, target: 0 })).toEqual({ kind: 'formation', formation: 'shield_wall' });
    expect(orderByDigit(0)).toBeUndefined();
  });
  it('advance goes to where the player looks, charge and loose at the man he looks at', () => {
    expect(orderByDigit(3)!.order({ ahead: { x: 5, z: 6 }, target: 0 })).toEqual({ kind: 'advance', at: { x: 5, z: 6 } });
    expect(orderByDigit(3)!.order({ ahead: null, target: 0 })).toEqual({ kind: 'advance' });
    expect(orderByDigit(4)!.order({ ahead: null, target: 77 })).toEqual({ kind: 'charge', target: 77 });
    expect(orderByDigit(5)!.order({ ahead: null, target: 77 })).toEqual({ kind: 'loose', target: 77 });
    expect(orderByDigit(4)!.order({ ahead: null, target: 0 })).toEqual({ kind: 'charge' });
  });
});

describe('what a click in the tactical view orders', () => {
  it('on an enemy: charge (archers loose); on the ground: march there in order, or just move with alt; on nothing: nothing', () => {
    expect(clickOrder('foot', { x: 1, z: 2 }, 9)).toEqual({ kind: 'charge', target: 9 });
    expect(clickOrder('archers', { x: 1, z: 2 }, 9)).toEqual({ kind: 'loose', target: 9 });
    expect(clickOrder('foot', { x: 1, z: 2 }, 0)).toEqual({ kind: 'advance', at: { x: 1, z: 2 } });
    expect(clickOrder('horse', { x: 1, z: 2 }, 0, true)).toEqual({ kind: 'move', at: { x: 1, z: 2 } });
    expect(clickOrder('foot', null, 0)).toBeNull();
    expect(dragOrder({ x: 3, z: 4 })).toEqual({ kind: 'move', at: { x: 3, z: 4 } });
  });
});

describe('what is drawn', () => {
  it('the group line says what the men are doing', () => {
    expect(groupLine(g('foot', { count: 12, order: 'advance' }))).toBe('Foot · 12 · advancing');
    expect(groupLine(g('foot', { count: 12, order: 'hold', formation: 'shield_wall' }))).toBe('Foot · 12 · holding · shield wall');
    expect(groupLine(g('horse', { count: 3, order: 'charge' }))).toBe('Horse · 3 · charging');
  });
  it('morale has a colour', () => {
    expect(moraleTone(0.9)).toBe('green');
    expect(moraleTone(0.5)).toBe('gold');
    expect(moraleTone(0.2)).toBe('vermilion');
  });
  it('marks: gold arrows for the player\'s orders, the selected group bright, hold flags, attack rings, the enemy\'s in red', () => {
    const own = [g('all', { count: 22 }), g('foot', { order: 'advance', at: { x: 200, z: 100 } }), g('archers', { order: 'hold' }), g('horse', { order: 'charge', target: 55 }), g('horse', { count: 0, order: 'hold' })];
    const enemy = [g('foot', { x: 300, z: 100, order: 'hold' }), g('archers', { x: 330, z: 100, order: 'advance', at: { x: 250, z: 100 } })];
    const marks = orderMarks(own, enemy, 'foot', (id) => (id === 55 ? { x: 290, z: 95 } : null));
    const byTone = (t: string) => marks.filter((m) => m.tone === t);
    expect(byTone('selected')).toHaveLength(1);
    expect(byTone('selected')[0]).toMatchObject({ kind: 'move', to: { x: 200, z: 100 } });
    expect(byTone('own').map((m) => m.kind).sort()).toEqual(['attack', 'hold']);
    expect(byTone('own').find((m) => m.kind === 'attack')!.to).toEqual({ x: 290, z: 95 });
    expect(byTone('enemy')).toHaveLength(2);
    // ids are distinct and stable for the same list
    expect(new Set(marks.map((m) => m.id)).size).toBe(marks.length);
    expect(orderMarks(own, enemy, 'foot', (id) => (id === 55 ? { x: 290, z: 95 } : null)).map((m) => m.id)).toEqual(marks.map((m) => m.id));
    // 'all' selected brightens every own group
    expect(orderMarks(own, [], 'all').every((m) => m.tone === 'selected')).toBe(true);
  });
  it('the overhead camera circles both armies, with room, and falls back to the player', () => {
    const own = [g('all', { count: 22 }), g('foot', { x: 0, z: 0, count: 10 }), g('archers', { x: -10, z: 0, count: 6 })];
    const enemy = [g('foot', { x: 80, z: 0, count: 14 })];
    const v = overviewFor(own, enemy, null)!;
    expect(v.x).toBeGreaterThan(0);
    expect(v.x).toBeLessThan(80);
    expect(v.radius).toBeGreaterThanOrEqual(110);
    expect(v.distance).toBeGreaterThan(60);
    expect(overviewFor([], [], null)).toBeNull();
    expect(overviewFor([], [], { x: 5, z: 6 })).toMatchObject({ x: 5, z: 6 });
  });
  it('the signature changes with what shows and not with where the men stand', () => {
    const a = [g('all'), g('foot')];
    const s0 = groupsSignature(a, []);
    expect(groupsSignature([g('all'), g('foot', { x: 999 })], [])).toBe(s0);
    expect(groupsSignature([g('all'), g('foot', { count: 9 })], [])).not.toBe(s0);
    expect(groupsSignature([g('all'), g('foot', { order: 'charge' })], [])).not.toBe(s0);
  });
});

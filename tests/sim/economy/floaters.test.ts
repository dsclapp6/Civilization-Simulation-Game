// Floating texts (clarity pass): a completed action floats its gains and the experience it gave, a level gained floats
// big, a trade floats what it cost and brought, and an opinion change floats a heart over the person; they leave the
// queue a few at a time.
import { describe, expect, it } from 'vitest';
import type { FloatText } from '../../../src/core/view';
import { bagAdd } from '../../../src/sim/economy/items';
import { econSim, makeFarmer, optionsFor, perform } from './helpers';

function setup(seed = 'floaters') {
  const ctx = econSim({ seed });
  const { player, hh, strips } = makeFarmer(ctx.sim, { age: 15, strips: 2, role: 1, strength: 12 });
  const home = ctx.sim.state.buildings.get(hh.home)!;
  let t = 0;
  ctx.eco.floaters.clock = () => t;
  // the player stands at home; the view reports where
  ctx.sim.view.setSource('player', () => ({ personId: player.id, x: home.x, y: 30, z: home.z, yaw: 0, mounted: false, alive: true }));
  const all: FloatText[] = [];
  const drain = (): FloatText[] => { const got = [...ctx.sim.view.drainFloaters!()]; all.push(...got); return got; };
  /** Lets enough time pass for everything queued to leave. */
  const settle = (): FloatText[] => { t += 10_000; const out: FloatText[] = []; for (let i = 0; i < 40; i++) { out.push(...drain()); t += 300; } return out; };
  return { ...ctx, player, hh, strips, home, drain, settle, advance: (ms: number) => { t += ms; } };
}

describe('floating texts', () => {
  it('floats the gains and the experience of a completed bout, a few at a time', () => {
    const f = setup();
    const id = f.strips[0];
    const st = f.sim.state.strips.get(id)!;
    st.state = 'ripe'; st.crop = 'barley'; st.growth = 1;
    f.sim.state.touchStrip(st);
    for (let i = 0; i < 7; i++) {
      const o = optionsFor(f.sim, { kind: 'strip', id }).find((x) => x.enabled && x.id === 'farm.reap')!;
      perform(f.sim, o);
    }
    expect(f.sim.state.strips.get(id)!.state).toBe('harvested');
    // the first thing out comes at once; the rest follow at a walking pace, not all in one frame
    const first = f.drain();
    expect(first.length).toBeLessThanOrEqual(1);
    const rest = f.settle();
    const texts = [...first, ...rest].map((x) => x.text);
    expect(texts.some((x) => /^Farming \+\d+$/.test(x))).toBe(true);
    expect(texts.some((x) => /^\+\d+ sheaves cut$/.test(x)), texts.join(' | ')).toBe(true);
    const sk = [...first, ...rest].find((x) => /^Farming/.test(x.text))!;
    expect(sk.tone).toBe('skill');
    // they start over the player's head
    expect(sk.x).toBe(f.home.x);
    expect(sk.z).toBe(f.home.z);
    expect(sk.y).toBeGreaterThan(30 + 1.5);
  });

  it('floats a level gained once, big, and money gained as pence', () => {
    const f = setup('floaters2');
    // one bout short of a level
    f.player.skills.farming = 39.5;
    f.sim.state.touch(f.player);
    const id = f.strips[0];
    const st = f.sim.state.strips.get(id)!;
    st.state = 'fallow'; st.crop = 'fallow';
    f.sim.state.touchStrip(st);
    f.sim.advanceDays(0.2);
    // a gift of money through the economy's own gains path
    const sim = f.sim;
    sim.actions.register({
      id: 'test', list: () => {},
      complete: (_c, _a, _o) => ({ ok: true, message: 'ok', gains: [{ label: 'Wages', amount: 3, ref: 'money' }, { label: 'Eggs', amount: 2, ref: 'eggs' }] }),
    });
    const o = { id: 'test.pay', provider: 'test', label: 'pay', category: 'work' as const, target: { kind: 'self' as const }, enabled: true, seconds: 0, range: 5, priority: 1 };
    sim.actions.start(f.player.id, o);
    const texts = f.settle().map((x) => x.text);
    expect(texts).toContain('+3d');
    expect(texts).toContain('+2 eggs');
  });

  it('floats a level-up as "Skill n!" and nothing is floated for a failed action', () => {
    const f = setup('floaters3');
    f.sim.events.emit('skillLevel', { person: f.player.id, skill: 'farming', level: 3, perkChoice: false });
    const texts = f.settle();
    expect(texts.map((x) => x.text)).toContain('Farming 3!');
    expect(texts.find((x) => x.text === 'Farming 3!')!.tone).toBe('skill');
    f.sim.actions.register({ id: 'nope', list: () => {}, complete: () => ({ ok: false, message: 'no', gains: [{ label: 'Wages', amount: 5, ref: 'money' }] }) });
    f.sim.actions.start(f.player.id, { id: 'nope.x', provider: 'nope', label: 'x', category: 'work', target: { kind: 'self' }, enabled: true, seconds: 0, range: 5, priority: 1 });
    expect(f.settle()).toHaveLength(0);
  });

  it('floats what a trade cost and brought, netted, and the heart of the person dealt with', () => {
    const f = setup('floaters4');
    const other = [...f.sim.state.persons.values()].find((p) => !p.death && p.id !== f.player.id)!;
    f.sim.events.emit('trade', { buyer: f.player.id, seller: other.id, settlement: f.player.settlement, item: 'eggs', qty: 1, pence: 1 });
    f.sim.events.emit('trade', { buyer: f.player.id, seller: other.id, settlement: f.player.settlement, item: 'eggs', qty: 1, pence: 1 });
    f.sim.events.emit('trade', { buyer: other.id, seller: f.player.id, settlement: f.player.settlement, item: 'wheat', qty: 3, pence: 4 });
    f.sim.events.emit('opinion', { of: other.id, about: f.player.id, delta: 3, reason: 'a fair price' });
    f.sim.events.emit('opinion', { of: other.id, about: f.player.id, delta: 0.2, reason: 'nothing much' });
    const texts = f.settle().map((x) => x.text);
    expect(texts).toContain('+2d'); // 4 earned, 2 spent
    expect(texts.some((x) => /^\+2 eggs$/.test(x)), texts.join('|')).toBe(true);
    expect(texts.some((x) => /^−3 wheat$/.test(x))).toBe(true);
    expect(texts).toContain('♥ +3');
    expect(texts.filter((x) => x.startsWith('♥')).length).toBe(1);
    bagAdd(f.player.inventory, 'eggs', 1);
  });

  it('never queues a flood: a burst is thinned and the queue stays short', () => {
    const f = setup('floaters5');
    for (let i = 0; i < 200; i++) f.sim.events.emit('opinion', { of: f.player.id + 1, about: f.player.id, delta: 1, reason: 'again' });
    const texts = f.settle();
    expect(texts.length).toBeLessThanOrEqual(16);
    expect(texts.length).toBeGreaterThan(0);
  });
});

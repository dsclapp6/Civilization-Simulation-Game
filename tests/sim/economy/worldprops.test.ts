// World props (clarity pass): the results of work lie about where it was done — woodpiles and sacks sized by the
// household's stores, stooks on a reaped strip until carried, a stump and logs where a tree was felled.
import { describe, expect, it } from 'vitest';
import { PROP_RANGE, stripFrame } from '../../../src/sim/economy/propfeed';
import { bagAdd } from '../../../src/sim/economy/items';
import { peekExtra } from '../../../src/sim/farming';
import { CHUNKS_PER_SIDE, CHUNK_SIZE, type ScatterItem } from '../../../src/world/types';
import { econSim, farmBot, find, makeFarmer, optionsFor, perform, runBot } from './helpers';

/** The mock world has no vegetation: plant an oak next to the village. */
function plantTree(sim: ReturnType<typeof econSim>['sim'], x: number, z: number): ScatterItem {
  const cx = Math.floor(x / CHUNK_SIZE), cz = Math.floor(z / CHUNK_SIZE);
  const tree: ScatterItem = { id: (cz * CHUNKS_PER_SIDE + cx) * 4096 + 3, kind: 'oak', x, z, scale: 1.2, rot: 0, variant: 0 };
  (sim.world as unknown as { scatterInChunk: (a: number, b: number) => ScatterItem[] }).scatterInChunk = (a, b) => (a === cx && b === cz ? [tree] : []);
  return tree;
}

/** A long wait is not cut short by the player's death: the run goes on with the next of kin. */
function carryOn(sim: ReturnType<typeof econSim>['sim']): void {
  sim.events.on('playerDied', (e) => { if (e.eligible.length) sim.switchTo(e.eligible[0]); });
}

describe('world props', () => {
  it('sizes a woodpile and a grain sack pile by what the household stores, near the focus only', () => {
    const { sim } = econSim({ seed: 'props' });
    const { player, hh } = makeFarmer(sim, { age: 15, strips: 3, role: 1 });
    const home = sim.state.buildings.get(hh.home)!;
    sim.view.setSource('focus', () => ({ x: home.x, z: home.z }));
    hh.stores['firewood'] = 0;
    for (const k of Object.keys(hh.stores)) if (/^(wheat|rye|barley|oats|peas|beans)/.test(k)) delete hh.stores[k];
    sim.state.touchHousehold(hh);
    const mine = (kind: string): { count?: number; x: number; z: number } | undefined => sim.view.worldProps!().find((p) => p.kind === kind && Math.hypot(p.x - home.x, p.z - home.z) < 20 && p.id % 1e9 === home.id);
    expect(mine('woodpile')).toBeUndefined();
    hh.stores['firewood'] = 6;
    sim.state.touchHousehold(hh);
    const small = mine('woodpile');
    expect(small?.count).toBeGreaterThanOrEqual(2);
    hh.stores['firewood'] = 90;
    sim.state.touchHousehold(hh);
    const big = mine('woodpile');
    expect(big?.count).toBeGreaterThan(small!.count!);
    expect(big!.count).toBeLessThanOrEqual(8);
    // it lies beside the home, not inside it
    expect(Math.hypot(big!.x - home.x, big!.z - home.z)).toBeLessThan(14);
    hh.stores['wheat'] = 60;
    sim.state.touchHousehold(hh);
    const sacks = sim.view.worldProps!().filter((p) => p.kind === 'sack_pile' && Math.hypot(p.x - home.x, p.z - home.z) < 40);
    expect(sacks.length).toBeGreaterThan(0);
    expect(sacks.every((p) => (p.count ?? 0) >= 1 && (p.count ?? 0) <= 8)).toBe(true);
    // every prop is within range of the focus, and ids are unique
    const all = sim.view.worldProps!();
    for (const p of all) expect(Math.hypot(p.x - home.x, p.z - home.z)).toBeLessThanOrEqual(PROP_RANGE + 60);
    expect(new Set(all.map((p) => p.id)).size).toBe(all.length);
    void player;
  });

  it('moves the version only when the props really change', () => {
    const { sim } = econSim({ seed: 'props' });
    const { hh } = makeFarmer(sim, { age: 15, strips: 3, role: 1 });
    const home = sim.state.buildings.get(hh.home)!;
    sim.view.setSource('focus', () => ({ x: home.x, z: home.z }));
    const v0 = sim.view.worldPropsVersion!();
    expect(sim.view.worldPropsVersion!()).toBe(v0);
    // touching a household without changing what is drawn does not move it
    sim.state.touchHousehold(hh);
    expect(sim.view.worldPropsVersion!()).toBe(v0);
    hh.stores['firewood'] = (hh.stores['firewood'] ?? 0) + 40;
    sim.state.touchHousehold(hh);
    expect(sim.view.worldPropsVersion!()).toBeGreaterThan(v0);
  });

  it('puts stooks on the strip when it is bound and takes them away as the sheaves are carried', () => {
    const { sim } = econSim({ seed: 'props' });
    const { hh, strips } = makeFarmer(sim, { age: 15, strips: 2, role: 1, strength: 12 });
    const id = strips[0];
    const c = sim.world.strips[id].poly.reduce((a, p) => ({ x: a.x + p.x / 4, z: a.z + p.z / 4 }), { x: 0, z: 0 });
    sim.view.setSource('focus', () => c);
    const st = sim.state.strips.get(id)!;
    st.state = 'ripe'; st.crop = 'barley'; st.growth = 1;
    sim.state.touchStrip(st);
    const onStrip = (kind: string): number => sim.view.worldProps!().filter((p) => p.kind === kind && p.id >= 1e9 && p.id < 2e9 && Math.floor((p.id - 1e9) / 64) === id).length;
    expect(onStrip('stook') + onStrip('sheaf')).toBe(0);
    const bot = farmBot(sim, [id], hh);
    runBot(bot, 6, { until: () => (bot.counts['farm.reap'] ?? 0) >= 7, skip: /^farm\.(bind|carry|unload|thresh|winnow|weed|harrow|sow|plough)/ });
    expect(st.state).toBe('harvested');
    expect(onStrip('sheaf')).toBeGreaterThan(0); // cut and lying
    expect(onStrip('stook')).toBe(0);
    runBot(bot, 6, { until: () => st.state === 'stubble', skip: /^farm\.(reap|carry|unload|thresh|winnow|weed|harrow|sow|plough)/ });
    expect(st.state).toBe('stubble');
    const standing = onStrip('stook');
    expect(standing).toBeGreaterThan(0);
    expect(onStrip('sheaf')).toBe(0);
    // they stand along the strip, inside it
    const ws = sim.world.strips[id];
    const f = stripFrame(ws.poly, { sx: 0, sz: 0, ux: 0, uz: 1, len: 1, vx: 1, vz: 0, width: 1 });
    for (const p of sim.view.worldProps!().filter((q) => q.kind === 'stook' && Math.floor((q.id - 1e9) / 64) === id)) {
      const t = ((p.x - f.sx) * f.ux + (p.z - f.sz) * f.uz) / f.len;
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThanOrEqual(1);
    }
    // carry everything in: the stooks go
    runBot(bot, 4, { until: () => (peekExtra(sim.state.ext.farm as never, id)?.k ?? 0) < 0.5, skip: /^farm\.(reap|bind|thresh|winnow|weed|harrow|sow|plough)/ });
    let guard = 0;
    while ((sim.view.worldProps!().filter((p) => p.kind === 'stook' && Math.floor((p.id - 1e9) / 64) === id).length) > 0 && guard++ < 40) {
      const o = optionsFor(sim, { kind: 'strip', id }).find((x) => x.enabled && x.id === 'farm.carry');
      if (!o) break;
      perform(sim, o);
      const home = optionsFor(sim, { kind: 'building', id: hh.home }).find((x) => x.enabled && x.id === 'farm.unload');
      if (home) perform(sim, home);
    }
    expect(onStrip('stook')).toBeLessThan(standing);
    expect(onStrip('stook')).toBe(0);
  }, 60000);

  it('leaves a stump where a tree was felled, and logs until the woodcutter has gone', () => {
    const { sim } = econSim({ seed: 'props' });
    const { player } = makeFarmer(sim, { age: 16, strips: 1, role: 1, strength: 12 });
    const village = sim.world.settlements.find((s) => s.id === player.settlement)!;
    const tree = plantTree(sim, village.x + 30, village.z + 10);
    let me = { x: tree!.x + 1.5, z: tree!.z };
    sim.view.setSource('focus', () => ({ x: tree!.x, z: tree!.z }));
    sim.view.setSource('player', () => ({ personId: player.id, x: me.x, y: 0, z: me.z, yaw: 0, mounted: false, alive: true }));
    bagAdd(player.inventory, 'axe#1', 1);
    const stumps = (): number => sim.view.worldProps!().filter((p) => p.kind === 'stump' && p.id === 6e9 + tree!.id * 2).length;
    const logs = (): number => sim.view.worldProps!().filter((p) => p.kind === 'logs' && p.id === 6e9 + tree!.id * 2 + 1).length;
    expect(stumps()).toBe(0);
    const o = find(optionsFor(sim, { kind: 'scatter', id: tree!.id }), 'wood.fell')!;
    expect(o?.enabled, o?.reason).toBe(true);
    expect(perform(sim, o).ok).toBe(true);
    expect(stumps()).toBe(1);
    expect(logs()).toBe(1);
    const stump = sim.view.worldProps!().find((p) => p.kind === 'stump')!;
    expect(Math.hypot(stump.x - tree!.x, stump.z - tree!.z)).toBeLessThan(0.1);
    // the woodcutter carries the wood away: the logs go, the stump stays
    me = { x: tree!.x + 60, z: tree!.z };
    sim.state.touchHousehold(sim.state.households.get(player.household)!);
    sim.advanceHours(1);
    expect(logs()).toBe(0);
    expect(stumps()).toBe(1);
  });

  it('cocks the hay on a meadow as it is mown, for a day or two, and then the meadow is bare again', () => {
    const { sim } = econSim({ seed: 'hay' });
    carryOn(sim);
    // high summer: the hay is cut (the mock world has pastures only: one becomes a meadow)
    const yr = Math.floor(sim.absDay / 16);
    const summer = (sim.absDay < yr * 16 + 5.3 ? yr : yr + 1) * 16 + 5.3;
    sim.state.clock.absDay = summer;
    sim.state.clock.firedHour = Math.floor(summer * 24);
    const { player } = makeFarmer(sim, { age: 16, strips: 1, role: 1, strength: 12 });
    const parcel = sim.world.parcels.find((q) => q.use === 'pasture')!;
    parcel.use = 'meadow';
    let cx = 0, cz = 0;
    for (const p of parcel.poly) { cx += p.x / parcel.poly.length; cz += p.z / parcel.poly.length; }
    sim.view.setSource('focus', () => ({ x: cx, z: cz }));
    bagAdd(player.inventory, 'scythe#1', 1);
    const cocks = (): { x: number; z: number }[] => sim.view.worldProps!().filter((p) => p.kind === 'hay_cock' && p.id >= 2e9 && p.id < 3e9);
    expect(cocks().length).toBe(0);
    const v0 = sim.view.worldPropsVersion!();
    const o = find(optionsFor(sim, { kind: 'parcel', id: parcel.id }), 'farm.mow')!;
    expect(o?.enabled, o?.reason).toBe(true);
    expect(perform(sim, o).ok).toBe(true);
    // the bout is seen at once, not at the next hour
    expect(sim.view.worldPropsVersion!()).toBeGreaterThan(v0);
    const first = cocks();
    expect(first.length).toBeGreaterThan(0);
    const xs = parcel.poly.map((q) => q.x), zs = parcel.poly.map((q) => q.z);
    for (const c of first) {
      expect(c.x).toBeGreaterThanOrEqual(Math.min(...xs) - 0.01);
      expect(c.x).toBeLessThanOrEqual(Math.max(...xs) + 0.01);
      expect(c.z).toBeGreaterThanOrEqual(Math.min(...zs) - 0.01);
      expect(c.z).toBeLessThanOrEqual(Math.max(...zs) + 0.01);
    }
    // more mowing, more cocks (never more than a meadow can hold)
    const o2 = find(optionsFor(sim, { kind: 'parcel', id: parcel.id }), 'farm.mow')!;
    perform(sim, o2, 3);
    expect(cocks().length).toBeGreaterThanOrEqual(first.length);
    expect(cocks().length).toBeLessThanOrEqual(14);
    // the first ones keep their places as more are added
    for (const c of first) expect(cocks().some((d) => Math.abs(d.x - c.x) < 1e-9 && Math.abs(d.z - c.z) < 1e-9)).toBe(true);
    sim.advanceHours(24 * 3);
    expect(cocks().length).toBe(0);
  });

  it('leaves stooks for about a day on a strip the village harvested while it was watched, then carries them in', () => {
    const { sim } = econSim({ seed: 'harvest' });
    carryOn(sim);
    const { player } = makeFarmer(sim, { age: 15, strips: 2, role: 1, strength: 12 });
    const village = sim.world.settlements.find((s) => s.id === player.settlement)!;
    sim.view.setSource('focus', () => ({ x: village.x, z: village.z }));
    const own = new Set(village.strips.filter((id) => sim.state.strips.get(id)!.holder === player.household));
    const stooks = (): Map<number, number> => {
      const m = new Map<number, number>();
      for (const p of sim.view.worldProps!()) if (p.kind === 'stook' && p.id >= 1e9 && p.id < 2e9) { const id = Math.floor((p.id - 1e9) / 64); m.set(id, (m.get(id) ?? 0) + 1); }
      return m;
    };
    const appeared = new Map<number, number>();
    const vanished = new Map<number, number>();
    const start = Math.ceil(sim.absDay / 16) * 16;
    sim.advanceHours(Math.round((start - sim.absDay) * 24));
    for (let h = 0; h < 24 * 16; h++) {
      sim.advanceHours(1);
      const now = stooks();
      for (const id of now.keys()) { if (!appeared.has(id)) appeared.set(id, sim.absDay); vanished.delete(id); }
      for (const id of appeared.keys()) if (!now.has(id) && !vanished.has(id)) vanished.set(id, sim.absDay);
    }
    const theirs = [...appeared.keys()].filter((id) => !own.has(id));
    expect(theirs.length, 'stooks were seen on strips the village harvested').toBeGreaterThan(0);
    let gone = 0;
    for (const id of theirs) {
      const t0 = appeared.get(id)!, t1 = vanished.get(id);
      if (t1 === undefined) continue; // still standing when the year ended: the harvest was late
      gone++;
      expect(t1 - t0).toBeGreaterThan(0.5); // about three-quarters of a day
      expect(t1 - t0).toBeLessThan(1);
    }
    expect(gone).toBeGreaterThan(0);
  }, 90000);
});

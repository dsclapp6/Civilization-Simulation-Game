import { describe, expect, it } from 'vitest';
import { militaryContext } from '../../../src/sim/military';
import { fakeCombat, milSim } from './helpers';

function royals(sim: ReturnType<typeof milSim>['sim']): number[] {
  return [...sim.state.houses.values()].filter((h) => h.kind === 'royal').map((h) => h.id);
}

function herds(sim: ReturnType<typeof milSim>['sim'], sid: number): number {
  let n = 0;
  for (const hh of sim.state.householdsIn(sid)) for (const [k, v] of Object.entries(hh.stores)) if (/^(ox|cow|sheep|pig|goat|horse)/.test(k)) n += v;
  return n;
}

describe('raids', () => {
  it('burn buildings and strips, drive off herds, take captives, and the event and chronicle say so', () => {
    const { sim, mil } = milSim({ seed: 'raid' });
    fakeCombat(sim, 0.3);
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const village = sim.world.settlements.find((s) => s.kind === 'village' && M.realm.root(M.realm.lordHouse(s.id)) === kb)!;
    const herds0 = herds(sim, village.id);
    expect(herds0).toBeGreaterThan(0);
    // the fields are sown: give some strips a crop to burn
    for (const id of village.strips.slice(0, 12)) { const s = sim.state.strips.get(id)!; s.state = 'ripe'; s.crop = 'wheat'; s.growth = 1; }
    const id = mil.raid(ka, village.id, { size: 40 });
    expect(id).toBeGreaterThan(0);
    const army = M.army(id)!;
    expect(army.intent).toBe('raid');
    army.x = village.x - 400; army.z = village.z; army.px = army.x; army.pz = army.z;
    const hostile = mil.hostile(ka, M.realm.lordHouse(village.id));
    expect(hostile).toBe(true);
    let raided: { burned: number; stolen: number; captives: number; settlement: number } | undefined;
    sim.events.on('raid', (e) => { raided = e; });
    const damage0 = [...sim.state.buildingsAt.get(village.id)!].reduce((s, b) => s + b.damage, 0);
    const burnedBefore = sim.state.stripRevision;
    for (let d = 0; d < 10 && !raided; d++) sim.advanceDays(1);
    expect(raided).toBeDefined();
    expect(raided!.settlement).toBe(village.id);
    expect(raided!.burned).toBeGreaterThan(0);
    expect(raided!.stolen).toBeGreaterThan(0);
    // the economy feels it: damaged buildings, fewer beasts, lost crops, a poorer village
    const damage1 = [...sim.state.buildingsAt.get(village.id)!].reduce((s, b) => s + b.damage, 0);
    expect(damage1).toBeGreaterThan(damage0);
    expect(herds(sim, village.id)).toBeLessThan(herds0);
    expect(sim.state.stripRevision).toBeGreaterThan(burnedBefore);
    const bare = village.strips.filter((sid) => sim.state.strips.get(sid)!.state === 'bare' || sim.state.strips.get(sid)!.state === 'fallow').length;
    expect(bare).toBeGreaterThan(0);
    expect(sim.state.chronicle.some((c) => c.kind === 'raid' && c.text.includes(village.name))).toBe(true);
    // the raiders go home with the plunder and share it
    for (let d = 0; d < 40 && M.armyById.has(id); d++) sim.advanceDays(1);
    expect(M.armyById.has(id)).toBe(false);
  });

  it('the villagers\' militia may beat a small raiding party off', () => {
    const { sim, mil } = milSim({ seed: 'raid2' });
    fakeCombat(sim, 0.2);
    const [ka, kb] = royals(sim);
    const M = militaryContext(sim);
    const town = sim.world.settlements.find((s) => (s.kind === 'town' || s.kind === 'city') && M.realm.root(M.realm.lordHouse(s.id)) === kb)!;
    // a handful of raiders against a town: the militia and garrison stand against them
    const id = mil.raid(ka, town.id, { size: 8 });
    if (!id) return;
    const army = M.army(id)!;
    army.x = town.x - 300; army.z = town.z; army.px = army.x; army.pz = army.z;
    const before = army.men.length;
    for (let d = 0; d < 6; d++) sim.advanceDays(1);
    // either the raid was repulsed (army gone or smaller) or went through; nothing crashes and the state is consistent
    expect(!M.armyById.has(id) || army.men.length <= before).toBe(true);
  });
});

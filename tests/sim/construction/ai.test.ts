// What an AI ruler does with the same API as the player: ask the catalogue, find a spot, stake it out and let the works run — with
// the real economy, advancement and politics installed. The registry stays consistent and two runs of one seed agree.
import { describe, expect, it } from 'vitest';
import type { BuildingKind } from '../../../src/content/types';
import { installAdvancement } from '../../../src/sim/advancement';
import { installConstruction } from '../../../src/sim/construction';
import { installEconomy } from '../../../src/sim/economy';
import { installPolitics } from '../../../src/sim/politics';
import { installSocial } from '../../../src/sim/social';
import type { Simulation } from '../../../src/sim/sim';
import { buildSim, fakeTerritory, invariants, setTime } from './helpers';

const WANTS: BuildingKind[] = ['cottage', 'barn', 'granary', 'well', 'brewhouse', 'sawpit', 'smithy', 'stable', 'longhouse', 'warehouse'];

function realWorld(seed: string): { sim: Simulation; cons: ReturnType<typeof installConstruction> } {
  const sim = buildSim(seed, { roads: [] });
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  const deps = { economy, social };
  installPolitics(sim, deps);
  installAdvancement(sim, deps);
  fakeTerritory(sim);
  const cons = installConstruction(sim, deps);
  setTime(sim, 8 / 24);
  return { sim, cons };
}

function runRulers(seed: string, days: number): { hash: string; placed: number; finished: number; bad: string[] } {
  const { sim, cons } = realWorld(seed);
  const st = sim.state;
  let placed = 0, finished = 0;
  sim.events.on('construction', (e) => { if (e.phase === 'placed') placed++; if (e.phase === 'done') finished++; });
  // every ruler of the continent: the lords of manors and the great lords
  const rulers = [...new Set([...st.titles.values()].filter((t) => t.holder && ['manor', 'county', 'kingdom', 'abbey'].includes(t.kind)).map((t) => t.holder))].sort((a, b) => a - b);
  for (const id of rulers) {
    const p = st.persons.get(id);
    const hh = p ? st.households.get(p.household) : undefined;
    if (!hh) continue;
    hh.purse = Math.max(hh.purse, 6000);
    for (const g of ['timber', 'planks', 'stone', 'straw', 'nails', 'iron']) hh.stores[g] = Math.max(hh.stores[g] ?? 0, 150);
  }
  const bad: string[] = [];
  for (let day = 0; day < days; day++) {
    if (day % 3 === 0) {
      for (const id of rulers) {
        const p = st.persons.get(id);
        if (!p || p.death) continue;
        const scope = cons.scope(id);
        for (const sid of scope.settlements.slice(0, 2)) {
          const want = WANTS[(day / 3 + id + sid) % WANTS.length | 0];
          const opt = cons.catalogue(id, sid).find((o) => o.kind === want);
          if (!opt?.ok) continue;
          const spot = cons.suggestSpot(id, want, sid);
          if (!spot) continue;
          cons.place(id, want, spot.x, spot.z, spot.rot);
        }
      }
    }
    sim.advanceDays(1);
    bad.push(...invariants(sim, cons));
  }
  return { hash: sim.stateHash(), placed, finished, bad };
}

describe('AI rulers use the same API', () => {
  it('plan, place and finish works in many places, with the registry staying consistent', () => {
    const out = runRulers('ai-1', 40);
    expect(out.bad).toEqual([]);
    expect(out.placed).toBeGreaterThan(5);
    expect(out.finished).toBeGreaterThan(0);
  }, 120000);

  it('give the same continent twice for the same seed', () => {
    const a = runRulers('ai-2', 24);
    const b = runRulers('ai-2', 24);
    expect(a.hash).toBe(b.hash);
    expect(a.placed).toBe(b.placed);
    expect(a.finished).toBe(b.finished);
  }, 120000);

  it('put the household\'s members to the real economy\'s build task', () => {
    const { sim, cons } = realWorld('ai-4');
    const eco = sim.services.construction ? (cons.core.economy as unknown as { setTask: (h: number, m: number, t: string) => { ok: boolean }; householdPlan: (h: number) => Array<{ person: number; task: string }> }) : null;
    const t = [...sim.state.titles.values()].find((x) => x.kind === 'manor')!;
    const lord = sim.state.persons.get(t.holder)!;
    const hh = sim.state.households.get(lord.household)!;
    hh.purse = 0; lord.money = 0;
    for (const g of ['planks', 'straw']) hh.stores[g] = 200;
    const kin = hh.members.map((id) => sim.state.persons.get(id)!).filter((m) => m.id !== lord.id && !m.death && (sim.absDay - m.birthDay) / 16 >= 15);
    expect(kin.length).toBeGreaterThan(0);
    for (const m of kin) expect(eco!.setTask(lord.id, m.id, 'build').ok).toBe(true);
    expect(eco!.householdPlan(hh.id).filter((l) => l.task === 'build').length).toBe(kin.length);
    const spot = cons.suggestSpot(lord.id, 'cottage', t.place)!;
    const res = cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    setTime(sim, 5 / 24, Math.floor(sim.absDay) + 1);
    sim.advanceHours(3);
    const s = cons.site(res.site as number)!;
    expect(s.status).toBe('working');
    const crew = cons.workersAt(s.id);
    expect(crew.length).toBeGreaterThan(0);
    for (const id of crew) expect(kin.some((k) => k.id === id)).toBe(true);
    expect(cons.onSite?.(crew[0])).toBe(s.id);
  });

  it('can be asked what a place needs by id alone (no player involved)', () => {
    const { sim, cons } = realWorld('ai-3');
    const t = [...sim.state.titles.values()].find((x) => x.kind === 'manor')!;
    const lord = t.holder;
    const sc = cons.scope(lord);
    expect(sc.settlements).toContain(t.place);
    const cat = cons.catalogue(lord, t.place);
    expect(cat.some((o) => o.ok)).toBe(true);
    const spot = cons.suggestSpot(lord, 'cottage', t.place);
    expect(spot).not.toBeNull();
    const hh = sim.state.households.get(sim.state.persons.get(lord)!.household)!;
    hh.purse = 5000; hh.stores['planks'] = 100; hh.stores['straw'] = 100;
    const res = cons.place(lord, 'cottage', spot!.x, spot!.z, spot!.rot);
    expect(res.ok, res.reason).toBe(true);
    expect(cons.sites(t.place).length).toBe(1);
    sim.advanceDays(12);
    expect(cons.sites(t.place).length).toBe(0);
  });
});

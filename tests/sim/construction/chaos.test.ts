// A rough fuzz of the whole API: rulers, masters and peasants stake out, improve, mend, pull down, cancel, reprioritise and
// re-hire at random for forty game days with the real economy running, and the registry stays consistent throughout. A fixed
// seed keeps it reproducible; nothing may throw.
import { describe, expect, it } from 'vitest';
import { BUILDING_KINDS, type BuildingKind } from '../../../src/content/types';
import { installAdvancement } from '../../../src/sim/advancement';
import { installConstruction } from '../../../src/sim/construction';
import { installEconomy } from '../../../src/sim/economy';
import { installPolitics } from '../../../src/sim/politics';
import { installSocial } from '../../../src/sim/social';
import { Rng } from '../../../src/core/rng';
import { buildSim, fakeTerritory, invariants, setTime } from './helpers';

function world(seed: string) {
  const sim = buildSim(seed, { roads: [] });
  const social = installSocial(sim);
  const economy = installEconomy(sim, { social });
  installPolitics(sim, { economy, social });
  installAdvancement(sim, { economy, social });
  fakeTerritory(sim);
  const cons = installConstruction(sim, { economy, social });
  setTime(sim, 8 / 24);
  return { sim, cons };
}

function run(seed: string, days: number): { hash: string; ops: number; failures: string[]; open: number; phases: Record<string, number>; cancels: number } {
  const { sim, cons } = world(seed);
  const phases: Record<string, number> = {};
  sim.events.on('construction', (e) => { phases[`${e.work}.${e.phase}`] = (phases[`${e.work}.${e.phase}`] ?? 0) + 1; });
  const st = sim.state;
  const rng = new Rng(`chaos:${seed}`);
  // the great and the small: every holder of a title, and some household heads of every rank
  const holders = [...new Set([...st.titles.values()].filter((t) => t.holder).map((t) => t.holder))].map((id) => st.persons.get(id)!).filter((p) => !p.death);
  const heads = [...st.households.values()].filter((h) => h.kind === 'family').map((h) => st.persons.get(h.head)!).filter((p) => p && !p.death && p.settlement < 9).slice(0, 60);
  const people = [...holders, ...heads];
  // some ruler-sized purses and stores so that things can happen
  for (const t of st.titles.values()) {
    const h = st.persons.get(t.holder);
    const hh = h ? st.households.get(h.household) : undefined;
    if (!hh) continue;
    hh.purse = Math.max(hh.purse, 4000);
    for (const g of ['timber', 'planks', 'stone', 'straw', 'nails', 'iron', 'brick', 'clay']) hh.stores[g] = Math.max(hh.stores[g] ?? 0, 100);
  }
  const failures: string[] = [];
  let ops = 0;
  let cancels = 0;
  for (let day = 0; day < days; day++) {
    for (let k = 0; k < 6; k++) {
      const p = people[rng.int(0, people.length - 1)];
      if (p.death) continue;
      const sc = cons.scope(p.id);
      const sid = sc.settlements.length ? sc.settlements[rng.int(0, sc.settlements.length - 1)] : p.settlement;
      const what = rng.int(0, 9);
      try {
        if (what <= 3) {
          const open = cons.catalogue(p.id, sid).filter((o) => o.ok).map((o) => o.kind);
          const kind: BuildingKind = open.length && rng.chance(0.85) ? open[rng.int(0, open.length - 1)] : BUILDING_KINDS[rng.int(0, BUILDING_KINDS.length - 1)];
          const spot = cons.suggestSpot(p.id, kind, sid);
          if (spot) cons.place(p.id, kind, spot.x, spot.z, spot.rot, { hired: rng.chance(0.3) ? rng.int(0, 3) : 'auto', occupant: rng.chance(0.2) ? 'vacant' : undefined });
        } else if (what <= 5) {
          const list = st.buildingsAt.get(sid) ?? [];
          if (list.length) {
            const b = list[rng.int(0, list.length - 1)];
            if (rng.chance(0.4)) b.damage = Math.min(1, b.damage + rng.range(0.1, 0.6));
            const op = rng.int(0, 2);
            if (op === 0) cons.upgrade(p.id, b.id); else if (op === 1) cons.repair(p.id, b.id); else cons.demolish(p.id, b.id);
          }
        } else if (what === 6) {
          // mostly a site the person may call off (their own or their lord's works), sometimes anyone's (refused)
          const all = cons.sites();
          const theirs = rng.chance(0.8) ? all.filter((x) => cons.canManage?.(p.id, x.id) ?? true) : all;
          const s = theirs[rng.int(0, Math.max(0, theirs.length - 1))];
          if (s && cons.cancel(p.id, s.id).ok) cancels++;
        } else if (what === 7) {
          const s = cons.sites()[rng.int(0, Math.max(0, cons.sites().length - 1))];
          if (s) { cons.setPriority(p.id, s.id, rng.int(-5, 50)); cons.setHired?.(p.id, s.id, rng.chance(0.5) ? 'auto' : rng.int(0, 4)); }
        } else {
          cons.catalogue(p.id, sid);
          cons.quote?.(p.id, 'repair', (st.buildingsAt.get(sid) ?? [])[0]?.id ?? -1);
        }
        ops++;
      } catch (err) {
        failures.push(`day ${day}: ${(err as Error).stack?.split('\n').slice(0, 3).join(' | ')}`);
      }
    }
    sim.advanceHours(rng.int(10, 30));
    for (const bad of invariants(sim, cons)) failures.push(`day ${day}: ${bad}`);
  }
  return { hash: sim.stateHash(), ops, failures, open: cons.sites().length, phases, cancels };
}

describe('chaos', () => {
  it('survives a month and more of random orders with the registry consistent', () => {
    const out = run('chaos-1', 40);
    expect(out.failures.slice(0, 5)).toEqual([]);
    expect(out.ops).toBeGreaterThan(200);
    // the orders did things: sites were staked out, some were finished and some called off, of every kind of work
    expect(out.phases['build.placed']).toBeGreaterThan(6);
    expect(out.phases['build.done']).toBeGreaterThan(1);
    // every work called off says so (with the economy's procurement most works now run to the end, so few are)
    const cancelled = Object.entries(out.phases).filter(([k]) => k.endsWith('.cancelled')).reduce((n, [, v]) => n + v, 0);
    expect(cancelled, JSON.stringify(out.phases)).toBe(out.cancels);
    expect(Object.keys(out.phases).some((k) => !k.startsWith('build.'))).toBe(true);
  }, 120000);

  it('is reproducible', () => {
    const a = run('chaos-2', 24);
    const b = run('chaos-2', 24);
    expect(a.failures).toEqual([]);
    expect(a.hash).toBe(b.hash);
    expect(a.open).toBe(b.open);
  }, 120000);
});

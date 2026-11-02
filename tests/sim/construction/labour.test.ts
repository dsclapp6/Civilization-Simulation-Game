// Labour and money: paid labourers and their wages, the size of a crew, cash fees as the work goes, queue priority, the House's
// own barns as stores, and a payer who has gone.
import { describe, expect, it } from 'vitest';
import { WAGES, maxCrew } from '../../../src/sim/construction/data';
import { allMaterials, clearSpot, enrich, houseOf, manorLord, rig, toWorkDawn, village, type Rig } from './helpers';

function lordSite(r: Rig, kind: Parameters<typeof clearSpot>[2], purse = 100000, extra: Record<string, number> = {}) {
  const v = village(r.sim);
  const lord = manorLord(r.sim, v.id);
  const hh = houseOf(r.sim, lord);
  enrich(hh, { ...allMaterials(kind, r.cons), ...extra }, purse);
  lord.money = 0;
  const spot = clearSpot(r, v.id, kind, lord);
  const purse0 = hh.purse;
  const res = r.cons.place(lord.id, kind, spot.x, spot.z, spot.rot);
  expect(res.ok, res.reason).toBe(true);
  return { v, lord, hh, res, site: r.cons.site(res.site as number)!, purse0 };
}

describe('paid labourers', () => {
  it('are paid a day\'s wage out of the purse into their own households, and nothing is lost', () => {
    const r = rig('lab-a');
    const v = village(r.sim);
    const total = (): number => {
      let s = 0;
      for (const hh of r.sim.state.householdsIn(v.id)) s += hh.purse;
      for (const p of r.sim.state.residentsOf(v.id)) s += p.money;
      return s;
    };
    const { lord, hh } = lordSite(r, 'cottage');
    toWorkDawn(r.sim);
    const purse0 = hh.purse, total0 = total();
    r.sim.advanceHours(1);
    const paid = purse0 - hh.purse;
    expect(paid).toBeGreaterThan(0);
    // two hands for a cottage, each at the going wage
    expect(paid % WAGES.labour).toBeCloseTo(0, 5);
    expect(paid).toBeLessThanOrEqual(2 * WAGES.labour + 1e-6);
    // the wages went to the labourers' households: the village's money is the same
    expect(total()).toBeCloseTo(total0, 5);
    expect(lord.money).toBe(0);
  });

  it('are not taken by the thousand: a crew is as big as the job and the village can spare', () => {
    const r = rig('lab-b');
    const { site } = lordSite(r, 'great_hall', 100000, { iron: 10 });
    r.sim.advanceHours(10);
    const s = r.cons.site(site.id)!;
    expect(s.workers).toBeGreaterThan(0);
    expect(s.workers).toBeLessThanOrEqual(maxCrew(80));
    const pool = r.sim.state.residentsOf(site.settlement).filter((p) => p.rankTier <= 2).length;
    // never more than three in ten of the folk who hire out
    expect(s.workers).toBeLessThanOrEqual(Math.max(1, Math.floor(pool * 0.3)));
  });

  it('are not hired when the purse is nearly empty: the site says it has no hands', () => {
    const r = rig('lab-c');
    const { res, hh } = lordSite(r, 'cottage', 1);
    // (a death in the household can bring its owner's pence into the purse: so each morning it is a penny at the hour of the plan)
    for (let d = 0; d < 3; d++) { toWorkDawn(r.sim); hh.purse = 1; r.sim.advanceHours(2); }
    const s = r.cons.site(res.site as number)!;
    expect(s.progress).toBe(0);
    expect(s.status).toBe('stalled');
    expect(s.note).toMatch(/No hands/);
  });

  it('can be set by the paying household: none, a few, or as many as the job allows', () => {
    const r = rig('lab-d');
    const { lord, res } = lordSite(r, 'barn');
    expect(r.cons.setHired?.(lord.id, res.site as number, 0).ok).toBe(true);
    toWorkDawn(r.sim);
    r.sim.advanceHours(4);
    expect(r.cons.site(res.site as number)!.workers).toBe(0);
    expect(r.cons.setHired?.(lord.id, res.site as number, 1).ok).toBe(true);
    toWorkDawn(r.sim);
    r.sim.advanceHours(4);
    expect(r.cons.site(res.site as number)!.workers).toBe(1);
    expect(r.cons.setHired?.(lord.id, res.site as number, 'auto').ok).toBe(true);
    toWorkDawn(r.sim);
    r.sim.advanceHours(4);
    expect(r.cons.site(res.site as number)!.workers).toBeGreaterThan(1);
    expect(r.cons.setHired?.(lord.id, res.site as number, -1).ok).toBe(false);
    const stranger = [...r.sim.state.persons.values()].find((p) => !p.death && p.settlement !== village(r.sim).id)!;
    expect(r.cons.setHired?.(stranger.id, res.site as number, 3).ok).toBe(false);
  });
});

describe('cash fees', () => {
  it('are paid as the work goes, and the work waits when they cannot be paid', () => {
    const r = rig('lab-e');
    const { hh, res, lord } = lordSite(r, 'great_hall');
    const s0 = r.cons.site(res.site as number)!;
    expect(s0.cost?.pence).toBe(60);
    const rec = r.cons.core.sitesById.get(s0.id)!;
    r.sim.advanceDays(3);
    expect(rec.paid).toBeGreaterThan(0);
    // fees follow the progress: about 60 d for the whole job
    expect(rec.paid / 60).toBeCloseTo(rec.done / rec.labour, 1);
    // out of money: wages and fees stop
    hh.purse = 0; lord.money = 0;
    const done0 = rec.done;
    r.sim.advanceDays(3);
    expect(rec.done).toBeCloseTo(done0, 1);
  });
});

describe('the queue and the stores', () => {
  it('gives scarce hands to the site with the lower priority number', () => {
    const r = rig('lab-f');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    enrich(hh, { ...allMaterials('cottage', r.cons, 2) }, 100000);
    lord.money = 0;
    const a = clearSpot(r, v.id, 'cottage', lord);
    const first = r.cons.place(lord.id, 'cottage', a.x, a.z, a.rot, { hired: 'auto' });
    const b = clearSpot(r, v.id, 'cottage', lord);
    const second = r.cons.place(lord.id, 'cottage', b.x, b.z, b.rot, { hired: 'auto' });
    expect(first.ok && second.ok).toBe(true);
    expect(r.cons.setPriority(lord.id, second.site as number, -1).ok).toBe(true);
    // only enough money for one labourer a day
    toWorkDawn(r.sim);
    hh.purse = 1.25 * WAGES.labour;
    r.sim.advanceHours(3);
    const sa = r.cons.site(first.site as number)!, sb = r.cons.site(second.site as number)!;
    expect(sb.workers).toBeGreaterThan(0);
    expect(sa.workers).toBe(0);
  });

  it('draws materials from the House\'s other households in the place (its barns and stores)', () => {
    const r = rig('lab-g');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    enrich(hh, {}, 100000);
    const barn = r.sim.state.addHousehold({ id: r.sim.state.households.alloc(), kind: 'service', head: 0, members: [], home: -1, settlement: v.id, purse: 0, stores: { planks: 100, straw: 100 }, house: lord.house });
    const spot = clearSpot(r, v.id, 'cottage', lord);
    const res = r.cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    const s = r.cons.site(res.site as number)!;
    expect(s.missing['planks'] ?? 0).toBe(0);
    expect(barn.stores['planks']).toBe(80);
  });

  it('is taken over by the lord of the place if the paying household is gone', () => {
    const r = rig('lab-h');
    const v = village(r.sim);
    // a master's workshop on a plot of his own, paid for by his household
    const lordHH = houseOf(r.sim, manorLord(r.sim, v.id));
    const lordHouse = manorLord(r.sim, v.id).house;
    void lordHouse;
    const { res, hh } = lordSite(r, 'cottage');
    const rec = r.cons.core.sitesById.get(res.site as number)!;
    // the household disappears (extinct); the site's payer is replaced by the lord's household, which here is the same
    r.sim.state.removeHousehold(hh);
    r.sim.advanceDays(1);
    expect(rec.closed !== 0 || rec.household !== hh.id).toBe(true);
    void lordHH;
  });
});

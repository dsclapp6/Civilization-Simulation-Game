// A stable, byre, fold, sty and henhouse come stocked: the beasts are part of the price and join the payer's stores when it is done.
import { describe, expect, it } from 'vitest';
import { levelCost, stockOf, stockPence, totalCost } from '../../../src/sim/construction/data';
import { allMaterials, clearSpot, enrich, houseOf, manorLord, rig, village } from './helpers';

describe('bought stocked', () => {
  it('names the beasts of each kind and prices them into the new building only', () => {
    expect(stockOf('stable')).toEqual({ 'horse#1': 3 });
    expect(stockOf('cowshed')).toEqual({ cow: 4, ox: 2 });
    expect(stockOf('sheepfold')).toEqual({ sheep: 20 });
    expect(stockOf('pigsty')).toEqual({ pig: 5 });
    expect(stockOf('henhouse')).toEqual({ chicken: 12 });
    expect(stockOf('cottage')).toEqual({});
    expect(stockPence('stable')).toBe(900);
    const bare = totalCost('stable', 1).pence;
    expect(levelCost('stable', 1).pence).toBe(bare + 900);
    // an upgrade brings no beasts, and mending is priced on the building alone
    expect(levelCost('stable', 2).pence).toBe(totalCost('stable', 2).pence - totalCost('stable', 1).pence);
  });

  it('delivers the beasts to the payer\'s stores when the stable is done', () => {
    const r = rig('stock-1');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = houseOf(r.sim, lord);
    enrich(hh, allMaterials('stable', r.cons));
    const before = hh.stores['horse#1'] ?? 0;
    const spot = clearSpot(r, v.id, 'stable', lord);
    const res = r.cons.place(lord.id, 'stable', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    expect(r.cons.site(res.site as number)!.cost?.pence).toBe(levelCost('stable', 1).pence);
    expect(hh.stores['horse#1'] ?? 0).toBe(before);
    const building = r.cons.site(res.site as number)!.building;
    const purse0 = hh.purse;
    r.sim.advanceDays(10);
    expect(r.cons.siteOf(building)).toBeNull();
    expect(hh.stores['horse#1'] ?? 0).toBe(before + 3);
    // the three horses were paid for at the going price
    expect(purse0 - hh.purse).toBeGreaterThanOrEqual(900);
  });
});

// What a household owes (brief: wave2-econ): rent at the terms, week-work of the unfree with fines when it is
// shirked, merchet on a serf's daughter's marriage, the price of freedom.
import { describe, expect, it } from 'vitest';
import { buyFreedom, manumissionPrice, merchetFee } from '../../../src/sim/economy/obligations';
import { econSim, makeFarmer } from './helpers';

describe('obligations', () => {
  it('a free tenant pays rent half-yearly to the lord and it shows in the ledger', () => {
    const { sim, eco } = econSim({ seed: 'dues' });
    const { player, hh } = makeFarmer(sim, { age: 20, strips: 2, role: 1 });
    player.estate = 'free';
    sim.state.touch(player);
    const lord = eco.econ.lordOf(player.settlement);
    expect(lord, 'the village has a lord').toBeTruthy();
    const listing = eco.listings(player.settlement, player.id).find((l) => l.kind === 'strip' && l.rent !== null);
    expect(listing).toBeTruthy();
    expect(eco.buyOrRent(player.id, listing!.id, 'rent').ok).toBe(true);
    const owed = eco.obligations(player.id).find((o) => o.kind === 'rent');
    expect(owed, 'rent is listed').toBeTruthy();
    expect(owed!.unit).toBe('pence');
    expect(owed!.amount).toBeGreaterThan(0);
    player.money = 200; // enough to pay without touching the family purse
    sim.state.touch(player);
    const before = lord!.household ? lord!.household.purse : 0;
    sim.advanceDays(17); // across a rent day
    const rent = eco.ledger(hh.id).filter((l) => /Rent/.test(l.label));
    expect(rent.length, JSON.stringify(eco.ledger(hh.id).slice(0, 8))).toBeGreaterThan(0);
    expect(rent[0].pence).toBeLessThan(0);
    expect(lord!.household ? lord!.household.purse : 0).toBeGreaterThan(before);
  });

  it('an unfree man owes week-work; when it is shirked the reeve fines him', () => {
    const { sim, eco } = econSim({ seed: 'serf' });
    const { player, hh } = makeFarmer(sim, { age: 20, strips: 2, role: 1 });
    player.estate = 'unfree';
    hh.purse = 400;
    sim.state.touch(player);
    const week = eco.obligations(player.id).find((o) => o.kind === 'week_work');
    expect(week, 'week-work is listed').toBeTruthy();
    expect(week!.unit).toBe('days');
    expect(week!.amount).toBeGreaterThanOrEqual(1);
    expect(eco.obligations(player.id).some((o) => o.kind === 'toll')).toBe(true);
    // two weeks without a day on the lord's land
    sim.advanceDays(9);
    const fines = eco.obligations(player.id).filter((o) => o.kind === 'fine');
    const paid = eco.ledger(hh.id).filter((l) => /Fine/i.test(l.label));
    expect(fines.length + paid.length, 'the reeve fined the idle serf').toBeGreaterThan(0);
  });

  it('merchet is charged to a serf father when his daughter marries', () => {
    const { sim, eco } = econSim({ seed: 'merchet' });
    const st = sim.state;
    let bride = null;
    for (const p of st.persons.values()) {
      if (p.death || p.sex !== 'f' || !p.father) continue;
      const f = st.persons.get(p.father);
      if (f && !f.death && f.household && f.estate === 'free' && sim.world.settlements.find((s) => s.id === f.settlement)?.kind === 'village') { bride = p; break; }
    }
    expect(bride, 'a village girl with a living father').toBeTruthy();
    const father = st.persons.get(bride!.father)!;
    father.estate = 'unfree';
    const fhh = st.households.get(father.household)!;
    fhh.purse = 500;
    const lord = eco.econ.lordOf(father.settlement);
    const lordPurse = lord?.household?.purse ?? 0;
    const groom = [...st.persons.values()].find((p) => !p.death && p.sex === 'm' && p.id !== father.id && p.settlement === father.settlement);
    sim.events.emit('marriage', { a: bride!.id, b: groom!.id, settlement: father.settlement });
    expect(fhh.purse).toBeLessThan(500);
    expect(500 - fhh.purse).toBeCloseTo(merchetFee(eco.econ, father), 0);
    if (lord?.household) expect(lord.household.purse).toBeGreaterThan(lordPurse);
  });

  it('a serf head of household can buy the family free; a free man cannot', () => {
    const { sim, eco } = econSim({ seed: 'free' });
    const { player, hh } = makeFarmer(sim, { age: 22, strips: 2 });
    expect(buyFreedom(eco.econ, player).ok).toBe(false);
    player.estate = 'unfree';
    for (const id of hh.members) { const m = sim.state.persons.get(id); if (m && !m.death) m.estate = 'unfree'; }
    player.money = 0;
    hh.purse = 3;
    expect(buyFreedom(eco.econ, player).ok).toBe(false); // too poor
    const price = manumissionPrice(eco.econ, player);
    expect(price).toBeGreaterThan(50);
    hh.purse = price + 20;
    expect(buyFreedom(eco.econ, player).ok).toBe(true);
    expect(player.estate).toBe('free');
    expect(eco.obligations(player.id).some((o) => o.kind === 'week_work')).toBe(false);
  });
});

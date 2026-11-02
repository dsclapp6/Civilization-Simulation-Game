// What a finished building is to the people who built it: a home the household moves into, a workshop that is a master's, an
// improved workshop, a steward's work for his lord, a mayor's well — and, with the real economy, a vacant home on the market.
import { describe, expect, it } from 'vitest';
import { installAdvancement } from '../../../src/sim/advancement';
import { installConstruction } from '../../../src/sim/construction';
import { installEconomy } from '../../../src/sim/economy';
import { installPolitics } from '../../../src/sim/politics';
import { installSocial } from '../../../src/sim/social';
import { mkHousehold, mkHouse, mkPerson, makePlayer } from '../builders';
import { allMaterials, buildSim, enrich, fakeTerritory, houseOf, manorLord, peasantWithGarden, rig, setTime, village, workUntilDone } from './helpers';

describe('a finished home', () => {
  it('is moved into by the household that built it on its own land, who leave their old home vacant', () => {
    const r = rig('home-a');
    const { p, hh, x, z } = peasantWithGarden(r, 2);
    makePlayer(r.sim, p);
    const oldHome = hh.home;
    hh.stores = { ...allMaterials('hovel', r.cons) };
    const res = r.cons.place(p.id, 'hovel', x, z, 0, { hired: 0 });
    expect(res.ok, res.reason).toBe(true);
    const site = r.cons.site(res.site as number)!;
    expect(r.cons.core.sitesById.get(site.id)!.occupant).toBe('builder');
    workUntilDone(r, p.id, site.building);
    const b = r.sim.state.buildings.get(site.building)!;
    expect(b.construction).toBe(1);
    expect(b.household).toBe(hh.id);
    expect(b.occupied).toBe(true);
    expect(hh.home).toBe(b.id);
    const old = r.sim.state.buildings.get(oldHome)!;
    expect(old.household).toBe(0);
    expect(old.occupied).toBe(false);
    expect(b.owner).toBe(p.house);
  });

  it('stands empty when the builder says to let it', () => {
    const r = rig('home-b');
    const { p, hh, x, z } = peasantWithGarden(r, 2);
    makePlayer(r.sim, p);
    hh.stores = { ...allMaterials('hovel', r.cons) };
    const home = hh.home;
    const res = r.cons.place(p.id, 'hovel', x, z, 0, { hired: 0, occupant: 'vacant' });
    const site = r.cons.site(res.site as number)!;
    workUntilDone(r, p.id, site.building);
    const b = r.sim.state.buildings.get(site.building)!;
    expect(b.household).toBe(0);
    expect(hh.home).toBe(home);
  });
});

describe('a master\'s workshop', () => {
  it('is his household\'s when built on his plot, and he may improve it', () => {
    const r = rig('home-c');
    const { p, hh, x, z } = peasantWithGarden(r, 3);
    makePlayer(r.sim, p);
    hh.stores = { ...allMaterials('smithy', r.cons, 3), iron: 60, stone: 100, brick: 200, planks: 200, nails: 100 };
    const res = r.cons.place(p.id, 'smithy', x, z, 0, { hired: 0 });
    expect(res.ok, res.reason).toBe(true);
    const site = r.cons.site(res.site as number)!;
    workUntilDone(r, p.id, site.building);
    const b = r.sim.state.buildings.get(site.building)!;
    expect(b.household).toBe(hh.id);
    expect(b.occupied).toBe(true);
    expect(hh.home).not.toBe(b.id);
    const up = r.cons.upgrade(p.id, b.id);
    expect(up.ok, up.reason).toBe(true);
    expect(r.cons.siteOf(b.id)?.work).toBe('upgrade');
    workUntilDone(r, p.id, b.id);
    expect(b.level).toBe(2);
    // and pull down: not his home, so he may
    const down = r.cons.demolish(p.id, b.id);
    expect(down.ok, down.reason).toBe(true);
  });

  it('cannot be improved by a stranger, and a lord may not pull down what another House owns and uses', () => {
    const r = rig('home-d');
    const { p, hh, x, z } = peasantWithGarden(r, 3);
    makePlayer(r.sim, p);
    hh.stores = { ...allMaterials('smithy', r.cons) };
    const res = r.cons.place(p.id, 'smithy', x, z, 0, { hired: 0 });
    const site = r.cons.site(res.site as number)!;
    workUntilDone(r, p.id, site.building);
    const b = r.sim.state.buildings.get(site.building)!;
    const stranger = peasantWithGarden(r, 3);
    expect(r.cons.upgrade(stranger.p.id, b.id).ok).toBe(false);
    const lord = manorLord(r.sim, village(r.sim).id);
    const down = r.cons.demolish(lord.id, b.id);
    expect(down.ok).toBe(false);
    expect(down.reason).toMatch(/another/i);
    // mending is always allowed to the lord of the place
    b.damage = 0.4;
    expect(r.cons.repair(lord.id, b.id).ok).toBe(true);
  });
});

describe('works ordered by an office', () => {
  it('are paid for by the lord and owned by his House, whoever gave the order', () => {
    const r = rig('home-e');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const lhh = houseOf(r.sim, lord);
    enrich(lhh, allMaterials('barracks', r.cons), 9000);
    const sh = mkHousehold(r.sim, v.id);
    const steward = mkPerson(r.sim, { age: 42, tier: 4, estate: 'free', career: 'steward', household: sh.id, settlement: v.id, house: mkHouse(r.sim, 'Steward').id });
    r.sim.state.setHead(sh, steward);
    steward.offices.push({ office: 'steward', place: v.id, since: 0 });
    sh.purse = 0;
    const spot = r.cons.suggestSpot(steward.id, 'barracks', v.id)!;
    const purse0 = lhh.purse;
    const res = r.cons.place(steward.id, 'barracks', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    const site = r.cons.site(res.site as number)!;
    expect(site.household).toBe(lhh.id);
    expect(site.house).toBe(lord.house);
    expect(site.builder).toBe(steward.id);
    r.sim.advanceDays(2);
    expect(purse0 - lhh.purse).toBeGreaterThan(0);
    expect(sh.purse).toBe(0);
    // the steward may cancel what he ordered
    expect(r.cons.cancel(steward.id, site.id).ok).toBe(true);
  });

  it('are a mayor\'s own cost: the town gets a well from his purse', () => {
    const r = rig('home-f');
    const town = r.sim.world.settlements.find((s) => s.kind === 'town')!;
    const hh = mkHousehold(r.sim, town.id);
    const mayor = mkPerson(r.sim, { age: 45, tier: 4, estate: 'free', career: 'merchant', household: hh.id, settlement: town.id, house: mkHouse(r.sim, 'Mayor').id });
    r.sim.state.setHead(hh, mayor);
    mayor.offices.push({ office: 'mayor', place: town.id, since: 0 });
    enrich(hh, allMaterials('well', r.cons), 3000);
    const spot = r.cons.suggestSpot(mayor.id, 'well', town.id)!;
    expect(spot).not.toBeNull();
    const res = r.cons.place(mayor.id, 'well', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    expect(r.cons.site(res.site as number)!.household).toBe(hh.id);
    expect(r.cons.check(mayor.id, 'barracks', spot.x + 30, spot.z, 0).ok).toBe(false);
  });
});

describe('with the real economy', () => {
  it('lists a lord\'s finished cottage on the market for a family to rent', () => {
    const sim = buildSim('home-g', { roads: [] });
    const social = installSocial(sim);
    const economy = installEconomy(sim, { social });
    installPolitics(sim, { economy, social });
    installAdvancement(sim, { economy, social });
    fakeTerritory(sim);
    const cons = installConstruction(sim, { economy, social });
    setTime(sim, 8 / 24);
    const v = village(sim);
    const lord = manorLord(sim, v.id);
    const hh = houseOf(sim, lord);
    enrich(hh, { planks: 100, straw: 100 }, 5000);
    const spot = cons.suggestSpot(lord.id, 'cottage', v.id)!;
    const res = cons.place(lord.id, 'cottage', spot.x, spot.z, spot.rot);
    expect(res.ok, res.reason).toBe(true);
    const bid = cons.site(res.site as number)!.building;
    // while it is a site, nobody can rent it
    const seeker = [...sim.state.residentsOf(v.id)].find((q) => q.id !== lord.id && !q.death && q.household !== lord.household)!;
    expect(economy.listings(v.id, seeker.id).some((l) => l.building === bid)).toBe(false);
    sim.advanceDays(12);
    expect(sim.state.buildings.get(bid)!.construction).toBe(1);
    const listing = economy.listings(v.id, seeker.id).find((l) => l.building === bid);
    expect(listing).toBeDefined();
    expect(listing!.kind).toBe('house');
    expect(listing!.seller).toBe(lord.id);
  });
});

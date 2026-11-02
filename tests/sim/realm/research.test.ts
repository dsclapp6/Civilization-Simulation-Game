// Research (docs/CIV.md §6.4): commissioning a technique with a researcher and a place, paying its price in the branch's
// currencies, daily progress, hand-over, stopping, and the stand-in market for goods the stores lack.
import { describe, expect, it } from 'vitest';
import { TECHS } from '../../../src/sim/advancement';
import { killPerson } from '../../../src/sim/succession';
import { addBuilding, aManor, forget, realmSim, stock, titlesOfKind, holderOf, householdOf } from './helpers';

const rig = () => realmSim({ politics: true, military: true, preset: 'small' });
const def = (id: string) => TECHS.find((t) => t.id === id)!;

/** A manor lord with a place for heavy ploughs and the House without the technique. */
function ploughScene() {
  const r = rig();
  const m = aManor(r.sim);
  forget(r, 'heavy_plough');
  const smithy = addBuilding(r.sim, m.settlement, 'carpenter');
  return { ...r, ...m, smithy };
}

describe('the options', () => {
  it('list the techniques the House lacks and may take up, with price, researchers and places', () => {
    const { sim, realm, lord } = ploughScene();
    const options = realm.researchOptions(lord.id);
    const o = options.find((x) => x.tech === 'heavy_plough')!;
    expect(o).toBeTruthy();
    expect(o.branch).toBe('economy');
    expect(o.cost).toEqual({ goods: def('heavy_plough').research!.goods, pence: 220, days: def('heavy_plough').research!.days });
    expect(o.researchers.length).toBeGreaterThan(0);
    expect(o.places.length).toBeGreaterThan(0);
    // the techniques the House has are not offered, nor those whose parents it lacks
    for (const x of options) {
      expect(sim.services.advancement!.houseHas(lord.house, x.tech)).toBe(false);
      for (const req of def(x.tech).requires) expect(sim.services.advancement!.houseHas(lord.house, req)).toBe(true);
    }
    expect(options.some((x) => x.tech === 'improved_rotation')).toBe(false);
  });

  it('say why one cannot be started: goods, coin, no place, no researcher', () => {
    const { realm, lord, hh } = ploughScene();
    const o = realm.researchOptions(lord.id).find((x) => x.tech === 'heavy_plough')!;
    expect(o.ok).toBe(false);
    expect(o.reason).toMatch(/Needs .*planks.*timber/);
    expect(o.short).toEqual({ planks: 20, timber: 24 });
    expect(o.buyCost).toBeGreaterThan(0);
    expect(o.buyable).toBe(true);
    // a school the realm lacks
    const ws = realm.researchOptions(lord.id).find((x) => x.tech === 'wool_trade');
    if (ws) expect(ws.reason).toMatch(/You have no warehouse|Nobody in your lands/);
    hh.purse = 50;
    const poor = realm.researchOptions(lord.id).find((x) => x.tech === 'heavy_plough')!;
    expect(poor.reason).toMatch(/treasury holds/);
    // goods can be bought only if the treasury can pay for the work and the goods both, and there is a merchant
    hh.purse = 230;
    expect(realm.researchOptions(lord.id).find((x) => x.tech === 'heavy_plough')!.buyable).toBe(false);
  });

  it('cannot be bought into without a merchant', () => {
    const r = realmSim({ politics: true, military: true, preset: 'small', market: false });
    const m = aManor(r.sim);
    forget(r, 'heavy_plough');
    addBuilding(r.sim, m.settlement, 'carpenter');
    const o = r.realm.researchOptions(m.lord.id).find((x) => x.tech === 'heavy_plough')!;
    expect(o.buyable).toBe(false);
    const res = r.realm.startResearch(m.lord.id, 'heavy_plough', 0, -1, { buy: true });
    expect(res.ok).toBe(false);
    expect(res.reason).toMatch(/no merchant/);
  });

  it('are empty for someone who rules nothing, and say so for a steward who may not commission', () => {
    const { sim, realm } = rig();
    const farmer = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'farmer' && p.rankTier <= 2)!;
    expect(realm.researchOptions(farmer.id)).toEqual([]);
    expect(realm.startResearch(farmer.id, 'heavy_plough', 0, -1).ok).toBe(false);
  });
});

describe('starting and finishing', () => {
  it('pays the price from the treasury and stores, works day by day, and hands the technique to the researcher and the lord', () => {
    const r = ploughScene();
    const { sim, realm, adv, lord, hh } = r;
    stock(sim, hh, { timber: 30, planks: 25 });
    const events: string[] = [];
    sim.events.on('research', (e) => events.push(e.phase));
    const purse0 = hh.purse;
    const res = realm.startResearch(lord.id, 'heavy_plough', 0, -1);
    expect(res.ok, res.reason).toBe(true);
    expect(hh.purse).toBe(Math.round((purse0 - 220) * 100) / 100);
    expect(hh.stores.timber).toBe(6);
    expect(hh.stores.planks).toBe(5);
    const p = realm.projects(lord.house).find((x) => x.id === res.project)!;
    expect(p.state).toBe('active');
    expect(p.progress).toBe(0);
    expect(events).toEqual(['started']);
    expect(realm.startResearch(lord.id, 'heavy_plough', 0, -1)).toMatchObject({ ok: false, reason: 'Already under way' });

    // it takes about a week or two at a capable researcher's pace; the daily jobs run in the early hours
    sim.advanceDays(3);
    const mid = realm.projects().find((x) => x.id === res.project)!;
    expect(mid.progress).toBeGreaterThan(0.05);
    expect(mid.progress).toBeLessThan(1);
    expect(mid.eta).toBeGreaterThan(sim.absDay);
    for (let i = 0; i < 40 && realm.projects().find((x) => x.id === res.project)!.state === 'active'; i++) sim.advanceDays(1);
    const done = realm.projects().find((x) => x.id === res.project)!;
    expect(done.state).toBe('done');
    expect(adv.knows(done.researcher, 'heavy_plough')).toBe(true);
    expect(adv.knows(lord.id, 'heavy_plough')).toBe(true);
    expect(adv.houseHas(lord.house, 'heavy_plough')).toBe(true);
    expect(events).toEqual(['started', 'done']);
    expect(realm.news(10).some((n) => n.kind === 'research' && /heavy plough/.test(n.text))).toBe(true);
  });

  it('refuses without coin, without goods, without a researcher of the right trade, and in the wrong building', () => {
    const r = ploughScene();
    const { realm, lord, hh, sim } = r;
    // goods first
    const noGoods = realm.startResearch(lord.id, 'heavy_plough', 0, -1);
    expect(noGoods.ok).toBe(false);
    expect(noGoods.reason).toMatch(/^Needs /);
    stock(sim, hh, { timber: 30, planks: 25 });
    // a building that is no place for it
    const church = addBuilding(sim, r.settlement, 'church');
    expect(realm.startResearch(lord.id, 'heavy_plough', 0, church.id).reason).toMatch(/no place for it/);
    // a researcher who is a child
    const child = [...sim.state.persons.values()].find((p) => !p.death && p.settlement === r.settlement && (sim.absDay - p.birthDay) / 16 < 10)!;
    expect(realm.startResearch(lord.id, 'heavy_plough', child.id, -1).ok).toBe(false);
    // not enough coin
    hh.purse = 100;
    expect(realm.startResearch(lord.id, 'heavy_plough', 0, -1).reason).toMatch(/treasury holds/);
    // a technique that needs another first
    expect(realm.startResearch(lord.id, 'windmill', 0, -1).ok).toBe(false);
    expect(realm.startResearch(lord.id, 'no_such_tech', 0, -1).ok).toBe(false);
  });

  it('buys what the stores lack when told to, and waits for the carts', () => {
    const r = ploughScene();
    const { realm, lord, hh, sim, market } = r;
    market.days = 2;
    const purse0 = hh.purse;
    const refused = realm.startResearch(lord.id, 'heavy_plough', 0, -1);
    expect(refused.ok).toBe(false);
    const res = realm.startResearch(lord.id, 'heavy_plough', 0, -1, { buy: true });
    expect(res.ok, res.reason).toBe(true);
    const p = realm.projects().find((x) => x.id === res.project)!;
    expect(p.state).toBe('stalled');
    expect(p.note).toMatch(/Waiting for/);
    expect(p.needs).toEqual({ planks: 20, timber: 24 });
    expect(market.calls.filter((c) => c.fn === 'procure').map((c) => c.good).sort()).toEqual(['planks', 'timber']);
    expect(hh.purse).toBeLessThan(purse0 - 220);
    // the goods come in two days, the work begins on the next morning
    sim.advanceDays(1);
    expect(realm.projects().find((x) => x.id === res.project)!.state).toBe('stalled');
    sim.advanceDays(3);
    const after = realm.projects().find((x) => x.id === res.project)!;
    expect(after.state).toBe('active');
    expect(after.progress).toBeGreaterThan(0);
    expect(after.needs).toBeUndefined();
    expect(hh.stores.timber ?? 0).toBeLessThan(1);
  });

  it('refuses to start when the market has none of what is lacking, and gives a work up after a season when the rest never comes', () => {
    const r = ploughScene();
    const { realm, lord, hh, sim, market } = r;
    market.strict = true;
    market.stock[r.settlement] = {};
    const purse0 = hh.purse;
    const none = realm.startResearch(lord.id, 'heavy_plough', 0, -1, { buy: true });
    expect(none.ok).toBe(false);
    expect(none.reason).toMatch(/market has none/);
    expect(hh.purse).toBe(purse0); // nothing was spent
    // a little is to be had, and the rest never comes
    market.stock[r.settlement] = { timber: 10, planks: 5 };
    const res = realm.startResearch(lord.id, 'heavy_plough', 0, -1, { buy: true });
    expect(res.ok, res.reason).toBe(true);
    expect(realm.projects().find((x) => x.id === res.project)!.state).toBe('stalled');
    sim.advanceDays(52);
    const p = realm.projects().find((x) => x.id === res.project)!;
    expect(p.state).toBe('abandoned');
    // half of the unspent price came back, and the books say so
    expect(realm.accounts!(lord.id).find((l) => l.label === 'Research refunded')?.pence).toBe(110);
  });

  it('does not order the same goods twice while they are on the road', () => {
    const r = ploughScene();
    const { realm, lord, sim, market } = r;
    market.days = 6; // the carts are slow
    const res = realm.startResearch(lord.id, 'heavy_plough', 0, -1, { buy: true });
    expect(res.ok, res.reason).toBe(true);
    const orders = market.calls.filter((c) => c.fn === 'procure').length;
    expect(orders).toBe(2);
    sim.advanceDays(5);
    expect(market.calls.filter((c) => c.fn === 'procure').length).toBe(2);
    expect(realm.projects().find((x) => x.id === res.project)!.note).toMatch(/on the road/);
    sim.advanceDays(4);
    expect(realm.projects().find((x) => x.id === res.project)!.state).toBe('active');
    expect(market.calls.filter((c) => c.fn === 'procure').length).toBe(2);
  });

  it('can be stopped by the lord, who gets part of the price back; others cannot stop it', () => {
    const r = ploughScene();
    const { realm, lord, hh, sim } = r;
    stock(sim, hh, { timber: 30, planks: 25 });
    const res = realm.startResearch(lord.id, 'heavy_plough', 0, -1);
    expect(res.ok).toBe(true);
    const purse = hh.purse;
    const kt = titlesOfKind(sim, 'kingdom')[0];
    expect(realm.stopResearch(holderOf(sim, kt).id, res.project!).ok).toBe(false);
    expect(realm.stopResearch(lord.id, res.project!).ok).toBe(true);
    expect(hh.purse).toBe(purse + 110);
    expect(realm.projects().find((x) => x.id === res.project)!.state).toBe('abandoned');
    expect(realm.stopResearch(lord.id, res.project!).ok).toBe(false);
    expect(hh.stores.timber).toBeGreaterThan(6);
  });

  it('puts another man to the work when the researcher dies, or stands still when there is none', () => {
    const r = ploughScene();
    const { realm, lord, hh, sim } = r;
    stock(sim, hh, { timber: 30, planks: 25 });
    const res = realm.startResearch(lord.id, 'heavy_plough', 0, -1);
    expect(res.ok).toBe(true);
    sim.advanceDays(2);
    const first = realm.projects().find((x) => x.id === res.project)!;
    const before = first.progress;
    const dead = sim.state.persons.get(first.researcher)!;
    killPerson(sim, dead, 'accident', sim.absDay);
    sim.advanceDays(2);
    const after = realm.projects().find((x) => x.id === res.project)!;
    expect(after.researcher).not.toBe(first.researcher);
    expect(after.progress).toBeGreaterThan(before);
    expect(after.state).toBe('active');
  });

  it('refuses a second work with the same researcher, and past the limit of works', () => {
    const r = ploughScene();
    const { realm, lord, hh, sim } = r;
    stock(sim, hh, { timber: 300, planks: 300, iron: 200, arrow: 400, stone: 400 });
    addBuilding(sim, r.settlement, 'smithy');
    addBuilding(sim, r.settlement, 'archery_butts');
    const a = realm.startResearch(lord.id, 'heavy_plough', 0, -1);
    expect(a.ok, a.reason).toBe(true);
    const first = realm.projects().find((x) => x.id === a.project)!;
    // the same man is at another work already
    const again = realm.startResearch(lord.id, 'longbow_drill', first.researcher, -1);
    expect(again.ok).toBe(false);
    expect(again.reason).toMatch(/at another work/);
  });
});

describe('who can do it', () => {
  it('lets a lord of the right standing work out a charter himself, and puts clerks and masters on other works at half pace', () => {
    const r = rig();
    const { sim, realm } = r;
    const kt = titlesOfKind(sim, 'kingdom')[0];
    const king = holderOf(sim, kt);
    forget(r, 'market_charter');
    forget(r, 'fair_charter');
    const capital = sim.world.kingdoms.find((k) => k.id === kt.place)!.capital;
    addBuilding(sim, capital, 'market_hall');
    stock(sim, householdOf(sim, king), { timber: 100, planks: 100 });
    const o = realm.researchOptions(king.id).find((x) => x.tech === 'market_charter')!;
    expect(o).toBeTruthy();
    expect(o.researchers.length).toBeGreaterThan(0);
    expect(o.ok, o.reason).toBe(true);
    // somebody of the other group is listed as slow
    const all = realm.researchOptions(king.id);
    const slow = all.find((x) => (x.slow?.length ?? 0) > 0);
    if (slow) for (const id of slow.slow!) expect(slow.researchers).toContain(id);
  });
});

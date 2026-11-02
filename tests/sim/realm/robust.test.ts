// The calls take whatever the panel or an AI gives them: nobody, a stranger, a dead man, a place that is not there, a good that
// does not exist. None of them may throw, and none may change the world when it refuses.
import { describe, expect, it } from 'vitest';
import { killPerson } from '../../../src/sim/succession';
import { aManor, realmSim, titlesOfKind, holderOf } from './helpers';

describe('odd arguments', () => {
  it('are refused in plain words, never thrown at, and leave the state as it was', () => {
    const r = realmSim({ preset: 'small', politics: true, military: true });
    const { sim, realm } = r;
    const { lord } = aManor(sim);
    const farmer = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'farmer' && p.rankTier <= 2)!;
    const dead = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'labourer')!;
    killPerson(sim, dead, 'accident', sim.absDay);
    const before = sim.stateHash();
    const people = [0, -1, 999999, Number.NaN, farmer.id, dead.id];
    const places = [-1, 0, 9999, Number.NaN];
    for (const who of people) {
      expect(() => {
        realm.canRule(who); realm.view(who); realm.rules!(who); realm.researchOptions(who); realm.projects();
        realm.tradeOrders(who); realm.rivals(who); realm.troops!(who); realm.accounts!(who);
        expect(realm.startResearch(who, 'heavy_plough', 0, -1).ok).toBe(false);
        expect(realm.startResearch(who, 'nonsense', 0, -1).ok).toBe(false);
        expect(realm.stopResearch(who, 1).ok).toBe(false);
        expect(realm.dub(who, lord.id).ok).toBe(false);
        expect(realm.dub(lord.id, who).ok).toBe(false);
        expect(realm.discharge!(who, lord.id).ok).toBe(false);
        expect(realm.removeTradeOrder(who, 1).ok).toBe(false);
        expect(realm.addTradeOrder(who, { settlement: 0, good: 'wheat', side: 'sell', limit: 0, keep: 0 }).ok).toBe(false);
        for (const place of places) {
          realm.recruitOptions(who, place);
          expect(realm.recruit(who, place, 'archer', 3).ok).toBe(false);
          expect(realm.setCropPlan(who, place, 0, 'wheat').ok).toBe(false);
          expect(realm.setWorksShare(who, place, 0.5).ok).toBe(false);
        }
      }, `person ${who}`).not.toThrow();
    }
    for (const place of places) {
      expect(() => { realm.rulerOf(place); realm.cropPlan(place); realm.cropPlanView!(place); realm.worksShare(place); }).not.toThrow();
    }
    expect(realm.rulerOf(Number.NaN)).toBe(0);
    expect(realm.worksShare(9999)).toBe(0);
    // a ruler's own bad requests
    expect(realm.recruit(lord.id, 9999, 'archer', 3).ok).toBe(false);
    expect(realm.recruit(lord.id, lord.settlement, 'archer', Number.NaN).ok).toBe(false);
    expect(realm.recruit(lord.id, lord.settlement, 'dragon' as 'archer', 3).ok).toBe(false);
    expect(realm.setCropPlan(lord.id, lord.settlement, 0, 'dragonfruit' as 'wheat').ok).toBe(false);
    expect(realm.startResearch(lord.id, 'heavy_plough', 999999, -1).ok).toBe(false);
    expect(realm.startResearch(lord.id, 'heavy_plough', 0, 999999).ok).toBe(false);
    expect(realm.addTradeOrder(lord.id, { settlement: 0, good: 'wheat', side: 'swap' as 'sell', limit: 0, keep: 0 }).ok).toBe(false);
    expect(realm.addTradeOrder(lord.id, { settlement: 0, good: 'wheat', side: 'sell', limit: Number.POSITIVE_INFINITY, keep: 0 }).ok).toBe(false);
    expect(sim.stateHash()).toBe(before);
  });

  it('work for a ruler whose House has gone, whose lands are all lost, or who is dead', () => {
    const r = realmSim({ preset: 'small', politics: true, military: true });
    const { sim, realm } = r;
    const { lord, title } = aManor(sim);
    killPerson(sim, lord, 'accident', sim.absDay);
    sim.advanceDays(2);
    expect(realm.canRule(lord.id)).toBe(false);
    expect(realm.view(lord.id)).toBeNull();
    // the heir (or whoever the title passed to) rules now
    const ruler = realm.rulerOf(title.place);
    if (ruler) expect(realm.canRule(ruler)).toBe(true);
    // the daily jobs run over it all
    sim.advanceDays(6);
    const king = holderOf(sim, titlesOfKind(sim, 'kingdom')[0]);
    expect(realm.view(king.id)).toBeTruthy();
  });

  it('survive a world with none of the other modules installed', () => {
    const r = realmSim({ preset: 'tiny', market: false });
    const { sim, realm } = r;
    const manor = titlesOfKind(sim, 'manor')[0];
    const lord = holderOf(sim, manor);
    expect(realm.canRule(lord.id)).toBe(true);
    expect(realm.view(lord.id)!.strength).toBeGreaterThanOrEqual(0);
    expect(realm.rivals(lord.id)).toEqual(expect.any(Array));
    expect(realm.recruitOptions(lord.id, manor.place).find((o) => o.kind === 'mercenary')!.available).toBeGreaterThanOrEqual(0);
    expect(realm.recruit(lord.id, manor.place, 'mercenary', 2).ok).toBe(false);
    sim.advanceDays(5);
  });
});

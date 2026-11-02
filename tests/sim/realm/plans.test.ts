// The field plan and the works share (docs/CIV.md §6.3).
import { describe, expect, it } from 'vitest';
import { nextSowing } from '../../../src/sim/realm/plans';
import { aManor, realmSim, setDay, titlesOfKind } from './helpers';

const rig = () => realmSim({ preset: 'small' });
/** Year index and day of the year to an absolute day. */
const at = (year: number, day: number): number => year * 16 + day;

describe('which sowing a field is due', () => {
  it('goes spring crop → autumn winter corn → (a year of winter corn) → spring, and so around', () => {
    // field 0 is winter corn in year 0, a spring crop in year 1, fallow in year 2
    expect(nextSowing(1, at(0, 1))).toBe('spring');   // spring crop year, before the sowing is over
    expect(nextSowing(1, at(0, 9))).toBe('winter');   // sown; the next is autumn of the year after (the field lay fallow)
    expect(nextSowing(2, at(0, 5))).toBe('winter');   // fallow: sown with winter corn in autumn
    expect(nextSowing(2, at(0, 13))).toBe('spring');  // that is done: the next sowing is a spring crop
    expect(nextSowing(0, at(0, 2))).toBe('spring');   // winter corn standing: spring next
  });
});

describe('the crop plan', () => {
  it('says "fallow" (the usual rotation decides) until a crop is named', () => {
    const { realm, lord, settlement } = (() => { const r = rig(); return { ...r, ...aManor(r.sim) }; })();
    expect(realm.cropPlan(settlement)).toEqual({ 0: 'fallow', 1: 'fallow', 2: 'fallow' });
    expect(realm.setCropPlan(lord.id, settlement, 0, 'rye').ok).toBe(true);
  });

  it('answers with the crop for each field\'s next sowing', () => {
    const r = rig();
    const { sim, realm, lord, settlement } = { ...r, ...aManor(r.sim) };
    setDay(sim, at(0, 1));
    // field 2 lies fallow and gets winter corn in autumn; field 1 gets a spring crop now; field 0 waits for next spring
    expect(realm.setCropPlan(lord.id, settlement, 2, 'rye').ok).toBe(true);
    expect(realm.setCropPlan(lord.id, settlement, 1, 'oats').ok).toBe(true);
    expect(realm.setCropPlan(lord.id, settlement, 0, 'peas').ok).toBe(true);
    expect(realm.cropPlan(settlement)).toEqual({ 0: 'peas', 1: 'oats', 2: 'rye' });
    // the spring sowing is done: field 1 is next sown in autumn with winter corn it has no plan for
    setDay(sim, at(0, 6));
    expect(realm.cropPlan(settlement)).toEqual({ 0: 'peas', 1: 'fallow', 2: 'rye' });
    // after the autumn sowing field 2 turns to its spring crop (none planned)
    setDay(sim, at(0, 13));
    expect(realm.cropPlan(settlement)).toEqual({ 0: 'peas', 1: 'fallow', 2: 'fallow' });
    // the view shows both plans per field and the choices
    const view = realm.cropPlanView!(settlement);
    expect(view).toHaveLength(3);
    expect(view[2].winter).toBe('rye');
    expect(view[1].spring).toBe('oats');
    expect(view[0].options.winter).toEqual(['wheat', 'rye']);
    expect(view[0].options.spring).toEqual(['barley', 'oats', 'peas', 'beans']);
    expect(view.map((v) => v.role)).toEqual(['winter', 'spring', 'fallow']);
  });

  it('clears a field\'s plan with "fallow", and refuses what the open fields do not grow', () => {
    const r = rig();
    const { realm, lord, settlement } = { ...r, ...aManor(r.sim) };
    realm.setCropPlan(lord.id, settlement, 0, 'wheat');
    realm.setCropPlan(lord.id, settlement, 0, 'barley');
    expect(realm.cropPlanView!(settlement)[0].winter).toBe('wheat');
    expect(realm.cropPlanView!(settlement)[0].spring).toBe('barley');
    expect(realm.setCropPlan(lord.id, settlement, 0, 'fallow').ok).toBe(true);
    expect(realm.cropPlanView!(settlement)[0].winter).toBe('fallow');
    expect(realm.cropPlanView!(settlement)[0].spring).toBe('fallow');
    expect(realm.setCropPlan(lord.id, settlement, 0, 'flax').ok).toBe(false);
    expect(realm.setCropPlan(lord.id, settlement, 0, 'cabbage').ok).toBe(false);
    expect(realm.setCropPlan(lord.id, settlement, 3 as 0, 'wheat').ok).toBe(false);
    expect(realm.setCropPlan(lord.id, -9, 0, 'wheat').ok).toBe(false);
    expect(r.R.data.plans[String(settlement)]).toBeUndefined();
  });

  it('is for the lord, his steward and the reeve of that manor only', () => {
    const r = rig();
    const { sim, realm, lord, settlement } = { ...r, ...aManor(r.sim) };
    const farmer = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'farmer' && p.settlement === settlement && !p.offices.some((o) => o.office === 'reeve'))!;
    expect(realm.setCropPlan(farmer.id, settlement, 0, 'wheat')).toMatchObject({ ok: false });
    const other = titlesOfKind(sim, 'manor').find((t) => t.holder !== lord.id)!;
    expect(realm.setCropPlan(lord.id, other.place, 0, 'wheat').ok).toBe(false);
    const reeve = [...sim.state.persons.values()].find((p) => !p.death && p.offices.some((o) => o.office === 'reeve' && o.place === settlement));
    if (reeve) expect(realm.setCropPlan(reeve.id, settlement, 1, 'oats').ok).toBe(true);
  });
});

describe('the works share', () => {
  it('is none by default, set in twentieths, kept between 0 and 1', () => {
    const r = rig();
    const { realm, lord, settlement } = { ...r, ...aManor(r.sim) };
    expect(realm.worksShare(settlement)).toBe(0);
    expect(realm.setWorksShare(lord.id, settlement, 0.33).ok).toBe(true);
    expect(realm.worksShare(settlement)).toBe(0.35);
    realm.setWorksShare(lord.id, settlement, 3);
    expect(realm.worksShare(settlement)).toBe(1);
    realm.setWorksShare(lord.id, settlement, -1);
    expect(realm.worksShare(settlement)).toBe(0);
    expect(realm.setWorksShare(lord.id, settlement, Number.NaN).ok).toBe(false);
    expect(r.R.data.plans[String(settlement)]).toBeUndefined();
  });

  it('is the lord\'s to give, and no one else\'s', () => {
    const r = rig();
    const { sim, realm, lord, settlement } = { ...r, ...aManor(r.sim) };
    const stranger = [...sim.state.persons.values()].find((p) => !p.death && p.career === 'farmer' && p.settlement !== settlement && !p.offices.length)!;
    expect(realm.setWorksShare(stranger.id, settlement, 0.5).ok).toBe(false);
    expect(realm.worksShare(settlement)).toBe(0);
    expect(realm.setWorksShare(lord.id, settlement, 0.5).ok).toBe(true);
    // it is read often (every site, every day): and costs nothing to ask
    for (let i = 0; i < 1000; i++) realm.worksShare(settlement);
  });
});

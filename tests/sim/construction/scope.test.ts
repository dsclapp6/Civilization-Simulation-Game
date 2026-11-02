// Who may build what where (SPEC §7, CIV §5): scope by rank, offices and titles; the catalogue and its reasons.
import { describe, expect, it } from 'vitest';
import { BUILDING_KINDS } from '../../../src/content/types';
import type { Person } from '../../../src/sim/state';
import { mkHousehold, mkHouse, mkPerson } from '../builders';
import { houseOf, manorLord, peasantWithGarden, rig, setTime, village, type Rig } from './helpers';

/** Gives a fake advancement service: only the listed techniques are commanded. */
function techs(r: Rig, have: string[] = []): void {
  (r.sim.services as { advancement?: unknown }).advancement = {
    knows: () => false,
    houseHas: (_h: number, t: string) => have.includes(t),
    tech: (id: string) => ({ name: id.replace(/_/g, ' ') }),
  };
}

function titleHolder(r: Rig, kind: 'county' | 'kingdom' | 'abbey' | 'town', place?: number): Person {
  const t = [...r.sim.state.titles.values()].find((x) => x.kind === kind && (place === undefined || x.place === place))!;
  return r.sim.state.persons.get(t.holder)!;
}

describe('scope by rank', () => {
  it('lets the lord of a manor build anywhere in it, paying from his own household', () => {
    const r = rig('scope-a');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const sc = r.cons.scope(lord.id);
    expect(sc.role).toBe('lord');
    expect(sc.settlements).toContain(v.id);
    expect(sc.household).toBe(lord.household);
    expect(sc.house).toBe(lord.house);
    expect(sc.outposts).toBe(false);
    expect(sc.label).toMatch(/manor of/i);
    expect(sc.agentFor).toEqual([]);
    expect(sc.rank).toBe(lord.rankTier);
  });

  it('lets an earl or king found outposts as well; a knight cannot', () => {
    const r = rig('scope-b');
    const v = village(r.sim);
    expect(r.cons.scope(manorLord(r.sim, v.id).id).outposts).toBe(false);
    const earl = titleHolder(r, 'county', 1);
    const es = r.cons.scope(earl.id);
    expect(es.outposts).toBe(true);
    expect(es.role).toBe('baron');
    expect(es.settlements).toContain(2); // the county's seat
    const king = titleHolder(r, 'kingdom');
    const ks = r.cons.scope(king.id);
    expect(ks.outposts).toBe(true);
    expect(ks.settlements).toContain(0);
    expect(ks.label).toMatch(/kingdom of/i);
  });

  it('gives an abbot his abbey', () => {
    const r = rig('scope-c');
    const abbot = titleHolder(r, 'abbey', 3);
    const sc = r.cons.scope(abbot.id);
    expect(sc.settlements).toContain(3);
    expect(sc.outposts).toBe(true);
  });

  it('gives a peasant head his own household\'s buildings, nothing more', () => {
    const r = rig('scope-d');
    const { p, hh } = peasantWithGarden(r, 2);
    const sc = r.cons.scope(p.id);
    expect(sc.role).toBe('head');
    expect(sc.settlements).toEqual([]);
    expect(sc.outposts).toBe(false);
    expect(sc.own).toContain(hh.home);
    expect(sc.household).toBe(hh.id);
    expect(sc.label).toMatch(/croft/);
  });

  it('calls a middling head\'s holding a house and workshop', () => {
    const r = rig('scope-e');
    const { p } = peasantWithGarden(r, 3);
    expect(r.cons.scope(p.id).label).toMatch(/workshop/);
  });

  it('gives nothing to a grown child who is not the head, a child, or a prisoner', () => {
    const r = rig('scope-f');
    const { hh } = peasantWithGarden(r, 2);
    const son = mkPerson(r.sim, { age: 18, household: hh.id, settlement: hh.settlement, tier: 2, estate: 'free' });
    const sc = r.cons.scope(son.id);
    expect(sc.role).toBe('none');
    expect(sc.own).toEqual([]);
    expect(sc.label).toMatch(/head of the household/i);
    expect(r.cons.catalogue(son.id, hh.settlement).every((o) => !o.ok)).toBe(true);
    const boy = mkPerson(r.sim, { age: 9, household: hh.id, settlement: hh.settlement });
    expect(r.cons.scope(boy.id).label).toMatch(/young/i);
    const lord = manorLord(r.sim, village(r.sim).id);
    lord.flags.captive = true;
    expect(r.cons.scope(lord.id).role).toBe('none');
    expect(r.cons.scope(lord.id).label).toMatch(/prisoner/i);
  });

  it('lets a steward build for the lord of the place, with the lord\'s money, up to his own rank', () => {
    const r = rig('scope-g');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const hh = mkHousehold(r.sim, v.id);
    const steward = mkPerson(r.sim, { age: 40, tier: 4, estate: 'free', career: 'steward', household: hh.id, settlement: v.id, house: mkHouse(r.sim, 'Steward').id });
    r.sim.state.setHead(hh, steward);
    steward.offices.push({ office: 'steward', place: v.id, since: 0 });
    const sc = r.cons.scope(steward.id);
    expect(sc.role).toBe('steward');
    expect(sc.settlements).toContain(v.id);
    expect(sc.agentFor).toContain(v.id);
    expect(sc.household).toBe(hh.id);
    // the catalogue: barracks are within his rank (gentry), a wall or keep is not
    techs(r, ['stone_keep', 'curtain_walls']);
    const cat = r.cons.catalogue(steward.id, v.id);
    expect(cat.find((o) => o.kind === 'barracks')!.ok).toBe(true);
    const wall = cat.find((o) => o.kind === 'wall')!;
    expect(wall.ok).toBe(false);
    expect(wall.reason).toMatch(/lord of/i);
    void lord;
  });

  it('limits a reeve to the farm and the village\'s own works', () => {
    const r = rig('scope-h');
    const v = village(r.sim);
    const hh = mkHousehold(r.sim, v.id);
    const reeve = mkPerson(r.sim, { age: 40, tier: 2, estate: 'free', career: 'farmer', household: hh.id, settlement: v.id, house: mkHouse(r.sim, 'Reeve').id });
    r.sim.state.setHead(hh, reeve);
    reeve.offices.push({ office: 'reeve', place: v.id, since: 0 });
    const cat = r.cons.catalogue(reeve.id, v.id);
    expect(cat.find((o) => o.kind === 'granary')!.ok).toBe(true);
    expect(cat.find((o) => o.kind === 'well')!.ok).toBe(true);
    expect(cat.find((o) => o.kind === 'smithy')!.ok).toBe(false);
    expect(cat.find((o) => o.kind === 'smithy')!.reason).toMatch(/may not order/i);
    expect(cat.find((o) => o.kind === 'church')!.ok).toBe(false);
  });

  it('lets a mayor raise the town\'s civic buildings from his own purse', () => {
    const r = rig('scope-i');
    const town = r.sim.world.settlements.find((s) => s.kind === 'town')!;
    const hh = mkHousehold(r.sim, town.id);
    const mayor = mkPerson(r.sim, { age: 45, tier: 4, estate: 'free', career: 'merchant', household: hh.id, settlement: town.id, house: mkHouse(r.sim, 'Mayor').id });
    r.sim.state.setHead(hh, mayor);
    mayor.offices.push({ office: 'mayor', place: town.id, since: 0 });
    const sc = r.cons.scope(mayor.id);
    expect(sc.settlements).toContain(town.id);
    expect(sc.household).toBe(hh.id);
    const cat = r.cons.catalogue(mayor.id, town.id);
    expect(cat.find((o) => o.kind === 'well')!.ok).toBe(true);
    expect(cat.find((o) => o.kind === 'market_cross')!.ok).toBe(true);
    expect(cat.find((o) => o.kind === 'barracks')!.ok).toBe(false);
  });

  it('lets a regent act for a child lord, with the ward\'s money', () => {
    const r = rig('scope-j');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const title = r.sim.state.titleFor('manor', v.id)!;
    // the lord is a child of 8, his uncle regent
    lord.birthDay = r.sim.absDay - 8 * 16;
    const uh = mkHousehold(r.sim, v.id);
    const uncle = mkPerson(r.sim, { age: 38, tier: 5, estate: 'noble', career: 'knight', house: lord.house, settlement: v.id, household: uh.id });
    r.sim.state.setHead(uh, uncle);
    uncle.flags.regent = true;
    title.regent = uncle.id;
    const sc = r.cons.scope(uncle.id);
    expect(sc.settlements).toContain(v.id);
    // the ward's household pays: the lord's own
    expect(sc.household).toBe(lord.household);
    // while the child is the one who holds it, the child builds nothing
    expect(r.cons.scope(lord.id).role).not.toBe('lord');
    // nor does a holder of fifteen, while a regent still acts for him
    setTime(r.sim, 0.4, Math.floor(r.sim.absDay) + 1); // (scopes are worked out afresh each day)
    lord.birthDay = r.sim.absDay - 15 * 16;
    r.sim.state.touch(lord);
    expect(r.cons.scope(lord.id).role).not.toBe('lord');
    expect(r.cons.scope(uncle.id).role).toBe('lord');
    // at sixteen the regency is over
    setTime(r.sim, 0.4, Math.floor(r.sim.absDay) + 1);
    lord.birthDay = r.sim.absDay - 16 * 16 - 1;
    expect(r.cons.scope(lord.id).role).toBe('lord');
  });
});

describe('the catalogue', () => {
  it('lists every kind with cost, requirements, what it does and whether it may be raised', () => {
    const r = rig('cat-a');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    techs(r, ['watermill']);
    const cat = r.cons.catalogue(lord.id, v.id);
    expect(cat.map((o) => o.kind)).toEqual([...BUILDING_KINDS]);
    const mill = cat.find((o) => o.kind === 'watermill')!;
    expect(mill.requires).toMatchObject({ tech: 'watermill', terrain: 'river' });
    expect(mill.cost.labour).toBe(60);
    expect(mill.does).toMatch(/grinds/i);
    expect(mill.category).toBe('food');
    expect(mill.ok).toBe(true);
    const mine = cat.find((o) => o.kind === 'mine')!;
    expect(mine.requires.terrain).toBe('deposit');
    expect(mine.requires.deposits).toEqual(['iron', 'silver', 'gold']);
    // every kind says why it can't be built
    for (const o of cat) if (!o.ok) expect(o.reason, o.kind).toBeTruthy();
  });

  it('says what a technique is missing', () => {
    const r = rig('cat-b');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    techs(r, []);
    const keep = r.cons.catalogue(lord.id, v.id).find((o) => o.kind === 'keep_stone')!;
    expect(keep.ok).toBe(false);
    expect(keep.reason).toMatch(/stone keep/i);
    techs(r, ['stone_keep']);
    expect(r.cons.catalogue(lord.id, v.id).find((o) => o.kind === 'keep_stone')!.ok).toBe(true);
  });

  it('says which rank a building needs, and "only the lord of X" for a peasant\'s wall', () => {
    const r = rig('cat-c');
    const v = village(r.sim);
    techs(r, ['stone_keep', 'curtain_walls']);
    const { p } = peasantWithGarden(r, 2);
    const cat = r.cons.catalogue(p.id, v.id);
    const hen = cat.find((o) => o.kind === 'henhouse')!;
    expect(hen.ok).toBe(true);
    expect(hen.requires.rank).toBe(1);
    const wall = cat.find((o) => o.kind === 'wall')!;
    expect(wall.ok).toBe(false);
    expect(wall.reason).toMatch(/Only the lord of/);
    const smithy = cat.find((o) => o.kind === 'smithy')!;
    expect(smithy.ok).toBe(false);
    expect(smithy.reason).toMatch(/yeoman|middling|rank/i);
    const { p: master } = peasantWithGarden(r, 3);
    expect(r.cons.catalogue(master.id, v.id).find((o) => o.kind === 'smithy')!.ok).toBe(true);
  });

  it('counts what the place already keeps', () => {
    const r = rig('cat-d');
    const v = village(r.sim);
    const lord = manorLord(r.sim, v.id);
    const cat = r.cons.catalogue(lord.id, v.id);
    const church = cat.find((o) => o.kind === 'church')!;
    expect(church.ok).toBe(false);
    expect(church.reason).toMatch(/already/);
    expect(church.requires.max).toBe(1);
    expect(cat.find((o) => o.kind === 'cottage')!.ok).toBe(true);
  });

  it('shows nothing buildable where the person holds nothing, and the wild only to a baron or greater', () => {
    const r = rig('cat-e');
    const v = village(r.sim);
    const other = r.sim.world.settlements.find((s) => s.kind === 'village' && s.id !== v.id)!;
    const lord = manorLord(r.sim, v.id);
    expect(r.cons.catalogue(lord.id, other.id).every((o) => !o.ok)).toBe(true);
    expect(r.cons.catalogue(lord.id, other.id)[0].reason).toMatch(/no land/);
    const wildKnight = r.cons.catalogue(lord.id, -1);
    expect(wildKnight.every((o) => !o.ok)).toBe(true);
    expect(wildKnight[0].reason).toMatch(/baron/i);
    const earl = titleHolder(r, 'county', 1);
    const wild = r.cons.catalogue(earl.id, -1);
    expect(wild.find((o) => o.kind === 'mine')!.ok).toBe(true);
    expect(wild.find((o) => o.kind === 'church')!.ok).toBe(false);
    expect(wild.find((o) => o.kind === 'church')!.reason).toMatch(/outpost/i);
  });
});

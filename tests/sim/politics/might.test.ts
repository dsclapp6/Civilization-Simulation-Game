// What the rival AI weighs besides head-counts (SPEC §16, "they weigh the new strength"): the walls a siege of a House's lands would
// meet, the quality its techniques add to its men, how thin its standing force is, and whether it is out-building its neighbour
// (the AI rulers of src/sim/realm/ai*.ts raise walls, research and recruit with the player's own calls; `might.ts` and `ai.ts` read it).
import { describe, expect, it } from 'vitest';
import type { BuildingKind } from '../../../src/content/types';
import { FORT_MAX, FORT_WEIGHT, fortFactor, masonryOf, mightOf, siegecraftOf } from '../../../src/sim/politics/might';
import type { BuildingState, HouseId } from '../../../src/sim/state';
import { ageHead, bringNear, housesHolding, noble, rig, setTraits, type Rig } from './helpers';

function building(kind: BuildingKind, o: Partial<BuildingState> = {}): BuildingState {
  return {
    id: 1, plot: -1, kind, level: 1, settlement: 0, construction: 1, damage: 0, onFire: false, owner: 0, household: 0, occupied: false,
    x: 0, z: 0, rot: 0, culture: 'anglo', seed: 1, ...o,
  };
}

/** Puts finished walls and the like into every demesne of a House. */
function fortify(r: Rig, house: HouseId, kinds: BuildingKind[], level = 1): void {
  const st = r.sim.state;
  for (const sid of r.x.core.demesnes(house)) {
    const list = st.buildingsAt.get(sid) ?? [];
    for (const kind of kinds) {
      const b = building(kind, { id: st.nextBuildingId++, settlement: sid, level });
      st.buildings.set(b.id, b);
      list.push(b);
    }
    st.buildingsAt.set(sid, list);
  }
  r.x.core.invalidate();
}

/** A fake advancement service: the bonuses of the techniques a House commands. */
function techs(r: Rig, by: Record<number, Record<string, number>>): void {
  (r.sim.services as { advancement?: unknown }).advancement = { bonus: (house: number, key: string) => by[house]?.[key] ?? 0 };
  r.x.core.invalidate();
}

/** A fake military service: the standing men of each House. */
function standing(r: Rig, by: Record<number, number>): void {
  (r.sim.services as { military?: unknown }).military = { standing: (house: number) => by[house] ?? 0, armies: () => [] };
  r.x.core.invalidate();
}

function pair(r: Rig): { a: HouseId; b: HouseId } {
  const k = housesHolding(r.sim, 'kingdom');
  bringNear(r, k[0], k[1]);
  return { a: k[0], b: k[1] };
}

describe('might.ts: the readings', () => {
  it('counts walls as the macro siege does: none is 1, pieces add up to a ceiling, unfinished and ruined ones do not count', () => {
    expect(fortFactor([]).fort).toBe(1);
    expect(fortFactor([building('cottage')]).fort).toBe(1);
    const one = fortFactor([building('palisade')]);
    expect(one.pieces).toBe(1);
    expect(one.fort).toBeGreaterThan(1.2);
    const wall = fortFactor([building('wall')]);
    expect(wall.fort).toBeGreaterThan(one.fort);
    const ring = fortFactor([building('wall'), building('wall'), building('wall'), building('tower'), building('gatehouse'), building('keep_stone')]);
    expect(ring.fort).toBeGreaterThan(wall.fort);
    expect(ring.pieces).toBe(6);
    const many = fortFactor(Array.from({ length: 30 }, () => building('wall')));
    expect(many.fort).toBeLessThanOrEqual(FORT_MAX + 1e-9);
    // a half-built wall counts for nothing, a ruined one for little
    expect(fortFactor([building('wall', { construction: 0.5 })]).fort).toBe(1);
    expect(fortFactor([building('wall', { damage: 0.9 })]).fort).toBeLessThan(wall.fort);
    // the weights are the siege's own
    expect(FORT_WEIGHT.keep_stone).toBeGreaterThan(FORT_WEIGHT.wall as number);
    expect(FORT_WEIGHT.wall).toBeGreaterThan(FORT_WEIGHT.palisade as number);
  });

  it('weighs the techniques: the bow, plate and paid retinues add to the men (at most a third), masonry and engines to a siege', () => {
    expect(mightOf(() => 0)).toBe(1);
    const some = mightOf((k) => (k === 'arms.longbow' ? 1 : 0));
    expect(some).toBeGreaterThan(1);
    expect(mightOf(() => 100)).toBeCloseTo(1.35, 6);
    expect(masonryOf(() => 0)).toBe(1);
    expect(masonryOf((k) => (k === 'defence.walls' ? 1 : 0))).toBeGreaterThan(1);
    expect(siegecraftOf(() => 0)).toBe(1);
    expect(siegecraftOf((k) => (k === 'siege.trebuchet' ? 1 : 0))).toBeGreaterThan(1);
  });
});

describe('rival AI: what a House builds, trains and learns changes the odds', () => {
  it('a walled neighbour is a harder prize: its bulwark rises with its walls and with the masonry it commands', () => {
    const r = rig({ preset: 'small', seed: 'might-wall' });
    const { a, b } = pair(r);
    const start = r.x.ai.bulwark(b);
    expect(start).toBeGreaterThanOrEqual(1);
    fortify(r, b, ['palisade']);
    const stockade = r.x.ai.bulwark(b);
    expect(stockade).toBeGreaterThan(start);
    fortify(r, b, ['wall', 'wall', 'tower', 'gatehouse', 'keep_stone']);
    const walled = r.x.ai.bulwark(b);
    expect(walled).toBeGreaterThan(stockade);
    expect(walled).toBeLessThanOrEqual(1 + (3.2 - 1) * 0.35 * 1.0001);
    techs(r, { [b]: { 'defence.walls': 2, 'defence.keep': 2 } });
    expect(r.x.ai.bulwark(b)).toBeGreaterThan(walled);
    // the other House's walls are its own
    const aStart = r.x.ai.bulwark(a);
    fortify(r, b, ['wall']);
    expect(r.x.ai.bulwark(a)).toBe(aStart);
  });

  it('desire to take a neighbour falls with its walls, and rises with the besieger\'s engines', () => {
    const r = rig({ preset: 'small', seed: 'might-desire' });
    const { a, b } = pair(r);
    setTraits(r, a, ['ambitious']);
    setTraits(r, b, ['content']);
    for (let i = 0; i < 8; i++) noble(r, a, 'm', 24 + (i % 10), { tier: 5 });
    r.x.core.invalidate();
    const bare = r.x.ai.desire(a, b, 'conquest');
    fortify(r, b, ['wall', 'wall', 'wall', 'tower', 'keep_stone']);
    const walled = r.x.ai.desire(a, b, 'conquest');
    expect(walled).toBeLessThan(bare - 0.03);
    techs(r, { [a]: { 'siege.trebuchet': 3, 'siege.bombard': 2 } });
    const engines = r.x.ai.desire(a, b, 'conquest');
    expect(engines).toBeGreaterThan(walled);
    // walls do not change the desire to take a neighbour that has none
    const c = housesHolding(r.sim, 'county').find((h) => h !== a && h !== b)!;
    bringNear(r, a, c);
    const before = r.x.ai.desire(a, c, 'conquest');
    fortify(r, b, ['wall']);
    expect(r.x.ai.desire(a, c, 'conquest')).toBeCloseTo(before, 6);
  });

  it('the bow, plate and paid retinues make a House\'s men count for more', () => {
    const r = rig({ preset: 'small', seed: 'might-men' });
    const { a, b } = pair(r);
    setTraits(r, a, ['ambitious']);
    setTraits(r, b, ['content']);
    const plain = r.x.ai.desire(a, b, 'conquest');
    expect(r.x.ai.might(a)).toBe(1);
    techs(r, { [a]: { 'arms.longbow': 2, 'levy.retinue': 1, 'armour.plates': 1 } });
    expect(r.x.ai.might(a)).toBeGreaterThan(1.1);
    expect(r.x.ai.desire(a, b, 'conquest')).toBeGreaterThan(plain);
    // the same techniques in the defender's hands take it back
    techs(r, { [a]: { 'arms.longbow': 2, 'levy.retinue': 1, 'armour.plates': 1 }, [b]: { 'arms.longbow': 2, 'levy.retinue': 1, 'armour.plates': 1 } });
    expect(r.x.ai.desire(a, b, 'conquest')).toBeCloseTo(plain, 3);
  });

  it('a House thin on men invites attack, and one that has raised its due does not', () => {
    const r = rig({ preset: 'small', seed: 'might-thin' });
    const { a, b } = pair(r);
    setTraits(r, a, ['ambitious']);
    setTraits(r, b, ['content']);
    standing(r, {});
    expect(r.x.ai.thin(b)).toBe(1);
    const thin = r.x.ai.desire(a, b, 'conquest');
    let pop = 0;
    for (const sid of r.x.core.demesnes(b)) pop += r.sim.state.residentsOf(sid).length;
    standing(r, { [b]: Math.ceil(pop * 0.05) });
    expect(r.x.ai.thin(b)).toBe(0);
    const raised = r.x.ai.desire(a, b, 'conquest');
    expect(raised).toBeLessThan(thin);
    // without the military module the reading is neutral
    delete (r.sim.services as { military?: unknown }).military;
    r.x.core.invalidate();
    expect(r.x.ai.thin(b)).toBe(0);
  });

  it('a neighbour that out-builds you comes for your lands: the growth the rulers report raises the appetite, and falls with a rival\'s', () => {
    const r = rig({ preset: 'small', seed: 'might-growth' });
    const { a, b } = pair(r);
    setTraits(r, a, ['ambitious']);
    setTraits(r, b, ['content']);
    expect(r.x.ai.outbuilt(a, b)).toBe(0);
    const none = r.x.ai.desire(a, b, 'conquest');
    r.pol.setGrowthSource?.((h) => (h === a ? 20 : h === b ? 2 : 0));
    r.x.core.invalidate();
    expect(r.x.ai.outbuilt(a, b)).toBe(1);
    expect(r.x.ai.outbuilt(b, a)).toBe(-1);
    const bold = r.x.ai.desire(a, b, 'conquest');
    expect(bold).toBeGreaterThan(none + 0.05);
    r.pol.setGrowthSource?.((h) => (h === a ? 2 : h === b ? 20 : 0));
    r.x.core.invalidate();
    expect(r.x.ai.desire(a, b, 'conquest')).toBeLessThan(none - 0.05);
    // the source can be taken away again
    r.pol.setGrowthSource?.(null);
    r.x.core.invalidate();
    expect(r.x.ai.desire(a, b, 'conquest')).toBeCloseTo(none, 6);
  });
});

describe('rival AI: the wars follow the strength', () => {
  /** Wars House `a` starts against `b` in `trials` thinking rounds (the other House is the weak one of the pair). */
  function warsAgainst(seed: string, prepare: (r: Rig, a: HouseId, b: HouseId) => void, trials = 80): number {
    const r = rig({ preset: 'small', seed });
    const { a, b } = pair(r);
    setTraits(r, a, ['ambitious', 'hot_tempered']);
    setTraits(r, b, ['content']);
    for (let i = 0; i < 8; i++) noble(r, a, 'm', 24 + (i % 10), { tier: 5 });
    ageHead(r, b, 9); // a boy on the throne
    for (const sid of r.x.core.demesnes(b)) r.sim.state.settlements.get(sid)!.prosperity = 0.55; // and a famine
    prepare(r, a, b);
    let n = 0;
    for (let i = 0; i < trials; i++) {
      r.x.core.mindOf(a).lastWar = -999;
      r.x.core.mindOf(a).lastProposal = -999;
      r.x.core.invalidate();
      r.x.ai.think(a);
      const w = r.x.wars.offensiveWar(a);
      if (w && w.defenders[0] === b) n++;
      if (w) r.x.wars.end(w, 'white_peace', 'white');
      const t = r.x.core.tieRef(a, b);
      t.truce = 0; t.grievance = 0;
    }
    return n;
  }

  it('strikes a bare neighbour more often than the same neighbour behind walls', () => {
    const bare = warsAgainst('might-war', () => undefined);
    const walled = warsAgainst('might-war', (r, _a, b) => fortify(r, b, ['wall', 'wall', 'wall', 'tower', 'tower', 'gatehouse', 'keep_stone']));
    expect(bare).toBeGreaterThan(0);
    expect(walled).toBeLessThan(bare);
  });

  it('strikes the neighbour that does not keep up more often than one that does', () => {
    const level = warsAgainst('might-race', (r, a, b) => { r.pol.setGrowthSource?.((h) => (h === a || h === b ? 6 : 0)); });
    const behind = warsAgainst('might-race', (r, a, b) => { r.pol.setGrowthSource?.((h) => (h === a ? 30 : h === b ? 0 : 0)); });
    expect(behind).toBeGreaterThan(level);
  });
});

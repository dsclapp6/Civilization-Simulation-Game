// Civilization pass, wave B art (docs/CIV.md; docs/ART.md "Civilization pass"): the five new models, construction stages
// aligned with the sim's stages, gates and breaches, siege works, deposits' pieces, the new props and clips.
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BUILDINGS, BUILDING_KINDS, type BuildingKind } from '../../src/content/types';
import { CULTURES } from '../../src/core/domain';
import { generateBuilding, normalizeRequest, requestKey, runRecipe } from '../../src/assets/buildings/index';
import { CONSTRUCTION_BREAKS, constructionOfStep, constructionStep } from '../../src/assets/buildings/states';
import { Layer, Mat, MeshBuilder } from '../../src/assets/core/builder';
import { buildProp } from '../../src/assets/props/props';
import { buildSiegeWork, engineArmAngle } from '../../src/assets/siege';
import { depositPieceInto, type DepositKindId } from '../../src/assets/deposits';
import { CLIPS } from '../../src/assets/characters/human/clips';
import { stageOf } from '../../src/sim/construction/sites';

const NEW_KINDS: BuildingKind[] = ['slaughterhouse', 'clay_pit', 'salt_pan', 'lumber_camp', 'gaol'];

function bounds(g: ReturnType<typeof generateBuilding>): THREE.Box3 {
  const bb = new THREE.Box3();
  for (const geo of g.geos) if (geo?.boundingBox) bb.union(geo.boundingBox);
  return bb;
}

describe('the new models', () => {
  it('are their own (not the stand-ins), in every culture, within budget and footprint, with a front door', () => {
    const standIn: Record<string, BuildingKind> = { slaughterhouse: 'tannery', clay_pit: 'quarry', salt_pan: 'quarry', lumber_camp: 'sawpit', gaol: 'granary' };
    for (const kind of NEW_KINDS) {
      const def = BUILDINGS[kind];
      for (const culture of CULTURES) {
        for (let level = 1; level <= def.maxLevel; level++) {
          const g = generateBuilding(normalizeRequest({ kind, level, culture, seed: 1 }));
          expect(g.triangles, `${kind} ${culture}`).toBeLessThanOrEqual(2600);
          expect(g.triangles, `${kind} ${culture}`).toBeGreaterThan(300);
          const bb = bounds(g);
          expect(bb.min.x, kind).toBeGreaterThanOrEqual(-def.w / 2 - 0.15);
          expect(bb.max.x, kind).toBeLessThanOrEqual(def.w / 2 + 0.15);
          expect(bb.min.z, kind).toBeGreaterThanOrEqual(-def.d / 2 - 0.15);
          expect(bb.max.z, kind).toBeLessThanOrEqual(def.d / 2 + 0.15);
          expect(g.doors[0].z, `${kind} main door on the front`).toBeGreaterThan(0);
        }
      }
      const own = generateBuilding(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 1 }));
      const old = generateBuilding(normalizeRequest({ kind: standIn[kind], level: 1, culture: 'anglo', seed: 1 }));
      expect(own.triangles, kind).not.toBe(old.triangles);
    }
  });

  it('report their door offsets (the agents put their DOOR_X here)', () => {
    // the main door's local x, the same for every culture and level
    const want: Record<string, number> = { slaughterhouse: -0.2, clay_pit: 0, salt_pan: 4.78, lumber_camp: 0, gaol: 0 };
    for (const kind of NEW_KINDS) {
      for (const culture of CULTURES) {
        for (let level = 1; level <= BUILDINGS[kind].maxLevel; level++) {
          const g = generateBuilding(normalizeRequest({ kind, level, culture, seed: 1 }));
          expect(g.doors[0].x, `${kind} ${culture} L${level}`).toBeCloseTo(want[kind], 1);
        }
      }
    }
  });

  it('the salt pans steam; the slaughterhouse, lumber camp and salt cote smoke', () => {
    const salt = generateBuilding(normalizeRequest({ kind: 'salt_pan', level: 1, culture: 'anglo', seed: 1 }));
    expect(salt.emitters.some((e) => e.kind === 'steam')).toBe(true);
    for (const kind of ['slaughterhouse', 'lumber_camp', 'salt_pan'] as BuildingKind[]) {
      expect(generateBuilding(normalizeRequest({ kind, level: 1, culture: 'franc', seed: 2 })).smoke.length, kind).toBeGreaterThan(0);
    }
  });
});

describe('construction stages', () => {
  it('bins break where the sim\'s stages do', () => {
    for (const edge of [0.08, 0.3, 0.75]) {
      expect(constructionStep(edge - 0.001)).not.toBe(constructionStep(edge));
      expect(CONSTRUCTION_BREAKS).toContain(edge);
    }
    // every bin is drawn at a progress of the same stage as the whole bin
    for (let i = 0; i < CONSTRUCTION_BREAKS.length; i++) {
      const a = CONSTRUCTION_BREAKS[i], b = i + 1 < CONSTRUCTION_BREAKS.length ? CONSTRUCTION_BREAKS[i + 1] - 1e-6 : 0.999;
      expect(stageOf(constructionOfStep(i))).toBe(stageOf(a));
      expect(stageOf(b)).toBe(stageOf(a));
    }
    expect(constructionStep(1)).toBe(CONSTRUCTION_BREAKS.length);
    expect(constructionOfStep(CONSTRUCTION_BREAKS.length)).toBe(1);
  });

  it('every kind reads its stages: pegs (no walls), footings, walls, roof, done — growing as it goes', () => {
    const problems: string[] = [];
    for (const kind of BUILDING_KINDS) {
      const tri = (c: number) => generateBuilding(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 3, construction: c }));
      const pegs = tri(0.02), walls = tri(0.56), roof = tri(0.8), done = tri(1);
      // pegs: the site staked out — nothing of the building's walls yet, and far less than the finished model
      const { b } = runRecipe(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 3 }));
      const hasWalls = b.tLayer.some((l) => l === Layer.Wall);
      if (hasWalls && pegs.triangles >= walls.triangles) problems.push(`${kind}: pegs ${pegs.triangles} ≥ walls ${walls.triangles}`);
      if (pegs.triangles >= done.triangles && done.triangles > 200) problems.push(`${kind}: pegs ${pegs.triangles} ≥ done ${done.triangles}`);
      if (roof.triangles <= 0 || walls.triangles <= 0) problems.push(`${kind}: empty stage`);
      for (const g of [pegs, walls, roof, done]) for (const geo of g.geos) geo?.dispose();
    }
    expect(problems).toEqual([]);
  }, 120000);

  it('the cache key follows the stage bins (one model per bin)', () => {
    const k = (c: number) => requestKey(normalizeRequest({ kind: 'cottage', level: 1, culture: 'anglo', seed: 1, construction: c }));
    expect(k(0.31)).toBe(k(0.39));
    expect(k(0.29)).not.toBe(k(0.31));
    expect(k(0.999)).not.toBe(k(1));
  });
});

describe('gates and breaches', () => {
  it('a gatehouse draws its gate open, shut or broken (both levels); other kinds ignore it', () => {
    for (const level of [1, 2]) {
      const t = (gate: 'open' | 'shut' | 'broken') => generateBuilding(normalizeRequest({ kind: 'gatehouse', level, culture: 'anglo', seed: 1, gate })).triangles;
      const open = t('open'), shut = t('shut'), broken = t('broken');
      expect(new Set([open, shut, broken]).size, `L${level}`).toBe(3);
    }
    const a = normalizeRequest({ kind: 'cottage', level: 1, culture: 'anglo', seed: 1, gate: 'shut', breach: 1 });
    expect(a.gate).toBe('open');
    expect(a.breach).toBe(0);
  });

  it('a breach takes the wall down: a battered crest below one half, a gap of rubble from one half', () => {
    for (const kind of ['wall', 'palisade'] as BuildingKind[]) {
      const top = (breach: number) => {
        const g = generateBuilding(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 1, breach }));
        return { tris: g.triangles, h: bounds(g).max.y };
      };
      const whole = top(0), battered = top(0.25), half = top(0.5), full = top(1);
      expect(battered.h, kind).toBeLessThan(whole.h);
      expect(half.tris, kind).not.toBe(whole.tris);
      // at 1 the whole segment is down to a heap
      expect(full.h, kind).toBeLessThan(whole.h * 0.75);
    }
  });
});

describe('siege works, deposits, props, clips', () => {
  it('siege works build (ladders by length), with a moving part where they have one', () => {
    for (const kind of ['ladder', 'ram', 'mantlet', 'trebuchet', 'mangonel'] as const) {
      const m = buildSiegeWork(kind, 0, 8);
      expect(m.body.triCount, kind).toBeGreaterThan(20);
      expect(m.body.triCount + (m.part?.triCount ?? 0), kind).toBeLessThan(3000);
      if (kind === 'ram' || kind === 'trebuchet' || kind === 'mangonel') expect(m.part, kind).not.toBeNull();
    }
    const short = buildSiegeWork('ladder', 0, 5).body.bounds(), long = buildSiegeWork('ladder', 0, 9).body.bounds();
    expect(long.max.y).toBeGreaterThan(short.max.y + 3);
    // an engine's arm turns one way as it throws
    expect(engineArmAngle('trebuchet', 1)).toBeGreaterThan(engineArmAngle('trebuchet', 0));
    expect(engineArmAngle('mangonel', 1)).toBeGreaterThan(engineArmAngle('mangonel', 0));
  });

  it('every deposit kind has its pieces', () => {
    for (const kind of ['iron', 'stone', 'clay', 'salt', 'silver', 'gold'] as DepositKindId[]) {
      const b = new MeshBuilder(1);
      depositPieceInto(b, kind, 3, 7, 0);
      expect(b.triCount, kind).toBeGreaterThan(5);
      expect(b.countMat(Mat.Opaque), kind).toBe(b.triCount);
    }
  });

  it('the new props build, and piles grow with their size', () => {
    for (const kind of ['carcass_hook', 'carcass_hanging', 'carcass_block', 'hide_frame', 'meat_joints', 'tallow_pot'] as const) {
      expect(buildProp(kind, 1).b.triCount, kind).toBeGreaterThan(20);
    }
    for (const kind of ['brick_stack', 'clay_heap', 'salt_heap', 'log_pile', 'timber_stack', 'straw_bundles'] as const) {
      const small = buildProp(kind, 1, 0, 1).b, big = buildProp(kind, 1, 0, 8).b;
      expect(big.bounds().getSize(new THREE.Vector3()).length(), kind).toBeGreaterThan(small.bounds().getSize(new THREE.Vector3()).length());
    }
  });

  it('the clips for captives, ladders and rams exist and loop', () => {
    for (const name of ['bound', 'bound_walk', 'climb', 'push']) {
      expect(CLIPS[name], name).toBeTruthy();
      expect(CLIPS[name].clip.loop, name).toBe(true);
    }
    expect(CLIPS.bound_walk.def.walkable).toBe(true);
    expect(CLIPS.push.def.walkable).toBe(true);
  });
});

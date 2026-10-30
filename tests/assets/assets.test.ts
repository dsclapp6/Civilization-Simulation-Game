import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BUILDINGS, BUILDING_KINDS, type BuildingKind } from '../../src/content/types';
import { CULTURES } from '../../src/core/domain';
import { generateBuilding, normalizeRequest } from '../../src/assets/buildings/index';
import { createAssetLibrary } from '../../src/assets/library';
import { PROP_KINDS, buildProp } from '../../src/assets/props/props';
import { CROP_KINDS, buildCropGeometry } from '../../src/assets/crops';
import { buildPlantGeometry } from '../../src/assets/vegetation/index';
import { PLANTS } from '../../src/assets/vegetation/plants';
import type { ScatterKind } from '../../src/world/types';

/** LOD0 triangle budgets (docs/ART.md §Budgets). */
function budget(kind: BuildingKind): number {
  if (kind === 'cathedral') return 12000;
  if (kind === 'abbey_church' || kind === 'cloister') return 6500;
  return 3000;
}

const TREES: ScatterKind[] = ['oak', 'beech', 'birch', 'ash', 'willow', 'pine', 'spruce', 'apple', 'deadtree'];

describe('buildings', () => {
  it('every kind × level × culture builds within budget and footprint', () => {
    const problems: string[] = [];
    for (const kind of BUILDING_KINDS) {
      const def = BUILDINGS[kind];
      for (let level = 1; level <= def.maxLevel; level++) {
        for (const culture of CULTURES) {
          const g = generateBuilding(normalizeRequest({ kind, level, culture, seed: 1 }));
          if (g.triangles > budget(kind)) problems.push(`${kind} L${level} ${culture}: ${g.triangles} tris > ${budget(kind)}`);
          const bb = new THREE.Box3();
          for (const geo of g.geos) if (geo?.boundingBox) bb.union(geo.boundingBox);
          const tol = 0.15;
          if (bb.min.x < -def.w / 2 - tol || bb.max.x > def.w / 2 + tol || bb.min.z < -def.d / 2 - tol || bb.max.z > def.d / 2 + tol) {
            problems.push(`${kind} L${level} ${culture}: outside footprint ${def.w}x${def.d}: x[${bb.min.x.toFixed(2)},${bb.max.x.toFixed(2)}] z[${bb.min.z.toFixed(2)},${bb.max.z.toFixed(2)}]`);
          }
          if (g.height <= 0.5) problems.push(`${kind} L${level} ${culture}: height ${g.height}`);
          for (const geo of g.geos) geo?.dispose();
        }
      }
    }
    expect(problems).toEqual([]);
  }, 120000);

  it('typical cottages stay light', () => {
    for (const culture of CULTURES) {
      for (const level of [1, 2]) {
        const g = generateBuilding(normalizeRequest({ kind: 'cottage', level, culture, seed: 2 }));
        expect(g.triangles, `cottage L${level} ${culture}`).toBeLessThanOrEqual(level === 1 ? 800 : 900);
      }
    }
  });

  it('levels are visibly distinct (more geometry or height)', () => {
    for (const kind of BUILDING_KINDS) {
      const def = BUILDINGS[kind];
      if (def.maxLevel < 2) continue;
      const a = generateBuilding(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 1 }));
      const b = generateBuilding(normalizeRequest({ kind, level: def.maxLevel, culture: 'anglo', seed: 1 }));
      const differs = Math.abs(b.triangles - a.triangles) > 20 || Math.abs(b.height - a.height) > 0.3;
      expect(differs, kind).toBe(true);
    }
  });

  it('homes and workplaces have doors on the +z side', () => {
    const noDoor = new Set<BuildingKind>(['palisade', 'wall', 'stocks']);
    for (const kind of BUILDING_KINDS) {
      if (noDoor.has(kind)) continue;
      const g = generateBuilding(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 1 }));
      expect(g.doors.length, kind).toBeGreaterThan(0);
      const front = g.doors.some((d) => d.z > 0);
      expect(front, `${kind} has a +z door`).toBe(true);
    }
  });

  it('construction and damage states build and differ from the finished model', () => {
    const kinds: BuildingKind[] = ['cottage', 'church', 'keep_stone', 'windmill', 'barn', 'wall'];
    for (const kind of kinds) {
      const done = generateBuilding(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 3 }));
      for (const c of [0.02, 0.3, 0.6, 0.9]) {
        const g = generateBuilding(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 3, construction: c }));
        expect(g.doubleSided).toBe(true);
        expect(g.triangles).not.toBe(done.triangles);
      }
      for (const d of [0.25, 0.5, 0.75, 1]) {
        const g = generateBuilding(normalizeRequest({ kind, level: 1, culture: 'anglo', seed: 3, damage: d }));
        expect(g.triangles).toBeGreaterThan(0);
        expect(g.doubleSided).toBe(true);
        // Light damage may only soot/char the model; heavy damage always changes the geometry.
        if (d >= 0.5) expect(g.triangles, `${kind} damage ${d}`).not.toBe(done.triangles);
      }
    }
  });

  it('lower LODs are cheaper', () => {
    for (const kind of ['cottage', 'manor_house', 'church', 'tavern'] as BuildingKind[]) {
      const l0 = generateBuilding(normalizeRequest({ kind, level: 2, culture: 'anglo', seed: 1, lod: 0 }));
      const l1 = generateBuilding(normalizeRequest({ kind, level: 2, culture: 'anglo', seed: 1, lod: 1 }));
      const l2 = generateBuilding(normalizeRequest({ kind, level: 2, culture: 'anglo', seed: 1, lod: 2 }));
      expect(l1.triangles, kind).toBeLessThan(l0.triangles);
      expect(l2.triangles, kind).toBeLessThanOrEqual(l1.triangles);
    }
  });

  it('animated parts exist where expected', () => {
    expect(generateBuilding(normalizeRequest({ kind: 'windmill', level: 1, culture: 'anglo', seed: 1 })).anims.length).toBeGreaterThan(0);
    expect(generateBuilding(normalizeRequest({ kind: 'watermill', level: 2, culture: 'anglo', seed: 1 })).anims.length).toBeGreaterThan(0);
    expect(generateBuilding(normalizeRequest({ kind: 'keep_stone', level: 2, culture: 'anglo', seed: 1 })).flags.length).toBeGreaterThan(0);
    expect(generateBuilding(normalizeRequest({ kind: 'cottage', level: 2, culture: 'anglo', seed: 1 })).smoke.length).toBeGreaterThan(0);
  });
});

describe('vegetation, crops, props', () => {
  it('every scatter kind has three LODs within budget', () => {
    for (const kind of Object.keys(PLANTS) as ScatterKind[]) {
      const tri = [0, 1, 2].map((lod) => {
        const g = buildPlantGeometry(kind, lod as 0 | 1 | 2);
        const n = g.getAttribute('position').count / 3;
        expect(g.getAttribute('aSway')).toBeTruthy();
        expect(g.getAttribute('aLeaf')).toBeTruthy();
        g.dispose();
        return n;
      });
      const caps = TREES.includes(kind) ? [300, 60, 12] : [160, 60, 16];
      expect(tri[0], `${kind} LOD0`).toBeLessThanOrEqual(caps[0]);
      expect(tri[1], `${kind} LOD1`).toBeLessThanOrEqual(caps[1]);
      expect(tri[2], `${kind} LOD2`).toBeLessThanOrEqual(caps[2]);
      expect(tri[2]).toBeLessThanOrEqual(tri[1]);
      expect(tri[1]).toBeLessThanOrEqual(tri[0]);
    }
  });

  it('every crop has four stages of small clumps', () => {
    for (const kind of CROP_KINDS) {
      for (let s = 0; s < 4; s++) {
        const g = buildCropGeometry(kind, s as 0 | 1 | 2 | 3);
        const n = g.getAttribute('position').count / 3;
        expect(n, `${kind} ${s}`).toBeGreaterThan(0);
        expect(n, `${kind} ${s}`).toBeLessThanOrEqual(120);
        g.computeBoundingBox();
        expect(g.boundingBox!.max.y, `${kind} ${s} height`).toBeLessThan(1.8);
        g.dispose();
      }
    }
  });

  it('every prop kind builds', () => {
    for (const kind of PROP_KINDS) {
      const { b } = buildProp(kind, 1);
      expect(b.triCount, kind).toBeGreaterThan(0);
      expect(b.triCount, kind).toBeLessThan(1500);
    }
  });
});

describe('asset library', () => {
  it('implements the contract, caches and shares geometry', () => {
    const lib = createAssetLibrary();
    lib.setEnvironment({ time: 1, season: 2, seasonProgress: 0.5, snowCover: 0.3, windX: 3, windZ: 1, nightLight: 0.5 });
    const a = lib.building({ kind: 'cottage', level: 2, culture: 'anglo', seed: 5 });
    const b = lib.building({ kind: 'cottage', level: 2, culture: 'anglo', seed: 9 });
    const meshA = a.object.children.find((o) => o.name === 'body') as THREE.Mesh;
    const meshB = b.object.children.find((o) => o.name === 'body') as THREE.Mesh;
    expect(meshA.geometry).toBe(meshB.geometry);
    expect(meshA.material).toBe(meshB.material);
    expect(a.doors.length).toBeGreaterThan(0);
    expect(a.smokePoints.length).toBeGreaterThan(0);
    a.update?.(1, 0.016);
    a.setLit?.(1);
    a.setLit?.(0);
    a.dispose();
    b.dispose();
    const mill = lib.building({ kind: 'windmill', level: 2, culture: 'franc', seed: 1, ownerColor: 0x224488 });
    mill.update?.(2, 0.1);
    mill.dispose();
    for (const kind of Object.keys(PLANTS) as ScatterKind[]) {
      const kit = lib.vegetation(kind, 0);
      expect(kit.radius).toBeGreaterThan(0);
      expect(kit.material).toBeTruthy();
    }
    expect(lib.crop('wheat', 3).geometry).toBe(lib.crop('wheat', 3).geometry);
    for (const kind of PROP_KINDS) expect(lib.prop(kind, 1).children.length).toBeGreaterThan(0);
    const proj = lib.createProjectileLayer();
    proj.update([{ id: 1, kind: 'arrow', x: 0, y: 2, z: 0, vx: 10, vy: 2, vz: 0, stuck: false }, { id: 2, kind: 'bolt', x: 1, y: 0, z: 0, vx: 0, vy: 0, vz: 0, stuck: true }], 0.016);
    proj.dispose();
    const fx = lib.createFxLayer();
    fx.emit([{ kind: 'fire', x: 0, y: 0, z: 0, intensity: 1 }, { kind: 'hearth_smoke', x: 0, y: 3, z: 0, intensity: 1 }]);
    fx.update(0.016, new THREE.PerspectiveCamera());
    fx.dispose();
    const chars = lib.createCharacterLayer();
    chars.dispose();
    const animals = lib.createAnimalLayer();
    animals.dispose();
    lib.dispose();
  });
});

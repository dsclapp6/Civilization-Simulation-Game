import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { BuildingSystem } from '../../src/render/buildings';
import { RoadSystem } from '../../src/render/roads';
import { PALETTE } from '../../src/assets/palette';
import type { AssetLibrary, BuildingAsset, BuildingRequest } from '../../src/assets/types';
import type { BuildingView } from '../../src/core/view';
import type { WorldModel } from '../../src/world/types';
import { makeFakeWorld } from './fakeWorld';

/** Asset library double that records requests and simulates the library's model cache. */
function recordingLibrary(): { lib: AssetLibrary; requests: BuildingRequest[]; generated: string[] } {
  const requests: BuildingRequest[] = [];
  const generated: string[] = [];
  const cache = new Set<string>();
  const geo = new THREE.BoxGeometry(4, 3, 4);
  const mat = new THREE.MeshLambertMaterial();
  const lib = {
    palette: PALETTE,
    setEnvironment() {},
    building(req: BuildingRequest): BuildingAsset {
      requests.push(req);
      const key = `${req.kind}|${req.level}|${req.culture}|${((req.seed % 4) + 4) % 4}|10|0|${req.ownerColor ?? -1}|${req.lod ?? 0}`;
      if (!cache.has(key)) { cache.add(key); generated.push(key); }
      const group = new THREE.Group();
      group.add(new THREE.Mesh(geo, mat));
      return {
        object: group, w: 4, d: 4, height: 6, doors: [],
        smokePoints: [new THREE.Vector3(1, 6, 0)],
        emitters: [{ kind: 'sparks', position: new THREE.Vector3(0, 1, 2), rate: 10 }],
        firePoints: [new THREE.Vector3(0, 2, 0)],
        setLit() {},
        dispose() { group.removeFromParent(); },
      };
    },
  } as unknown as AssetLibrary;
  return { lib, requests, generated };
}

function views(n: number, x0: number, z0: number, spacing: number, kind: BuildingView['kind'] = 'cottage', seedBase = 0): BuildingView[] {
  return Array.from({ length: n }, (_, i) => ({
    id: i, kind, level: 1, x: x0 + (i % 10) * spacing, z: z0 + Math.floor(i / 10) * spacing, rot: 0, culture: 'anglo' as const,
    seed: seedBase + i, settlement: 0, construction: 1, damage: 0, onFire: false, occupied: true,
  }));
}

const cam = (x: number, y: number, z: number) => {
  const c = new THREE.PerspectiveCamera(55, 1.6, 0.3, 30000);
  c.position.set(x, y, z);
  c.lookAt(x + 50, y - 5, z + 50);
  c.updateMatrixWorld();
  return c;
};

describe('building integration with the asset library contract', () => {
  const world = makeFakeWorld();

  it('requests detail levels by distance and generates at most one new model per frame', () => {
    const { lib, requests, generated } = recordingLibrary();
    const bs = new BuildingSystem(world, lib, { detailDistance: 2000, drawBudget: 1000 });
    // 40 buildings with 40 different seeds → 4 seed buckets; spread from 20 m to 900 m away
    const list = views(40, 6000, 6000, 90);
    const c = cam(5980, 30, 5980);
    bs.update(list, 1, c, 0, 1 / 60, 50);
    expect(generated.length).toBe(1);
    for (let f = 0; f < 60; f++) bs.update(list, 1, c, f / 60, 1 / 60, 50);
    expect(bs.detailedCount).toBe(40);
    const lods = new Set(requests.map((r) => r.lod));
    expect(lods.has(0) && lods.has(1) && lods.has(2)).toBe(true);
    bs.dispose();
  });

  it('emits hearth smoke at smokePoints and emitter FX in world space', () => {
    const { lib } = recordingLibrary();
    const bs = new BuildingSystem(world, lib, { detailDistance: 2000, drawBudget: 1000 });
    const list = views(1, 6000, 6000, 10);
    const c = cam(5990, 10, 5990);
    let smoke = 0, sparks = 0, sx = 0;
    for (let f = 0; f < 120; f++) {
      const fx = bs.update(list, 1, c, f / 60, 1 / 60, 50, true);
      for (const e of fx) {
        if (e.kind === 'hearth_smoke') { smoke++; sx = e.x; }
        if (e.kind === 'sparks') sparks++;
      }
    }
    expect(smoke).toBeGreaterThan(3);
    expect(sparks).toBeGreaterThan(10);
    // local (1, 6, 0) rotated by yaw 0 and placed at x = 6000
    expect(sx).toBeCloseTo(6001, 3);
    bs.dispose();
  });

  it('turns water buildings so their mill race (local -z) faces the water', () => {
    const { lib } = recordingLibrary();
    const bs = new BuildingSystem(world, lib, { detailDistance: 2000, drawBudget: 1000 });
    // fake world: at z = 300π the shore is exactly x = 2000 (sea to the west); a mill on the
    // bank whose plot yaw puts its door (+z) towards the water
    const z = 300 * Math.PI;
    const mill: BuildingView = { ...views(1, 2004, z, 1)[0], kind: 'watermill', rot: -Math.PI / 2 };
    bs.update([mill], 1, cam(2030, 10, z), 0, 1 / 60, 50, true);
    const placed = (bs as unknown as { entries: Map<number, { rot: number }> }).entries.get(mill.id)!;
    // door must point away from the sea (+x): yaw +PI/2
    expect(Math.sin(placed.rot)).toBeGreaterThan(0.9);
    bs.dispose();
  });

  it('batches identical static buildings into instanced meshes', () => {
    const { lib } = recordingLibrary();
    const bs = new BuildingSystem(world, lib, { detailDistance: 2000, drawBudget: 1000 });
    // same seed bucket for all: one model, many copies
    // all within 120 m of the camera → one detail level, one model
    const list = views(12, 6000, 6000, 8, 'wall', 0).map((v) => ({ ...v, seed: 4 }));
    const c = cam(5990, 20, 5990);
    for (let f = 0; f < 20; f++) bs.update(list, 1, c, f / 60, 1 / 60, 50, true);
    expect(bs.batchedCount).toBe(12);
    let instanced = 0;
    bs.root.traverse((o) => { if ((o as THREE.InstancedMesh).isInstancedMesh && o.name.startsWith('building-batch')) instanced += (o as THREE.InstancedMesh).count; });
    expect(instanced).toBe(12);
    bs.dispose();
  });
});

describe('road ribbons', () => {
  it('drapes smooth ribbons along roads near the camera and leaves bridges to the bridge deck', () => {
    const base = makeFakeWorld();
    const world = {
      ...base,
      roads: [{ id: 0, kind: 'road', points: [{ x: 5000, z: 5000 }, { x: 5100, z: 5000 }, { x: 5200, z: 5050 }], width: 5, from: -1, to: -1 }],
      bridges: [{ id: 0, roadId: 0, riverId: 0, x: 5100, z: 5000, rot: Math.PI / 2, length: 12, width: 6, stone: true }],
    } as unknown as WorldModel;
    const rs = new RoadSystem(world, PALETTE, 600);
    rs.update(cam(5050, 8, 4990), 1000);
    let verts = 0, onBridge = 0;
    rs.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      const p = m.geometry.getAttribute('position');
      verts += p.count;
      for (let i = 0; i < p.count; i++) {
        if (Math.hypot(p.getX(i) - 5100, p.getZ(i) - 5000) < 4) onBridge++;
        // draped on the terrain
        expect(Math.abs(p.getY(i) - world.heightAt(p.getX(i), p.getZ(i)))).toBeLessThan(0.2);
      }
    });
    expect(verts).toBeGreaterThan(100);
    expect(onBridge).toBe(0);
    rs.dispose();
  });
});

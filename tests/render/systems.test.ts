import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createStubWorld } from '../../src/render/dev/stubWorld';
import { createPlaceholderAssets } from '../../src/render/dev/placeholderAssets';
import { MockView } from '../../src/render/dev/mockView';
import { VegetationSystem } from '../../src/render/vegetation/vegetationSystem';
import { BuildingSystem } from '../../src/render/buildings';
import { FieldSystem } from '../../src/render/fields';
import { createTerrainUniforms } from '../../src/render/terrain/terrainMaterial';
import type { BuildingView } from '../../src/core/view';
import { CHUNK_SIZE } from '../../src/world/types';

const world = createStubWorld('systems-test');
const assets = createPlaceholderAssets();

function cameraAt(x: number, z: number, height: number, lookX = x + 10, lookZ = z): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 30000);
  cam.position.set(x, world.heightAt(x, z) + height, z);
  cam.lookAt(lookX, world.heightAt(lookX, lookZ) + height * 0.5, lookZ);
  cam.updateMatrixWorld();
  return cam;
}

describe('vegetation system', () => {
  it('instances scatter around the camera and drops felled trees', () => {
    // find a wooded chunk near the main village
    const v = world.settlements[0];
    let best = { x: v.x, z: v.z, n: 0 };
    for (let i = 0; i < 300; i++) {
      const x = v.x + Math.cos(i) * (300 + i * 4), z = v.z + Math.sin(i * 1.3) * (300 + i * 4);
      const n = world.scatterInChunk(Math.floor(x / CHUNK_SIZE), Math.floor(z / CHUNK_SIZE)).filter((it) => it.kind === 'oak' || it.kind === 'beech' || it.kind === 'pine' || it.kind === 'spruce').length;
      if (n > best.n) best = { x, z, n };
    }
    expect(best.n).toBeGreaterThan(3);
    const veg = new VegetationSystem(world, assets, { near: 110, mid: 300, far: 500, grass: 30, maxPerKind: 60000, kindTris: 1e9 });
    const cam = cameraAt(best.x, best.z, 2);
    veg.settle(cam, 20000);
    const before = veg.instances;
    expect(before).toBeGreaterThan(50);
    const items = world.scatterInChunk(Math.floor(best.x / CHUNK_SIZE), Math.floor(best.z / CHUNK_SIZE));
    const felled = new Set(items.filter((it) => it.kind !== 'grass_tuft' && it.kind !== 'flowers').map((it) => it.id));
    veg.setFelled(1, felled);
    veg.settle(cam, 20000);
    expect(veg.instances).toBeLessThan(before);
    expect(before - veg.instances).toBeGreaterThanOrEqual(felled.size - 2);
    veg.dispose();
  });
});

describe('building system', () => {
  it('creates detailed assets near the camera, proxies elsewhere, and follows version changes', () => {
    const s = world.settlements[0];
    const views: BuildingView[] = world.plots.filter((p) => p.settlement === s.id).map((p) => ({
      id: p.id, kind: p.kind, level: p.level, x: p.x, z: p.z, rot: p.rot, culture: p.culture, seed: p.seed,
      settlement: p.settlement, construction: 1, damage: 0, onFire: false, occupied: p.kind === 'cottage' || p.kind === 'longhouse',
    }));
    expect(views.length).toBeGreaterThan(10);
    const bs = new BuildingSystem(world, assets, { detailDistance: 800, drawBudget: 400 });
    const cam = cameraAt(s.x, s.z, 30, s.x + 50, s.z + 50);
    let fx: readonly { kind: string }[] = [];
    let smoke = 0;
    for (let i = 0; i < 30; i++) {
      fx = bs.update(views, 1, cam, i * 0.1, 0.1, 1000, true);
      smoke += fx.filter((e) => e.kind === 'hearth_smoke').length;
    }
    expect(bs.count).toBe(views.length);
    expect(bs.detailedCount).toBe(views.length);
    expect(smoke).toBeGreaterThan(0);
    // a changed request rebuilds that building; removing one drops it
    const changed = views.slice(1).map((b, i) => (i === 0 ? { ...b, damage: 1 } : b));
    bs.update(changed, 2, cam, 3, 0.1, 1000, true);
    expect(bs.count).toBe(views.length - 1);
    // a tight draw budget falls back to proxies for distant buildings
    bs.configure({ detailDistance: 800, drawBudget: 6 });
    bs.update(changed, 2, cam, 3.1, 0.1, 1000, true);
    expect(bs.detailedCount).toBeLessThan(changed.length);
    const ray = new THREE.Ray(new THREE.Vector3(views[3].x, 200, views[3].z), new THREE.Vector3(0, -1, 0));
    expect(bs.raycast(ray, 1000)?.id).toBe(views[3].id);
    bs.dispose();
  });
});

describe('field system', () => {
  it('draws strips and instances crops in ripe strips near the camera', () => {
    const view = new MockView(world, { time: 0.6, season: 1 });
    view.setDayOfSeason(2);
    const ripe = view.strips().find((st) => st.state === 'ripe');
    expect(ripe).toBeDefined();
    const c = ripe!.poly[0];
    const fs = new FieldSystem(world, assets, createTerrainUniforms(world.size), { stripDistance: 3000, cropRadius: 70, cropMax: 20000, cropTris: 1e9 });
    const cam = cameraAt(c.x, c.z, 4);
    fs.update(view.strips(), view.stripsVersion(), cam, 100);
    fs.settle(cam);
    expect(fs.cropInstances).toBeGreaterThan(100);
    expect(fs.root.children.length).toBeGreaterThan(1);
    // a tight triangle budget trims instances
    const small = new FieldSystem(world, assets, createTerrainUniforms(world.size), { stripDistance: 3000, cropRadius: 70, cropMax: 20000, cropTris: 2000 });
    small.update(view.strips(), view.stripsVersion(), cam, 100);
    small.settle(cam);
    expect(small.cropInstances).toBeLessThan(fs.cropInstances);
    fs.dispose();
    small.dispose();
  });
});

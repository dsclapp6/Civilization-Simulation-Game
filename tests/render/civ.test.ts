// Civilization pass, wave B render (docs/ART.md §14): quest marks, the builder's land tint and ghost, the overview
// camera, orders on the ground, deposits in the world, siege works — their logic (what is drawn, when it is rebuilt).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import type { CharacterDrawItem, BuildingView } from '../../src/core/view';
import { FADE_R, FULL_R, QuestMarks } from '../../src/render/feedback/marks';
import { BuildAreaOverlay, rasterizeArea } from '../../src/render/feedback/buildArea';
import { GhostLayer } from '../../src/render/feedback/ghost';
import { OrderMarkLayer } from '../../src/render/feedback/orderMarks';
import { CameraRig } from '../../src/render/camera/cameraRig';
import { DepositSystem } from '../../src/render/deposits';
import { SiegeLayer } from '../../src/render/siege';
import { createAssetLibrary } from '../../src/assets/library';
import type { Deposit } from '../../src/world/types';
import { makeFakeWorld } from './fakeWorld';

function person(id: number, x: number, z: number, o: Partial<CharacterDrawItem> = {}): CharacterDrawItem {
  return {
    id, x, y: 0, z, yaw: 0, lookVersion: 1, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0,
    moveSpeed: 0, highlight: 0,
    look: {
      sex: 'm', age: 30, height: 1.75, build: 0.5, skin: 0, hair: 0, hairStyle: 0, beard: 0, culture: 'anglo', armour: 'none', helmet: 'none',
      clothing: { tunic: 0, tunicStyle: 'short', legs: 0, headwear: 'none', shoes: 'shoes' },
    },
    ...o,
  };
}

function camAt(x: number, y: number, z: number, lookX = 0, lookZ = 0): THREE.PerspectiveCamera {
  const c = new THREE.PerspectiveCamera(55, 16 / 9, 0.2, 5000);
  c.position.set(x, y, z);
  c.lookAt(lookX, 1.5, lookZ);
  c.updateMatrixWorld();
  return c;
}

describe('quest marks', () => {
  it('draw "!" and "?" over the marked people within ~90 m, never the player, fading out by 100 m', () => {
    const m = new QuestMarks();
    const chars = [
      person(1, 0, 10, { mark: 'quest' }), person(2, 5, 40, { mark: 'turnin' }), person(3, 0, 70, { mark: 'quest' }),
      person(4, 0, 120, { mark: 'quest' }), person(5, 2, 8, { mark: 'track' }), person(6, 0, 4, { mark: 'quest', highlight: 3 }),
      person(7, -3, 12),
    ];
    m.update(chars, camAt(0, 3, 0, 0, 50), 720, 0.016, true);
    expect(m.drawn).toBe(3);
    m.update(chars, camAt(0, 3, 0, 0, 50), 720, 0.016, false);
    expect(m.drawn).toBe(0);
    expect(QuestMarks.strength(FULL_R - 1)).toBe(1);
    expect(QuestMarks.strength(FADE_R + 1)).toBe(0);
    expect(QuestMarks.strength((FULL_R + FADE_R) / 2)).toBeGreaterThan(0);
    expect(QuestMarks.strength((FULL_R + FADE_R) / 2)).toBeLessThan(1);
    m.dispose();
  });

  it('ask about cover only every few frames per person', () => {
    const m = new QuestMarks();
    let rays = 0;
    m.occluded = () => { rays++; return true; };
    const chars = [person(1, 0, 10, { mark: 'quest' }), person(2, 5, 30, { mark: 'turnin' })];
    for (let i = 0; i < 30; i++) m.update(chars, camAt(0, 3, 0, 0, 50), 720, 0.016, true);
    expect(m.drawn).toBe(2);
    expect(rays).toBeLessThanOrEqual(12);
    m.dispose();
  });
});

describe("builder's land tint", () => {
  it('rasterises the union of the polygons (inside lit, outside dark, the edge softened)', () => {
    const sq = (x0: number, z0: number, s: number) => [{ x: x0, z: z0 }, { x: x0 + s, z: z0 }, { x: x0 + s, z: z0 + s }, { x: x0, z: z0 + s }];
    const n = 64;
    const rect = { x0: 0, z0: 0, w: 100, d: 100 };
    const m = rasterizeArea([sq(10, 10, 40), sq(40, 40, 40)], rect, n);
    const at = (x: number, z: number) => m[Math.floor((z / 100) * n) * n + Math.floor((x / 100) * n)];
    expect(at(25, 25)).toBe(255);
    expect(at(60, 60)).toBe(255);
    expect(at(45, 45)).toBe(255);
    expect(at(80, 15)).toBe(0);
    expect(at(5, 90)).toBe(0);
    // the soft edge: in between
    let partial = 0;
    for (const v of m) if (v > 10 && v < 245) partial++;
    expect(partial).toBeGreaterThan(20);
  });

  it('is rebuilt only when the area changes, eased in and out', () => {
    const o = new BuildAreaOverlay();
    const area = [[{ x: 0, z: 0 }, { x: 300, z: 0 }, { x: 300, z: 300 }, { x: 0, z: 300 }]];
    o.set(area);
    o.set(area);
    o.set(area.map((p) => p.map((q) => ({ ...q }))));
    expect(o.rebuilds).toBe(1);
    for (let i = 0; i < 60; i++) o.update(1 / 60);
    expect(o.uniforms.uBuildOn.value).toBe(1);
    expect(o.uniforms.uBuildMask.value).not.toBeNull();
    o.set(null);
    for (let i = 0; i < 60; i++) o.update(1 / 60);
    expect(o.uniforms.uBuildOn.value).toBe(0);
    o.set([[{ x: 0, z: 0 }, { x: 500, z: 0 }, { x: 0, z: 500 }]]);
    expect(o.rebuilds).toBe(2);
    o.dispose();
  });
});

describe("builder's ghost", () => {
  it('asks the library for a model only when the kind, level or place changes; recolours and moves cheaply', () => {
    const world = makeFakeWorld();
    const lib = createAssetLibrary();
    const ghost = new GhostLayer(world, lib, world.heightAt);
    const fp = [{ x: 4996, z: 4997 }, { x: 5004, z: 4997 }, { x: 5004, z: 5003 }, { x: 4996, z: 5003 }];
    for (let i = 0; i < 20; i++) ghost.set({ kind: 'cottage', level: 1, x: 5000 + i * 0.3, z: 5000, rot: 0, ok: i % 2 === 0, footprint: fp });
    expect(ghost.builds).toBe(1);
    expect(ghost.root.visible).toBe(true);
    ghost.set({ kind: 'smithy', level: 2, x: 5000, z: 5000, rot: 0.4, ok: true, footprint: fp });
    expect(ghost.builds).toBe(2);
    ghost.set(null);
    expect(ghost.root.visible).toBe(false);
    ghost.dispose();
    lib.dispose();
  });
});

describe('overview camera', () => {
  const env = { heightAt: () => 10, worldSize: 16000 };
  it('looks down at ~55°, keeps its look-at inside the circle, clamps zoom, and returns to the mode before', () => {
    const rig = new CameraRig(16 / 9, env);
    const focus = new THREE.Vector3(3000, 10, 3000);
    for (let i = 0; i < 10; i++) rig.update(1 / 30, focus);
    expect(rig.reportedMode).toBe('follow');
    rig.setOverview({ x: 3100, z: 3100, radius: 200, distance: 150 });
    expect(rig.overviewOn).toBe(true);
    expect(rig.reportedMode).toBe('free');
    for (let i = 0; i < 90; i++) rig.update(1 / 30, focus);
    const cam = rig.camera;
    const dir = cam.getWorldDirection(new THREE.Vector3());
    const pitch = Math.asin(-dir.y) * 180 / Math.PI;
    expect(pitch).toBeGreaterThan(48);
    expect(pitch).toBeLessThan(62);
    // drag far beyond the edge: the look-at stays within the radius
    for (let i = 0; i < 40; i++) rig.pan(-400, 300, 720);
    for (let i = 0; i < 90; i++) rig.update(1 / 30, focus);
    const look = cam.position.clone().addScaledVector(dir, (cam.position.y - 10) / -dir.y);
    expect(Math.hypot(look.x - 3100, look.z - 3100)).toBeLessThan(201);
    // zoom limits [20, 2.2 R]
    for (let i = 0; i < 40; i++) rig.zoom(3);
    for (let i = 0; i < 120; i++) rig.update(1 / 30, focus);
    expect(cam.position.distanceTo(look)).toBeLessThan(2.2 * 200 + 1);
    for (let i = 0; i < 80; i++) rig.zoom(-3);
    for (let i = 0; i < 120; i++) rig.update(1 / 30, focus);
    const look2 = cam.position.clone().addScaledVector(cam.getWorldDirection(new THREE.Vector3()), (cam.position.y - 10) / -cam.getWorldDirection(new THREE.Vector3()).y);
    expect(cam.position.distanceTo(look2)).toBeGreaterThan(19);
    rig.setOverview(null);
    expect(rig.overviewOn).toBe(false);
    expect(rig.reportedMode).toBe('follow');
    for (let i = 0; i < 60; i++) rig.update(1 / 30, focus);
    expect(cam.position.distanceTo(focus)).toBeLessThan(20);
  });

  it('an explicit camera mode or pose ends it', () => {
    const rig = new CameraRig(16 / 9, env);
    rig.setOverview({ x: 100, z: 100, radius: 50 });
    rig.setMode('map');
    expect(rig.overviewOn).toBe(false);
    expect(rig.reportedMode).toBe('map');
    rig.setOverview({ x: 100, z: 100, radius: 50 });
    rig.setPose({ x: 0, y: 50, z: 0 }, { x: 100, y: 0, z: 100 }, 0);
    expect(rig.overviewOn).toBe(false);
  });
});

describe('orders on the ground', () => {
  it('rebuild only when the orders change; hold flags counted', () => {
    const o = new OrderMarkLayer(() => 0);
    const marks = [
      { id: 1, kind: 'move' as const, from: { x: 0, z: 0 }, to: { x: 40, z: 10 }, tone: 'selected' as const },
      { id: 2, kind: 'attack' as const, from: { x: 0, z: 20 }, to: { x: 50, z: 30 }, tone: 'own' as const },
      { id: 3, kind: 'hold' as const, from: { x: 5, z: 5 }, to: { x: 5, z: 5 }, tone: 'own' as const },
      { id: 4, kind: 'retreat' as const, from: { x: 60, z: 0 }, to: { x: 80, z: 0 }, tone: 'enemy' as const },
    ];
    o.set(marks);
    o.set(marks.map((m) => ({ ...m, from: { ...m.from }, to: { ...m.to } })));
    expect(o.rebuilds).toBe(1);
    expect(o.count).toBe(4);
    o.update(0.016, camAt(0, 120, -60, 20, 20), 720);
    o.set(null);
    expect(o.count).toBe(0);
    expect(o.rebuilds).toBe(2);
    o.dispose();
  });
});

describe('deposits in the world', () => {
  it('are built only near the camera, kept while in range, dropped beyond, rebuilt when a building comes by', () => {
    const world = makeFakeWorld();
    const deposits: Deposit[] = [
      { id: 0, kind: 'iron', x: 5000, z: 5000, radius: 50, richness: 0.8, settlement: -1 },
      { id: 1, kind: 'salt', x: 5150, z: 5000, radius: 60, richness: 0.5, settlement: -1 },
      { id: 2, kind: 'gold', x: 9000, z: 9000, radius: 30, richness: 0.5, settlement: -1 },
    ];
    (world as { deposits?: Deposit[] }).deposits = deposits;
    const lib = createAssetLibrary();
    const sys = new DepositSystem(world, lib, world.heightAt);
    const cam = camAt(5050, 80, 4900, 5000, 5000);
    sys.update(cam, [], 1, 0, 1, true);
    expect(sys.builtIds().sort()).toEqual([0, 1]);
    const builds = sys.builds;
    sys.update(cam, [], 1, 0.1, 1, true);
    expect(sys.builds).toBe(builds);
    // a mine raised on the iron deposit: that one is rebuilt round it
    const mine: BuildingView = { id: 77, kind: 'mine', level: 1, x: 5000, z: 5000, rot: 0, culture: 'anglo', seed: 1, settlement: -1, construction: 0.1, damage: 0, onFire: false, occupied: false };
    sys.update(cam, [mine], 2, 0.2, 1, true);
    expect(sys.builds).toBe(builds + 1);
    // far away: dropped
    sys.update(camAt(12000, 80, 12000, 12000, 12100), [mine], 2, 0.3, 1, true);
    expect(sys.builtIds()).toEqual([]);
    sys.dispose();
    lib.dispose();
  });
});

describe('siege works', () => {
  it('follow the list, swing their parts, burn with fire FX', () => {
    const lib = createAssetLibrary();
    const s = new SiegeLayer(lib);
    const list = [
      { id: 1, kind: 'ram' as const, x: 0, y: 0, z: 0, yaw: 0, swing: 0.2 },
      { id: 2, kind: 'ladder' as const, x: 5, y: 0, z: 0, yaw: 0, length: 7 },
      { id: 3, kind: 'mantlet' as const, x: 10, y: 0, z: 0, yaw: 0, state: 'burning' as const },
      { id: 4, kind: 'trebuchet' as const, x: 20, y: 0, z: 0, yaw: 0, swing: 0 },
    ];
    let fx = s.update(list, 0.5);
    expect(s.count).toBe(4);
    expect(fx.some((e) => e.kind === 'fire')).toBe(true);
    const ram = s.root.children.find((c) => c.name === 'siege:ram')!;
    const arm = ram.children.find((c) => !(c as THREE.Mesh).isMesh)!;
    const before = arm.rotation.x;
    list[0].swing = 1;
    s.update(list, 0.016);
    expect(arm.rotation.x).not.toBe(before);
    fx = s.update(list.slice(0, 2), 0.016);
    expect(s.count).toBe(2);
    expect(fx.length).toBe(0);
    s.dispose();
    lib.dispose();
  });
});

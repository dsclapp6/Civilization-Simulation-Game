import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { createStubWorld } from '../../src/render/dev/stubWorld';
import { createPlaceholderAssets } from '../../src/render/dev/placeholderAssets';
import { MockView } from '../../src/render/dev/mockView';
import { FieldSystem } from '../../src/render/fields';
import { createTerrainUniforms } from '../../src/render/terrain/terrainMaterial';
import { createAssetLibrary } from '../../src/assets/library';
import { WorldPropsLayer } from '../../src/render/feedback/worldProps';
import { BeaconLayer } from '../../src/render/feedback/beacons';
import { FloaterLayer, floaterStyle } from '../../src/render/feedback/floaters';
import { isSpeech, layoutPlates, MAX_PLATES } from '../../src/render/feedback/nameplates';
import { HoverLayer, scatterItem } from '../../src/render/feedback/hover';
import type { CharacterDrawItem, StripView, WorldMarker } from '../../src/core/view';

const world = createStubWorld('feedback-test');
const assets = createPlaceholderAssets();

function cameraAt(x: number, z: number, height: number, lookX = x + 10, lookZ = z): THREE.PerspectiveCamera {
  const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 30000);
  cam.position.set(x, world.heightAt(x, z) + height, z);
  cam.lookAt(lookX, world.heightAt(lookX, lookZ) + height * 0.5, lookZ);
  cam.updateMatrixWorld();
  return cam;
}

/** The drawn work boundary (metres along) of a strip in the field system's tile geometry. */
function boundaryOf(fs: FieldSystem, id: number): number | null {
  for (const m of fs.root.children) {
    const mesh = m as THREE.Mesh;
    if (!mesh.name.startsWith('strips:')) continue;
    const g = (fs as unknown as { strips: Map<number, { start: number; count: number; tile: number }> }).strips.get(id);
    if (!g) return null;
    const wrk = mesh.geometry.getAttribute('aWork') as THREE.BufferAttribute;
    if (!wrk || g.start + g.count > wrk.count) continue;
    if (wrk.getY(g.start) > 0) return wrk.getX(g.start);
  }
  return null;
}

describe('strip work on the field surface', () => {
  it('draws the worked part, glides to new progress and cuts the crop behind a reaper', () => {
    const view = new MockView(world, { time: 0.6, season: 1 });
    view.setDayOfSeason(2);
    const ripe = view.strips().find((st) => st.state === 'ripe')!;
    expect(ripe).toBeDefined();
    const c = ripe.poly[0];
    const fs = new FieldSystem(world, assets, createTerrainUniforms(world.size), { stripDistance: 3000, cropRadius: 90, cropMax: 60000, cropTris: 1e9 });
    const cam = cameraAt(c.x, c.z, 4);
    fs.update(view.strips(), view.stripsVersion(), cam, 100);
    fs.settle(cam);
    const before = fs.cropInstances;
    expect(before).toBeGreaterThan(100);

    // reaping starts and the first bout is done: the boundary glides from the first edge
    view.setStrip(ripe.id, { task: 'reap', work: 0.5 });
    fs.update(view.strips(), view.stripsVersion(), cam, 100, 0.1);
    const len = (fs as unknown as { strips: Map<number, { length: number }> }).strips.get(ripe.id)!.length;
    const early = boundaryOf(fs, ripe.id)!;
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(len * 0.5);
    for (let i = 0; i < 30; i++) fs.update(view.strips(), view.stripsVersion(), cam, 100, 0.1);
    fs.settle(cam);
    expect(boundaryOf(fs, ripe.id)!).toBeCloseTo(len * 0.5, 1);
    expect(fs.workingStrips).toBe(1);

    // plants behind the boundary are gone, those ahead still stand
    const cut = (fs as unknown as { strips: Map<number, { cut: { along: number; hidden: boolean }[] | null }> }).strips.get(ripe.id)!.cut!;
    expect(cut.length).toBeGreaterThan(20);
    for (const ci of cut) expect(ci.hidden).toBe(ci.along < len * 0.5);
    expect(cut.some((ci) => ci.hidden)).toBe(true);
    expect(cut.some((ci) => !ci.hidden)).toBe(true);

    // the reaping is finished: the strip turns 'harvested' and no plants remain on it
    view.setStrip(ripe.id, { state: 'harvested', task: undefined, work: 0 });
    fs.update(view.strips(), view.stripsVersion(), cam, 100, 0.1);
    fs.settle(cam);
    expect(fs.workingStrips).toBe(0);
    expect(fs.cropInstances).toBeLessThan(before);
    fs.dispose();
  });

  it('restyles only the changed strip (partial uploads)', () => {
    const view = new MockView(world, { time: 0.6, season: 1 });
    const fs = new FieldSystem(world, assets, createTerrainUniforms(world.size), { stripDistance: 3000, cropRadius: 40, cropMax: 1000, cropTris: 1e9 });
    const st = view.strips()[0] as StripView;
    const cam = cameraAt(st.poly[0].x, st.poly[0].z, 6);
    fs.update(view.strips(), view.stripsVersion(), cam, 100);
    fs.settle(cam);
    view.setStrip(st.id, { state: 'stubble', task: 'plough', work: 0.3 });
    fs.update(view.strips(), view.stripsVersion(), cam, 100, 0.05);
    const tile = fs.root.children.find((m) => m.name.startsWith('strips:') && ((m as THREE.Mesh).geometry.getAttribute('aWork') as THREE.BufferAttribute).updateRanges.length > 0) as THREE.Mesh | undefined;
    expect(tile).toBeDefined();
    const ranges = (tile!.geometry.getAttribute('aWork') as THREE.BufferAttribute).updateRanges;
    const total = ranges.reduce((s, r) => s + r.count, 0);
    expect(total).toBeLessThan((tile!.geometry.getAttribute('aWork') as THREE.BufferAttribute).array.length);
    fs.dispose();
  });
});

describe('world props', () => {
  it('instances props by kind and pile size, grows them in and lets carried ones sink away', () => {
    const lib = createAssetLibrary();
    const layer = new WorldPropsLayer(lib, () => 0);
    const props = [
      { id: 1, kind: 'stook', x: 0, z: 0, rot: 0, scale: 1 },
      { id: 2, kind: 'stook', x: 3, z: 0, rot: 0.3, scale: 1 },
      { id: 3, kind: 'woodpile', x: 0, z: 5, rot: 0, scale: 1, count: 2 },
      { id: 4, kind: 'not_a_prop', x: 9, z: 9, rot: 0, scale: 1 },
    ];
    layer.update(props, 1, 0.016);
    expect(layer.count).toBe(3);
    expect(layer.find(3)).toMatchObject({ kind: 'woodpile' });
    // the woodpile grows: a bigger model, no new prop
    props[2] = { ...props[2], count: 8 };
    layer.update(props, 2, 0.016);
    expect(layer.count).toBe(3);
    const piles = layer.root.children.filter((m) => m.name.startsWith('prop:woodpile')) as THREE.InstancedMesh[];
    const tri = (m: THREE.InstancedMesh) => m.geometry.getAttribute('position').count;
    const big = piles.find((m) => m.name.endsWith('|8'))!, small = piles.find((m) => m.name.endsWith('|2'))!;
    expect(tri(big)).toBeGreaterThan(tri(small));
    expect(big.count).toBe(1);
    expect(small.count).toBe(0);
    // a stook is carried away: it sinks out, then leaves the batch
    layer.update(props.filter((p) => p.id !== 1), 3, 0.016);
    expect(layer.count).toBe(3);
    for (let i = 0; i < 40; i++) layer.update(props.filter((p) => p.id !== 1), 3, 0.05);
    expect(layer.count).toBe(2);
    expect(layer.find(1)).toBeNull();
    layer.dispose();
    lib.dispose();
  });
});

describe('beacons', () => {
  it('draws the primary pillar, keeps it quiet up close and gone when the player stands on it', () => {
    const b = new BeaconLayer(() => 0, false);
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 30000);
    cam.position.set(0, 3, -200);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld();
    const markers: WorldMarker[] = [
      { id: 1, kind: 'objective', x: 0, z: 0, label: 'Fetch water', color: 0xf2c14e, primary: true },
      { id: 2, kind: 'home', x: 30, z: 10, label: 'Home', color: 0x8fd0ff },
    ];
    b.update(markers, cam, { x: 0, z: -200 }, 0.016, 720, true);
    expect(b.drawn).toBe(2);
    const far = b.primaryAlpha;
    expect(far).toBeGreaterThan(0.8);
    cam.position.set(0, 3, -10);
    b.update(markers, cam, { x: 0, z: -8 }, 0.016, 720, true);
    expect(b.primaryAlpha).toBeLessThan(far * 0.7);
    b.update(markers, cam, { x: 0.5, z: 0.5 }, 0.016, 720, true);
    expect(b.primaryAlpha).toBe(0);
    expect(b.drawn).toBe(1);
    b.update(markers, cam, null, 0.016, 720, false);
    expect(b.drawn).toBe(0);
    b.dispose();
  });
});

describe('floating texts', () => {
  it('styles level-ups and opinion changes, staggers texts from one spot and fades them out', () => {
    expect(floaterStyle({ text: 'Farming 3!', tone: 'skill' }).big).toBe(true);
    expect(floaterStyle({ text: '+3 sheaves', tone: 'gain' }).big).toBe(false);
    expect(floaterStyle({ text: '♥ +3', tone: 'gain' }).tone.fill).not.toBe(floaterStyle({ text: '+3', tone: 'gain' }).tone.fill);
    const f = new FloaterLayer();
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 1000);
    cam.position.set(0, 2, -6);
    f.spawn([
      { x: 0, y: 1.7, z: 0, text: '+3 sheaves', tone: 'gain' },
      { x: 0, y: 1.7, z: 0, text: 'Farming +6', tone: 'skill' },
      { x: 0, y: 1.7, z: 0, text: '+1d', tone: 'gain' },
      { x: 500, y: 1.7, z: 0, text: 'too far', tone: 'info' },
    ], cam);
    // they pop in turn, one line above the other, and rise together
    f.update(0.05, cam, 720);
    expect(f.active).toBe(1);
    f.update(0.12, cam, 720);
    expect(f.active).toBe(2);
    f.update(0.14, cam, 720);
    expect(f.active).toBe(3);
    const sprites = f.scene.children.filter((s) => s.visible) as THREE.Sprite[];
    const lines = sprites.map((s) => s.center.y).sort((a, b) => a - b);
    expect(new Set(lines).size).toBe(3);
    expect(new Set(sprites.map((s) => s.position.y.toFixed(4))).size).toBe(1);
    for (let i = 0; i < 40; i++) f.update(0.1, cam, 720);
    expect(f.active).toBe(0);
    // the pool recycles the oldest when flooded
    const many = Array.from({ length: 60 }, (_, i) => ({ x: i * 3, y: 1, z: 0, text: `+${i}`, tone: 'gain' as const }));
    f.spawn(many, cam);
    f.update(30, cam, 720);
    f.dispose();
  });
});

function person(id: number, x: number, z: number, o: Partial<CharacterDrawItem> = {}): CharacterDrawItem {
  return {
    id, x, y: 0, z, yaw: 0, lookVersion: 1, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none', anim: 'idle', animTime: 0,
    moveSpeed: 0, highlight: 0, label: `Person ${id}`,
    look: {
      sex: 'm', age: 30, height: 1.75, build: 0.5, skin: 0, hair: 0, hairStyle: 0, beard: 0, culture: 'anglo', armour: 'none', helmet: 'none',
      clothing: { tunic: 0, tunicStyle: 'short', legs: 0, headwear: 'none', shoes: 'shoes' },
    },
    ...o,
  };
}

describe('nameplates', () => {
  // a simple pin-hole projection looking down +z from the origin: 1280×720 screen
  const project = (x: number, y: number, z: number) => (z <= 0.5 ? null : { x: 640 + (x / z) * 700, y: 360 - ((y - 1.7) / z) * 700 });
  const cam = { x: 0, y: 1.7, z: 0 };

  it('shows people within their range, kin further than strangers, the hovered one always', () => {
    const chars = [
      person(1, 0, 10, { labelTone: 'stranger', labelRange: 15 }),
      person(2, 6, 30, { labelTone: 'stranger', labelRange: 15 }),
      person(3, -6, 30, { labelTone: 'kin', labelRange: 40, sublabel: 'your father · farmer' }),
      person(4, 12, 60, { labelTone: 'stranger', labelRange: 15, highlight: 1 }),
      person(5, -30, 60, { labelTone: 'stranger', labelRange: 15, mark: 'quest' }),
      person(6, 0, 3, { highlight: 3 }),
    ];
    const out = layoutPlates(chars, cam, -1, project, null);
    const ids = out.map((o) => o.it.id).sort();
    expect(ids).toEqual([1, 3, 4, 5]);
    expect(out.find((o) => o.it.id === 5)!.mode).toBe('mark');
    expect(out.find((o) => o.it.id === 4)!.focus).toBe(true);
    // far kin show the name only; the second line is for people close by
    expect(out.find((o) => o.it.id === 3)!.mode).toBe('name');
  });

  it('keeps a crowd tidy: no overlaps, important plates first, capped', () => {
    const crowd: CharacterDrawItem[] = [];
    for (let i = 0; i < 80; i++) crowd.push(person(100 + i, ((i % 10) - 4.5) * 0.9, 6 + Math.floor(i / 10) * 0.8, { labelTone: i === 33 ? 'kin' : 'stranger', labelRange: 15, sublabel: 'villager' }));
    const out = layoutPlates(crowd, cam, 177, project, null);
    expect(out.length).toBeLessThanOrEqual(MAX_PLATES);
    expect(out.length).toBeGreaterThan(3);
    expect(out[0].it.id).toBe(177);
    expect(out.some((o) => o.it.id === 133)).toBe(true);
    // occluded people get no plate
    const none = layoutPlates(crowd, cam, -1, project, () => true);
    expect(none.length).toBe(0);
  });

  it('lifts a spoken line clear of the plate in front of it rather than dropping it', () => {
    const chars = [
      person(1, 0, 8, { highlight: 1 }),
      person(2, 0.3, 9, { label: 'Fine weather for the harvest, God be thanked.' }),
    ];
    const out = layoutPlates(chars, cam, -1, project, null);
    const speech = out.find((o) => o.it.id === 2);
    expect(speech?.speech).toBe(true);
    expect(speech!.dy).toBeLessThan(0);
  });

  it('tells a spoken line from a name', () => {
    expect(isSpeech('Wat Atwood')).toBe(false);
    expect(isSpeech('Sir Hugh of Dromore')).toBe(false);
    expect(isSpeech('Good morrow!')).toBe(true);
    expect(isSpeech('Fine weather for the harvest, God be thanked.')).toBe(true);
  });
});

describe('nameplate occlusion', () => {
  it('hides people behind a house but not people standing in a yard or plot', async () => {
    const { BuildingSystem } = await import('../../src/render/buildings');
    const p = world.plots.find((q) => q.kind === 'church') ?? world.plots.find((q) => q.kind === 'cottage')!;
    const view = { id: p.id, kind: p.kind, level: p.level, x: p.x, z: p.z, rot: 0, culture: p.culture, seed: p.seed, settlement: p.settlement, construction: 1, damage: 0, onFire: false, occupied: false };
    const bs = new BuildingSystem(world, assets, { detailDistance: 800, drawBudget: 400 });
    const cam = cameraAt(p.x, p.z - 40, 3, p.x, p.z);
    for (let i = 0; i < 5; i++) bs.update([view], 1, cam, i * 0.1, 0.1, 1000, true);
    const y = world.heightAt(p.x, p.z);
    const from = new THREE.Vector3(p.x, y + 2, p.z - 40);
    const { BUILDINGS } = await import('../../src/content/types');
    const d = BUILDINGS[p.kind].d;
    expect(bs.occludes(from, new THREE.Vector3(p.x, y + 1.5, p.z + d / 2 + 6))).toBe(true);
    // inside the plot (a churchyard, a yard): visible
    expect(bs.occludes(from, new THREE.Vector3(p.x, y + 1.5, p.z - d * 0.3))).toBe(false);
    // off to the side: visible
    expect(bs.occludes(from, new THREE.Vector3(p.x + 60, y + 1.5, p.z))).toBe(false);
    bs.dispose();
  });
});

describe('hover outline', () => {
  it('frames buildings and strips, rings trees, ignores other targets', () => {
    const view = new MockView(world, { time: 0.5, season: 1 });
    const b = view.buildings()[0];
    const s = view.strips()[0];
    const layer = new HoverLayer({
      world, heightAt: (x, z) => world.heightAt(x, z),
      building: (id) => view.buildings().find((x) => x.id === id) ?? null,
      strip: (id) => view.strips().find((x) => x.id === id) ?? null,
      prop: () => null,
    });
    const shown = () => layer.root.children.some((m) => m.visible);
    layer.set({ kind: 'building', id: b.id });
    expect(shown()).toBe(true);
    layer.set({ kind: 'strip', id: s.id });
    expect(shown()).toBe(true);
    layer.set({ kind: 'ground' });
    expect(shown()).toBe(false);
    // a tree by its scatter id
    let tree: { id: number } | null = null;
    for (let cz = 0; cz < 250 && !tree; cz += 7) for (let cx = 0; cx < 250 && !tree; cx += 7) {
      const it = world.scatterInChunk(cx, cz).find((x) => x.kind === 'oak' || x.kind === 'beech' || x.kind === 'pine');
      if (it) tree = it;
    }
    expect(tree).not.toBeNull();
    expect(scatterItem(world, tree!.id)?.id).toBe(tree!.id);
    layer.set({ kind: 'scatter', id: tree!.id });
    expect(shown()).toBe(true);
    layer.set(null);
    expect(shown()).toBe(false);
    layer.dispose();
  });
});

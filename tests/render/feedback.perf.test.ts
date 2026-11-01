// Timing budgets of the clarity-pass feedback layers (run alone: npm run test:perf).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { FloaterLayer } from '../../src/render/feedback/floaters';
import { layoutPlates } from '../../src/render/feedback/nameplates';
import { WorldPropsLayer } from '../../src/render/feedback/worldProps';
import { BeaconLayer } from '../../src/render/feedback/beacons';
import { createAssetLibrary } from '../../src/assets/library';
import type { CharacterDrawItem, WorldMarker, WorldPropView } from '../../src/core/view';

function avgMs(n: number, fn: (i: number) => void): number {
  for (let i = 0; i < 20; i++) fn(i);
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn(i);
  return (performance.now() - t0) / n;
}

describe('feedback layer budgets', () => {
  it('floating texts: ≤ 0.3 ms per frame with a full pool (spawning a few per second)', () => {
    const f = new FloaterLayer();
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 1000);
    cam.position.set(0, 2, -6);
    const texts = ['+3 sheaves', 'Farming +6', '+1d', '♥ +3', 'Farming 3!'];
    const ms = avgMs(600, (i) => {
      if (i % 20 === 0) f.spawn([{ x: (i % 7) * 2, y: 1.7, z: 0, text: texts[i % texts.length], tone: 'gain' }], cam);
      f.update(1 / 60, cam, 1080);
    });
    console.log(`floaters: ${ms.toFixed(4)} ms/frame`);
    expect(ms).toBeLessThan(0.3);
    f.dispose();
  });

  it('nameplate layout: 300 people in the zone in well under a millisecond', () => {
    const chars: CharacterDrawItem[] = [];
    for (let i = 0; i < 300; i++) {
      chars.push({
        id: i, x: Math.sin(i) * 60, y: 0, z: 5 + (i % 50) * 2, yaw: 0, lookVersion: 1, mainHand: 'none', offHand: 'none', back: 'none', carry: 'none',
        anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 0, label: `Villager ${i}`, sublabel: 'farmer', labelTone: i % 9 === 0 ? 'kin' : 'stranger',
        labelRange: i % 9 === 0 ? 40 : 15, mark: i % 37 === 0 ? 'quest' : undefined,
        look: { sex: 'm', age: 30, height: 1.75, build: 0.5, skin: 0, hair: 0, hairStyle: 0, beard: 0, culture: 'anglo', armour: 'none', helmet: 'none',
          clothing: { tunic: 0, tunicStyle: 'short', legs: 0, headwear: 'none', shoes: 'shoes' } },
      });
    }
    const project = (x: number, y: number, z: number) => (z <= 0.5 ? null : { x: 960 + (x / z) * 1000, y: 540 - ((y - 1.7) / z) * 1000 });
    const ms = avgMs(300, () => { layoutPlates(chars, { x: 0, y: 1.7, z: 0 }, 5, project, null); });
    console.log(`nameplate layout (300 people): ${ms.toFixed(4)} ms`);
    expect(ms).toBeLessThan(0.5);
  });

  it('world props and beacons: idle frames cost next to nothing', () => {
    const lib = createAssetLibrary();
    const props = new WorldPropsLayer(lib, () => 0);
    const list: WorldPropView[] = [];
    for (let i = 0; i < 300; i++) list.push({ id: i + 1, kind: i % 3 === 0 ? 'stook' : i % 3 === 1 ? 'woodpile' : 'logs', x: (i % 20) * 3, z: Math.floor(i / 20) * 3, rot: i, scale: 1, count: 1 + (i % 8) });
    props.update(list, 1, 1);
    const rebuild = avgMs(20, (i) => props.update(list, 2 + i, 0.016));
    const idle = avgMs(600, () => props.update(list, 999, 0.016));
    console.log(`world props: rebuild ${rebuild.toFixed(3)} ms, idle ${idle.toFixed(4)} ms`);
    expect(idle).toBeLessThan(0.05);
    expect(rebuild).toBeLessThan(5);
    const b = new BeaconLayer(() => 0, false);
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 30000);
    cam.position.set(0, 3, -100);
    const markers: WorldMarker[] = [
      { id: 1, kind: 'objective', x: 0, z: 0, label: 'Go', color: 0xf2c14e, primary: true },
      { id: 2, kind: 'home', x: 40, z: 0, label: 'Home', color: 0x8fd0ff },
      { id: 3, kind: 'work', x: -40, z: 0, label: 'Work', color: 0xc8e07a },
    ];
    const bms = avgMs(600, () => b.update(markers, cam, { x: 0, z: -100 }, 0.016, 1080, true));
    console.log(`beacons: ${bms.toFixed(4)} ms/frame`);
    expect(bms).toBeLessThan(0.1);
    props.dispose();
    b.dispose();
    lib.dispose();
  });
});

// Timing budgets of the civilization-pass layers (run alone: npm run test:perf): what the quest marks, the builder's
// ghost and land tint, orders on the ground, deposits and siege works add to a frame in a busy village (CPU side; their
// draw calls are counted in the renderer's stats and only exist while something is shown).
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
import { QuestMarks } from '../../src/render/feedback/marks';
import { GhostLayer } from '../../src/render/feedback/ghost';
import { OrderMarkLayer } from '../../src/render/feedback/orderMarks';
import { BuildAreaOverlay } from '../../src/render/feedback/buildArea';
import { DepositSystem } from '../../src/render/deposits';
import { SiegeLayer } from '../../src/render/siege';
import { createAssetLibrary } from '../../src/assets/library';
import type { SiegeWorkDrawItem } from '../../src/core/view';
import type { Deposit } from '../../src/world/types';

/** Per-call ms: the median of batches of 20 calls (a shared machine's stalls land in a few batches, not in the median). */
function avgMs(n: number, fn: (i: number) => void): number {
  for (let i = 0; i < 20; i++) fn(i);
  const batches: number[] = [];
  for (let b = 0, i = 0; b < Math.max(5, Math.round(n / 20)); b++) {
    const t0 = performance.now();
    for (let k = 0; k < 20; k++) fn(i++);
    batches.push((performance.now() - t0) / 20);
  }
  batches.sort((a, b) => a - b);
  return batches[Math.floor(batches.length / 2)];
}

describe('civilization layer budgets', () => {
  it('cost a fraction of a millisecond per frame', async () => {
    const { createStubWorld } = await import('../../src/render/dev/stubWorld');
    const { MockView } = await import('../../src/render/dev/mockView');
    const world = createStubWorld('civ-perf');
    const view = new MockView(world, { time: 0.6, season: 1 });
    const v = view.village;
    const chars = view.characters();
    chars.slice(0, 6).forEach((c, i) => { c.mark = i % 2 ? 'turnin' : 'quest'; });
    // deposits all over the map, a few of them near the village
    const kinds: Deposit['kind'][] = ['iron', 'stone', 'clay', 'salt', 'silver', 'gold'];
    const deposits: Deposit[] = [];
    for (let i = 0; i < 400; i++) {
      const near = i < 4;
      deposits.push({ id: i, kind: kinds[i % 6], x: near ? v.x + 120 + i * 60 : (i * 977) % world.size, z: near ? v.z - 80 : (i * 613) % world.size, radius: 40, richness: 0.6, settlement: -1 });
    }
    (world as { deposits?: Deposit[] }).deposits = deposits;
    const lib = createAssetLibrary();
    const cam = new THREE.PerspectiveCamera(55, 16 / 9, 0.3, 30000);
    // the camera drifts a little each frame (the harness itself kept cheap: the ground height sampled once)
    const gy = world.heightAt(v.x, v.z);
    cam.position.set(v.x - 30, gy + 6, v.z - 30);
    cam.lookAt(v.x, gy + 1, v.z);
    cam.updateMatrixWorld();
    const at = (i: number) => { cam.position.x = v.x - 30 + (i % 200) * 0.05; cam.updateMatrixWorld(); };
    at(0);

    const marks = new QuestMarks();
    marks.occluded = () => false;
    const tMarks = avgMs(300, (i) => { at(i); marks.update(chars, cam, 720, 1 / 60, true); });

    const ghost = new GhostLayer(world, lib, world.heightAt);
    const fp = (x: number, z: number) => [{ x: x - 4, z: z - 3 }, { x: x + 4, z: z - 3 }, { x: x + 4, z: z + 3 }, { x: x - 4, z: z + 3 }];
    const tGhost = avgMs(300, (i) => {
      const x = v.x + 20 + (i % 50) * 0.1, z = v.z + 15;
      ghost.set({ kind: 'cottage', level: 1, x, z, rot: 0.4, ok: i % 40 < 20, footprint: fp(x, z) });
      ghost.update(1 / 60);
    });

    const orders = new OrderMarkLayer(world.heightAt);
    orders.set([0, 1, 2, 3, 4, 5].map((k) => ({ id: k + 1, kind: (['move', 'attack', 'hold', 'retreat', 'move', 'attack'] as const)[k], from: { x: v.x + k * 20, z: v.z }, to: { x: v.x + k * 20 + 30, z: v.z + 40 }, tone: (['own', 'selected', 'enemy'] as const)[k % 3] })));
    const tOrders = avgMs(300, (i) => { at(i); orders.update(1 / 60, cam, 720); });

    const area = new BuildAreaOverlay();
    area.set([[{ x: v.x - 300, z: v.z - 300 }, { x: v.x + 300, z: v.z - 300 }, { x: v.x + 300, z: v.z + 300 }, { x: v.x - 300, z: v.z + 300 }]]);
    const tArea = avgMs(300, () => area.update(1 / 60));

    const deps = new DepositSystem(world, lib, world.heightAt);
    const buildings = view.buildings();
    deps.update(cam, buildings, 1, 0, 1, true);
    const tDeps = avgMs(300, (i) => { at(i); deps.update(cam, buildings, 1, i / 60, 1, true); });

    const siege = new SiegeLayer(lib);
    const works: SiegeWorkDrawItem[] = [];
    for (let k = 0; k < 10; k++) works.push({ id: k + 1, kind: (['ladder', 'ram', 'mantlet', 'trebuchet', 'mangonel'] as const)[k % 5], x: v.x + k * 8, y: 0, z: v.z + 50, yaw: 0, swing: 0, length: 7, state: k === 2 ? 'burning' : 'ok' });
    siege.update(works, 0.016);
    const tSiege = avgMs(300, (i) => { for (const w of works) w.swing = (i % 60) / 60; siege.update(works, 1 / 60); });

    // what a frame always pays (marks, deposits, orders, the tint, siege works shown or not), and the ghost while it
    // follows the pointer (it re-drapes its outline on the ground each time it moves)
    const steady = tMarks + tOrders + tArea + tDeps + tSiege;
    console.log(`civ layers per frame (ms): marks ${tMarks.toFixed(4)} (${chars.length} people, ${marks.drawn} marked), orders ${tOrders.toFixed(4)}, land tint ${tArea.toFixed(4)}, deposits ${tDeps.toFixed(4)} (${deps.drawn} near), siege ${tSiege.toFixed(4)} (${works.length} works): ${steady.toFixed(4)}; ghost while dragged ${tGhost.toFixed(4)}`);
    expect(steady).toBeLessThan(0.6);
    expect(tGhost).toBeLessThan(1.0);
    for (const d of [marks, ghost, orders, area, deps, siege]) d.dispose();
    lib.dispose();
  });
});

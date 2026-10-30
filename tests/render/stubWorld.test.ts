import { describe, expect, it } from 'vitest';
import { createStubWorld } from '../../src/render/dev/stubWorld';
import { CHUNKS_PER_SIDE, WORLD_SIZE } from '../../src/world/types';

describe('dev stub world (WorldModel contract stand-in)', () => {
  const world = createStubWorld('test-seed');

  it('is deterministic per seed', () => {
    const again = createStubWorld('test-seed');
    expect(again.heightAt(5000, 6000)).toBe(world.heightAt(5000, 6000));
    expect(again.plots.length).toBe(world.plots.length);
    expect(again.scatterInChunk(100, 120).length).toBe(world.scatterInChunk(100, 120).length);
  });

  it('has sea around the edges and land in the middle', () => {
    expect(world.heightAt(50, 50)).toBeLessThan(0);
    expect(world.heightAt(WORLD_SIZE - 50, WORLD_SIZE / 2)).toBeLessThan(0);
    expect(world.macro.water.some((w) => w === 1)).toBe(true);
    expect(world.settlements.length).toBeGreaterThan(5);
  });

  it('encodes scatter ids as chunkIndex * 4096 + index', () => {
    const s = world.settlements[0];
    const cx = Math.floor(s.x / 64) + 6, cz = Math.floor(s.z / 64) + 6;
    const items = world.scatterInChunk(cx, cz);
    items.forEach((it, i) => {
      expect(Math.floor(it.id / 4096)).toBe(cz * CHUNKS_PER_SIDE + cx);
      expect(it.id % 4096).toBe(i);
    });
    expect(world.scatterInChunk(cx, cz)).toBe(items);
  });

  it('has rivers flowing downhill, a lake, plots, strips and roads that reference each other', () => {
    for (const r of world.rivers) {
      for (let i = 1; i < r.surface.length; i++) expect(r.surface[i]).toBeLessThanOrEqual(r.surface[i - 1] + 1e-6);
      expect(r.widths.length).toBe(r.points.length);
    }
    expect(world.lakes.length).toBe(1);
    expect(world.lakes[0].outline.length).toBeGreaterThan(10);
    for (const s of world.settlements) {
      for (const id of s.plots) expect(world.plots[id].settlement).toBe(s.id);
      for (const id of s.strips) expect(world.strips[id].settlement).toBe(s.id);
    }
    for (const st of world.strips) {
      let a2 = 0;
      for (let i = 0; i < st.poly.length; i++) {
        const a = st.poly[i], b = st.poly[(i + 1) % st.poly.length];
        a2 += a.x * b.z - b.x * a.z;
      }
      expect(a2).toBeGreaterThan(0);
    }
    expect(world.roads.length).toBeGreaterThan(5);
  });

  it('answers detailed queries quickly', () => {
    const t0 = performance.now();
    let acc = 0;
    for (let i = 0; i < 20000; i++) acc += world.heightAt(3000 + (i % 200) * 13, 4000 + Math.floor(i / 200) * 17);
    const per = ((performance.now() - t0) * 1000) / 20000;
    expect(Number.isFinite(acc)).toBe(true);
    expect(per).toBeLessThan(20);
  });
});

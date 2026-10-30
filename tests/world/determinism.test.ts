import { describe, expect, it } from 'vitest';
import { buildWorld, generateWorld } from '../../src/world/generate';
import type { World } from '../../src/world/world';

/** FNV-1a over a JSON rendering with numbers rounded so that float noise cannot hide a real difference. */
function digest(value: unknown): string {
  const text = JSON.stringify(value, (_k, v) => (typeof v === 'number' ? Math.round(v * 1e5) / 1e5 : v));
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
  return `${text.length}:${h.toString(16)}`;
}
function typedDigest(a: ArrayLike<number>): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i += 1) { h ^= Math.round((a[i] as number) * 1000) | 0; h = Math.imul(h, 0x01000193) >>> 0; }
  return h.toString(16);
}

function fingerprint(w: World): Record<string, string> {
  const samples: number[] = [];
  for (let i = 0; i < 400; i++) {
    const x = (i * 7919.13) % 15900 + 50, z = (i * 104729.7) % 15900 + 50;
    samples.push(w.heightAt(x, z), w.waterSurfaceAt(x, z) ?? -999, w.groundAt(x, z), w.biomeAt(x, z), w.forestAt(x, z), w.walkCostAt(x, z) === Infinity ? -1 : w.walkCostAt(x, z));
  }
  const scatter: unknown[] = [];
  for (let k = 0; k < 40; k++) scatter.push(w.scatterInChunk((k * 53) % 250, (k * 97) % 250));
  return {
    macroHeight: typedDigest(w.macro.height), macroBiome: typedDigest(w.macro.biome), macroForest: typedDigest(w.macro.forest),
    macroKingdom: typedDigest(w.macro.kingdom), macroCounty: typedDigest(w.macro.county),
    settlements: digest(w.settlements), kingdoms: digest(w.kingdoms), counties: digest(w.counties), plots: digest(w.plots),
    strips: digest(w.strips), parcels: digest(w.parcels), rivers: digest(w.rivers), lakes: digest(w.lakes), roads: digest(w.roads),
    bridges: digest(w.bridges), fords: digest(w.fords), graph: digest(w.roadGraph), samples: digest(samples), scatter: digest(scatter),
  };
}

describe('determinism', () => {
  it('same seed gives the identical world (default options)', () => {
    const a = fingerprint(buildWorld('determinism-A'));
    const b = fingerprint(buildWorld('determinism-A'));
    expect(b).toEqual(a);
  }, 120_000);

  it('same seed gives the identical world (sparse) and generateWorld matches buildWorld', () => {
    const a = fingerprint(buildWorld('determinism-B', { sparse: true }));
    const b = fingerprint(generateWorld('determinism-B', { sparse: true }) as World);
    expect(b).toEqual(a);
  }, 120_000);

  it('different seeds give different worlds', () => {
    const a = fingerprint(buildWorld('seed-one', { sparse: true }));
    const b = fingerprint(buildWorld('seed-two', { sparse: true }));
    expect(a.macroHeight).not.toBe(b.macroHeight);
    expect(a.settlements).not.toBe(b.settlements);
    expect(a.rivers).not.toBe(b.rivers);
  }, 120_000);

  it('options change the world: kingdom count and sparse mode', () => {
    const six = buildWorld('options', { sparse: true, kingdoms: 6 });
    const eight = buildWorld('options', { sparse: true, kingdoms: 8 });
    expect(six.kingdoms.length).toBe(6);
    expect(eight.kingdoms.length).toBe(8);
    for (const w of [six, eight]) {
      expect(w.kingdoms.filter((k) => k.culture === 'anglo').length).toBeGreaterThanOrEqual(1);
      for (const k of w.kingdoms) { expect(w.settlements[k.capital].kind).toBe('city'); expect(k.counties.length).toBeGreaterThanOrEqual(3); }
    }
    const sparse = buildWorld('options', { sparse: true });
    expect(sparse.settlements.length).toBeLessThan(80);
    expect(sparse.settlements.length).toBeGreaterThan(25);
  }, 120_000);
});

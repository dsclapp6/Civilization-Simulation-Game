import { describe, expect, it } from 'vitest';
import { Rng } from '../../../src/core/rng';
import type { AnimalAnim, AnimState, CharacterDrawItem, CharacterLook, HeldItem } from '../../../src/core/view';
import { CULTURES, type RankTier } from '../../../src/core/domain';
import { armLook, generateLook } from '../../../src/assets/characters/looks';
import { humanDims, HUMAN_BONES } from '../../../src/assets/characters/human/skeleton';
import { buildHumanBody } from '../../../src/assets/characters/human/body';
import { createAnimState, evaluatePose, poseToBones, type AnimContext } from '../../../src/assets/characters/human/animator';
import { ITEMS, itemGeometry } from '../../../src/assets/characters/human/items';
import { buildQuadruped, quadDims, Q_BONES } from '../../../src/assets/animals/quadruped';
import { createQuadState, quadEvaluate, quadFK, type QuadAnim } from '../../../src/assets/animals/quadAnim';
import { quadSpec } from '../../../src/assets/animals/kinds';
import { birdDims, birdEvaluate, birdFK, buildBird, createBirdState } from '../../../src/assets/animals/birds';
import { mulEulerT, setIdentity } from '../../../src/assets/characters/engine/affine';

const ANIMS: AnimState[] = [
  'idle', 'walk', 'run', 'sprint', 'carry_walk', 'sit', 'sleep', 'talk', 'eat', 'drink', 'pray', 'wave', 'kneel',
  'work_hoe', 'work_scythe', 'work_sickle', 'work_sow', 'work_hammer', 'work_axe', 'work_pick', 'work_saw', 'work_dig',
  'work_stir', 'work_lift', 'work_spin', 'work_knead', 'work_milk',
  'attack_slash', 'attack_overhead', 'attack_thrust', 'block', 'dodge',
  'draw_bow', 'aim_bow', 'shoot_bow', 'aim_crossbow', 'shoot_crossbow', 'reload_crossbow',
  'hit', 'stagger', 'fall', 'dead',
  'ride_idle', 'ride_walk', 'ride_trot', 'ride_gallop', 'ride_charge', 'mount', 'dismount',
];
const MAIN: Partial<Record<AnimState, HeldItem>> = {
  work_hoe: 'hoe', work_scythe: 'scythe', work_sickle: 'sickle', work_hammer: 'hammer', work_axe: 'axe', work_pick: 'pick',
  work_saw: 'saw', work_dig: 'spade', work_stir: 'ladle', work_spin: 'distaff', attack_slash: 'sword', attack_overhead: 'longsword',
  attack_thrust: 'spear', block: 'sword', draw_bow: 'longbow', aim_bow: 'longbow', shoot_bow: 'shortbow', aim_crossbow: 'crossbow',
  shoot_crossbow: 'crossbow', reload_crossbow: 'crossbow', ride_charge: 'lance', drink: 'cup',
};

function item(look: CharacterLook, anim: AnimState): CharacterDrawItem {
  return {
    id: 42, x: 3, y: 1, z: -2, yaw: 0.7, look, lookVersion: 1, mainHand: MAIN[anim] ?? 'none', offHand: anim === 'block' ? 'shield_heater' : 'none',
    back: 'quiver', carry: anim === 'carry_walk' || anim === 'work_lift' ? 'sack' : 'none', anim, animTime: 0, moveSpeed: anim === 'run' ? 3.5 : 1.3,
    highlight: 2, lookYaw: 0.3, aimPitch: 0.2,
    mount: anim.startsWith('ride') || anim === 'mount' || anim === 'dismount' ? { coat: 0x6a4026, anim: 'gallop', animTime: 0 } : undefined,
  };
}

function finite(a: Float32Array, n: number): boolean {
  for (let i = 0; i < n; i++) if (!Number.isFinite(a[i])) return false;
  return true;
}

describe('character assets', () => {
  it('builds every rank/sex/age look with sane geometry', () => {
    const rng = new Rng('looks');
    let maxV = 0;
    for (let tier = 1; tier <= 8; tier++) {
      for (const sex of ['m', 'f'] as const) {
        for (const age of [7, 12, 25, 70]) {
          const look = generateLook(rng, { tier: tier as RankTier, sex, age, culture: rng.pick(CULTURES) });
          if (tier === 5 && age === 25) armLook(rng, look, 'knight');
          const g = buildHumanBody(look, humanDims(look));
          expect(g.vertexCount).toBeGreaterThan(300);
          expect(g.indexCount % 3).toBe(0);
          for (let i = 0; i < g.indexCount; i++) expect(g.index[i]).toBeLessThan(g.vertexCount);
          for (let i = 0; i < g.vertexCount; i++) expect(g.skin[i * 4]).toBeLessThan(HUMAN_BONES);
          maxV = Math.max(maxV, g.vertexCount);
        }
      }
    }
    expect(maxV).toBeLessThan(6000);
  });

  it('builds every held item', () => {
    for (const k of Object.keys(ITEMS) as (keyof typeof ITEMS)[]) {
      const g = itemGeometry(k, null);
      expect(g.vertexCount).toBeGreaterThan(3);
    }
  });

  it('animates every AnimState without NaNs (on foot and mounted)', () => {
    const rng = new Rng('anim');
    const look = generateLook(rng, { tier: 5, sex: 'm', age: 30, culture: 'anglo' });
    armLook(rng, look, 'knight');
    const d = humanDims(look);
    const bones = new Float32Array(HUMAN_BONES * 12);
    const place = new Float32Array(12);
    setIdentity(place, 0);
    mulEulerT(place, 0, place, 0, 0, 0.7, 0, 3, 1, -2);
    const saddle = new Float32Array(12);
    mulEulerT(saddle, 0, place, 0, 0, 0, 0, 0, 1.45, 0);
    const stand = new Float32Array(12);
    mulEulerT(stand, 0, place, 0, 0, 0, 0, 0.6, d.hipY, 0);
    for (const anim of ANIMS) {
      const st = createAnimState(1234, d);
      const it = item(look, anim);
      const ctx: AnimContext = { place, saddle: it.mount ? saddle : null, stand: it.mount ? stand : null, horsePhase: 0, horseBob: 0, dt: 1 / 30, time: 0 };
      for (let f = 0; f < 120; f++) {
        it.animTime += 1 / 30;
        ctx.time += 1 / 30;
        evaluatePose(st, it, ctx);
        poseToBones(st, it, ctx, bones, 0);
        if (!finite(bones, bones.length)) throw new Error(`NaN in ${anim} at frame ${f}`);
      }
    }
  });

  it('animates every animal kind and animation without NaNs', () => {
    const anims: AnimalAnim[] = ['idle', 'graze', 'walk', 'trot', 'run', 'lie', 'sleep', 'eat', 'attack', 'hit', 'dead'];
    const place = new Float32Array(12);
    setIdentity(place, 0);
    for (const kind of ['horse', 'ox', 'cow', 'sheep', 'pig', 'goat', 'dog', 'cat', 'deer', 'boar', 'wolf', 'fox', 'hare'] as const) {
      for (const young of [false, true]) {
        const q = quadDims(quadSpec(kind, 0x886644), 1, young, 0x886644, true);
        const g = buildQuadruped(q);
        expect(g.vertexCount).toBeGreaterThan(100);
        for (const a of [...anims, 'rear', 'fall'] as QuadAnim[]) {
          const st = createQuadState(7);
          for (let f = 0; f < 60; f++) {
            quadEvaluate(st, q, a, f / 30, 2, 1 / 30);
            quadFK(st, q, place, 1 / 30);
          }
          if (!finite(st.world, Q_BONES * 12 - 5 * 12)) throw new Error(`NaN in ${kind} ${a}`);
        }
      }
    }
    for (const goose of [false, true]) {
      const q = birdDims(goose, 1, false, 0xffffff, true);
      expect(buildBird(q, false).vertexCount).toBeGreaterThan(50);
      for (const a of anims) {
        const st = createBirdState(3);
        for (let f = 0; f < 60; f++) { birdEvaluate(st, q, a, 1, 1 / 30); birdFK(st, q, place); }
        if (!finite(st.world, 13 * 12)) throw new Error(`NaN in bird ${a}`);
      }
    }
  });
});

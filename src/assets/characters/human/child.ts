// A small child carried on the hip: a full child body baked rigid in a straddling pose.
import type { CharacterLook } from '../../../core/view';
import { mulEulerT, setIdentity } from '../engine/affine';
import type { GeometryData } from '../engine/builder';
import { buildHumanBody } from './body';
import { CH, NEUTRAL, poseFrom } from './pose';
import { HB, HUMAN_BONES, humanDims, POSE_BONES, POSE_PARENT } from './skeleton';

const TUNICS = [0x9a8a6a, 0x8a6a4a, 0x6a7a5a, 0xb8a888, 0x7a5a4a, 0x8a8a7a];
const SKINS = [0xf1d3c0, 0xe8c1a2, 0xd9a983, 0xe8c1a2, 0xf1d3c0, 0xc68e65];
const HAIRS = [0x6b4428, 0x4a3020, 0xb07a3a, 0xd2b071, 0x2b1d14, 0x8a5a2c];

export function buildChildCarry(seed: number): GeometryData {
  const i = seed % 6;
  const look: CharacterLook = {
    sex: i % 2 ? 'f' : 'm', age: 4, height: 0.9, build: 0.5, skin: SKINS[i], hair: HAIRS[i], hairStyle: i % 2 ? 3 : 1, beard: 0,
    culture: 'anglo',
    clothing: { tunic: TUNICS[i], tunicStyle: 'long', legs: SKINS[i], headwear: 'none', shoes: 'bare' },
    armour: 'none', helmet: 'none',
  };
  const d = humanDims(look);
  const g = buildHumanBody(look, d);
  const pose = poseFrom({
    ...NEUTRAL,
    thL: [-78, 0, 28], shL: [72, 0, 0], thR: [-78, 0, -28], shR: [72, 0, 0], ftL: [20, 0, 0], ftR: [20, 0, 0],
    spine: [4, 0, 0], chest: [-4, 0, 0], head: [-8, 30, 6],
    uaL: [-40, 20, 30], faL: [-70, 0, 0], uaR: [-60, -30, -20], faR: [-80, 0, 0],
  });
  void CH;
  // FK with the pelvis at the origin
  const W = new Float32Array(HUMAN_BONES * 12);
  const root = new Float32Array(12);
  setIdentity(root, 0);
  mulEulerT(W, 0, root, 0, pose[0], pose[1], pose[2], 0, 0, 0);
  for (let b = 1; b < POSE_BONES; b++) {
    const pa = POSE_PARENT[b];
    mulEulerT(W, b * 12, W, pa * 12, pose[b * 3], pose[b * 3 + 1], pose[b * 3 + 2],
      d.bind[b * 3] - d.bind[pa * 3], d.bind[b * 3 + 1] - d.bind[pa * 3 + 1], d.bind[b * 3 + 2] - d.bind[pa * 3 + 2]);
  }
  // secondary bones follow their parents rigidly
  const follow = (b: number, pa: number): void => {
    mulEulerT(W, b * 12, W, pa * 12, 0, 0, 0, d.bind[b * 3] - d.bind[pa * 3], d.bind[b * 3 + 1] - d.bind[pa * 3 + 1], d.bind[b * 3 + 2] - d.bind[pa * 3 + 2]);
  };
  follow(HB.skirtL, HB.thL); follow(HB.skirtR, HB.thR);
  mulEulerT(W, HB.skirtL * 12, W, 0, pose[HB.thL * 3] * 0.8, 0, pose[HB.thL * 3 + 2] * 0.6, d.bind[HB.skirtL * 3], 0, 0);
  mulEulerT(W, HB.skirtR * 12, W, 0, pose[HB.thR * 3] * 0.8, 0, pose[HB.thR * 3 + 2] * 0.6, d.bind[HB.skirtR * 3], 0, 0);
  follow(HB.cloak, HB.chest); follow(HB.eyes, HB.head); follow(HB.mouth, HB.head);
  // bake
  const n = g.vertexCount;
  const pos = new Float32Array(n * 3);
  const skin = new Uint8Array(n * 4);
  const xf = (b: number, x: number, y: number, z: number, out: number[]): void => {
    const o = b * 12;
    const bx = x - d.bind[b * 3], by = y - d.bind[b * 3 + 1], bz = z - d.bind[b * 3 + 2];
    out[0] = W[o] * bx + W[o + 1] * by + W[o + 2] * bz + W[o + 3];
    out[1] = W[o + 4] * bx + W[o + 5] * by + W[o + 6] * bz + W[o + 7];
    out[2] = W[o + 8] * bx + W[o + 9] * by + W[o + 10] * bz + W[o + 11];
  };
  const pa = [0, 0, 0], pb = [0, 0, 0];
  for (let v = 0; v < n; v++) {
    const x = g.position[v * 3], y = g.position[v * 3 + 1], z = g.position[v * 3 + 2];
    const a = g.skin[v * 4], b = g.skin[v * 4 + 1], w = g.skin[v * 4 + 2] / 255;
    xf(a, x, y, z, pa);
    if (w > 0) { xf(b, x, y, z, pb); for (let k = 0; k < 3; k++) pa[k] += (pb[k] - pa[k]) * w; }
    pos[v * 3] = pa[0]; pos[v * 3 + 1] = pa[1]; pos[v * 3 + 2] = pa[2];
    skin[v * 4] = 0; skin[v * 4 + 1] = 0; skin[v * 4 + 2] = 0; skin[v * 4 + 3] = g.skin[v * 4 + 3];
  }
  return { ...g, position: pos, skin };
}

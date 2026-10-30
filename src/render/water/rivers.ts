// River ribbons following River.points / widths / surface, with flow coordinates for the shader.
import * as THREE from 'three';
import { clamp, pointInPolygon, type P2 } from '../../core/math';
import type { Lake, River, WorldModel } from '../../world/types';

export interface RibbonData {
  position: Float32Array;
  depth: Float32Array;
  flow: Float32Array;
  speed: Float32Array;
  index: Uint32Array;
}

const ACROSS = 5;

/** Catmull-Rom resampling of a polyline with attached per-point values. */
function resampleRiver(r: River, spacing: number): { p: P2[]; w: number[]; s: number[] } {
  const p: P2[] = [], w: number[] = [], s: number[] = [];
  const pts = r.points;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    const len = Math.hypot(p2.x - p1.x, p2.z - p1.z);
    const steps = Math.max(1, Math.ceil(len / spacing));
    for (let k = 0; k < steps; k++) {
      const t = k / steps, t2 = t * t, t3 = t2 * t;
      const cr = (a: number, b: number, c: number, d: number) =>
        0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      p.push({ x: cr(p0.x, p1.x, p2.x, p3.x), z: cr(p0.z, p1.z, p2.z, p3.z) });
      w.push(r.widths[i] + (r.widths[i + 1] - r.widths[i]) * t);
      s.push(r.surface[i] + (r.surface[i + 1] - r.surface[i]) * t);
    }
  }
  p.push(pts[pts.length - 1]);
  w.push(r.widths[r.widths.length - 1]);
  s.push(r.surface[r.surface.length - 1]);
  return { p, w, s };
}

function inAnyLake(x: number, z: number, lakes: readonly Lake[], boxes: { x0: number; x1: number; z0: number; z1: number }[]): boolean {
  for (let k = 0; k < lakes.length; k++) {
    const b = boxes[k];
    if (x < b.x0 || x > b.x1 || z < b.z0 || z > b.z1) continue;
    if (pointInPolygon(x, z, lakes[k].outline)) return true;
  }
  return false;
}

/**
 * Build ribbon pieces for a river. The river is cut where it enters the open sea (its surface
 * would z-fight with the sea plane) or a lake. Long rivers are split into pieces for culling.
 */
export function buildRiverRibbons(world: WorldModel, river: River, maxSamplesPerPiece = 400): RibbonData[] {
  const lakes = world.lakes;
  const boxes = lakes.map((l) => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const q of l.outline) { x0 = Math.min(x0, q.x); x1 = Math.max(x1, q.x); z0 = Math.min(z0, q.z); z1 = Math.max(z1, q.z); }
    return { x0, x1, z0, z1 };
  });
  const avgW = river.widths.reduce((a, b) => a + b, 0) / Math.max(1, river.widths.length);
  const { p, w, s } = resampleRiver(river, clamp(avgW * 0.7, 4, 10));
  const m = world.macro;
  const isSea = (x: number, z: number) => {
    const i = clamp(Math.floor(x / m.cell), 0, m.res - 1), j = clamp(Math.floor(z / m.cell), 0, m.res - 1);
    return m.water[j * m.res + i] === 1;
  };
  // which samples to keep
  const keep: boolean[] = p.map((q, i) => !(s[i] < 0.25 && isSea(q.x, q.z)) && !inAnyLake(q.x, q.z, lakes, boxes));
  const out: RibbonData[] = [];
  let start = 0;
  while (start < p.length) {
    while (start < p.length && !keep[start]) start++;
    if (start >= p.length - 1) break;
    let end = start;
    while (end + 1 < p.length && keep[end + 1] && end - start < maxSamplesPerPiece) end++;
    if (end > start) out.push(buildPiece(world, p, w, s, start, end));
    start = end;
    if (end + 1 < p.length && !keep[end + 1]) start = end + 1;
  }
  return out;
}

function buildPiece(world: WorldModel, p: P2[], w: number[], s: number[], a: number, b: number): RibbonData {
  const n = b - a + 1;
  const position = new Float32Array(n * ACROSS * 3);
  const depth = new Float32Array(n * ACROSS);
  const flow = new Float32Array(n * ACROSS * 2);
  const speed = new Float32Array(n * ACROSS);
  let along = 0;
  for (let k = 0; k < n; k++) {
    const i = a + k;
    const prev = p[Math.max(0, i - 1)], next = p[Math.min(p.length - 1, i + 1)];
    let tx = next.x - prev.x, tz = next.z - prev.z;
    const tl = Math.hypot(tx, tz) || 1;
    tx /= tl; tz /= tl;
    const px = -tz, pz = tx;
    if (k > 0) along += Math.hypot(p[i].x - p[i - 1].x, p[i].z - p[i - 1].z);
    const half = w[i] * 0.5 + Math.max(1.6, w[i] * 0.22);
    // slope → flow speed
    const ds = (s[Math.max(0, i - 2)] - s[Math.min(s.length - 1, i + 2)]) / Math.max(1, Math.hypot(p[Math.min(p.length - 1, i + 2)].x - p[Math.max(0, i - 2)].x, p[Math.min(p.length - 1, i + 2)].z - p[Math.max(0, i - 2)].z));
    const sp = clamp(0.6 + ds * 160, 0.5, 3.5);
    for (let c = 0; c < ACROSS; c++) {
      const u = c / (ACROSS - 1);
      const off = (u - 0.5) * 2 * half;
      const x = p[i].x + px * off, z = p[i].z + pz * off;
      const v = k * ACROSS + c;
      position[v * 3] = x; position[v * 3 + 1] = s[i]; position[v * 3 + 2] = z;
      depth[v] = s[i] - world.heightAt(x, z);
      flow[v * 2] = along; flow[v * 2 + 1] = u;
      speed[v] = sp;
    }
  }
  const index = new Uint32Array((n - 1) * (ACROSS - 1) * 6);
  let t = 0;
  for (let k = 0; k < n - 1; k++) {
    for (let c = 0; c < ACROSS - 1; c++) {
      const v0 = k * ACROSS + c, v1 = v0 + 1, v2 = v0 + ACROSS, v3 = v2 + 1;
      // upward-facing winding depends on the side; ensure +y normals
      index[t++] = v0; index[t++] = v2; index[t++] = v1;
      index[t++] = v1; index[t++] = v2; index[t++] = v3;
    }
  }
  // fix winding so faces point up
  if (n > 1) {
    const ax = position[0], az = position[2];
    const bx = position[ACROSS * 3], bz = position[ACROSS * 3 + 2];
    const cx = position[3], cz = position[5];
    const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
    if (ny < 0) for (let q = 0; q < index.length; q += 3) { const tmp = index[q + 1]; index[q + 1] = index[q + 2]; index[q + 2] = tmp; }
  }
  return { position, depth, flow, speed, index };
}

export function ribbonGeometry(d: RibbonData): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
  g.setAttribute('aDepth', new THREE.BufferAttribute(d.depth, 1));
  g.setAttribute('aFlow', new THREE.BufferAttribute(d.flow, 2));
  g.setAttribute('aSpeed', new THREE.BufferAttribute(d.speed, 1));
  g.setIndex(new THREE.BufferAttribute(d.index, 1));
  g.computeBoundingSphere();
  return g;
}

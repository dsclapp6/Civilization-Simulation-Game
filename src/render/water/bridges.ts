// Procedural bridges (timber trestle or stone arches, per Bridge.stone) and ford stepping stones.
import * as THREE from 'three';
import { hash01 } from '../../core/math';
import type { Bridge, Ford, WorldModel } from '../../world/types';
import type { Palette } from '../../assets/types';

interface Acc { pos: number[]; nor: number[]; col: number[] }

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _c = new THREE.Color();
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _cc = new THREE.Vector3();

function pushGeo(acc: Acc, geo: THREE.BufferGeometry, matrix: THREE.Matrix4, color: number, shade = 1): void {
  const g = geo.index ? geo.toNonIndexed() : geo;
  const p = g.getAttribute('position');
  _c.setHex(color).multiplyScalar(shade);
  for (let i = 0; i < p.count; i += 3) {
    _a.fromBufferAttribute(p, i).applyMatrix4(matrix);
    _b.fromBufferAttribute(p, i + 1).applyMatrix4(matrix);
    _cc.fromBufferAttribute(p, i + 2).applyMatrix4(matrix);
    _n.subVectors(_b, _a).cross(_v.subVectors(_cc, _a)).normalize();
    for (const q of [_a, _b, _cc]) {
      acc.pos.push(q.x, q.y, q.z);
      acc.nor.push(_n.x, _n.y, _n.z);
      acc.col.push(_c.r, _c.g, _c.b);
    }
  }
  if (g !== geo) g.dispose();
  geo.dispose();
}

function boxAt(acc: Acc, frame: THREE.Matrix4, x: number, y: number, z: number, w: number, h: number, d: number, color: number, rx = 0, shade = 1): void {
  const g = new THREE.BoxGeometry(w, h, d);
  _m.makeRotationX(rx).setPosition(x, y, z);
  pushGeo(acc, g, new THREE.Matrix4().multiplyMatrices(frame, _m), color, shade);
}

function buildBridge(acc: Acc, world: WorldModel, br: Bridge, palette: Palette): void {
  const L = br.length, W = br.width;
  const dx = Math.sin(br.rot), dz = Math.cos(br.rot);
  const ax = br.x - dx * L / 2, az = br.z - dz * L / 2, bx = br.x + dx * L / 2, bz = br.z + dz * L / 2;
  const hA = world.heightAt(ax, az), hB = world.heightAt(bx, bz);
  const river = world.rivers.find((r) => r.id === br.riverId);
  let surface = Math.min(hA, hB) - 1;
  if (river) {
    let best = Infinity;
    for (let i = 0; i < river.points.length; i++) {
      const d = Math.hypot(river.points[i].x - br.x, river.points[i].z - br.z);
      if (d < best) { best = d; surface = river.surface[i]; }
    }
  }
  const deckMid = Math.max((hA + hB) / 2 + (br.stone ? 1.2 : 0.4), surface + (br.stone ? 3.2 : 2.2));
  const frame = new THREE.Matrix4().makeRotationY(br.rot).setPosition(br.x, 0, br.z);
  const deckY = (s: number) => {
    // s in [-L/2, L/2]; smooth hump from both ends to the middle
    const t = s / (L / 2);
    const end = t < 0 ? hA : hB;
    const k = 1 - t * t;
    return end + (deckMid - end) * Math.sqrt(Math.max(0, k));
  };
  const segs = Math.max(4, Math.round(L / 2.5));
  const timber = palette.timber, stone = palette.stone;
  for (let k = 0; k < segs; k++) {
    const s0 = -L / 2 + (k / segs) * L, s1 = -L / 2 + ((k + 1) / segs) * L;
    const y0 = deckY(s0), y1 = deckY(s1);
    const sm = (s0 + s1) / 2, ym = (y0 + y1) / 2;
    const len = Math.hypot(s1 - s0, y1 - y0) + 0.05;
    const pitch = -Math.atan2(y1 - y0, s1 - s0);
    if (br.stone) {
      boxAt(acc, frame, 0, ym - 0.35, sm, W, 0.7, len, stone, pitch, 0.95 + hash01(br.id, k) * 0.08);
      // parapets
      boxAt(acc, frame, W / 2 - 0.25, ym + 0.45, sm, 0.5, 0.9, len, stone, pitch, 0.9);
      boxAt(acc, frame, -W / 2 + 0.25, ym + 0.45, sm, 0.5, 0.9, len, stone, pitch, 0.9);
    } else {
      boxAt(acc, frame, 0, ym - 0.12, sm, W, 0.24, len, timber, pitch, 1.15 + hash01(br.id, k) * 0.15);
      // rails and posts
      boxAt(acc, frame, W / 2 - 0.1, ym + 0.95, sm, 0.12, 0.12, len, timber, pitch, 0.95);
      boxAt(acc, frame, -W / 2 + 0.1, ym + 0.95, sm, 0.12, 0.12, len, timber, pitch, 0.95);
      boxAt(acc, frame, W / 2 - 0.1, ym + 0.5, sm - len / 2, 0.14, 1.0, 0.14, timber, 0, 0.85);
      boxAt(acc, frame, -W / 2 + 0.1, ym + 0.5, sm - len / 2, 0.14, 1.0, 0.14, timber, 0, 0.85);
    }
  }
  if (br.stone) {
    // body: the side profile with arch openings, extruded across the width
    const spans = L > 16 ? 3 : 2;
    const bed = surface - 2.5;
    const shape = new THREE.Shape();
    shape.moveTo(-L / 2, bed);
    shape.lineTo(L / 2, bed);
    const steps = 18;
    for (let q = 0; q <= steps; q++) {
      const sx = L / 2 - (q / steps) * L;
      shape.lineTo(sx, deckY(sx) - 0.68);
    }
    shape.closePath();
    const pier = 1.7;
    for (let k = 0; k < spans; k++) {
      const s0 = -L / 2 + (k / spans) * L + (k === 0 ? 1.5 : pier / 2);
      const s1 = -L / 2 + ((k + 1) / spans) * L - (k === spans - 1 ? 1.5 : pier / 2);
      if (s1 - s0 < 1) continue;
      let top = Infinity;
      for (let q = 0; q <= 8; q++) top = Math.min(top, deckY(s0 + ((s1 - s0) * q) / 8) - 1.25);
      const spring = Math.max(bed + 0.6, Math.min(surface + 0.3, top - 0.9));
      const rise = Math.max(0.5, top - spring);
      const hole = new THREE.Path();
      hole.moveTo(s0, bed + 0.3);
      hole.lineTo(s1, bed + 0.3);
      hole.lineTo(s1, spring);
      hole.absellipse((s0 + s1) / 2, spring, (s1 - s0) / 2, rise, 0, Math.PI, false, 0);
      hole.lineTo(s0, bed + 0.3);
      shape.holes.push(hole);
    }
    const body = new THREE.ExtrudeGeometry(shape, { depth: W * 0.96, bevelEnabled: false, curveSegments: 7 });
    body.rotateY(-Math.PI / 2);
    body.translate(W * 0.48, 0, 0);
    pushGeo(acc, body, frame, stone, 0.9);
    // pointed cutwaters on the piers, upstream and downstream
    for (let k = 1; k < spans; k++) {
      const sx = -L / 2 + (k / spans) * L;
      const top = deckY(sx) - 1.4;
      const h = top - bed;
      for (const side of [-1, 1]) {
        const g = new THREE.CylinderGeometry(0, 0.95, h, 4);
        _m.makeRotationY(Math.PI / 4).setPosition(side * (W / 2 + 0.2), bed + h / 2, sx);
        pushGeo(acc, g, new THREE.Matrix4().multiplyMatrices(frame, _m), stone, 0.85);
      }
    }
  } else {
    // trestle piles into the river bed
    const piles = Math.max(2, Math.round(L / 4));
    for (let k = 1; k < piles; k++) {
      const s = -L / 2 + (k / piles) * L;
      const top = deckY(s) - 0.24;
      const bottom = surface - 2.2;
      for (const side of [-1, 1]) boxAt(acc, frame, side * (W / 2 - 0.3), (top + bottom) / 2, s, 0.3, top - bottom, 0.3, timber, 0, 0.8);
      boxAt(acc, frame, 0, top - 0.25, s, W, 0.22, 0.25, timber, 0, 0.75);
    }
  }
}

function buildFord(acc: Acc, world: WorldModel, f: Ford, palette: Palette): void {
  const road = world.roads.find((r) => r.id === f.roadId);
  let dir = 0;
  if (road) {
    let best = Infinity;
    for (let i = 0; i < road.points.length - 1; i++) {
      const a = road.points[i], b = road.points[i + 1];
      const d = Math.hypot((a.x + b.x) / 2 - f.x, (a.z + b.z) / 2 - f.z);
      if (d < best) { best = d; dir = Math.atan2(b.x - a.x, b.z - a.z); }
    }
  }
  const surface = world.waterSurfaceAt(f.x, f.z) ?? world.heightAt(f.x, f.z);
  const dx = Math.sin(dir), dz = Math.cos(dir);
  for (let k = -5; k <= 5; k++) {
    for (const side of [-0.9, 0.9]) {
      const jitter = (hash01(f.id, k, side > 0 ? 1 : 2) - 0.5) * 0.5;
      const x = f.x + dx * k * 1.3 + dz * (side + jitter), z = f.z + dz * k * 1.3 - dx * (side + jitter);
      const y = Math.max(world.heightAt(x, z), surface - 0.25);
      const g = new THREE.DodecahedronGeometry(0.42, 0);
      _m.makeScale(1.1, 0.45, 0.9).setPosition(x, y + 0.08, z);
      pushGeo(acc, g, _m.clone(), palette.ground[8], 0.9 + hash01(f.id, k, 5) * 0.2);
    }
  }
}

export function buildBridgesGeometry(world: WorldModel, palette: Palette): THREE.BufferGeometry | null {
  const acc: Acc = { pos: [], nor: [], col: [] };
  for (const br of world.bridges) buildBridge(acc, world, br, palette);
  for (const f of world.fords) buildFord(acc, world, f, palette);
  if (!acc.pos.length) return null;
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(acc.pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(acc.nor, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(acc.col, 3));
  g.computeBoundingSphere();
  return g;
}

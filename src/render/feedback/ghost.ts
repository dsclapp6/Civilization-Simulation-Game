// Builder mode (docs/CIV.md §5): the ghost of the building about to be placed — a translucent block of its footprint and
// a rough height, green when it fits and red when not, its footprint outlined on the ground — and the outline of the
// land the builder may build on. Cheap to update every frame: geometry is rebuilt only when the kind or the land changes.
import * as THREE from 'three';
import { BUILDINGS, type BuildingKind } from '../../content/types';
import type { BuildGhost } from '../types';

const OK = 0x5fd16a;
const BAD = 0xe0533a;

/** A rough height for the ghost block by kind and level (the real model replaces it once built). */
function heightOf(kind: BuildingKind, level: number): number {
  const def = BUILDINGS[kind];
  const big = Math.max(def.w, def.d);
  const base = kind === 'keep_stone' ? 14 : kind === 'tower' ? 11 : kind.includes('wall') || kind === 'palisade' ? 5
    : kind === 'manor_house' || kind === 'great_hall' ? 8 : Math.min(9, 3 + big * 0.28);
  return base * (1 + 0.18 * (Math.max(1, level) - 1));
}

export class GhostLayer {
  readonly root = new THREE.Group();
  private readonly mat = new THREE.MeshBasicMaterial({ color: OK, transparent: true, opacity: 0.32, depthWrite: false });
  private readonly edgeMat = new THREE.LineBasicMaterial({ color: OK, transparent: true, opacity: 0.95 });
  private readonly areaMat = new THREE.LineBasicMaterial({ color: 0xffd24a, transparent: true, opacity: 0.8 });
  private block: THREE.Mesh | null = null;
  private edges: THREE.LineSegments | null = null;
  private outline: THREE.LineLoop | null = null;
  private readonly area = new THREE.Group();
  private key = '';

  constructor(private readonly heightAt: (x: number, z: number) => number) {
    this.root.renderOrder = 5;
    this.root.add(this.area);
  }

  set(g: BuildGhost | null): void {
    if (!g) {
      if (this.block) this.block.visible = false;
      if (this.edges) this.edges.visible = false;
      if (this.outline) this.outline.visible = false;
      return;
    }
    const def = BUILDINGS[g.kind];
    const hgt = heightOf(g.kind, g.level);
    const key = `${g.kind}|${g.level}`;
    if (key !== this.key || !this.block) {
      this.key = key;
      if (this.block) { this.root.remove(this.block); this.block.geometry.dispose(); }
      if (this.edges) { this.root.remove(this.edges); this.edges.geometry.dispose(); }
      const box = new THREE.BoxGeometry(def.w, hgt, def.d);
      box.translate(0, hgt / 2, 0);
      this.block = new THREE.Mesh(box, this.mat);
      this.edges = new THREE.LineSegments(new THREE.EdgesGeometry(box), this.edgeMat);
      this.root.add(this.block, this.edges);
    }
    const color = g.ok ? OK : BAD;
    this.mat.color.setHex(color);
    this.edgeMat.color.setHex(color);
    // sit on the highest ground under the footprint so the block never sinks into a slope
    let y = this.heightAt(g.x, g.z);
    for (const c of g.footprint) y = Math.max(y, this.heightAt(c.x, c.z));
    y = Math.max(0, y);
    for (const o of [this.block!, this.edges!]) {
      o.visible = true;
      o.position.set(g.x, y, g.z);
      o.rotation.set(0, g.rot, 0);
    }
    // the footprint on the ground
    if (this.outline) { this.root.remove(this.outline); this.outline.geometry.dispose(); }
    if (g.footprint.length >= 3) {
      const pts = g.footprint.map((c) => new THREE.Vector3(c.x, Math.max(0, this.heightAt(c.x, c.z)) + 0.15, c.z));
      this.outline = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.edgeMat);
      this.root.add(this.outline);
    } else this.outline = null;
  }

  setArea(polys: ReadonlyArray<ReadonlyArray<{ x: number; z: number }>> | null): void {
    for (const c of [...this.area.children]) { this.area.remove(c); (c as THREE.Line).geometry.dispose(); }
    if (!polys) return;
    for (const poly of polys) {
      if (poly.length < 3) continue;
      // follow the ground between the corners
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 8));
        for (let k = 0; k < n; k++) {
          const t = k / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
          pts.push(new THREE.Vector3(x, Math.max(0, this.heightAt(x, z)) + 0.4, z));
        }
      }
      this.area.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), this.areaMat));
    }
  }
}

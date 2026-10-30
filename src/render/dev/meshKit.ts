// Tiny helper for building merged, flat-coloured low-poly geometry from primitive parts.
// Used by the dev placeholder assets only.
import * as THREE from 'three';

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();
const _c = new THREE.Color();
const _n = new THREE.Vector3();

export interface PartOpts {
  x?: number; y?: number; z?: number;
  rx?: number; ry?: number; rz?: number;
  sx?: number; sy?: number; sz?: number;
  /** 0..1 per-part weight written to the `aFoliage` attribute (vegetation tint/sway). */
  foliage?: number;
}

/** Accumulates non-indexed triangles with per-vertex colour and an optional foliage weight. */
export class MeshKit {
  private pos: number[] = [];
  private nor: number[] = [];
  private col: number[] = [];
  private fol: number[] = [];

  add(geo: THREE.BufferGeometry, color: number, o: PartOpts = {}): this {
    const g = geo.index ? geo.toNonIndexed() : geo;
    _e.set(o.rx ?? 0, o.ry ?? 0, o.rz ?? 0);
    _q.setFromEuler(_e);
    _s.set(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
    _p.set(o.x ?? 0, o.y ?? 0, o.z ?? 0);
    _m.compose(_p, _q, _s);
    _c.setHex(color);
    const pa = g.getAttribute('position');
    const tri = pa.count;
    const v = new THREE.Vector3();
    for (let i = 0; i < tri; i += 3) {
      const a = new THREE.Vector3().fromBufferAttribute(pa, i).applyMatrix4(_m);
      const b = new THREE.Vector3().fromBufferAttribute(pa, i + 1).applyMatrix4(_m);
      const c = new THREE.Vector3().fromBufferAttribute(pa, i + 2).applyMatrix4(_m);
      _n.subVectors(c, b).cross(v.subVectors(a, b)).normalize();
      for (const p of [a, b, c]) {
        this.pos.push(p.x, p.y, p.z);
        this.nor.push(_n.x, _n.y, _n.z);
        this.col.push(_c.r, _c.g, _c.b);
        this.fol.push(o.foliage ?? 0);
      }
    }
    if (g !== geo) g.dispose();
    geo.dispose();
    return this;
  }

  get triangleCount(): number { return this.pos.length / 9; }

  build(withFoliage = false): THREE.BufferGeometry {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    geo.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    geo.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (withFoliage) geo.setAttribute('aFoliage', new THREE.Float32BufferAttribute(this.fol, 1));
    geo.computeBoundingSphere();
    geo.computeBoundingBox();
    return geo;
  }
}

/** A gable roof prism spanning x (width) with the ridge along z (depth), base at y=0. */
export function gableGeometry(width: number, depth: number, height: number): THREE.BufferGeometry {
  const w = width / 2, d = depth / 2;
  const p = [
    // left slope
    -w, 0, d, 0, height, d, 0, height, -d,
    -w, 0, d, 0, height, -d, -w, 0, -d,
    // right slope
    w, 0, -d, 0, height, -d, 0, height, d,
    w, 0, -d, 0, height, d, w, 0, d,
    // gables
    -w, 0, d, w, 0, d, 0, height, d,
    w, 0, -d, -w, 0, -d, 0, height, -d,
  ];
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(p, 3));
  return g;
}

/** Square pyramid with base at y=0. */
export function pyramidGeometry(width: number, depth: number, height: number): THREE.BufferGeometry {
  const g = new THREE.ConeGeometry(Math.SQRT1_2, 1, 4, 1, true);
  g.rotateY(Math.PI / 4);
  g.translate(0, 0.5, 0);
  g.scale(width, height, depth);
  return g;
}

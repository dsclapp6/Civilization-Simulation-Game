// Stand-in props for gallery vignettes (the real props come from the environment asset
// library). Plain flat-shaded meshes; only used by the characters gallery.
import * as THREE from 'three';

const mats = new Map<number, THREE.MeshStandardMaterial>();
function mat(color: number, emissive = 0, rough = 0.85, metal = 0): THREE.MeshStandardMaterial {
  const key = color * 7 + emissive * 3 + Math.round(rough * 100) + metal * 1000;
  let m = mats.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: rough, metalness: metal, emissive, emissiveIntensity: emissive ? 1.6 : 0 });
    mats.set(key, m);
  }
  return m;
}
function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = true; o.receiveShadow = true;
  return o;
}

export function anvil(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.22, 0.26, 0.5, 7), mat(0x6a4a30), 0, 0.25, 0));
  g.add(mesh(new THREE.BoxGeometry(0.22, 0.12, 0.2), mat(0x3a3c40, 0, 0.45, 0.5), 0, 0.56, 0));
  const top = mesh(new THREE.BoxGeometry(0.3, 0.08, 0.5), mat(0x45474c, 0, 0.35, 0.6), 0, 0.66, 0);
  g.add(top);
  const horn = mesh(new THREE.ConeGeometry(0.06, 0.22, 6), mat(0x45474c, 0, 0.35, 0.6), 0, 0.66, 0.34);
  horn.rotation.x = Math.PI / 2;
  g.add(horn);
  // glowing work piece
  g.add(mesh(new THREE.BoxGeometry(0.035, 0.03, 0.16), mat(0xff8a2a, 0xff6a10), 0.0, 0.715, -0.08));
  return g;
}

export function forge(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(1.1, 0.8, 0.9), mat(0x8a8478), 0, 0.4, 0));
  g.add(mesh(new THREE.BoxGeometry(0.7, 0.08, 0.55), mat(0xff7a20, 0xff5a10), 0, 0.82, 0));
  g.add(mesh(new THREE.BoxGeometry(0.5, 1.6, 0.4), mat(0x7a746a), 0, 1.6, -0.25));
  return g;
}

export function chopLog(): THREE.Group {
  const g = new THREE.Group();
  const trunk = mesh(new THREE.CylinderGeometry(0.28, 0.34, 2.6, 8), mat(0x6a4a30), 0, 1.3, 0);
  g.add(trunk);
  g.add(mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.12, 8), mat(0xc8a676), 0, 0.62, 0.0));
  return g;
}

export function cauldron(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    const leg = mesh(new THREE.CylinderGeometry(0.025, 0.025, 1.3, 4), mat(0x5a4030), Math.cos(a) * 0.45, 0.6, Math.sin(a) * 0.45);
    leg.rotation.z = Math.cos(a) * 0.35; leg.rotation.x = -Math.sin(a) * 0.35;
    g.add(leg);
  }
  const pot = mesh(new THREE.SphereGeometry(0.32, 8, 6, 0, Math.PI * 2, Math.PI * 0.3, Math.PI * 0.7), mat(0x2a2a2a, 0, 0.5, 0.4), 0, 0.62, 0);
  g.add(pot);
  g.add(mesh(new THREE.CircleGeometry(0.27, 8).rotateX(-Math.PI / 2), mat(0x7a5a2a), 0, 0.82, 0));
  g.add(mesh(new THREE.ConeGeometry(0.22, 0.35, 6), mat(0xffa030, 0xff7010), 0, 0.17, 0));
  return g;
}

export function butts(): THREE.Group {
  const g = new THREE.Group();
  const face = mesh(new THREE.CylinderGeometry(0.55, 0.55, 0.3, 12), mat(0xd8b864), 0, 1.0, 0);
  face.rotation.x = Math.PI / 2;
  g.add(face);
  for (const [r, c] of [[0.42, 0xe8e2d2], [0.3, 0x2a4a8a], [0.18, 0xb01c24], [0.07, 0xe8c64a]] as const) {
    const ring = mesh(new THREE.CircleGeometry(r, 16), mat(c), 0, 1.0, 0.152 + (0.5 - r) * 0.002);
    g.add(ring);
  }
  for (const s of [-1, 1]) {
    const leg = mesh(new THREE.BoxGeometry(0.08, 1.6, 0.08), mat(0x6a4a30), s * 0.4, 0.75, -0.25);
    leg.rotation.x = 0.25;
    g.add(leg);
  }
  return g;
}

export function table(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(1.4, 0.07, 0.7), mat(0x8a6a44), 0, 0.78, 0));
  for (const x of [-0.6, 0.6]) for (const z of [-0.28, 0.28]) g.add(mesh(new THREE.BoxGeometry(0.07, 0.76, 0.07), mat(0x6a4a30), x, 0.38, z));
  g.add(mesh(new THREE.SphereGeometry(0.16, 7, 5).scale(1.3, 0.45, 1), mat(0xe8d8b0), 0, 0.86, 0.0));
  return g;
}

export function bench(len = 1.6, h = 0.45): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(len, 0.06, 0.32), mat(0x8a6a44), 0, h, 0));
  for (const x of [-len / 2 + 0.12, len / 2 - 0.12]) g.add(mesh(new THREE.BoxGeometry(0.08, h, 0.26), mat(0x6a4a30), x, h / 2, 0));
  return g;
}

export function stool(h = 0.3): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.CylinderGeometry(0.16, 0.16, 0.05, 8), mat(0x8a6a44), 0, h, 0));
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2;
    g.add(mesh(new THREE.CylinderGeometry(0.02, 0.025, h, 4), mat(0x6a4a30), Math.cos(a) * 0.1, h / 2, Math.sin(a) * 0.1));
  }
  return g;
}

/** A patch of standing wheat (instanced stalks). */
export function wheatPatch(w: number, d: number, density = 70, cut = 0): THREE.Group {
  const g = new THREE.Group();
  const n = Math.round(w * d * density);
  const geo = new THREE.ConeGeometry(0.035, 0.95, 3);
  geo.translate(0, 0.47, 0);
  const inst = new THREE.InstancedMesh(geo, mat(0xd8b85a), n);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3(), e = new THREE.Euler();
  let k = 0;
  for (let i = 0; i < n; i++) {
    const x = (Math.random() - 0.5) * w, z = (Math.random() - 0.5) * d;
    const stubble = z < -d / 2 + cut;
    e.set((Math.random() - 0.5) * 0.25, Math.random() * 3, (Math.random() - 0.5) * 0.25);
    q.setFromEuler(e);
    const h = stubble ? 0.12 : 0.85 + Math.random() * 0.3;
    s.set(1, h, 1);
    p.set(x, 0, z);
    m.compose(p, q, s);
    inst.setMatrixAt(k++, m);
  }
  inst.count = k;
  inst.castShadow = true; inst.receiveShadow = true;
  g.add(inst);
  return g;
}

export function fence(len: number): THREE.Group {
  const g = new THREE.Group();
  const posts = Math.max(2, Math.round(len / 1.8) + 1);
  for (let i = 0; i < posts; i++) {
    const x = -len / 2 + (i / (posts - 1)) * len;
    g.add(mesh(new THREE.BoxGeometry(0.1, 1.1, 0.1), mat(0x6a4a30), x, 0.55, 0));
  }
  for (const y of [0.45, 0.9]) g.add(mesh(new THREE.BoxGeometry(len, 0.07, 0.05), mat(0x7a5a38), 0, y, 0));
  return g;
}

export function trough(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(1.4, 0.35, 0.45), mat(0x7a5a38), 0, 0.3, 0));
  g.add(mesh(new THREE.BoxGeometry(1.3, 0.05, 0.36), mat(0x9a8a4a), 0, 0.45, 0));
  return g;
}

export function sawhorse(): THREE.Group {
  const g = new THREE.Group();
  g.add(mesh(new THREE.BoxGeometry(1.6, 0.12, 0.25), mat(0xb08a5a), 0, 0.72, 0));
  for (const x of [-0.6, 0.6]) for (const s of [-1, 1]) {
    const l = mesh(new THREE.BoxGeometry(0.06, 0.75, 0.06), mat(0x6a4a30), x, 0.35, s * 0.12);
    l.rotation.x = s * 0.3;
    g.add(l);
  }
  return g;
}

export function rockPile(): THREE.Group {
  const g = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const r = 0.25 + Math.random() * 0.3;
    g.add(mesh(new THREE.DodecahedronGeometry(r, 0), mat(0x8d8a83), (Math.random() - 0.5) * 1.2, r * 0.6, (Math.random() - 0.5) * 1.0));
  }
  return g;
}

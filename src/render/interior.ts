// Interiors: when the player goes inside a building, the renderer draws its room instead of the world. A room is made
// from the building kind (and level): plank or flagstone floor, plastered or stone walls with the door and windows,
// roof beams, a hearth that lights the room, and the furniture of its use — a cottage's bed, table and chest; the lord's
// hall with its high table, dais and hangings; the smithy's forge and anvil; the church's nave of pews and its altar; the
// alehouse's barrels and benches. People inside are drawn by the same character layer as outside. The camera looks into
// the room from above the door, the way a stage is seen.
import * as THREE from 'three';
import { BUILDINGS, type BuildingKind } from '../content/types';
import type { AssetLibrary, CharacterLayer, PropKind } from '../assets/types';
import type { CharacterDrawItem } from '../core/view';

export interface InteriorSpec {
  kind: BuildingKind;
  level: number;
  seed: number;
}

/** The room's inner size (metres) and what kind of room it is. */
export interface RoomLayout {
  w: number;
  d: number;
  /** Where people stand or sit (local metres), for the controller to place occupants. */
  spots: Array<{ x: number; z: number; yaw: number; sit?: number }>;
  /** Beds (local) for sleeping. */
  beds: Array<{ x: number; z: number }>;
  /** Furniture blocks the player walks round (local, axis-aligned half sizes). */
  solids: Array<{ x: number; z: number; hw: number; hd: number }>;
}

type Style = 'home' | 'hall' | 'smithy' | 'workshop' | 'church' | 'tavern' | 'barn';
const STYLE: Partial<Record<BuildingKind, Style>> = {
  hovel: 'home', cottage: 'home', longhouse: 'home', townhouse: 'home',
  manor_house: 'hall', great_hall: 'hall', keep_stone: 'hall',
  smithy: 'smithy', bloomery: 'smithy',
  carpenter: 'workshop', weaver: 'workshop', tannery: 'workshop', bakehouse: 'workshop', brewhouse: 'workshop', school: 'workshop', library: 'workshop', guildhall: 'hall',
  church: 'church', chapel: 'church', abbey_church: 'church', cathedral: 'church', infirmary: 'church',
  alehouse: 'tavern', tavern: 'tavern',
  barn: 'barn', tithe_barn: 'barn', granary: 'barn', stable: 'barn', cowshed: 'barn', warehouse: 'barn',
};

export function hasInterior(kind: BuildingKind): boolean { return !!STYLE[kind]; }

/** The layout of a room (pure: the controller uses it without a renderer). */
export function roomLayout(spec: InteriorSpec): RoomLayout {
  const def = BUILDINGS[spec.kind];
  const style = STYLE[spec.kind] ?? 'home';
  // the room fills the footprint less the walls; halls grow with their level
  const grow = style === 'hall' ? 1 + 0.15 * (Math.max(1, spec.level) - 1) : 1;
  const w = Math.max(4, def.w * grow - 1), d = Math.max(3.5, def.d * grow - 1);
  const spots: RoomLayout['spots'] = [];
  const beds: RoomLayout['beds'] = [];
  const solids: RoomLayout['solids'] = [];
  const hw = w / 2, hd = d / 2;
  switch (style) {
    case 'home': {
      // a small room keeps its hearth against the back wall, out of the way to the door
      const small = d < 5;
      solids.push({ x: 0, z: -hd + (small ? 0.5 : 0.9), hw: small ? 0.6 : 0.8, hd: small ? 0.4 : 0.6 }); // hearth
      if (!small) {
        solids.push({ x: hw - 1.6, z: 0, hw: 0.9, hd: 0.55 }); // table
        spots.push({ x: hw - 1.6, z: -1.1, yaw: 0, sit: 0.45 }, { x: hw - 1.6, z: 1.1, yaw: Math.PI, sit: 0.45 });
      }
      beds.push({ x: -hw + 1.1, z: -hd + 1.3 });
      // a pallet in a hovel, a bed in a cottage
      solids.push({ x: -hw + 1.1, z: -hd + 1.3, hw: 0.7, hd: Math.min(1.05, hd - 0.9) });
      spots.push({ x: 0.9, z: -hd + (small ? 1.3 : 2.2), yaw: Math.PI }, small ? { x: 1.2, z: 0.4, yaw: -Math.PI / 2 } : { x: -0.6, z: Math.min(0.9, hd - 1.8), yaw: Math.PI / 2 });
      break;
    }
    case 'hall':
      solids.push({ x: 0, z: -hd + 2.2, hw: Math.min(3.5, hw - 1.5), hd: 0.55 }); // high table on the dais
      solids.push({ x: 0, z: 0.8, hw: 0.6, hd: Math.min(4, hd - 3.5) }); // long table down the hall
      solids.push({ x: hw - 1.2, z: 0, hw: 0.8, hd: 1.0 }); // great hearth on the side wall
      spots.push({ x: 0, z: -hd + 1.3, yaw: 0, sit: 0.75 }); // the lord's chair
      spots.push({ x: -1.6, z: -hd + 1.4, yaw: 0, sit: 0.5 }, { x: 1.6, z: -hd + 1.4, yaw: 0, sit: 0.5 });
      for (let i = 0; i < 4; i++) spots.push({ x: i % 2 ? 1.1 : -1.1, z: -1 + i * 1.3, yaw: i % 2 ? -Math.PI / 2 : Math.PI / 2, sit: 0.45 });
      spots.push({ x: -hw + 1.2, z: 1.5, yaw: Math.PI / 2 }, { x: -hw + 1.2, z: -1.5, yaw: Math.PI / 2 });
      beds.push({ x: -hw + 1.3, z: -hd + 1.4 });
      break;
    case 'smithy':
      solids.push({ x: -hw + 1.3, z: -hd + 1.2, hw: 1.0, hd: 0.8 }); // forge
      solids.push({ x: 0.3, z: -0.2, hw: 0.35, hd: 0.25 }); // anvil
      spots.push({ x: 0.3, z: 0.6, yaw: Math.PI }, { x: hw - 1.2, z: 0.5, yaw: -Math.PI / 2 });
      break;
    case 'workshop':
      solids.push({ x: 0, z: -hd + 0.9, hw: Math.min(2, hw - 1), hd: 0.45 }); // bench
      spots.push({ x: -0.8, z: -hd + 1.7, yaw: Math.PI }, { x: 0.8, z: -hd + 1.7, yaw: Math.PI });
      break;
    case 'church':
      solids.push({ x: 0, z: -hd + 1.0, hw: 1.0, hd: 0.45 }); // altar
      for (let r = 0; r < Math.min(6, Math.floor((d - 5) / 1.4)); r++) {
        const z = -hd + 3.4 + r * 1.4;
        solids.push({ x: -1.7, z, hw: 1.1, hd: 0.25 }, { x: 1.7, z, hw: 1.1, hd: 0.25 });
        spots.push({ x: r % 2 ? 1.7 : -1.7, z: z + 0.45, yaw: Math.PI, sit: 0.45 });
      }
      spots.unshift({ x: 0, z: -hd + 2.0, yaw: Math.PI }); // the priest
      break;
    case 'tavern':
      solids.push({ x: -hw + 0.8, z: -0.4, hw: 0.5, hd: Math.min(2.2, hd - 1.4) }); // barrels on the wall
      solids.push({ x: hw - 1.6, z: -0.6, hw: 1.0, hd: 0.5 }, { x: hw - 1.6, z: Math.min(1.8, hd - 1.7), hw: 1.0, hd: 0.5 });
      spots.push({ x: hw - 1.6, z: -1.4, yaw: 0, sit: 0.45 }, { x: hw - 1.6, z: 0.2, yaw: Math.PI, sit: 0.45 }, { x: -hw + 1.7, z: -0.4, yaw: -Math.PI / 2 });
      break;
    case 'barn':
      solids.push({ x: -hw + 1.0, z: -0.5, hw: 0.7, hd: Math.min(3, hd - 1.5) }); // hay and sacks
      spots.push({ x: 0.5, z: 0, yaw: -Math.PI / 2 });
      break;
  }
  return { w, d, spots, beds, solids };
}

const mat = (color: number, rough = 0.9, emissive = 0): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({ color, roughness: rough, metalness: 0, ...(emissive ? { emissive: color, emissiveIntensity: emissive } : {}) });

export class InteriorScene {
  readonly scene = new THREE.Scene();
  readonly camera = new THREE.PerspectiveCamera(55, 1, 0.1, 200);
  private room = new THREE.Group();
  private readonly chars: CharacterLayer;
  private fire: THREE.PointLight | null = null;
  private flicker = 0;
  private spec: InteriorSpec | null = null;
  layout: RoomLayout | null = null;

  constructor(private readonly assets: AssetLibrary) {
    this.scene.background = new THREE.Color(0x0d0905);
    // warm indoor light: a soft fill everywhere, daylight from the door and windows, the hearth flickering
    this.scene.add(new THREE.AmbientLight(0xffe6c0, 0.7));
    this.scene.add(new THREE.HemisphereLight(0xfff0d8, 0x3a2a18, 0.9));
    const day = new THREE.DirectionalLight(0xfff2d6, 1.2);
    day.position.set(2, 6, 9);
    this.scene.add(day);
    this.scene.add(this.room);
    this.chars = assets.createCharacterLayer();
    this.scene.add(this.chars.object);
  }

  get active(): boolean { return this.spec !== null; }

  open(spec: InteriorSpec | null): void {
    this.spec = spec;
    this.scene.remove(this.room);
    this.room.traverse((o) => { const m = o as THREE.Mesh; if (m.geometry && !(m.userData.shared)) m.geometry.dispose(); });
    this.room = new THREE.Group();
    this.scene.add(this.room);
    this.fire = null;
    this.layout = spec ? roomLayout(spec) : null;
    if (spec && this.layout) this.build(spec, this.layout);
  }

  private prop(kind: PropKind, x: number, z: number, yaw = 0, scale = 1): void {
    try {
      const o = this.assets.prop(kind, 1);
      o.position.set(x, 0, z); o.rotation.y = yaw; o.scale.setScalar(scale);
      o.traverse((c) => { c.userData.shared = true; });
      this.room.add(o);
    } catch { /* a prop the library lacks: the room does without it */ }
  }

  private box(w: number, h: number, d: number, color: number, x: number, y: number, z: number, emissive = 0): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat(color, 0.9, emissive));
    m.position.set(x, y, z);
    this.room.add(m);
    return m;
  }

  private build(spec: InteriorSpec, L: RoomLayout): void {
    const style = STYLE[spec.kind] ?? 'home';
    const stone = style === 'church' || style === 'hall' && (spec.kind !== 'manor_house' || spec.level >= 3) || spec.kind === 'keep_stone';
    const hw = L.w / 2, hd = L.d / 2;
    const wallH = style === 'church' ? 7 : style === 'hall' ? 5.5 : style === 'barn' ? 5 : 3.2;
    const wall = stone ? 0x9a9182 : 0xd9ccb0;
    const floor = style === 'church' || stone ? 0x6f685e : style === 'barn' ? 0x7a6243 : 0x5a4a3a;
    // floor
    this.box(L.w + 0.6, 0.1, L.d + 0.6, floor, 0, -0.05, 0);
    if (style === 'barn') for (let i = 0; i < 30; i++) this.box(0.6, 0.02, 0.3, 0xc9b26a, ((i * 37) % 100) / 100 * L.w - hw, 0.01, ((i * 61) % 100) / 100 * L.d - hd);
    // walls: back, sides, and the door wall in two pieces round the door
    const t = 0.3;
    this.box(L.w + 0.6, wallH, t, wall, 0, wallH / 2, -hd - t / 2);
    this.box(t, wallH, L.d + 0.6, wall, -hw - t / 2, wallH / 2, 0);
    this.box(t, wallH, L.d + 0.6, wall, hw + t / 2, wallH / 2, 0);
    const door = 1.3;
    this.box(hw - door / 2 + 0.3, wallH, t, wall, -(hw + door / 2) / 2 - 0.15, wallH / 2, hd + t / 2);
    this.box(hw - door / 2 + 0.3, wallH, t, wall, (hw + door / 2) / 2 + 0.15, wallH / 2, hd + t / 2);
    this.box(door, wallH - 2.2, t, wall, 0, 2.2 + (wallH - 2.2) / 2, hd + t / 2);
    // daylight through the door and the windows
    this.box(door - 0.1, 2.15, 0.05, 0xfff1c8, 0, 1.08, hd + t + 0.02, 0.9);
    for (const sx of [-1, 1]) this.box(0.05, 0.8, 0.6, 0xfff1c8, sx * (hw + t / 2 + 0.01), 1.9, -hd / 3, 0.8);
    // timber: posts and roof beams
    const timber = 0x4a3220;
    for (const [x, z] of [[-hw, -hd], [hw, -hd], [-hw, hd], [hw, hd]]) this.box(0.25, wallH, 0.25, timber, x, wallH / 2, z);
    for (let z = -hd + 1; z < hd; z += 2.2) this.box(L.w + 0.6, 0.22, 0.22, timber, 0, wallH - 0.1, z);
    // the furniture of its use
    const fireAt = (x: number, z: number, big = false): void => {
      this.box(big ? 1.8 : 1.3, 0.35, big ? 1.4 : 1.0, 0x6b6159, x, 0.17, z);
      this.box(big ? 1.0 : 0.6, 0.25, big ? 0.6 : 0.4, 0xff8a2a, x, 0.45, z, 2.2);
      const l = new THREE.PointLight(0xff9a4a, big ? 60 : 36, big ? 22 : 14, 1.2);
      l.position.set(x, 1.2, z);
      this.room.add(l);
      this.fire = l;
    };
    switch (style) {
      case 'home': {
        const small = L.d < 5;
        fireAt(0, -hd + (small ? 0.5 : 0.9));
        if (!small) {
          this.prop('table', hw - 1.6, 0, Math.PI / 2);
          this.prop('bench', hw - 1.6, -1.1, Math.PI / 2, 0.9);
          this.prop('bench', hw - 1.6, 1.1, Math.PI / 2, 0.9);
        }
        this.bed(L.beds[0].x, L.beds[0].z, Math.min(2.0, (L.d / 2 - 0.9) * 2));
        this.box(0.9, 0.5, 0.5, 0x5b3a22, -hw + 0.6, 0.25, hd - 0.9); // chest
        this.prop('barrel', hw - 0.6, -hd + 0.6);
        this.prop('sack_pile', hw - 0.7, hd - 0.9);
        this.prop('cauldron', 0.7, -hd + 0.9, 0, 0.8);
        if (spec.kind !== 'hovel') this.prop('loom', -hw + 0.9, 1.0, Math.PI / 2, 0.9);
        break;
      }
      case 'hall': {
        this.box(Math.min(8, L.w - 2), 0.35, 2.6, 0x5a4330, 0, 0.17, -hd + 1.6); // dais
        this.box(Math.min(7, L.w - 3), 0.8, 1.0, 0x4e3420, 0, 0.75, -hd + 2.2); // high table
        this.box(0.9, 1.9, 0.8, 0x6d2f1e, 0, 1.25, -hd + 0.9); // the lord's chair
        this.box(1.2, 0.8, Math.min(8, L.d - 7), 0x4e3420, 0, 0.4, 0.8); // long table
        for (const sx of [-1, 1]) this.box(0.4, 0.45, Math.min(8, L.d - 7), 0x4e3420, sx * 1.1, 0.22, 0.8); // benches
        fireAt(hw - 1.2, 0, true);
        // hangings in the House's red and gold
        for (let i = -1; i <= 1; i++) this.box(1.6, 2.6, 0.05, i === 0 ? 0xa3241a : 0x1f3f8a, i * 2.6, wallH - 2, -hd + 0.03);
        this.prop('banner_pole', -hw + 0.8, -hd + 0.8);
        this.prop('banner_pole', hw - 0.8, -hd + 0.8);
        this.prop('barrel', -hw + 0.7, hd - 1.2);
        this.prop('crate', -hw + 0.8, hd - 2.4);
        this.bed(L.beds[0].x, L.beds[0].z);
        break;
      }
      case 'smithy':
        fireAt(-hw + 1.3, -hd + 1.2, true);
        this.prop('anvil', 0.3, -0.2);
        this.prop('grindstone', hw - 1.0, -hd + 1.0);
        this.prop('barrel', hw - 0.7, hd - 0.8);
        this.prop('crate', -hw + 0.8, hd - 0.8);
        break;
      case 'workshop':
        this.box(Math.min(4, L.w - 2), 0.85, 0.9, 0x6a4a2c, 0, 0.42, -hd + 0.9);
        this.prop('plank_pile', hw - 1.0, hd - 1.0, 0, 0.8);
        this.prop(spec.kind === 'weaver' ? 'loom' : 'barrel', -hw + 1.0, 0.5);
        this.prop('sack_pile', hw - 0.8, -0.5);
        fireAt(-hw + 0.9, hd - 1.0);
        break;
      case 'church': {
        this.box(2.0, 1.0, 0.9, 0xe8e0cc, 0, 0.5, -hd + 1.0); // altar
        this.box(0.12, 1.1, 0.12, 0xd4af37, 0, 1.55, -hd + 1.0, 0.4); // cross
        this.box(0.6, 0.12, 0.12, 0xd4af37, 0, 1.85, -hd + 1.0, 0.4);
        for (let r = 0; r < Math.min(6, Math.floor((L.d - 5) / 1.4)); r++) {
          const z = -hd + 3.4 + r * 1.4;
          for (const sx of [-1, 1]) this.box(2.2, 0.45, 0.45, 0x5b3d26, sx * 1.7, 0.22, z);
        }
        for (const sx of [-1, 1]) this.box(0.05, 2.2, 0.9, 0x6a8fd0, sx * (hw + 0.16), 3.6, -hd / 2, 0.6); // glass
        const l = new THREE.PointLight(0xfff0d0, 14, 16, 1.6); l.position.set(0, 3, -hd + 2); this.room.add(l);
        break;
      }
      case 'tavern':
        fireAt(0, -hd + 0.9);
        for (let i = 0; i < Math.min(4, Math.floor((L.d - 2) / 1.1)); i++) this.prop('barrel', -hw + 0.7, -hd + 1.2 + i * 1.1);
        this.prop('table', hw - 1.6, -0.6, Math.PI / 2); this.prop('table', hw - 1.6, Math.min(1.8, hd - 1.7), Math.PI / 2);
        for (const z of [-1.4, 0.2]) this.prop('bench', hw - 1.6, z, Math.PI / 2, 0.85);
        break;
      case 'barn':
        this.prop('haystack', -hw + 1.0, -0.5, 0, 0.7);
        this.prop('sack_pile', -hw + 1.2, hd - 1.2);
        this.prop('crate', hw - 1.0, -hd + 1.0);
        this.prop('cart', hw - 2.0, 1.0, Math.PI / 2, 0.85);
        break;
    }
    // a lamp at dusk for rooms without a fire
    if (!this.fire && style !== 'church') {
      const l = new THREE.PointLight(0xffd090, 10, 12, 1.6); l.position.set(0, wallH - 0.8, 0); this.room.add(l);
    }
  }

  private bed(x: number, z: number, len = 2.0): void {
    const k = len / 2;
    this.box(1.3, 0.35, len, 0x5b3a22, x, 0.18, z);
    this.box(1.2, 0.18, len - 0.1, 0xb9a17a, x, 0.44, z);
    this.box(1.15, 0.08, len * 0.6, 0x7b2d26, x, 0.56, z + 0.3 * k);
    this.box(0.9, 0.14, 0.4, 0xece2c8, x, 0.6, z - 0.7 * k);
  }

  /** Draws the room with the people in it, seen from `eye` towards `at`. */
  render(r: THREE.WebGLRenderer, chars: readonly CharacterDrawItem[], eye: THREE.Vector3Like, at: THREE.Vector3Like, dt: number): void {
    const el = r.domElement;
    const aspect = el.clientWidth / Math.max(1, el.clientHeight);
    if (Math.abs(this.camera.aspect - aspect) > 1e-3) { this.camera.aspect = aspect; this.camera.updateProjectionMatrix(); }
    this.camera.position.set(eye.x, eye.y, eye.z);
    this.camera.lookAt(at.x, at.y, at.z);
    this.camera.updateMatrixWorld();
    if (this.fire) {
      this.flicker += dt;
      this.fire.intensity = this.fire.userData.base ?? (this.fire.userData.base = this.fire.intensity);
      this.fire.intensity = (this.fire.userData.base as number) * (0.88 + 0.12 * Math.sin(this.flicker * 9.1) * Math.sin(this.flicker * 3.7 + 1));
    }
    this.chars.update(chars, dt, this.camera);
    r.render(this.scene, this.camera);
  }

  pick(raycaster: THREE.Raycaster): number { return this.chars.pick(raycaster); }
}

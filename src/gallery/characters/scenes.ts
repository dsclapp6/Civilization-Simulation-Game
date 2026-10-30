// Gallery scenes: actors (draw items + behaviour), props, labels and default cameras.
import * as THREE from 'three';
import type { AnimalKind, CultureId, RankTier, Sex } from '../../core/domain';
import { CULTURES, RANK_NAMES } from '../../core/domain';
import type { AnimalAnim, AnimalDrawItem, AnimState, BackLook, CarryLook, CharacterDrawItem, CharacterLook, HeldItem, HorseAnim } from '../../core/view';
import { Rng } from '../../core/rng';
import { armLook, generateLook, heraldryFor, type Role } from '../../assets/characters/looks';
import { DEFAULT_COAT } from '../../assets/animals/kinds';
import * as P from './props';

export interface CharActor { item: CharacterDrawItem; tick?: (t: number, dt: number) => void; subject?: boolean }
export interface AnimalActor { item: AnimalDrawItem; tick?: (t: number, dt: number) => void; subject?: boolean }
export interface Label { text: string; x: number; y: number; z: number; small?: boolean }
export interface SceneDef {
  name: string;
  chars: CharActor[];
  animals: AnimalActor[];
  props: THREE.Object3D[];
  labels: Label[];
  camera: { pos: [number, number, number]; target: [number, number, number] };
  shadow: { x: number; z: number; r: number };
}

export interface SceneOptions {
  seed: number;
  anim?: AnimState | '';
  armour?: boolean;
  items?: boolean;
  gait?: HorseAnim;
  animalAnim?: AnimalAnim | '';
  count?: number;
  animals?: number;
  /** solo scene: subject description (URL params). */
  solo?: { tier: RankTier; sex: Sex; age: number; culture: CultureId; animal?: AnimalKind; main?: HeldItem; off?: HeldItem; arm?: 'levy' | 'archer' | 'crossbow' | 'man_at_arms' | 'knight'; speed?: number; yaw?: number };
}

let nextId = 1;
export function resetIds(): void { nextId = 1; }

export function makeChar(look: CharacterLook, x: number, z: number, yaw = 0, extra: Partial<CharacterDrawItem> = {}): CharacterDrawItem {
  return {
    id: nextId++, x, y: 0, z, yaw, look, lookVersion: 1,
    mainHand: 'none', offHand: 'none', back: 'none', carry: 'none',
    anim: 'idle', animTime: 0, moveSpeed: 0, highlight: 0, ...extra,
  };
}

export function makeAnimal(kind: AnimalKind, x: number, z: number, yaw = 0, extra: Partial<AnimalDrawItem> = {}): AnimalDrawItem {
  return { id: 100000 + nextId++, kind, x, y: 0, z, yaw, anim: 'idle', animTime: 0, moveSpeed: 0, scale: 1, coat: DEFAULT_COAT[kind], highlight: 0, ...extra };
}

/** Advance animTime every frame. */
function clock(item: { animTime: number }): (t: number, dt: number) => void {
  return (_t, dt) => { item.animTime += dt; };
}

const WORK_ITEMS: Partial<Record<AnimState, { main?: HeldItem; off?: HeldItem; carry?: CarryLook; back?: BackLook }>> = {
  work_hoe: { main: 'hoe' }, work_scythe: { main: 'scythe' }, work_sickle: { main: 'sickle' }, work_sow: { off: 'sack' },
  work_hammer: { main: 'hammer', off: 'tongs' }, work_axe: { main: 'axe' }, work_pick: { main: 'pick' }, work_saw: { main: 'saw' },
  work_dig: { main: 'spade' }, work_stir: { main: 'ladle' }, work_lift: { carry: 'sack' }, work_spin: { main: 'distaff' },
  attack_slash: { main: 'sword', off: 'shield_heater' }, attack_overhead: { main: 'war_axe' }, attack_thrust: { main: 'spear' },
  block: { main: 'sword', off: 'shield_heater' }, dodge: { main: 'sword', off: 'shield_round' },
  draw_bow: { main: 'longbow', back: 'quiver' }, aim_bow: { main: 'longbow', back: 'quiver' }, shoot_bow: { main: 'longbow', back: 'quiver' },
  aim_crossbow: { main: 'crossbow', back: 'quiver' }, shoot_crossbow: { main: 'crossbow', back: 'quiver' }, reload_crossbow: { main: 'crossbow', back: 'quiver' },
  drink: { main: 'cup' }, carry_walk: { carry: 'bundle_wood' }, ride_charge: { main: 'lance', off: 'shield_heater' },
};

export const ALL_ANIMS: AnimState[] = [
  'idle', 'walk', 'run', 'sprint', 'carry_walk', 'sit', 'sleep', 'talk', 'eat', 'drink', 'pray', 'wave', 'kneel',
  'work_hoe', 'work_scythe', 'work_sickle', 'work_sow', 'work_hammer', 'work_axe', 'work_pick', 'work_saw', 'work_dig',
  'work_stir', 'work_lift', 'work_spin', 'work_knead', 'work_milk',
  'attack_slash', 'attack_overhead', 'attack_thrust', 'block', 'dodge',
  'draw_bow', 'aim_bow', 'shoot_bow', 'aim_crossbow', 'shoot_crossbow', 'reload_crossbow',
  'hit', 'stagger', 'fall', 'dead',
  'ride_idle', 'ride_walk', 'ride_trot', 'ride_gallop', 'ride_charge', 'mount', 'dismount',
];
export const ALL_ANIMAL_ANIMS: AnimalAnim[] = ['idle', 'graze', 'walk', 'trot', 'run', 'lie', 'sleep', 'eat', 'attack', 'hit', 'dead'];
export const ALL_KINDS: AnimalKind[] = ['horse', 'ox', 'cow', 'sheep', 'pig', 'goat', 'chicken', 'goose', 'dog', 'cat', 'deer', 'boar', 'wolf', 'fox', 'hare'];

function equipFor(item: CharacterDrawItem, anim: AnimState): void {
  const w = WORK_ITEMS[anim];
  if (!w) return;
  if (w.main) item.mainHand = w.main;
  if (w.off) item.offHand = w.off;
  if (w.carry) item.carry = w.carry;
  if (w.back) item.back = w.back;
}

function applyAnim(item: CharacterDrawItem, anim: AnimState): void {
  item.anim = anim;
  item.animTime = 0;
  item.moveSpeed = anim === 'walk' || anim === 'carry_walk' || anim === 'work_sow' ? 1.3 : anim === 'run' ? 3.4 : anim === 'sprint' ? 6.2 : 0;
  if (anim.startsWith('ride_') || anim === 'mount' || anim === 'dismount') {
    item.mount = { coat: 0x6a4026, anim: anim === 'ride_walk' ? 'walk' : anim === 'ride_trot' ? 'trot' : anim === 'ride_gallop' || anim === 'ride_charge' ? 'gallop' : 'idle', animTime: 0 };
    item.moveSpeed = anim === 'ride_walk' ? 1.7 : anim === 'ride_trot' ? 4 : anim === 'ride_gallop' ? 10 : anim === 'ride_charge' ? 12 : 0;
  }
}

// ------------------------------------------------------------------------------------------------ lineup
export function lineupScene(o: SceneOptions): SceneDef {
  resetIds();
  const rng = new Rng(`lineup-${o.seed}`);
  const chars: CharActor[] = [];
  const labels: Label[] = [];
  const spacing = 2.5;
  for (let tier = 1 as RankTier; tier <= 8; tier = (tier + 1) as RankTier) {
    const cx = (tier - 4.5) * spacing;
    const culture: CultureId = CULTURES[(tier + o.seed) % CULTURES.length];
    const man = generateLook(rng, { tier, sex: 'm', age: 28 + rng.int(0, 12), culture });
    const woman = generateLook(rng, { tier, sex: 'f', age: 24 + rng.int(0, 12), culture });
    const third: CharacterLook = tier % 2 === 0
      ? generateLook(rng, { tier, sex: rng.chance(0.5) ? 'm' : 'f', age: 7 + rng.int(0, 5), culture })
      : generateLook(rng, { tier, sex: rng.chance(0.5) ? 'm' : 'f', age: 66 + rng.int(0, 8), culture });
    if (tier === 5 && o.armour !== false) armLook(rng, man, 'knight');
    const m = makeChar(man, cx - 0.5, 0, 0);
    const f = makeChar(woman, cx + 0.5, 0.05, 0);
    const c = makeChar(third, cx, 1.05, 0);
    if (o.items !== false) {
      if (tier === 1) { m.mainHand = 'hoe'; f.carry = 'basket'; }
      if (tier === 2) { m.mainHand = 'spade'; f.mainHand = 'bucket'; }
      if (tier === 3) { m.mainHand = 'hammer'; }
      if (tier === 4) { m.mainHand = 'staff'; }
      if (tier === 5) { m.mainHand = 'sword'; m.offHand = 'shield_heater'; }
      if (tier === 6) { m.mainHand = 'sword'; }
      if (tier === 7) { m.mainHand = 'staff'; }
      if (tier === 8) { m.mainHand = 'sword'; }
      if (third.age > 60) c.mainHand = 'staff';
    }
    for (const it of [m, f, c]) {
      if (o.anim) { applyAnim(it, o.anim); if (o.items !== false) equipFor(it, o.anim); }
      chars.push({ item: it, tick: clock(it), subject: true });
    }
    labels.push({ text: `${tier} · ${RANK_NAMES[tier]}`, x: cx, y: 2.25, z: 0 });
    labels.push({ text: culture, x: cx, y: 2.05, z: 0, small: true });
  }
  return {
    name: 'lineup', chars, animals: [], props: [], labels,
    camera: { pos: [0, 2.6, 15.5], target: [0, 0.95, 0.3] },
    shadow: { x: 0, z: 0, r: 13 },
  };
}

// ------------------------------------------------------------------------------------------------ close-up faces
export function facesScene(o: SceneOptions): SceneDef {
  resetIds();
  const rng = new Rng(`faces-${o.seed}`);
  const specs: { tier: RankTier; sex: Sex; age: number; culture: CultureId; role?: Role; hair?: number; beard?: number; head?: CharacterLook['clothing']['headwear'] }[] = [
    { tier: 1, sex: 'f', age: 19, culture: 'anglo', hair: 4, head: 'none' },
    { tier: 2, sex: 'm', age: 45, culture: 'norse', beard: 4, hair: 3, head: 'none' },
    { tier: 3, sex: 'm', age: 34, culture: 'franc', role: 'monk' },
    { tier: 4, sex: 'f', age: 30, culture: 'anglo', head: 'wimple' },
    { tier: 2, sex: 'm', age: 9, culture: 'gael', hair: 1, head: 'none' },
    { tier: 6, sex: 'm', age: 52, culture: 'teuton', beard: 2, head: 'felt_hat' },
    { tier: 1, sex: 'f', age: 70, culture: 'cymric', head: 'coif' },
    { tier: 8, sex: 'm', age: 40, culture: 'anglo', beard: 3, head: 'crown' },
  ];
  const chars: CharActor[] = [];
  specs.forEach((s, i) => {
    const look = generateLook(rng, { tier: s.tier, sex: s.sex, age: s.age, culture: s.culture, role: s.role });
    if (s.hair !== undefined) look.hairStyle = s.hair;
    if (s.beard !== undefined) look.beard = s.beard;
    if (s.head !== undefined) look.clothing.headwear = s.head;
    const x = (i - 3.5) * 0.85;
    const it = makeChar(look, x, 0, 0, { anim: o.anim || 'idle' });
    chars.push({ item: it, tick: clock(it), subject: true });
  });
  return {
    name: 'faces', chars, animals: [], props: [], labels: [],
    camera: { pos: [0, 1.62, 4.2], target: [0, 1.35, 0] },
    shadow: { x: 0, z: 0, r: 6 },
  };
}

// ------------------------------------------------------------------------------------------------ every animation
export function animsScene(o: SceneOptions): SceneDef {
  resetIds();
  const rng = new Rng(`anims-${o.seed}`);
  const chars: CharActor[] = [];
  const labels: Label[] = [];
  const cols = ANIM_COLS;
  const props: THREE.Object3D[] = [];
  VIGNETTES.length = 0;
  ALL_ANIMS.forEach((anim, i) => {
    const col = i % cols, row = Math.floor(i / cols);
    const x = (col - (cols - 1) / 2) * ANIM_DX, z = -row * ANIM_DZ;
    const tier = ((i % 5) + 1) as RankTier;
    const look = generateLook(rng, { tier, sex: i % 3 === 0 ? 'f' : 'm', age: 30, culture: CULTURES[i % 6] });
    if (anim.startsWith('attack') || anim === 'block' || anim === 'dodge') armLook(rng, look, 'man_at_arms');
    if (anim.startsWith('ride') || anim === 'mount' || anim === 'dismount') armLook(rng, look, 'knight');
    if (anim.includes('bow')) armLook(rng, look, 'archer');
    const it = makeChar(look, x, z, anim.includes('bow') ? 0 : 0.35, {});
    applyAnim(it, anim);
    equipFor(it, anim);
    it.moveSpeed = anim === 'walk' || anim === 'run' || anim === 'sprint' || anim === 'carry_walk' ? it.moveSpeed : 0;
    if (it.mount) { it.mount.animTime = 0; it.moveSpeed = 0; }
    if (anim === 'sit') it.seatHeight = 0.45;
    chars.push({ item: it, tick: (_t, dt) => { it.animTime += dt; if (it.mount) it.mount.animTime += dt; } });
    labels.push({ text: anim, x, y: 2.05, z, small: true });
    if (anim === 'sit') { const b = P.bench(0.9); b.position.set(x, 0, z - 0.1); b.rotation.y = 0.35; props.push(b); }
    if (anim === 'work_milk') { const s = P.stool(0.3); s.position.set(x, 0, z - 0.05); props.push(s); }
    if (anim === 'work_hammer') { const a = P.anvil(); a.position.set(x + Math.sin(0.35) * 0.56, 0, z + Math.cos(0.35) * 0.56); a.rotation.y = 0.35; props.push(a); }
    if (anim === 'work_knead') { const t = P.table(); t.position.set(x + Math.sin(0.35) * 0.62, 0, z + Math.cos(0.35) * 0.62); t.rotation.y = 0.35; props.push(t); }
    if (anim === 'work_stir') { const c = P.cauldron(); c.position.set(x + Math.sin(0.35) * 0.5, 0, z + Math.cos(0.35) * 0.5); props.push(c); }
  });
  const rows = Math.ceil(ALL_ANIMS.length / cols);
  for (let r = 0; r < rows; r++) {
    VIGNETTES.push({ name: `row${r}`, cam: { pos: [0, 1.55, -r * ANIM_DZ + 7.0], target: [0, 0.8, -r * ANIM_DZ] } });
  }
  return {
    name: 'anims', chars, animals: [], props, labels,
    camera: { pos: [0, 12, 16], target: [0, 0.6, -ANIM_DZ * 3] },
    shadow: { x: 0, z: -ANIM_DZ * 3, r: 26 },
  };
}
export const ANIM_COLS = 7;
export const ANIM_DX = 1.9;
export const ANIM_DZ = 9;

// ------------------------------------------------------------------------------------------------ riders
export function ridersScene(o: SceneOptions): SceneDef {
  resetIds();
  const rng = new Rng(`riders-${o.seed}`);
  const gait: HorseAnim = o.gait ?? 'walk';
  const riderAnim: AnimState = gait === 'walk' ? 'ride_walk' : gait === 'trot' ? 'ride_trot' : gait === 'gallop' ? 'ride_gallop' : 'ride_idle';
  const speed = gait === 'walk' ? 1.7 : gait === 'trot' ? 4 : gait === 'gallop' ? 10 : 0;
  const defs = [
    { tier: 5 as RankTier, kind: 'knight' as const, coat: 0xe8e4dc, barding: true, main: 'lance' as HeldItem, off: 'shield_heater' as HeldItem },
    { tier: 6 as RankTier, kind: 'noble' as const, coat: 0x3a2a20, barding: false, main: 'none' as HeldItem, off: 'none' as HeldItem },
    { tier: 3 as RankTier, kind: 'sergeant' as const, coat: 0x8a5a32, barding: false, main: 'spear' as HeldItem, off: 'shield_kite' as HeldItem },
    { tier: 4 as RankTier, kind: 'lady' as const, coat: 0xb8b0a0, barding: false, main: 'none' as HeldItem, off: 'none' as HeldItem },
  ];
  const chars: CharActor[] = [];
  defs.forEach((d, i) => {
    const look = generateLook(rng, { tier: d.tier, sex: d.kind === 'lady' ? 'f' : 'm', age: 32, culture: 'anglo' });
    if (d.kind === 'knight') armLook(rng, look, 'knight');
    if (d.kind === 'sergeant') armLook(rng, look, 'sergeant');
    const it = makeChar(look, (i - 1.5) * 3.2, 0, 0, { anim: riderAnim, mainHand: d.main, offHand: d.off });
    it.mount = { coat: d.coat, barding: d.barding ? look.heraldry?.field : undefined, anim: gait, animTime: 0 };
    it.moveSpeed = speed;
    chars.push({ item: it, tick: (_t, dt) => { it.animTime += dt; it.mount!.animTime += dt; }, subject: true });
  });
  return {
    name: 'riders', chars, animals: [], props: [], labels: [],
    camera: { pos: [7.5, 2.4, 8.5], target: [0, 1.2, 0] },
    shadow: { x: 0, z: 0, r: 10 },
  };
}

// ------------------------------------------------------------------------------------------------ action vignettes
export interface Vignette { name: string; cam: { pos: [number, number, number]; target: [number, number, number] } }
export const VIGNETTES: Vignette[] = [];

export function actionScene(o: SceneOptions): SceneDef {
  resetIds();
  const rng = new Rng(`action-${o.seed}`);
  const chars: CharActor[] = [];
  const animals: AnimalActor[] = [];
  const props: THREE.Object3D[] = [];
  const labels: Label[] = [];
  VIGNETTES.length = 0;
  const add = (it: CharacterDrawItem, tick?: (t: number, dt: number) => void): void => { chars.push({ item: it, tick: tick ?? clock(it) }); };
  const peasant = (sex: Sex = 'm', tier: RankTier = 2): CharacterLook => generateLook(rng, { tier, sex, age: 30, culture: 'anglo' });

  // 1. smith at the anvil (x 0, z 0)
  {
    const look = peasant('m', 3);
    look.clothing.apron = 0x5a3b26; look.clothing.headwear = 'none'; look.clothing.cloak = undefined; look.clothing.tunicStyle = 'short'; look.beard = 2; look.build = 0.8; look.hairStyle = 0; look.hair = 0x3a281c;
    const it = makeChar(look, 0, 0, 0, { anim: 'work_hammer', mainHand: 'hammer', offHand: 'tongs' });
    add(it);
    const a = P.anvil(); a.position.set(0.04, 0, 0.56); props.push(a);
    const f = P.forge(); f.position.set(-1.5, 0, -1.3); f.rotation.y = 0.5; props.push(f);
    VIGNETTES.push({ name: 'smith', cam: { pos: [-1.95, 1.65, 2.55], target: [0.0, 1.0, 0.3] } });
  }
  // 2. mower in the wheat (x 8)
  {
    const look = peasant('m', 1);
    look.clothing.headwear = 'straw_hat';
    const it = makeChar(look, 8, 0, 0, { anim: 'work_scythe', mainHand: 'scythe', animTime: 0.0 });
    add(it);
    const w = P.wheatPatch(4, 7, 60, 0); w.position.set(10.9, 0, 1.6); props.push(w);
    const st = P.wheatPatch(3.2, 7, 40, 7); st.position.set(7.3, 0, 1.6); props.push(st);
    const look2 = peasant('f', 1);
    const it2 = makeChar(look2, 10.3, 1.0, -0.4, { anim: 'work_sickle', mainHand: 'sickle', animTime: 0.4 });
    add(it2);
    VIGNETTES.push({ name: 'scythe', cam: { pos: [6.0, 1.75, 3.9], target: [8.5, 0.72, 0.6] } });
  }
  // 3. archers at the butts (x -8)
  {
    for (let i = 0; i < 2; i++) {
      const look = peasant('m', 2);
      armLook(rng, look, 'archer');
      look.clothing.headwear = i === 0 ? 'hood' : 'none';
      look.helmet = i === 0 ? 'none' : 'kettle';
      const it = makeChar(look, -8 - i * 1.5, i * 0.4, 0, { anim: i === 0 ? 'aim_bow' : 'draw_bow', mainHand: 'longbow', back: 'quiver', aimPitch: 0.05, animTime: i === 0 ? 0 : 0.85 });
      add(it);
    }
    const b = P.butts(); b.position.set(-8.6, 0, 14); props.push(b);
    VIGNETTES.push({ name: 'archer', cam: { pos: [-5.6, 1.75, 2.6], target: [-8.4, 1.35, 0.4] } });
  }
  // 4. crossbowmen (x -15)
  {
    const l1 = peasant('m', 2); armLook(rng, l1, 'crossbow');
    const a = makeChar(l1, -15, 0, 0, { anim: 'aim_crossbow', mainHand: 'crossbow', back: 'quiver', aimPitch: 0.04 });
    add(a);
    const l2 = peasant('m', 2); armLook(rng, l2, 'crossbow');
    const r = makeChar(l2, -16.4, -0.4, 0.3, { anim: 'reload_crossbow', mainHand: 'crossbow', back: 'quiver', animTime: 0.9 });
    add(r, (t, dt) => { r.animTime += dt; if (r.animTime > 3.6) r.animTime = 0; });
    VIGNETTES.push({ name: 'crossbow', cam: { pos: [-12.6, 1.6, 2.5], target: [-15.6, 1.05, 0.0] } });
  }
  // 5. sword fight (x 16)
  {
    const l1 = peasant('m', 3); armLook(rng, l1, 'man_at_arms'); l1.helmet = 'nasal';
    const l2 = peasant('m', 3); armLook(rng, l2, 'man_at_arms'); l2.helmet = 'kettle'; l2.armour = 'mail';
    l2.clothing.tunicStyle = 'surcoat'; l2.heraldry = heraldryFor(rng);
    const a = makeChar(l1, 16.1, 1.7, Math.PI, { anim: 'attack_slash', mainHand: 'sword', offHand: 'shield_round' });
    const b = makeChar(l2, 16, 0, 0, { anim: 'block', mainHand: 'sword', offHand: 'shield_heater' });
    add(a); add(b);
    VIGNETTES.push({ name: 'swordfight', cam: { pos: [19.3, 1.75, 1.2], target: [16.05, 1.1, 0.85] } });
  }
  // 6. the fallen (x 22)
  {
    const l1 = peasant('m', 2); armLook(rng, l1, 'levy');
    const a = makeChar(l1, 22, 0, 0.6, { anim: 'dead', mainHand: 'none' });
    add(a);
    const l2 = peasant('m', 2); armLook(rng, l2, 'levy');
    const b = makeChar(l2, 23.4, 0.9, -2.2, { anim: 'dead' });
    b.id = 9003; // unique id whose hash gives the face-down variant
    add(b);
    const l3 = peasant('f', 2);
    const c = makeChar(l3, 22.3, 1.5, Math.PI + 0.3, { anim: 'kneel' });
    add(c);
    VIGNETTES.push({ name: 'fallen', cam: { pos: [25.2, 2.1, 3.8], target: [22.6, 0.4, 0.7] } });
  }
  // 7. knight charging with a couched lance (gallops along z at x 30)
  {
    const look = generateLook(rng, { tier: 5, sex: 'm', age: 30, culture: 'franc' });
    armLook(rng, look, 'knight');
    look.armour = 'plate'; look.helmet = 'great_helm';
    const it = makeChar(look, 30, -20, 0, { anim: 'ride_charge', mainHand: 'lance', offHand: 'shield_heater', moveSpeed: 11 });
    it.mount = { coat: 0xe8e2d8, barding: look.heraldry!.field, anim: 'gallop', animTime: 0 };
    add(it, (t, dt) => {
      it.animTime += dt; it.mount!.animTime += dt;
      it.z += it.moveSpeed * dt;
      if (it.z > 20) it.z -= 40;
    });
    VIGNETTES.push({ name: 'knight', cam: { pos: [34.2, 1.8, 3.9], target: [30, 1.35, 0.2] } });
  }
  // 8. woodcutter, digger and miner (x 38..46)
  {
    const l1 = peasant('m', 2);
    const a = makeChar(l1, 38, 0, 0, { anim: 'work_axe', mainHand: 'axe' });
    add(a);
    const log = P.chopLog(); log.position.set(38.45, 0, 0.95); props.push(log);
    const l2 = peasant('m', 1);
    const b = makeChar(l2, 41, 0, 0, { anim: 'work_dig', mainHand: 'spade', animTime: 0.6 });
    add(b);
    const l3 = peasant('m', 2);
    const c = makeChar(l3, 44, 0, 0, { anim: 'work_pick', mainHand: 'pick', animTime: 0.3 });
    add(c);
    const r = P.rockPile(); r.position.set(44, 0, 1.4); props.push(r);
    const l4 = peasant('m', 1);
    const d = makeChar(l4, 47, 0, 0, { anim: 'work_hoe', mainHand: 'hoe', animTime: 0.2 });
    add(d);
    VIGNETTES.push({ name: 'labour', cam: { pos: [42.5, 2.4, 6.5], target: [42.5, 0.9, 0.4] } });
  }
  // 9. village life: talk, eat, drink, sit, spin, knead, milk, sow (x 54..)
  {
    const pairs: [AnimState, Partial<CharacterDrawItem>, Sex][] = [
      ['talk', {}, 'm'], ['talk', {}, 'f'], ['drink', { mainHand: 'cup' }, 'm'], ['eat', {}, 'f'],
      ['work_spin', { mainHand: 'distaff' }, 'f'], ['work_knead', {}, 'f'], ['wave', {}, 'm'], ['pray', {}, 'f'],
    ];
    pairs.forEach(([anim, ex, sex], i) => {
      const look = peasant(sex, (1 + (i % 4)) as RankTier);
      const x = 54 + (i % 4) * 1.7, z = Math.floor(i / 4) * 2.2;
      const it = makeChar(look, x, z, i === 1 ? Math.PI * 0.9 : i === 0 ? 0.3 : 0, { anim, ...ex, animTime: i * 0.37 });
      add(it);
      if (anim === 'work_knead') { const t = P.table(); t.position.set(x, 0, z + 0.62); props.push(t); }
    });
    VIGNETTES.push({ name: 'village', cam: { pos: [56.5, 2.6, 8.5], target: [56.5, 0.9, 1.0] } });
  }
  void labels; void animals;
  return {
    name: 'action', chars, animals, props, labels,
    camera: { pos: VIGNETTES[0].cam.pos, target: VIGNETTES[0].cam.target },
    shadow: { x: 0, z: 0, r: 12 },
  };
}

// ------------------------------------------------------------------------------------------------ crowd stress test
export function crowdScene(o: SceneOptions): SceneDef {
  resetIds();
  const rng = new Rng(`crowd-${o.seed}`);
  const n = o.count ?? 300, na = o.animals ?? 150;
  const chars: CharActor[] = [];
  const animals: AnimalActor[] = [];
  const R = 34;
  const helds: HeldItem[] = ['none', 'none', 'none', 'staff', 'hoe', 'sack', 'basket', 'spear', 'sword', 'bucket', 'torch', 'book'];
  for (let i = 0; i < n; i++) {
    const tier = rng.weighted([1, 2, 3, 4, 5, 6, 7, 8] as RankTier[], [30, 35, 15, 8, 5, 3, 2, 1]);
    const age = rng.chance(0.18) ? rng.int(6, 13) : rng.chance(0.12) ? rng.int(60, 78) : rng.int(16, 55);
    const look = generateLook(rng, { tier, sex: rng.chance(0.5) ? 'm' : 'f', age, culture: rng.pick(CULTURES) });
    if (rng.chance(0.08)) armLook(rng, look, rng.pick(['levy', 'archer', 'man_at_arms'] as const));
    const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * R;
    const it = makeChar(look, Math.cos(a) * r, Math.sin(a) * r, rng.next() * 6.28, { anim: 'walk' });
    it.mainHand = rng.pick(helds);
    if (rng.chance(0.1)) it.carry = rng.pick(['sack', 'bundle_wood', 'basket', 'child'] as const);
    if (it.carry !== 'none') it.mainHand = 'none';
    const speed = it.carry !== 'none' ? 1.0 : rng.chance(0.1) ? 3.3 : 1.1 + rng.next() * 0.5;
    it.moveSpeed = speed;
    it.anim = it.carry !== 'none' ? 'carry_walk' : speed > 2.5 ? 'run' : 'walk';
    let tx = (rng.next() - 0.5) * 2 * R, tz = (rng.next() - 0.5) * 2 * R;
    const wander = new Rng(`w${i}`);
    chars.push({
      item: it,
      tick: (_t, dt) => {
        it.animTime += dt;
        const dx = tx - it.x, dz = tz - it.z;
        const d = Math.hypot(dx, dz);
        if (d < 1) { const a2 = wander.next() * Math.PI * 2, r2 = Math.sqrt(wander.next()) * R; tx = Math.cos(a2) * r2; tz = Math.sin(a2) * r2; return; }
        const want = Math.atan2(dx, dz);
        let dy = want - it.yaw;
        while (dy > Math.PI) dy -= Math.PI * 2;
        while (dy < -Math.PI) dy += Math.PI * 2;
        it.yaw += Math.max(-2.5 * dt, Math.min(2.5 * dt, dy));
        it.x += Math.sin(it.yaw) * it.moveSpeed * dt;
        it.z += Math.cos(it.yaw) * it.moveSpeed * dt;
      },
    });
  }
  const kindsW: AnimalKind[] = ['sheep', 'sheep', 'cow', 'pig', 'goat', 'chicken', 'chicken', 'goose', 'dog', 'horse', 'ox', 'cat', 'deer', 'hare'];
  for (let i = 0; i < na; i++) {
    const kind = rng.pick(kindsW);
    const a = rng.next() * Math.PI * 2, r = Math.sqrt(rng.next()) * R;
    const it = makeAnimal(kind, Math.cos(a) * r, Math.sin(a) * r, rng.next() * 6.28, { anim: 'walk', young: rng.chance(0.15) });
    it.coat = coatFor(rng, kind);
    let state = 0, timer = rng.next() * 6;
    const wander = new Rng(`a${i}`);
    animals.push({
      item: it,
      tick: (_t, dt) => {
        it.animTime += dt;
        timer -= dt;
        if (timer <= 0) {
          state = (state + 1) % 2;
          timer = 3 + wander.next() * 6;
          it.anim = state === 0 ? 'walk' : (kind === 'chicken' || kind === 'goose' ? 'eat' : 'graze');
          it.animTime = 0;
          it.yaw += (wander.next() - 0.5) * 2;
        }
        it.moveSpeed = it.anim === 'walk' ? (kind === 'chicken' ? 0.5 : kind === 'horse' || kind === 'deer' ? 1.4 : 0.9) : 0;
        if (Math.hypot(it.x, it.z) > R) it.yaw = Math.atan2(-it.x, -it.z);
        it.x += Math.sin(it.yaw) * it.moveSpeed * dt;
        it.z += Math.cos(it.yaw) * it.moveSpeed * dt;
      },
    });
  }
  return {
    name: 'crowd', chars, animals, props: [], labels: [],
    camera: { pos: [0, 30, 52], target: [0, 0, 0] },
    shadow: { x: 0, z: 0, r: 40 },
  };
}

export function coatFor(rng: Rng, kind: AnimalKind): number {
  switch (kind) {
    case 'horse': return rng.pick([0x6a4026, 0x3a2a20, 0x8a5a32, 0xb8b0a0, 0x2a2420, 0xa08050, 0xe8e2d8]);
    case 'cow': return rng.pick([0x6a4a34, 0x8a5a36, 0x3a2a24, 0xc8b8a0]);
    case 'ox': return rng.pick([0x8a5a36, 0x6a4a34, 0xb09070]);
    case 'sheep': return rng.pick([0xe8e0cc, 0xdcd2bc, 0xe2d8c3, 0x6a5a4a]);
    case 'pig': return rng.pick([0xd89a8a, 0x8a6a5a, 0x4a3a30, 0xc8a090]);
    case 'goat': return rng.pick([0xb09878, 0xe0d8c8, 0x5a4a3a, 0x8a7058]);
    case 'chicken': return rng.pick([0xc87a3a, 0xf0ece0, 0x6a4a2a, 0x2a2420, 0xd8a050]);
    case 'goose': return rng.pick([0xf0eee6, 0x9a948a]);
    case 'dog': return rng.pick([0x8a6a44, 0x3a2a20, 0xc8a878, 0x6a6058]);
    case 'cat': return rng.pick([0x9a8a78, 0x2a2420, 0xc87a3a, 0xe0d8c8]);
    default: return DEFAULT_COAT[kind];
  }
}

// ------------------------------------------------------------------------------------------------ animal pen
export function animalsScene(o: SceneOptions): SceneDef {
  resetIds();
  const rng = new Rng(`animals-${o.seed}`);
  const animals: AnimalActor[] = [];
  const labels: Label[] = [];
  const props: THREE.Object3D[] = [];
  VIGNETTES.length = 0;
  // three rows by size, animals in profile (facing +x) with their young beside them
  const rows: AnimalKind[][] = [
    ['horse', 'ox', 'cow', 'deer', 'boar'],
    ['pig', 'sheep', 'goat', 'wolf', 'dog'],
    ['fox', 'cat', 'hare', 'chicken', 'goose'],
  ];
  const rowZ = [-3.2, 0, 2.6];
  const rowW = [3.6, 2.6, 1.9];
  const anim = o.animalAnim || 'idle';
  rows.forEach((row, ri) => {
    row.forEach((kind, ci) => {
      const x = (ci - (row.length - 1) / 2) * rowW[ri] * (ri === 0 ? 1 : 1.25);
      const z = rowZ[ri];
      const it = makeAnimal(kind, x, z, Math.PI / 2, { anim });
      it.coat = coatFor(rng, kind);
      if (kind === 'deer' || kind === 'sheep' || kind === 'chicken' || kind === 'goat' || kind === 'boar') it.male = true;
      it.moveSpeed = anim === 'walk' ? 1.0 : anim === 'trot' ? 2.5 : anim === 'run' ? 6 : 0;
      animals.push({ item: it, tick: (_t, dt) => { it.animTime += dt; }, subject: true });
      const y = makeAnimal(kind, x - rowW[ri] * 0.32, z + (ri === 0 ? 1.0 : 0.7), Math.PI / 2, { anim, young: true, coat: it.coat });
      y.moveSpeed = it.moveSpeed;
      animals.push({ item: y, tick: (_t, dt) => { y.animTime += dt; }, subject: true });
      const top: Record<string, number> = { horse: 2.0, ox: 1.9, cow: 1.75, deer: 2.0, boar: 1.2, pig: 1.05, sheep: 1.0, goat: 1.15, wolf: 1.1, dog: 0.9, fox: 0.6, cat: 0.45, hare: 0.55, chicken: 0.55, goose: 0.95 };
      labels.push({ text: kind, x, y: top[kind] ?? 1, z, small: true });
    });
  });
  const f2 = P.fence(24); f2.position.set(0, 0, -5.2); props.push(f2);
  const tr = P.trough(); tr.position.set(9, 0, -4.4); props.push(tr);
  VIGNETTES.push({ name: 'big', cam: { pos: [0, 2.6, 6.5], target: [0, 0.8, -3.0] } });
  VIGNETTES.push({ name: 'small', cam: { pos: [0, 1.9, 7.5], target: [0, 0.3, 1.6] } });
  return {
    name: 'animals', chars: [], animals, props, labels,
    camera: { pos: [0, 5.5, 13], target: [0, 0.4, -0.5] },
    shadow: { x: 0, z: -0.5, r: 13 },
  };
}

// ------------------------------------------------------------------------------------------------ one subject (inspection, film strips)
export function soloScene(o: SceneOptions): SceneDef {
  resetIds();
  const rng = new Rng(`solo-${o.seed}`);
  const so = o.solo ?? { tier: 3 as RankTier, sex: 'm' as Sex, age: 30, culture: 'anglo' as CultureId };
  const yaw = so.yaw ?? Math.PI / 2;
  const chars: CharActor[] = [];
  const animals: AnimalActor[] = [];
  if (so.animal) {
    const anim = o.animalAnim || 'idle';
    const it = makeAnimal(so.animal, 0, 0, yaw, { anim, coat: coatFor(rng, so.animal) });
    it.male = true;
    it.moveSpeed = so.speed ?? (anim === 'walk' ? 1.2 : anim === 'trot' ? 3 : anim === 'run' ? 8 : 0);
    animals.push({ item: it, tick: (_t, dt) => { it.animTime += dt; }, subject: true });
  } else {
    const look = generateLook(rng, { tier: so.tier, sex: so.sex, age: so.age, culture: so.culture });
    if (so.arm) armLook(rng, look, so.arm);
    const it = makeChar(look, 0, 0, yaw);
    const anim = o.anim || 'idle';
    applyAnim(it, anim);
    if (o.items !== false) equipFor(it, anim);
    if (so.main) it.mainHand = so.main;
    if (so.off) it.offHand = so.off;
    if (so.speed !== undefined) it.moveSpeed = so.speed;
    if (it.mount && o.gait) it.mount.anim = o.gait;
    chars.push({ item: it, tick: (_t, dt) => { it.animTime += dt; if (it.mount) it.mount.animTime += dt; }, subject: true });
  }
  return {
    name: 'solo', chars, animals, props: [], labels: [],
    camera: { pos: [0, 1.1, 4.2], target: [0, 0.85, 0] },
    shadow: { x: 0, z: 0, r: 4 },
  };
}

export function buildScene(name: string, o: SceneOptions): SceneDef {
  switch (name) {
    case 'solo': return soloScene(o);
    case 'faces': return facesScene(o);
    case 'anims': return animsScene(o);
    case 'riders': return ridersScene(o);
    case 'action': return actionScene(o);
    case 'crowd': return crowdScene(o);
    case 'animals': return animalsScene(o);
    default: return lineupScene(o);
  }
}

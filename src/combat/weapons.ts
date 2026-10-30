// Typed access to src/content/weapons.json: melee weapons, shields, bows, armour and the default kit of
// people who have no equipment slots (NPCs wear what they are seen wearing, see `looks` in the data).
import type { ArmourLook, AnimState, HeldItem, HelmetLook } from '../core/view';
import { parseItemKey, type Quality } from '../sim/economy/types';
import type { HitLocation, WoundKind } from '../sim/wave3';
import data from '../content/weapons.json';

export type AttackKey = 'slash' | 'overhead' | 'thrust';
export const ATTACK_KEYS: readonly AttackKey[] = ['slash', 'overhead', 'thrust'];

export interface AttackDef {
  kind: WoundKind;
  dmg: number;
  ap: number;
  windup: number;
  recover: number;
  stamina: number;
  /** Half-angle (rad) of the blow's cone in front of the wielder. */
  arc: number;
  anim: AnimState;
}

export interface WeaponDef {
  id: string;
  name: string;
  held: HeldItem;
  hands: 1 | 2;
  reach: number;
  weight: number;
  /** How well the weapon parries (0..1). */
  guard: number;
  mounted?: boolean;
  attacks: Record<AttackKey, AttackDef>;
}

export interface ShieldDef { id: string; name: string; held: HeldItem; block: number; cover: number; weight: number }

export interface RangedDef {
  id: string;
  name: string;
  held: HeldItem;
  type: 'bow' | 'crossbow';
  ammo: string;
  drawWeight: number;
  strReq: number;
  range: number;
  speed: number;
  dmg: number;
  ap: number;
  drawTime: number;
  reload: number;
  aimTime: number;
}

export interface ArmourDef {
  id: string;
  name: string;
  slot: 'armour' | 'helmet';
  look: ArmourLook | HelmetLook;
  weight: number;
  cover: Partial<Record<HitLocation, number>>;
  gap: number;
  absorb: Record<WoundKind, number>;
}

interface Raw {
  weapons: Record<string, Omit<WeaponDef, 'id'>>;
  shields: Record<string, Omit<ShieldDef, 'id'>>;
  ranged: Record<string, Omit<RangedDef, 'id'>>;
  armour: Record<string, Omit<ArmourDef, 'id'>>;
  looks: { armour: Record<string, string>; helmet: Record<string, string> };
  careers: Record<string, unknown>;
}
const raw = data as unknown as Raw;

function indexed<T extends { id: string }>(src: Record<string, Omit<T, 'id'>>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [id, v] of Object.entries(src)) out[id] = { id, ...v } as T;
  return out;
}

export const WEAPONS: Readonly<Record<string, WeaponDef>> = indexed<WeaponDef>(raw.weapons);
export const SHIELDS: Readonly<Record<string, ShieldDef>> = indexed<ShieldDef>(raw.shields);
export const RANGED: Readonly<Record<string, RangedDef>> = indexed<RangedDef>(raw.ranged);
export const ARMOUR: Readonly<Record<string, ArmourDef>> = indexed<ArmourDef>(raw.armour);

export const DAMAGE_QUALITY: readonly number[] = [0.85, 1, 1.06, 1.12, 1.2];
export const ABSORB_QUALITY: readonly number[] = [0.7, 1, 1.1, 1.2, 1.35];

export function qualityOf(q: Quality | undefined): Quality { return (q ?? 1) as Quality; }

/** The weapon, shield, bow or armour piece an item key stands for ("sword#2"), or null. */
export function weaponOfKey(key: string): { def: WeaponDef; quality: Quality } | null {
  const { good, quality } = parseItemKey(key);
  const def = WEAPONS[good];
  return def ? { def, quality: qualityOf(quality) } : null;
}
export function shieldOfKey(key: string): { def: ShieldDef; quality: Quality } | null {
  const { good, quality } = parseItemKey(key);
  const def = SHIELDS[good];
  return def ? { def, quality: qualityOf(quality) } : null;
}
export function rangedOfKey(key: string): { def: RangedDef; quality: Quality } | null {
  const { good, quality } = parseItemKey(key);
  const def = RANGED[good];
  return def ? { def, quality: qualityOf(quality) } : null;
}
export function armourOfKey(key: string): { def: ArmourDef; quality: Quality } | null {
  const { good, quality } = parseItemKey(key);
  const def = ARMOUR[good];
  return def ? { def, quality: qualityOf(quality) } : null;
}

/** The goods that give the protection of what the renderer shows a person wearing. */
export function armourGoodOfLook(look: ArmourLook): string | null { return look === 'none' ? null : raw.looks.armour[look] ?? null; }
export function helmetGoodOfLook(look: HelmetLook): string | null { return look === 'none' ? null : raw.looks.helmet[look] ?? null; }

export interface CareerKit { main: string; off: string | null; ranged?: string; alt?: string[] }
const CAREER_KITS = raw.careers as unknown as Record<string, CareerKit | string[]>;
export function careerKit(career: string): CareerKit | null {
  const k = CAREER_KITS[career];
  return k && !Array.isArray(k) ? k : null;
}
export const IMPROVISED: readonly string[] = (CAREER_KITS.improvised as string[]) ?? ['staff'];
